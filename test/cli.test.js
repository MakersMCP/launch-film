"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { tmp, shortTmp, WAITS } = require("./tmp");
const { available, FFMPEG } = require("../src/ffmpeg");

const root = path.join(__dirname, "..");
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 30_000 });
// The same with these added to its environment, and a minute to end in.
const cliWith = (env, ...args) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

test("help, looks and types", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:\n {2}launch-film <url> \[options\]/);
  const looks = cli("looks").stdout.trim().split("\n");
  assert.deepEqual(looks.map((l) => l.split(" ")[0]), ["launch", "aurora", "gridline", "pop", "journal"]);
  assert.match(cli("types").stdout, /^features /m);
  assert.match(cli("icons", "rocket").stdout, /rocket-launch/);
});

test("a bad address is refused plainly", () => {
  const r = cli("not a url");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a command or an address/);
});

// The words people read: the README, the skill, the CLI's help and the
// look descriptions. No dashes as punctuation and none of the stock words.
test("public text has no em or en dashes and no hype words", () => {
  const texts = {
    "README.md": fs.readFileSync(path.join(root, "README.md"), "utf8"),
    "SKILL.md": fs.readFileSync(path.join(root, "skills", "launch-film", "SKILL.md"), "utf8"),
    "THIRD_PARTY.md": fs.readFileSync(path.join(root, "THIRD_PARTY.md"), "utf8"),
    help: cli("--help").stdout,
    looks: cli("looks").stdout,
    types: cli("types").stdout,
    "bin/launch-film.js": fs.readFileSync(path.join(root, "bin", "launch-film.js"), "utf8"),
  };
  const banned = /\b(delve|unleash|seamless(ly)?|cutting-edge|game-?changer|elevate|empower|robust|harness|revolutioni[sz]e|supercharge|effortless(ly)?|stunning|magic(al)?|blazing|world-class|next-gen)\b/i;
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(!/[\u2013\u2014]/.test(text), `${name} has a dash: ${(/.{0,40}[\u2013\u2014].{0,40}/.exec(text) || [""])[0]}`);
    const hit = banned.exec(text);
    assert.ok(!hit, `${name} uses "${hit && hit[0]}"`);
  }
});

// A film's folder as a plan leaves it: the test brand as brand/, words.json
// and film.json, and a film.mp4 from a render.
const os = require("os");
const crypto = require("crypto");
const fixture = path.join(root, "test", "fixtures", "acme");
function filmFolder() {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  fs.copyFileSync(path.join(fixture, "words.json"), path.join(dir, "words.json"));
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ brand: "brand/brand.json", look: "launch", clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }));
  fs.writeFileSync(path.join(dir, "film.mp4"), "a film");
  return dir;
}
// Every file and folder in it, hidden ones too, with a hash of each file;
// with links, a link as where it leads.
function snap(dir, { links = false } = {}) {
  const seen = {};
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const s = fs.lstatSync(file);
      if (links && s.isSymbolicLink()) seen[key] = `link to ${fs.readlinkSync(file)}`;
      else if (s.isDirectory()) walk(file, key);
      else seen[key] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return seen;
}
// An easybrandkit that empties the folder it is given and fails, as one
// that could not open the page did.
function failingEasybrandkit(dir) {
  const file = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(file, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];' +
    ' for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) fs.rmSync(out + "/" + f, { recursive: true, force: true });' +
    ' process.stderr.write("easybrandkit: Could not open the page\\n"); process.exit(1);');
  return file;
}

// A kit of its own: the test brand under another name, or with a brand.json
// that cannot be read.
function otherKit(text) {
  const dir = path.join(tmp(), "kit");
  fs.cpSync(fixture, dir, { recursive: true });
  const kit = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "brand.json"), text || JSON.stringify({ ...kit, name: "Other Notes" }));
  return dir;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A plan run on a film's folder that fails: the folder is as it was, and
// the last line says so.
function planFails(args, said) {
  const dir = filmFolder();
  const before = snap(dir);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, ...args);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, said);
  assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
  assert.deepEqual(snap(dir), before);
}

test("a plan given another kit and a words.json that is not there leaves the folder as it was", () => {
  planFails(["--brand", otherKit(), "--words", path.join(os.tmpdir(), "launch-film-no-such-words.json")], /--words .*no-such-words\.json: no such file/);
});

