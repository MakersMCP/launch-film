"use strict";
// ─── Chrome over a DevTools pipe ───────────────────────────────────────────
// Every clip is an HTML page rendered frame by frame in headless Chrome: the
// page's clock is virtual, so a frame is drawn for its time and captured,
// however long the drawing takes. No ports are opened: the DevTools protocol
// runs over the pipe Chrome gets as file descriptors 3 and 4.
//
// On a Mac, Chrome asks for the login keychain under a fresh profile unless
// it is given a mock keychain and a basic password store: without them a
// dialog came up on every render. The real HOME stays, so Chrome finds its
// own files; the profile is a temp folder of its own, removed once Chrome
// has gone (and on a stop, with the pages' folders: out.js).
//
// A page can make Chrome save a file of its choosing, of any size, into the
// Downloads folder of the user it runs as, where nothing removes it: a site a
// plan read filled that folder, outside every folder of the run's. So every
// Chrome is told to refuse downloads before any page opens, and its profile
// names a folder inside it for them, should one still be saved.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { encoder } = require("./ffmpeg");
const { getSystemErrorMap } = require("util");
const { tempDir, tempEnv, release, track, socketFolder, closeProfile, save } = require("./out");

// A wait on Chrome that ran out, said with what to do: a machine too busy for
// Chrome is what made it this slow in the runs seen. A render of more than
// one clip at once adds that one at a time eases it (film.js).
function late(what) {
  return Object.assign(new Error(`${what}, most often because the machine is too busy: run again once it is less busy`), { slow: true });
}

function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}

// The browser to render with: LAUNCH_FILM_CHROME, else an installed Chrome
// or Chromium.
function findChrome() {
  const given = process.env.LAUNCH_FILM_CHROME || process.env.CHROME_PATH;
  if (given) return fs.existsSync(given) ? given : null;
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  const win = [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];
  const listed = process.platform === "darwin" ? mac : process.platform === "win32" ? win : [];
  for (const file of listed) if (file && fs.existsSync(file)) return file;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const found = onPath(name);
    if (found) return found;
  }
  return null;
}

// Why Chrome stopped. A sandbox it could not start ends Chrome at once,
// whatever signal or code it ends with, and is said as that, with what to do:
// as root Chrome runs without one, but anyone else gets it.
function stoppedWhy(code, signal, stderr) {
  const fatal = /^.*:FATAL:[^\]]*\]\s*(.*\bsandbox\b.*)$/im.exec(stderr || "");
  if (fatal) {
    const said = fatal[1].split(/(?<=!)\s|\.\s/)[0].replace(/!$/, "").slice(0, 160);
    return `Chrome could not start its sandbox (${said}). Run launch-film where Chrome's sandbox can start: Google Chrome's own package sets it up, and a container needs --security-opt seccomp=unconfined`;
  }
  if (signal) return `Chrome was stopped by ${signal}${signal === "SIGKILL" ? ", most often because the system ran out of memory" : ""}`;
  return `Chrome stopped (exit ${code})${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`;
}