test("a plan whose easybrandkit fails leaves the folder's kit as it was", () => {
  planFails(["--easybrandkit", failingEasybrandkit(tmp())], /easybrandkit failed \(exit 1\): easybrandkit: Could not open the page/);
});

test("a plan whose easybrandkit fails leaves a kit that brand/ links to as it was", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  // brand/ links to a kit other films share.
  const dir = filmFolder();
  const shared = path.join(tmp(), "shared-kit");
  fs.renameSync(path.join(dir, "brand"), shared);
  fs.symlinkSync(shared, path.join(dir, "brand"));
  const [before, kit] = [snap(dir, { links: true }), snap(shared)];
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", failingEasybrandkit(tmp()));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(snap(shared), kit);
  assert.deepEqual(snap(dir, { links: true }), before);
});

test("a plan whose easybrandkit fails cannot reach through a link inside the folder's kit", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  // A file and a folder in brand/ that link to files other films share, as
  // an easybrandkit working on the run's copy would write and clear them.
  const dir = filmFolder();
  const shared = tmp();
  fs.mkdirSync(path.join(shared, "pages"));
  fs.writeFileSync(path.join(shared, "logo.png"), "the shared logo");
  fs.writeFileSync(path.join(shared, "pages", "home.md"), "the shared page");
  fs.symlinkSync(path.join(shared, "logo.png"), path.join(dir, "brand", "logo-01.png"));
  fs.symlinkSync(path.join(shared, "pages"), path.join(dir, "brand", "pages"));
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];' +
    ' if (fs.lstatSync(out + "/logo-01.png").isSymbolicLink()) process.stderr.write("a link reached the copy\\n");' +
    ' fs.writeFileSync(out + "/logo-01.png", "new"); fs.writeFileSync(out + "/pages/home.md", "new"); fs.rmSync(out + "/pages/home.md");' +
    ' process.stderr.write("easybrandkit: Could not open the page\\n"); process.exit(1);');
  const [before, theirs] = [snap(dir, { links: true }), snap(shared)];
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!r.stderr.includes("a link reached the copy"), r.stderr);
  assert.deepEqual(snap(shared), theirs);
  assert.deepEqual(snap(dir, { links: true }), before);
});

test("a plan makes the folder's brand/ of plain files, however the kit it was given holds them", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  const kit = otherKit();
  const shared = tmp();
  fs.mkdirSync(path.join(shared, "pages"));
  fs.writeFileSync(path.join(shared, "pages", "home.md"), "the shared page");
  fs.renameSync(path.join(kit, "logo-header.png"), path.join(shared, "logo-header.png"));
  fs.symlinkSync(path.join(shared, "logo-header.png"), path.join(kit, "logo-header.png"));
  fs.symlinkSync(path.join(shared, "pages"), path.join(kit, "pages"));
  const dir = filmFolder();
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(kit, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.lstatSync(path.join(dir, "brand", "logo-header.png")).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(dir, "brand", "pages")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, "brand", "pages", "home.md"), "utf8"), "the shared page");
  assert.equal(fs.readdirSync(shared).length, 2);
});

test("easybrandkit's own words about the folder it was given name it as the user knows it", () => {
  // The run gives it its copy of brand/; the folder it speaks of is the
  // user's own, not a new one.
  const dir = filmFolder();
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, 'const out = process.argv[process.argv.indexOf("--out") + 1]; process.stderr.write("easybrandkit: " + out + " is not empty and holds no earlier brand kit. Pick another folder with --out.\\n"); process.exit(1);');
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.split("\n").slice(-3, -1).join("\n"), `launch-film: easybrandkit failed (exit 1): easybrandkit: ${path.join(dir, "brand")} is not empty and holds no earlier brand kit. Pick another folder with --out.\nlaunch-film: ${dir} is as it was.`);
});

test("a plan that ends well keeps the files of the user's in the folder's kit", () => {
  // easybrandkit makes its kit again where one is and leaves the other
  // files: it is given the run's copy of the folder's brand/.
  const dir = filmFolder();
  fs.writeFileSync(path.join(dir, "brand", "my-notes.txt"), "the user's own notes");
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, `const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1]; fs.cpSync(${JSON.stringify(fixture)}, out, { recursive: true, force: true });`);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit, "--words", path.join(fixture, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "brand", "my-notes.txt"), "utf8"), "the user's own notes");
});

test("a kit that cannot be copied is named, with the new folder and the reason", { skip: (process.platform === "win32" || process.getuid() === 0) && "a file its user may not read" }, () => {
  const kit = otherKit();
  fs.chmodSync(path.join(kit, "logo-header.png"), 0o000);
  planFails(["--brand", kit, "--words", path.join(fixture, "words.json")], new RegExp(`^launch-film: copying the brand kit ${escape(kit)} to the new .*/brand: permission denied \\(EACCES\\)\\n`));
});

test("a plan given a kit that cannot be read leaves the folder's kit as it was", () => {
  planFails(["--brand", otherKit("{ this is not JSON")], /JSON/);
});

test("a plan that fails makes no folder", () => {
  const base = tmp();
  const r = cli("plan", "https://acme-notes.example", "--out", path.join(base, "films", "acme"), "--easybrandkit", failingEasybrandkit(base));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(path.join(base, "films", "acme"))} was not made\\.\\n$`));
  assert.deepEqual(fs.readdirSync(base), ["easybrandkit.js"]);
});

test("a Ctrl-C that ends ffprobe as launch-film waits on it is told of as a stop", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  // frames reads the film with ffprobe first. Ctrl-C reaches every process
  // of the group at once, so it ends ffprobe while launch-film waits on it.
  const dir = tmp();
  const ffprobe = path.join(dir, "ffprobe");
  fs.writeFileSync(ffprobe, `#!/bin/sh\n: > "${path.join(dir, "started")}"\nsleep 20\nexec ffprobe "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "frames", path.join(dir, "film.mp4")], {
    detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LAUNCH_FILM_FFPROBE: ffprobe } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dir, "started")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  process.kill(-child.pid, "SIGINT");
  const { code, signal } = await ended;
  assert.deepEqual({ code, signal, stderr }, { code: null, signal: "SIGINT", stderr: "launch-film: stopped\n" });
});

// A stand-in easybrandkit that starts a stand-in Chrome and waits, with no
// handler for a signal, as easybrandkit 0.4.0. Its Chrome makes its profile
// and its socket folder in the temp folder, as Chrome does, writes its pid
// to STAND_IN_PID, lets SIGTERM go, and on Ctrl-C removes its socket folder
// and ends a moment later.
function easybrandkitWithChrome(dir) {
  const chrome = path.join(dir, "chrome.js");
  fs.writeFileSync(chrome, `
const fs = require("fs");
const path = require("path");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const sock = fs.mkdtempSync(path.join(process.env.TMPDIR, "com.google.Chrome."));
fs.writeFileSync(path.join(sock, "SingletonSocket"), "");
fs.symlinkSync(path.join(sock, "SingletonSocket"), path.join(profile, "SingletonSocket"));
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {
  if (process.env.STAND_IN_STUBBORN) return;
  fs.rmSync(path.join(profile, "SingletonSocket"));
  fs.rmSync(sock, { recursive: true });
  setTimeout(() => process.exit(0), 200);
});
fs.writeFileSync(process.env.STAND_IN_PID, String(process.pid));
${WAITS}
`);
  const kit = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(kit, `
const fs = require("fs");
const os = require("os");
const path = require("path");
const profile = process.env.STAND_IN_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-chrome-"));
require("child_process").spawn(process.execPath, [${JSON.stringify(chrome)}, "--headless=new", "--user-data-dir=" + profile], { stdio: "ignore" });
${WAITS}
`);
  return kit;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

test("a plan stopped while easybrandkit reads the brand ends the Chrome easybrandkit started and removes its profile", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  // With a temp folder long enough that easybrandkit keeps to it, and one
  // short enough for easybrandkit to get a temp folder of the run's own.
  for (const [how, temp] of [["SIGTERM", tmp()], ["SIGINT", tmp()], ["SIGTERM", shortTmp()], ["SIGINT", shortTmp()]]) {
    const dir = filmFolder();
    const before = snap(dir);
    const pidFile = path.join(tmp(), "chrome.pid");
    const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
      { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const chrome = Number(fs.readFileSync(pidFile, "utf8"));
    try {
      if (how === "SIGTERM") {
        // To launch-film alone: easybrandkit ends, its Chrome would not.
        child.kill("SIGTERM");
      } else {
        // Ctrl-C reaches every process of the group: easybrandkit ends at
        // once and its Chrome is moved out of its tree before launch-film
        // looks, so this comes a moment into the brand, as a Ctrl-C does.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        process.kill(-child.pid, "SIGINT");
      }
      const { signal } = await ended;
      assert.equal(signal, how, stderr);
      assert.ok(stderr.endsWith(`launch-film: stopped, so ${dir} is as it was\n`), stderr);
      for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(!alive(chrome), `${how}: easybrandkit's Chrome is gone`);
      assert.deepEqual(fs.readdirSync(temp), [], `${how}: neither its profile nor its socket folder is left`);
      assert.deepEqual(snap(dir), before);
    } finally {
      try {
        process.kill(chrome, "SIGKILL");
      } catch {
        // Gone, as it should be.
      }
    }
  }
});

test("a Chrome that outlives easybrandkit at a Ctrl-C is ended by the profile it uses in the run's own temp folder", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const dir = filmFolder();
  const temp = shortTmp();
  const pidFile = path.join(tmp(), "chrome.pid");
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
    { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile, STAND_IN_STUBBORN: "1" } });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const chrome = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.kill(-child.pid, "SIGINT");
    assert.equal(await ended, "SIGINT");
    for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!alive(chrome), "its Chrome is gone");
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally {
    try {
      process.kill(chrome, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
  }
});