// ─── addresses that are no web page's ──────────────────────────────────────
// Chrome hands an address of a kind no page shows to the system, and a
// mailto:, news: or snews: one without asking: on Linux to xdg-email or
// xdg-open, which it finds on PATH. A page that went to mailto: as it loaded
// started the user's mail program, and on a server ran xdg-open with the
// site's address. So every Chrome launch-film starts, and the one
// easybrandkit starts for it (brand.js), has a folder of stand-ins first on
// its PATH, in a temp folder of the run's own, for each program Chrome or
// xdg-open hands such an address to, and for xdg-settings, which Chrome asks
// first which program takes its kind. A stand-in starts nothing and ends
// well, and notes what it was given beside it. Linux only: macOS and Windows hand
// the address to the system by no PATH, and no switch of Chrome's,
// preference of its profile or call of the DevTools protocol stops these
// three kinds there (README). A stand-in that cannot be run, from a temp
// folder on a disk mounted noexec, would be passed over for the real
// program, so no Chrome starts then. A plan says which addresses a page
// asked for (opened): those a page of launch-film's Chrome went to or opened
// a window for, and those that reached a stand-in, as from easybrandkit's.
// A page can ask for as many as it likes, each as long as it likes: the
// first NOTED of them are kept, each cut to NOTED_LENGTH characters, and the
// rest are counted, in memory and in the stand-ins' note alike.
const OPENERS = ["xdg-open", "xdg-email", "x-www-browser", "www-browser", "sensible-browser", "xdg-settings"];
const NOTED = 5;
const NOTED_LENGTH = 200;
const STAND_IN = `#!/bin/sh
d=\${0%/*}
a=$(printf '%s' "$*" | tr -d '\\r\\n' | head -c ${NOTED_LENGTH})
grep -qxF -- "$a" "$d/opened" 2>/dev/null && exit 0
if [ "$(wc -l < "$d/opened" 2>/dev/null || echo 0)" -lt ${NOTED} ]; then printf '%s\\n' "$a" >> "$d/opened"; else printf . >> "$d/more"; fi
exit 0
`;
let openers = null;
const asked = new Set();
let askedMore = 0;
// An address a page of launch-film's Chrome asked for, kept as the
// stand-ins keep one.
function ask(url) {
  const address = String(url).replace(/[\r\n]/g, "").slice(0, NOTED_LENGTH);
  if (asked.has(address)) return;
  if (asked.size < NOTED) asked.add(address);
  else askedMore++;
}
// The kinds of address a page shows, or that Chrome keeps to itself: any
// other it hands to the system.
const SHOWN = new Set(["http:", "https:", "data:", "blob:", "about:", "javascript:", "file:", "filesystem:", "chrome:", "chrome-error:", "chrome-untrusted:", "devtools:", "view-source:", "ws:", "wss:"]);
function handedOn(url) {
  try {
    return !SHOWN.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}
function openerFolder() {
  if (process.platform !== "linux") return null;
  if (openers && fs.existsSync(path.join(openers, "opened"))) return openers;
  // PATH reads a ":" as the end of a folder, so a stand-ins' folder whose
  // path holds one would be passed over for what comes after it on PATH,
  // while the try below, which runs a stand-in by its path, still passed.
  if (os.tmpdir().includes(path.delimiter)) {
    throw new Error(`launch-film cannot put its stand-ins for xdg-open, which keep a page from starting a program of the machine's, first on Chrome's PATH from the temp folder ${os.tmpdir()}, ` +
      `as PATH reads the "${path.delimiter}" in its path as the end of a folder: set TMPDIR to a folder whose path has no "${path.delimiter}"`);
  }
  const dir = tempDir("launch-film-bin-");
  for (const name of OPENERS) save(path.join(dir, name), name === "xdg-settings" ? "#!/bin/sh\nexit 0\n" : STAND_IN);
  for (const name of OPENERS) fs.chmodSync(path.join(dir, name), 0o700);
  const tried = require("child_process").spawnSync(path.join(dir, OPENERS[0]), [], { timeout: 10_000 });
  if (tried.error || tried.status !== 0) {
    release(dir);
    // The system short of a file descriptor or a process is not the disk.
    const short = require("./programs").short(tried.error, "its stand-ins for xdg-open");
    if (short) throw Object.assign(new Error(short), { short: true });
    const why = tried.error && `${(getSystemErrorMap().get(tried.error.errno) || [])[1] || tried.error.code}, ${tried.error.code}`;
    throw new Error(`launch-film could not run its stand-ins for xdg-open in ${dir}${why ? ` (${why})` : ""}, which keep a page from starting a program of the machine's: ` +
      "set TMPDIR to a folder on a disk where programs may run, as one mounted noexec runs none");
  }
  // The try is not an address a page asked for.
  save(path.join(dir, "opened"), "");
  fs.rmSync(path.join(dir, "more"), { force: true });
  openers = dir;
  return dir;
}

// The environment `env` with the stand-ins first on its PATH (Linux).
function withoutOpeners(env = process.env) {
  const dir = openerFolder();
  if (!dir) return env;
  return { ...env, PATH: env.PATH ? `${dir}${path.delimiter}${env.PATH}` : `${dir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
}

// The addresses no page shows that pages asked for since the last call:
// those launch-film's Chrome saw a page go to or open a window for, and
// those handed to a stand-in. { list, more }: the first NOTED, each once,
// and how many more times one was asked for.
function opened() {
  let text = "";
  let more = 0;
  if (openers) {
    try {
      text = fs.readFileSync(path.join(openers, "opened"), "utf8");
      more = fs.statSync(path.join(openers, "more")).size;
    } catch {
      // None handed on, or none past the first.
    }
    save(path.join(openers, "opened"), "");
    fs.rmSync(path.join(openers, "more"), { force: true });
  }
  const all = [...new Set([...asked, ...text.split("\n").filter(handedOn)])];
  const list = all.slice(0, NOTED);
  more += askedMore + all.length - list.length;
  asked.clear();
  askedMore = 0;
  return { list, more };
}

// What Chrome is started with: the browser that renders the clips' pages
// (offline), or the one that reads a site's words (network).
function chromeArgs({ W = 1920, H = 1080, network = false, profile }) {
  return [
    "--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-sync", "--disable-default-apps", "--disable-background-networking",
    "--disable-component-update", "--disable-domain-reliability", "--disable-breakpad", "--metrics-recording-only",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--use-mock-keychain", "--password-store=basic", "--force-color-profile=srgb", "--font-render-hinting=none",
    // Chrome's sandbox does not start as root; anyone else keeps it, so a
    // page that breaks into Chrome's renderer is held there.
    ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    ...(process.env.LAUNCH_FILM_GPU === "0" ? ["--disable-gpu"] : []),
    // Pages render offline: they carry their fonts and pictures with them,
    // and are given their files by openPage. WebRTC goes around a proxy over
    // UDP, so it is let send nothing but through the proxy, which is none.
    ...(network ? [] : ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]),
    "--remote-debugging-pipe", `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "about:blank",
  ];
}

// A browser with its own temp profile, answering protocol calls by promise.
async function launch({ W = 1920, H = 1080, network = false } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome was not found. Install Google Chrome or Chromium, or set LAUNCH_FILM_CHROME to its path.");
  // The stand-ins first, so a temp folder they cannot run in starts no Chrome.
  openerFolder();
  // Removed with the socket folder Chrome links from it, however the run
  // ends: Chrome killed by a stop leaves that folder in the temp folder.
  let socket = null;
  const profile = tempDir("launch-film-chrome-", (dir) => closeProfile(dir, socket));
  // Downloads, should Chrome save one in spite of the refusal below, go in
  // the profile, which goes with the run.
  fs.mkdirSync(path.join(profile, "Default"));
  save(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: path.join(profile, "Downloads"), prompt_for_download: false } }));
  const args = chromeArgs({ W, H, network, profile });
  // A Chrome with network access, stopped as it starts, leaves a
  // com.google.Chrome.chrome_chrome_url_fetcher_ folder in its TMPDIR: given
  // its profile as TMPDIR, that goes with the profile.
  const child = track(spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: withoutOpeners(network ? tempEnv(profile) : process.env) }));
  // One the system had no file descriptor for comes back with no pipes, and
  // its error comes next (ffmpeg.js run): that is all there is to wait for.
  if (!child.stdio) {
    const err = await new Promise((resolve) => child.once("error", resolve));
    release(profile);
    const { short } = require("./programs");
    throw Object.assign(new Error(short(err, "Chrome") || `Chrome could not be started from ${chrome}: ${err.message}`), { short: Boolean(short(err, "Chrome")) });
  }
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  let buf = Buffer.alloc(0);
  let dead = null;
  let exited = false;
  let closing = false;
  const end = (err) => {
    dead = err;
    for (const w of pending.values()) w.reject(dead);
    pending.clear();
  };
  // What Chrome printed last can come in after it exits, from a helper that
  // holds its stderr: what is said of it waits for that, a second at most.
  child.on("exit", (code, signal) => {
    exited = true;
    let told = false;
    const tell = () => {
      if (told) return;
      told = true;
      end(new Error(stoppedWhy(code, signal, stderr)));
    };
    if (child.stderr.readableEnded) return tell();
    child.stderr.once("end", tell);
    setTimeout(tell, 1000).unref();
  });
  // A Chrome that cannot be started at all (a file that may not be run, or
  // the folder Google Chrome.app) has no process to end, so its calls fail
  // here. They waited for an answer that never came, and with nothing left
  // to wait on, the run ended with 0 and no word.
  child.on("error", (err) => {
    const { short } = require("./programs");
    if (short(err, "Chrome")) return end(Object.assign(new Error(short(err, "Chrome")), { short: true }));
    const why = { EACCES: "permission denied", ENOENT: "no such file" }[err.code];
    end(new Error(`Chrome could not be started from ${chrome}: ${why ? `${why} (${err.code})` : err.message}. Set LAUNCH_FILM_CHROME to the Chrome program itself, or install Google Chrome or Chromium`));
  });
  child.stdio[4].on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
      buf = buf.subarray(i + 1);
      // An address no page shows, that a page went to or opened a window
      // for: Chrome would hand it to the system (above).
      if ((msg.method === "Page.frameRequestedNavigation" || msg.method === "Page.windowOpen") && msg.params && handedOn(msg.params.url)) ask(msg.params.url);
      if (msg.id && pending.has(msg.id)) {
        const w = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { answered: true }));
        else w.resolve(msg.result || {});
      } else for (const l of listeners) l(msg);
    }
  });
  child.stdio[3].on("error", () => {});
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const n = ++id;
    // A call with no answer in 60 s is an error, not a hang.
    const timer = setTimeout(() => {
      if (pending.delete(n)) reject(late(`Chrome did not answer ${method} within 60 s`));
    }, 60_000);
    timer.unref();
    pending.set(n, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
    child.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  // A Chrome that does not answer its first call, in time or at all, is
  // ended here with its profile, since the caller never gets it to close:
  // left running, its pipes kept the process up after doctor or a plan that
  // went on with the page's HTML had ended. One that does not take the
  // refusal of downloads is ended the same way, before it opens a page.
  try {
    await send("Browser.getVersion");
    await send("Browser.setDownloadBehavior", { behavior: "deny" });
  } catch (err) {
    if (!exited) child.kill("SIGKILL");
    release(profile);
    for (const stream of [child.stderr, child.stdio[3], child.stdio[4]]) if (stream) stream.destroy();
    throw err;
  }
  socket = socketFolder(profile);
  return {
    send,
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    async page() {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      return { sessionId, targetId, call: (m, p) => send(m, p, sessionId) };
    },
    // Chrome is asked to close, so its helpers (the GPU, network and page
    // processes) end with it: killed outright, they went on writing to the
    // profile for seconds. One that has not gone in 3 s is killed. The
    // profile is removed once it has gone.
    close() {
      if (closing) return;
      closing = true;
      const gone = () => release(profile);
      if (dead || exited) return gone();
      child.once("exit", gone);
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
      send("Browser.close").catch(() => {});
    },
  };
}