// A plan into the test's film folder whose easybrandkit starts its Chrome,
// stopped with SIGTERM to launch-film alone once that Chrome is up: the
// Chrome's pid, what the plan said, and a way to end that Chrome. `stub` is
// loaded into the CLI first.
async function planStoppedAtChrome({ temp, env = {}, stub = "" }) {
  const dir = filmFolder();
  const before = snap(dir);
  const work = tmp();
  const pidFile = path.join(work, "chrome.pid");
  const stubFile = path.join(work, "stub.js");
  fs.writeFileSync(stubFile, stub);
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile, NODE_OPTIONS: `--require ${stubFile}`, ...env } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const chrome = Number(fs.readFileSync(pidFile, "utf8"));
  child.kill("SIGTERM");
  const { signal } = await ended;
  assert.equal(signal, "SIGTERM", stderr);
  assert.deepEqual(snap(dir), before);
  for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return { chrome, stillRuns: alive(chrome), end: () => { try { process.kill(chrome, "SIGKILL"); } catch { /* Gone, as it should be. */ } } };
}

test("a stop that comes before the first look at what easybrandkit started still ends its Chrome", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  // The looks four times a second never happen here, so the stop has to
  // look for itself as it begins, while easybrandkit's tree is whole.
  const temp = tmp();
  const plan = await planStoppedAtChrome({ temp, stub: "const real = global.setInterval; global.setInterval = (fn, ms, ...rest) => (ms === 250 ? { unref() {} } : real(fn, ms, ...rest));" });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.deepEqual(fs.readdirSync(temp), [], "neither its profile nor its socket folder is left");
  } finally {
    plan.end();
  }
});

test("a Chrome of easybrandkit's that uses a profile outside the temp folder is ended and its profile left", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const profile = path.join(tmp(), "a-chrome-profile-of-the-user's");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "Preferences"), "{}");
  const plan = await planStoppedAtChrome({ temp: tmp(), env: { STAND_IN_PROFILE: profile } });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.equal(fs.readFileSync(path.join(profile, "Preferences"), "utf8"), "{}");
  } finally {
    plan.end();
  }
});

test("a profile in the temp folder that is not this user's is left, whatever a process below easybrandkit names", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const temp = tmp();
  const plan = await planStoppedAtChrome({ temp, stub: `const fs = require("fs"); const path = require("path"); const real = fs.lstatSync; fs.lstatSync = (at, ...rest) => { const s = real(at, ...rest); if (s && path.basename(String(at)).startsWith("easybrandkit-chrome-")) s.uid += 1; return s; };` });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.equal(fs.readdirSync(temp).filter((n) => n.startsWith("easybrandkit-chrome-")).length, 1, fs.readdirSync(temp).join(", "));
  } finally {
    plan.end();
    for (const name of fs.readdirSync(temp)) fs.rmSync(path.join(temp, name), { recursive: true, force: true });
  }
});

test("a stop while a process still writes in easybrandkit's temp folder ends within a second", { skip: process.platform !== "linux" && "easybrandkit gets a temp folder of the run's own on Linux" }, async () => {
  // easybrandkit, with no handler for a signal, ends at the stop, while the
  // process it started writes on in its temp folder, as its Chrome does: a
  // removal then waits through all its retries. makersmcp kills a canceled
  // kit a second after the stop. Three tries, as a loaded machine can take
  // that long by itself; a removal that waits takes 1.5 s every time.
  const writer = `const fs = require("fs"); const path = require("path");
const at = (i) => path.join(process.env.TMPDIR, "f" + (i % 2000));
for (let i = 0; i < 2000; i++) fs.writeFileSync(at(i), "x");
fs.writeFileSync(process.env.STAND_IN_PID, String(process.pid));
for (let i = 0, t = Date.now(); Date.now() - t < 20000; i++) { try { fs.writeFileSync(at(i), "x"); } catch {} }`;
  let took = Infinity;
  for (let t = 0; t < 3 && took >= 1000; t++) {
    const work = tmp();
    const kit = path.join(work, "easybrandkit.js");
    fs.writeFileSync(kit, `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: "ignore" });\n${WAITS}`);
    const dir = filmFolder();
    const before = snap(dir);
    const temp = shortTmp();
    const pidFile = path.join(work, "writer.pid");
    const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 1000 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const writing = Number(fs.readFileSync(pidFile, "utf8"));
    try {
      assert.match(fs.readdirSync(temp).join(" "), /launch-film-brand-\d+-/, "it writes in the run's own temp folder");
      const sent = Date.now();
      child.kill("SIGTERM");
      const { signal } = await ended;
      took = Date.now() - sent;
      assert.equal(signal, "SIGTERM", stderr);
      assert.ok(stderr.endsWith(`launch-film: stopped, so ${dir} is as it was\n`), stderr);
      for (let i = 0; i < 50 && alive(writing); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(!alive(writing), "what wrote there is gone");
      assert.deepEqual(fs.readdirSync(temp), [], "nothing is left in the temp folder");
      assert.deepEqual(snap(dir), before);
    } finally {
      try {
        process.kill(writing, "SIGKILL");
      } catch {
        // Gone, as it should be.
      }
    }
  }
  assert.ok(took < 1000, `it ended ${took} ms after the stop`);
});

test("--verbose shows easybrandkit's words with the folder as it will be, not the part folder", () => {
  // A site's address, and a store listing, which easybrandkit reads too.
  for (const url of ["https://acme-notes.example", "https://apps.apple.com/us/app/acme-notes/id1234567"]) {
    const dir = filmFolder();
    const kit = path.join(tmp(), "easybrandkit.js");
    fs.writeFileSync(kit, `const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];
fs.cpSync(${JSON.stringify(fixture)}, out, { recursive: true, force: true });
const brand = JSON.parse(fs.readFileSync(out + "/brand.json", "utf8"));
brand.stores = [{ type: "appstore", ok: true, name: "Acme Notes" }];
fs.writeFileSync(out + "/brand.json", JSON.stringify(brand));
console.log("Saved the kit to " + out);
console.log("Read " + out + "/BRAND.md for the details.");`);
    const r = cli("plan", url, "--out", dir, "--easybrandkit", kit, "--words", path.join(fixture, "words.json"), "--verbose");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`Saved the kit to ${path.join(dir, "brand")}\nRead ${path.join(dir, "brand", "BRAND.md")} for the details.\n`), r.stderr);
    assert.ok(!r.stderr.includes(".launch-film-part-"), r.stderr);
  }
});

// A run whose plan is made and whose next step fails: Chrome is not there.
for (const [what, args] of [["the one-go command", []], ["stills of an address", ["stills"]]]) {
  test(`${what} puts the plan in with what it makes, or not at all`, { skip: !available() && "ffmpeg not found" }, () => {
    const dir = filmFolder();
    const before = snap(dir);
    const r = cliWith({ LAUNCH_FILM_CHROME: path.join(dir, "no-such-chrome") }, ...args, "https://acme-notes.example", "--out", dir, "--brand", otherKit(), "--words", path.join(fixture, "words.json"), "--look", "journal");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Chrome was not found/);
    assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
    assert.deepEqual(snap(dir), before);
  });
}