// ─── the virtual clock ─────────────────────────────────────────────────────
// Time stands still in the page until the renderer moves it: animation
// frames never fire on their own, timers wait for the clock, Math.random is
// seeded. __lfAdvance(ms) moves the clock, seeks every CSS animation to it
// and calls the page's own __seek(ms).
const CLOCK = String.raw`(() => {
  if (window.__lfAdvance) return;
  let now = 0;
  let seq = 0;
  const timers = new Map();
  let nextId = 1;
  let seed = 0x2f6b9a1d;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const EPOCH = 1767225600000;
  const RealDate = Date;
  function VirtualDate(...args) {
    if (!new.target) return new RealDate(EPOCH + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(EPOCH + now);
  }
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.now = () => EPOCH + now;
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  window.Date = VirtualDate;
  try {
    Object.defineProperty(performance, "now", { value: () => now, configurable: true, writable: true });
  } catch {}
  const frames = new Map();
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.setTimeout = (fn, ms, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, seq: seq++ });
    return id;
  };
  window.setInterval = (fn, ms, ...args) => {
    const id = nextId++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: now + every, every, fn, args, seq: seq++ });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  const errors = [];
  window.addEventListener("error", (e) => errors.length < 20 && errors.push(String(e.message || e)));
  window.__lfErrors = () => errors;
  window.__lfAdvance = (ms) => {
    now = ms;
    // Timers due by now, in order. Animation frames are not run: a page
    // here draws from __seek, and a frame loop of its own would race it.
    for (let guard = 0; guard < 1000; guard++) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= now && (!due || t.at < due[1].at || (t.at === due[1].at && t.seq < due[1].seq))) due = [id, t];
      if (!due) break;
      const [id, t] = due;
      if (t.every) t.at += t.every;
      else timers.delete(id);
      try { if (typeof t.fn === "function") t.fn(...t.args); } catch (e) { errors.length < 20 && errors.push(String(e && e.message || e)); }
    }
    for (const a of document.getAnimations()) {
      try {
        a.pause();
        a.currentTime = ms;
      } catch {}
    }
    if (typeof window.__seek === "function") window.__seek(ms);
    return true;
  };
})();`;