test("a render stops on a track it refuses, before any Chrome is started", { skip: (process.platform === "win32" && "the stand-in Chrome is a shell script") || (!available() && "ffmpeg not found") }, () => {
  const dir = filmFolder();
  fs.rmSync(path.join(dir, "film.mp4"));
  const started = path.join(tmp(), "chrome-started");
  const chrome = path.join(tmp(), "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\n: > "${started}"\nexit 1\n`, { mode: 0o755 });
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  const render = (music) => {
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, music }));
    return cliWith({ LAUNCH_FILM_CHROME: chrome }, "render", path.join(dir, "film.json"));
  };
  const missing = render("no-such-track.wav");
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(missing.stderr, `launch-film: film.json has problems:\n  - "music" "no-such-track.wav" is not a file. It was looked for at ${path.join(dir, "no-such-track.wav")}, as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)\n`);
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", path.join(dir, "short.wav")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  const short = render("short.wav");
  assert.equal(short.status, 1, short.stderr);
  assert.match(short.stderr, /^launch-film: film\.json has problems:\n {2}- "music" "short\.wav" lasts 1\.00 s and the film 2\.50 s: give a track at least as long as the film\./);
  assert.ok(!fs.existsSync(path.join(dir, "film.mp4")), "no film is made");
  assert.ok(!fs.existsSync(started), "no Chrome was started");
});

test("a plan into a folder already there writes the path of a file outside the kit so the film finds it", () => {
  // A kit whose brand.json names its screen by an absolute path outside it.
  const kit = otherKit();
  const shared = path.join(path.dirname(kit), "shared");
  fs.mkdirSync(shared);
  fs.renameSync(path.join(kit, "screenshot-1.png"), path.join(shared, "screen.png"));
  const brand = JSON.parse(fs.readFileSync(path.join(kit, "brand.json"), "utf8"));
  brand.screenshots[0].file = path.join(shared, "screen.png");
  fs.writeFileSync(path.join(kit, "brand.json"), JSON.stringify(brand));
  const dir = filmFolder();
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(kit, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  assert.ok(film.clips.some((c) => c.image && path.resolve(dir, c.image) === path.join(shared, "screen.png")), JSON.stringify(film.clips.map((c) => c.image || c.logo || c.icon).filter(Boolean)));
  const { loadFilm } = require("../src/film");
  assert.deepEqual(loadFilm(path.join(dir, "film.json")).problems, []);
});

test("an option's value is all that follows its first =", () => {
  // The folder's name holds an =: cut there, the plan would land on the
  // film in a folder named "my".
  const base = tmp();
  fs.mkdirSync(path.join(base, "my"));
  fs.writeFileSync(path.join(base, "my", "film.json"), "another film's plan");
  const r = cli("plan", "https://acme-notes.example", `--out=${base}/my=film`, `--brand=${fixture}`, "--words", path.join(fixture, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(base, "my=film", "film.json")));
  assert.equal(fs.readFileSync(path.join(base, "my", "film.json"), "utf8"), "another film's plan");
});

// What each command takes, as its refusal lists it.
const TAKES = {
  check: "--out, --expect, --seconds, --lufs, --cues, --cuts and --allow",
  plan: "--out, --brand, --words, --easybrandkit, --look, --seconds, --aspect, --no-music, --no-sfx and --verbose",
  url: "--out, --brand, --words, --easybrandkit, --look, --seconds, --aspect, --no-music, --no-sfx, --verbose, --jobs and --keep",
};

test("an option a command does not take is refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const url = "https://acme-notes.example";
  const out = path.join(dir, "out");
  for (const [args, said] of [
    [["check", "film.mp4", "--outt", out], `--outt is not an option of launch-film check, which takes ${TAKES.check}.`],
    [["render", film, "--music", "track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["plan", url, "--out", out, "--music=track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["render", film, "--no-music"], '--no-music is for a plan: a render plays what "music" in film.json says. Set it to false there and render again'],
    [["render", film, "--no-sfx"], '--no-sfx is for a plan: a render plays what "sfx" in film.json says. Set it to false there and render again'],
    [["render", film, "--out", out], "--out is not an option of launch-film render, which takes --jobs, --keep and --output."],
    [["plan", url, "--out", out, "--jobs", "1"], `--jobs is not an option of launch-film plan, which takes ${TAKES.plan}.`],
    [["frames", "film.mp4", "--for", "og"], "--for is not an option of launch-film frames, which takes --out."],
    [["stills", film, "--look", "pop"], "--look is not an option of launch-film stills <film.json>, which takes --for and --easybrandkit."],
    [[url, "--out", out, "--output", path.join(dir, "movie.mp4")], `--output is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [["looks", "--everything"], "--everything is not an option of launch-film looks, which takes no options."],
    [["plan", url, "--out", out, "--__proto__", "x"], `--__proto__ is not an option of launch-film plan, which takes ${TAKES.plan}.`],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, `launch-film: ${said}\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an option given without its value is refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const url = "https://acme-notes.example";
  const out = path.join(dir, "out");
  const words = path.join(fixture, "words.json");
  for (const [args, option] of [
    [["check", "a.mp4", "--out", "--lufs", "-14"], "--out"],
    [["check", "a.mp4", "--seconds"], "--seconds"],
    [["check", "a.mp4", "--out="], "--out"],
    [["check", "a.mp4", "--out", ""], "--out"],
    [["plan", url, "--out", out, "--brand", "--words", words], "--brand"],
    [["plan", url, "--out", out, "--brand=", "--words="], "--brand"],
    [["plan", url, "--look"], "--look"],
    [["render", film, "--jobs"], "--jobs"],
    [["render", film, "--output="], "--output"],
    [["frames", "a.mp4", "--out"], "--out"],
    [["stills", film, "--for"], "--for"],
    [[url, "--aspect", "--no-sfx"], "--aspect"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, `launch-film: ${option} needs a value\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  // What a command does not take is told of as that first.
  assert.equal(cli("render", film, "--out").stderr, "launch-film: --out is not an option of launch-film render, which takes --jobs, --keep and --output.\n");
  // A value given with = can start with two dashes.
  assert.match(cli("check", path.join(dir, "no-such.mp4"), "--out=--a-folder").stderr, /no-such\.mp4/);
});

test("a word that starts with a dash and an argument past the ones a command reads are refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const other = path.join(dir, "other");
  const url = "https://acme-notes.example";
  for (const [args, said] of [
    [["check", "a.mp4", "-o", "x"], `-o is not an option of launch-film check, which takes ${TAKES.check}.`],
    [["plan", url, "-x"], `-x is not an option of launch-film plan, which takes ${TAKES.plan}.`],
    [["-x"], `-x is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [[url, "-"], `- is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [["check", "a.mp4", other, "--out", path.join(dir, "out")], `launch-film check takes one film, so "${other}" would not be read.`],
    [["render", film, other], `launch-film render takes one film.json, so "${other}" would not be read.`],
    [["frames", "a.mp4", other], `launch-film frames takes one film, so "${other}" would not be read.`],
    [["stills", film, other], `launch-film stills <film.json> takes one address or film.json, so "${other}" would not be read.`],
    [["stills", url, other], `launch-film stills takes one address or film.json, so "${other}" would not be read.`],
    [["plan", url, other], `launch-film plan takes one address, so "${other}" would not be read.`],
    [[url, other], `launch-film <url> takes one address, so "${other}" would not be read.`],
    [["looks", other], `launch-film looks takes no arguments, so "${other}" would not be read.`],
    [["types", other], `launch-film types takes no arguments, so "${other}" would not be read.`],
    [["doctor", other], `launch-film doctor takes no arguments, so "${other}" would not be read.`],
    [["icons", "rocket", "launch"], 'launch-film icons takes one word, so "launch" would not be read.'],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, `launch-film: ${said}\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  // A first word that is neither a command nor an address is told of as that.
  assert.equal(cli("rendr", film).stderr, 'launch-film: "rendr" is not a command or an address. Run launch-film --help.\n');
  // -h and -v are options of every command, and a value can start with a dash.
  assert.match(cli("-h").stdout, /^launch-film: a 20-40 second/);
  assert.equal(cli("-v").stdout, `${require("../package.json").version}\n`);
  assert.doesNotMatch(cli("check", path.join(dir, "no-such.mp4"), "--lufs", "-14").stderr, /needs a value|is not an option/);
});

test("the texts name easybrandkit's script as its package has it, and --help lists --verbose", () => {
  const help = cli("--help").stdout;
  assert.match(help, /--verbose/);
  for (const text of [help, fs.readFileSync(path.join(root, "src", "brand.js"), "utf8"), fs.readFileSync(path.join(root, "skills", "launch-film", "SKILL.md"), "utf8")]) {
    assert.match(text, /skills\/easybrandkit\/scripts\/easybrandkit\.js/);
    assert.doesNotMatch(text, /(?<!skills\/easybrandkit\/)scripts\/easybrandkit\.js/);
  }
});

test("every option a command takes gets past the refusal, also as makersmcp gives them", () => {
  const dir = tmp();
  const none = path.join(dir, "none.json");
  const notAnOption = /is not an option|is for a plan|needs a value|would not be read/;
  const url = "https://acme-notes.example";
  const kit = path.join(dir, "no-such-kit");
  const plans = ["--out", path.join(dir, "out"), "--brand", kit, "--words", path.join(fixture, "words.json"), "--easybrandkit", "ebk", "--look", "pop", "--seconds", "20", "--aspect", "9:16", "--no-music", "--no-sfx", "--verbose"];
  for (const args of [
    [url, ...plans, "--jobs", "2", "--keep"],
    ["plan", url, ...plans],
    ["stills", url, ...plans, "--for", "og"],
    ["stills", none, "--for", "og", "--easybrandkit", "ebk"],
    ["render", none, "--jobs", "1", "--keep", "--output", path.join(dir, "m.mp4")],
    ["frames", none, "--out", path.join(dir, "f")],
    ["check", none, "--out", path.join(dir, "c"), "--expect", "1920x1080@25", "--seconds", "20-40", "--lufs", "-14", "--cues", none, "--cuts", "1,2", "--allow", "1-2"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(!notAnOption.test(r.stderr), r.stderr);
  }
  // --keep and --verbose take no value: what follows them is read as usual.
  assert.match(cli("plan", url, "--verbose", "--brand", kit, "--out", path.join(dir, "out")).stderr, /no brand\.json at/);
});

test("a look or a place named as one of JavaScript's own properties is refused", () => {
  const dir = tmp();
  const r = cli("plan", "https://acme-notes.example", "--out", path.join(dir, "out"), "--brand", fixture, "--words", path.join(fixture, "words.json"), "--look", "constructor");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, 'launch-film: --look "constructor": choose from launch, aurora, gridline, pop, journal\n');
  assert.deepEqual(fs.readdirSync(dir), []);
  const { parseTargets } = require("../src/stills");
  assert.throws(() => parseTargets("constructor"), /--for "constructor": choose from ph, og, x, play, chrome/);
  const { loadFilm } = require("../src/film");
  const { parseScene } = require("../src/scene");
  const file = path.join(dir, "film.json");
  fs.writeFileSync(file, JSON.stringify({ look: "toString", clips: [{ kind: "scene", seconds: 3, scene: { type: "headline", title: "A title" } }] }));
  assert.deepEqual(loadFilm(file).problems.filter((p) => !p.includes("clips[0].scene")), ['"look" must be one of launch, aurora, gridline, pop, journal']);
  assert.match(parseScene({ type: "constructor" }).problems[0], /^"type" must be one of/);
  assert.match(parseScene({ type: "headline", title: "A title", look: "valueOf" }).problems[0], /^"look" must be one of/);
  assert.match(parseScene({ type: "features", items: [{ icon: "constructor", title: "A" }, { icon: "constructor", title: "B" }] }).problems[0], /"constructor" is not an icon/);
});

test("doctor says when ffmpeg is older than 4.4, and passes a version it cannot read", { skip: process.platform === "win32" && "the stand-in ffmpeg is a shell script" }, () => {
  const dir = tmp();
  const doctor = (version) => {
    const ffmpeg = path.join(dir, `ffmpeg-${version}`);
    fs.writeFileSync(ffmpeg, `#!/bin/sh\necho 'ffmpeg version ${version} Copyright (c) 2000-2022 the FFmpeg developers'\n`, { mode: 0o755 });
    return spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "doctor"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  };
  const old = doctor("4.2.7-0ubuntu0.1");
  assert.match(old.stdout, /^ffmpeg {2}4\.2\.7-0ubuntu0\.1 \(4\.4 or newer is needed\)$/m);
  assert.equal(old.status, 1);
  for (const version of ["4.4.2-0ubuntu0.22.04.1", "n7.1", "N-112233-gabcdef0"]) assert.match(doctor(version).stdout, new RegExp(`^ffmpeg {2}${escape(version)}$`, "m"));
});