// Runs `expression` in the page. Chrome ends a script that runs on past
// `timeout` with no word but "Internal error", which is said here as that.
async function evaluate(page, expression, timeout = 20_000) {
  const started = Date.now();
  const r = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout }).catch((err) => {
    throw err.answered && Date.now() - started >= timeout ? late(`the page's script did not finish within ${timeout / 1000} s`) : err;
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`the page failed: ${((d.exception && d.exception.description) || d.text || "error").split("\n")[0]}`);
  }
  return r.result ? r.result.value : undefined;
}

// A page is given its files by this process, at an https address of its
// own that leads nowhere on the network, and is never opened from the disk:
// it gets the files of its folder and nothing else. Chrome lets an https
// page open no file of the machine's, and every other address it asks for
// fails here. The folder's name is in the address, so no page is given
// another's file of the same name from Chrome's cache. Returns the page's
// address.
//
// Each file goes to Chrome in one DevTools message, which Chrome takes only
// up to 100 MB once the file is in base64: past that it answered nothing
// more, and the page waited out its load. So a file larger than
// PAGE_FILE_MAX fails the page at once, by name, and so does one Chrome
// refuses (fail): the pictures a film names are given as smaller copies when
// they are larger than this (film.js).
const PAGES = "https://launch-film.invalid";
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" };
const PAGE_FILE_MAX = 64 * 1024 * 1024;
function serve(browser, page, dir, fail = () => {}) {
  const base = `/${encodeURIComponent(path.basename(dir))}/`;
  browser.on((msg) => {
    if (msg.sessionId !== page.sessionId || msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    let file = null;
    try {
      const u = new URL(request.url);
      if (u.origin === PAGES && u.pathname.startsWith(base)) {
        const at = path.join(dir, ...u.pathname.slice(base.length).split("/").map(decodeURIComponent));
        const rel = path.relative(dir, at);
        if (rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) file = at;
      }
    } catch {
      // An address no page of ours has.
    }
    if (!file) return page.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    const name = path.relative(dir, file).split(path.sep).join("/");
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Not there: it is answered with a 404 below.
    }
    if (size > PAGE_FILE_MAX) {
      page.call("Fetch.failRequest", { requestId, errorReason: "Failed" }).catch(() => {});
      return fail(new Error(`the page's ${name} is ${Math.round(size / 1048576)} MB, more than the ${PAGE_FILE_MAX / 1048576} MB Chrome is given in one file`));
    }
    fs.readFile(file, (err, data) => {
      const headers = [{ name: "Cache-Control", value: "no-store" }];
      const answer = err ? { responseCode: 404, responseHeaders: headers, body: "" }
        : { responseCode: 200, responseHeaders: [...headers, { name: "Content-Type", value: TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" }], body: data.toString("base64") };
      // A Chrome that refuses the file, or that has stopped, fails the page
      // now. One too slow to answer is told of as that by the page's load.
      page.call("Fetch.fulfillRequest", { requestId, ...answer }).catch((e) => e.slow || fail(e.answered ? new Error(`Chrome did not take the page's ${name}: ${e.message}`) : e));
    });
  });
  return `${PAGES}${base}index.html`;
}

// Opens a page from a folder (index.html and the files next to it) with the
// clock in place, and waits for its fonts and pictures.
async function openPage(browser, dir, { W, H, scale = 1 }) {
  const page = await browser.page();
  const exceptions = [];
  browser.on((msg) => {
    if (msg.sessionId !== page.sessionId) return;
    if (msg.method === "Runtime.exceptionThrown" && exceptions.length < 20) {
      const d = msg.params.exceptionDetails || {};
      exceptions.push(String((d.exception && d.exception.description) || d.text || "error").split("\n")[0].slice(0, 300));
    }
  });
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: CLOCK });
  await page.call("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: scale, mobile: false });
  const loaded = new Promise((resolve) => {
    const on = (msg) => {
      if (msg.sessionId === page.sessionId && msg.method === "Page.loadEventFired") {
        browser.off(on);
        resolve(true);
      }
    };
    browser.on(on);
    setTimeout(() => resolve(false), 30_000).unref();
  });
  // A file the page cannot be given fails it at once (serve).
  let fail = null;
  const failed = new Promise((resolve, reject) => (fail = reject));
  failed.catch(() => {});
  const url = serve(browser, page, dir, (err) => fail(err));
  await page.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await page.call("Page.navigate", { url });
  if (!(await Promise.race([loaded, failed]))) throw late("the page did not load within 30 s");
  const failedFonts = await evaluate(page, `Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))])
    .then(() => document.fonts.ready).then(() => [...document.fonts].filter((f) => f.status === "error").map((f) => f.family))`);
  return { page, exceptions, failedFonts: failedFonts || [] };
}

// Renders a page to a silent MP4: `seconds` at `fps`, each frame drawn for
// its time and captured as a JPEG into ffmpeg. files: { name: Buffer } served
// next to the page.
async function renderPage({ html, files = {}, output, seconds, W = 1920, H = 1080, scale = 1, fps = 25, onFrame = null }) {
  const dir = tempDir("launch-film-page-");
  save(path.join(dir, "index.html"), html);
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    save(file, data);
  }
  const browser = await launch({ W, H });
  const enc = encoder({ output, fps });
  try {
    const { page, exceptions, failedFonts } = await openPage(browser, dir, { W, H, scale });
    const frames = Math.round(seconds * fps);
    for (let f = 0; f < frames; f++) {
      await evaluate(page, `__lfAdvance(${((f * 1000) / fps).toFixed(3)})`);
      const shot = await page.call("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true });
      await enc.write(Buffer.from(shot.data, "base64"));
      if (onFrame) onFrame(f + 1, frames);
    }
    await enc.end();
    const errors = [...exceptions, ...((await evaluate(page, "window.__lfErrors ? window.__lfErrors() : []").catch(() => [])) || [])];
    return { frames, errors, failedFonts };
  } catch (err) {
    enc.kill();
    throw err;
  } finally {
    browser.close();
    release(dir);
  }
}

// One still of a page at a time (ms), as PNG: for checks and tests.
async function stillOf({ html, files = {}, at = 0, W = 1920, H = 1080, scale = 1 }) {
  const dir = tempDir("launch-film-page-");
  save(path.join(dir, "index.html"), html);
  for (const [name, data] of Object.entries(files)) save(path.join(dir, name), data);
  const browser = await launch({ W, H });
  try {
    const { page, exceptions } = await openPage(browser, dir, { W, H, scale });
    // The clock moves forward to the time, as in a render.
    const step = 40;
    for (let ms = 0; ms < at; ms += step) await evaluate(page, `__lfAdvance(${ms})`);
    await evaluate(page, `__lfAdvance(${at})`);
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    return { png: Buffer.from(shot.data, "base64"), errors: exceptions };
  } finally {
    browser.close();
    release(dir);
  }
}

// PNGs of pages, one browser for them all. Each page { html, files, W, H,
// at, until } is shot at `at` ms, or once its entrances have played when
// `at` is "end" (but not after `until`).
async function snapshots(pages) {
  const browser = await launch({ W: 1920, H: 1080 });
  const out = [];
  try {
    for (const p of pages) {
      const dir = tempDir("launch-film-page-");
      try {
        save(path.join(dir, "index.html"), p.html);
        for (const [name, data] of Object.entries(p.files || {})) save(path.join(dir, name), data);
        const { page, exceptions } = await openPage(browser, dir, { W: p.W, H: p.H, scale: p.scale || 1 });
        let at = p.at || 0;
        if (at === "end") at = Math.round(Number(await evaluate(page, "window.__end ? window.__end() : 0")) || 0) + 150;
        if (p.until) at = Math.min(at, p.until);
        // The clock moves forward to the time, as in a render.
        for (let ms = 0; ms < at; ms += 40) await evaluate(page, `__lfAdvance(${ms})`);
        await evaluate(page, `__lfAdvance(${at}); if (window.__fit) window.__fit(); true`);
        const shot = await page.call("Page.captureScreenshot", { format: "png" });
        out.push({ png: Buffer.from(shot.data, "base64"), errors: exceptions });
        await browser.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      } finally {
        release(dir);
      }
    }
  } finally {
    browser.close();
  }
  return out;
}

module.exports = { findChrome, onPath, chromeArgs, launch, openPage, renderPage, stillOf, snapshots, evaluate, standIns: openerFolder, withoutOpeners, opened, CLOCK, PAGE_FILE_MAX, OPENERS };
