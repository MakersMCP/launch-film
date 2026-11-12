"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { easybrandkitCommands, runEasybrandkit } = require("../src/brand");

const { tmp, shortTmp } = require("./tmp");

// Runs fn with PATH set to dir alone and LAUNCH_FILM_EASYBRANDKIT unset.
async function withPath(dir, fn) {
  const saved = [process.env.LAUNCH_FILM_EASYBRANDKIT, process.env.PATH];
  delete process.env.LAUNCH_FILM_EASYBRANDKIT;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_EASYBRANDKIT;
    else process.env.LAUNCH_FILM_EASYBRANDKIT = saved[0];
    process.env.PATH = saved[1];
  }
}

// A stand-in for npx: it notes each package it is asked for in npx.log and
// runs the shell line given for that package ($3 is the URL, $5 the folder).
async function withFakeNpx(cases, fn) {
  const dir = tmp();
  const npx = path.join(dir, "npx");
  const lines = Object.entries(cases).map(([spec, line]) => `  "${spec}") ${line} ;;`);
  fs.writeFileSync(npx, ["#!/bin/sh", 'echo "$2" >> "$0.log"', 'case "$2" in', ...lines, "esac", ""].join("\n"), { mode: 0o755 });
  await withPath(dir, () => fn(dir, () => fs.readFileSync(`${npx}.log`, "utf8").trim().split("\n")));
}

const NOT_ON_NPM = 'echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/easybrandkit - Not found" >&2; exit 1';
const WRITES_KIT = '/bin/mkdir -p "$5" && echo "{}" > "$5/brand.json"';
const CANNOT_OPEN = 'echo "Opening $3..."; echo "easybrandkit: Could not open $3: net::ERR_NAME_NOT_RESOLVED" >&2; exit 1';
const noShell = process.platform === "win32" && "the stand-in npx is a shell script";

test("the easybrandkit to run: a script path, a command, one on PATH, else npm and then GitHub through npx", async () => {
  const dir = tmp();
  const script = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(script, "");
  assert.deepEqual(easybrandkitCommands(script), [[process.execPath, script]]);
  assert.deepEqual(easybrandkitCommands("my-easybrandkit --flag"), [["my-easybrandkit", "--flag"]]);
  await withPath(dir, () => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    assert.deepEqual(easybrandkitCommands(), [[npx, "-y", "easybrandkit@0.4.1"], [npx, "-y", "github:EminBudak/easybrandkit#v0.4.1"]]);
    const installed = path.join(dir, process.platform === "win32" ? "easybrandkit.cmd" : "easybrandkit");
    fs.writeFileSync(installed, "", { mode: 0o755 });
    assert.deepEqual(easybrandkitCommands(), [[installed]]);
  });
});

test("when npx cannot fetch easybrandkit from npm, it is fetched from GitHub", { skip: noShell }, async () => {
  await withFakeNpx({ "easybrandkit@0.4.1": NOT_ON_NPM, "github:EminBudak/easybrandkit#v0.4.1": WRITES_KIT }, async (dir, asked) => {
    assert.equal(await runEasybrandkit("https://example.com", path.join(dir, "out")), path.join(dir, "out", "brand.json"));
    assert.deepEqual(asked(), ["easybrandkit@0.4.1", "github:EminBudak/easybrandkit#v0.4.1"]);
  });
  await withFakeNpx({ "easybrandkit@0.4.1": NOT_ON_NPM, "github:EminBudak/easybrandkit#v0.4.1": NOT_ON_NPM }, async (dir) => {
    await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out")), /could not be fetched \(npm error code E404\)\. Install easybrandkit \(npm install -g easybrandkit\)/);
  });
});

test("an easybrandkit that ran and failed is not run again", { skip: noShell }, async () => {
  await withFakeNpx({ "easybrandkit@0.4.1": CANNOT_OPEN, "github:EminBudak/easybrandkit#v0.4.1": WRITES_KIT }, async (dir, asked) => {
    await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out")), /easybrandkit failed \(exit 1\).*Could not open https:\/\/example\.com/);
    assert.deepEqual(asked(), ["easybrandkit@0.4.1"]);
  });
});

// npx prints npm's notice that a newer npm is out as it ends, the first
// time it runs in a new npm home, after what easybrandkit said. All of it
// goes to stderr here, so that the lines come in the order they are written.
test("npm's notices and warnings are not given as the reason easybrandkit failed", { skip: noShell }, async () => {
  const notice = ["npm notice", "npm notice New major version of npm available! 10.9.9 -> 12.2.2", "npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2",
    "npm notice To update run: npm install -g npm@12.2.2", "npm notice"].map((line) => `echo "${line}" >&2`).join("; ");
  const fails = `echo "npm warn exec The following package was not found and will be installed: easybrandkit@0.4.1" >&2; echo "Opening $3..." >&2; ` +
    `echo "easybrandkit: Could not open $3: net::ERR_CONNECTION_REFUSED" >&2; ${notice}; exit 1`;
  await withFakeNpx({ "easybrandkit@0.4.1": fails }, async (dir) => {
    await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out")),
      { message: "easybrandkit failed (exit 1): Opening https://example.com... easybrandkit: Could not open https://example.com: net::ERR_CONNECTION_REFUSED" });
  });
});

test("a bot check says what to do instead", async () => {
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, 'process.stderr.write("https://example.com answered with a bot check, so no kit was saved.\\n"); process.exit(1);');
  await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out"), { command: fake }), /bot check.*ask for the logo file and the main colors/);
});

test("an easybrandkit that writes brand.json resolves its path", async () => {
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + "/brand.json", "{}");');
  assert.equal(await runEasybrandkit("https://example.com", path.join(dir, "out"), { command: fake }), path.join(dir, "out", "brand.json"));
});

// Run as on Windows, in a process of its own: what easybrandkitCommands
// answers with `dir` as the whole of PATH.
function commandsOnWindows(dir) {
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  const env = { ...process.env, PATH: dir };
  delete env.LAUNCH_FILM_EASYBRANDKIT;
  const r = spawnSync(process.execPath, ["-e", `Object.defineProperty(process, "platform", { value: "win32" }); process.stdout.write(JSON.stringify(require(${brand}).easybrandkitCommands()));`], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("on Windows the script behind npx.cmd and easybrandkit.cmd is run with Node, as Node starts no .cmd file without a shell", () => {
  const dir = tmp();
  const put = (rel, text = "") => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
    return file;
  };
  assert.deepEqual(commandsOnWindows(dir), [["npx.cmd", "-y", "easybrandkit@0.4.1"], ["npx.cmd", "-y", "github:EminBudak/easybrandkit#v0.4.1"]]);
  put("npx.cmd");
  const cli = put(path.join("node_modules", "npm", "bin", "npx-cli.js"));
  assert.deepEqual(commandsOnWindows(dir), [[process.execPath, cli, "-y", "easybrandkit@0.4.1"], [process.execPath, cli, "-y", "github:EminBudak/easybrandkit#v0.4.1"]]);
  const installed = put("easybrandkit.cmd");
  assert.deepEqual(commandsOnWindows(dir), [[installed]]);
  put(path.join("node_modules", "easybrandkit", "package.json"), JSON.stringify({ bin: { easybrandkit: "skills/easybrandkit/scripts/easybrandkit.js" } }));
  const script = put(path.join("node_modules", "easybrandkit", "skills", "easybrandkit", "scripts", "easybrandkit.js"));
  assert.deepEqual(commandsOnWindows(dir), [[process.execPath, script]]);
});

test("an easybrandkit Node refuses to start is told of with what to do", () => {
  // Node throws for a .cmd file on Windows, where a missing command is an event.
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  const r = spawnSync(process.execPath, ["-e", `require("child_process").spawn = () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); };
require(${brand}).runEasybrandkit("https://example.com", process.argv[1], { command: "some.cmd" }).catch((e) => process.stdout.write(e.message));`, tmp()], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^easybrandkit could not be started \(spawn EINVAL\)\. Install easybrandkit/);
});

test("easybrandkit's temp files go with a temp folder of the run's own, on Linux", { skip: process.platform !== "linux" && "the temp folder is left as it is elsewhere" }, async () => {
  // It leaves a folder in its temp folder, as a Chrome stopped as it starts
  // does.
  const temp = shortTmp();
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, `const fs = require("fs"); const os = require("os"); const path = require("path");
fs.mkdirSync(path.join(os.tmpdir(), "com.google.Chrome.chrome_chrome_url_fetcher_.AbCdEf"));
fs.writeFileSync(process.env.SAW, os.tmpdir());
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/brand.json", "{}");`);
  const saw = path.join(dir, "saw");
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  // The stand-ins easybrandkit's Chrome gets (chrome.js) stay for the run.
  const r = spawnSync(process.execPath, ["-e", `require(${brand}).runEasybrandkit("https://example.com", process.argv[1], { command: process.argv[2] }).then(() => process.stdout.write(String(require("fs").readdirSync(require("os").tmpdir()).filter((n) => !n.startsWith("launch-film-bin-")).length)));`, path.join(dir, "out"), fake],
    { encoding: "utf8", env: { ...process.env, TMPDIR: temp, SAW: saw } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0", "it goes as soon as easybrandkit has ended");
  assert.match(path.basename(fs.readFileSync(saw, "utf8")), /^launch-film-brand-\d+-/);
  assert.deepEqual(fs.readdirSync(temp), [], "nothing is left in the temp folder");
});

test("a temp folder too long for Chrome's socket is not given", { skip: process.platform !== "linux" && "the temp folder is left as it is elsewhere" }, () => {
  const { tempEnv } = require("../src/out");
  const room = 107 - "/com.google.Chrome.XXXXXX/SingletonSocket".length;
  assert.equal(tempEnv("/".padEnd(room, "x")).TMPDIR, "/".padEnd(room, "x"));
  assert.equal(tempEnv("/".padEnd(room + 1, "x")).TMPDIR, process.env.TMPDIR);
  // A socket's path is counted in bytes: é takes two.
  assert.equal(tempEnv(`${"/".padEnd(room - 1, "x")}é`).TMPDIR, process.env.TMPDIR);
  assert.equal(tempEnv(null).TMPDIR, process.env.TMPDIR);
});

// easybrandkit starts a Chrome of its own with its own environment, so
// the stand-ins that keep a page from starting a program (chrome.js) reach
// that Chrome through easybrandkit's PATH, the rest of PATH as it was.
test("easybrandkit runs with the stand-ins for xdg-open and the like first on its PATH, on Linux", { skip: process.platform !== "linux" && "the stand-ins are Linux's" }, async () => {
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  const saw = path.join(dir, "path");
  fs.writeFileSync(fake, `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(saw)}, process.env.PATH);
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/brand.json", "{}");`);
  await runEasybrandkit("https://example.com", path.join(dir, "out"), { command: fake });
  const [first, ...rest] = fs.readFileSync(saw, "utf8").split(path.delimiter);
  assert.match(path.basename(first), /^launch-film-bin-\d+-/);
  assert.equal(rest.join(path.delimiter), process.env.PATH);
  const { OPENERS } = require("../src/chrome");
  for (const name of OPENERS) {
    const r = spawnSync(path.join(first, name), ["mailto:hello@acme-notes.example"], { encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], name);
  }
});

// The Chrome of easybrandkit 0.4.0 and older, which one on PATH can still
// be, saves a file a page makes it download into the
// Downloads folder of the user it runs as, where nothing removes it. This
// stand-in starts the machine's Chrome as easybrandkit does, with the
// environment it was given, on a page that makes it save one.
test("a file easybrandkit's Chrome is made to save goes in the run's temp folder, and with it, on Linux", { skip: (process.platform !== "linux" && "XDG_CONFIG_HOME is Linux's") || (!require("../src/chrome").findChrome() && "Chrome not found"), timeout: 120_000 }, async () => {
  const http = require("http");
  const dir = tmp();
  // Made when Chrome asks for the file.
  const asked = path.join(dir, "asked");
  const server = http.createServer((req, res) => {
    if (req.url === "/file.bin") {
      fs.writeFileSync(asked, "");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="planted.desktop"' });
      return res.end("[Desktop Entry]\n");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>Acme</title><h1>Acme</h1><script>addEventListener("load", () => (location.href = "/file.bin"));</script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, `const fs = require("fs"); const os = require("os"); const path = require("path");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fake-easybrandkit-"));
const chrome = require("child_process").spawn(${JSON.stringify(require("../src/chrome").findChrome())}, ["--headless=new", "--no-first-run", "--user-data-dir=" + profile, process.argv[2]], { stdio: "ignore" });
// Once Chrome has had the file, and a moment to save it.
const since = Date.now();
const wait = setInterval(() => {
  if (!fs.existsSync(process.env.ASKED) && Date.now() - since < 60000) return;
  clearInterval(wait);
  setTimeout(() => {
    chrome.kill("SIGKILL");
    const out = process.argv[process.argv.indexOf("--out") + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(out + "/brand.json", "{}");
  }, 3000);
}, 100);`);
  const home = tmp();
  const temp = shortTmp();
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  try {
    const r = await new Promise((resolve) => {
      const child = require("child_process").spawn(process.execPath, ["-e", `require(${brand}).runEasybrandkit(process.argv[1], process.argv[2], { command: process.argv[3] }).then(() => console.log("ran"), (e) => console.log(e.message))`,
        `http://127.0.0.1:${server.address().port}/`, path.join(dir, "out"), fake], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, TMPDIR: temp, ASKED: asked } });
      let said = "";
      child.stdout.on("data", (d) => (said += d));
      child.stderr.on("data", (d) => (said += d));
      child.on("close", (code) => resolve({ code, said }));
    });
    assert.equal(r.code, 0, r.said);
    assert.equal(r.said.trim(), "ran");
    assert.ok(fs.existsSync(asked), "Chrome was not sent to the file");
    assert.ok(!fs.existsSync(path.join(home, "Downloads")), "Chrome saved the file in HOME/Downloads");
    assert.deepEqual(fs.readdirSync(temp), [], "the run's temp folder, with the file, is gone");
  } finally {
    server.close();
  }
});

// easybrandkit's Chrome reads the site, and on a Linux desktop would hand a
// mailto: address to the desktop's portal over the session bus, which opens
// the mail program, past the stand-ins on PATH. easybrandkit is given a bus
// that leads nowhere, a socket in the run's temp folder that is never made,
// the stand-ins and no display (as its Wayland display, a path there that
// is never made), all of which the Chrome it starts takes from it. This
// stand-in writes down what it was given.
test("easybrandkit gets a session bus that leads nowhere, the stand-ins first on its PATH and no display, on Linux", { skip: process.platform !== "linux" && "the session bus and the stand-ins are Linux's" }, async () => {
  const dir = tmp();
  // A desktop's bus, a socket that is there.
  const desktop = path.join(dir, "desktop-bus");
  const listening = require("net").createServer().listen(desktop);
  await new Promise((resolve) => listening.once("listening", resolve));
  const seen = path.join(dir, "seen.json");
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, `const fs = require("fs"); const path = require("path");
const bus = (process.env.DBUS_SESSION_BUS_ADDRESS || "").replace(/^unix:path=/, "");
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ address: process.env.DBUS_SESSION_BUS_ADDRESS, there: fs.existsSync(bus), display: process.env.DISPLAY || null, wayland: process.env.WAYLAND_DISPLAY || null,
  made: fs.existsSync(process.env.WAYLAND_DISPLAY || ""), socket: process.env.WAYLAND_SOCKET || null, first: process.env.PATH.split(path.delimiter)[0] }));
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "brand.json"), "{}");`);
  const temp = tmp();
  try {
    const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "..", "src", "brand.js"))}).runEasybrandkit("https://acme.example/", process.argv[1], { command: process.argv[2] }).then(() => console.log("ran"), (e) => console.log(e.message))`, path.join(dir, "out"), fake],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: temp, DBUS_SESSION_BUS_ADDRESS: `unix:path=${desktop}`, DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-99", WAYLAND_SOCKET: "9" } });
    assert.equal(r.stdout, "ran\n", r.stderr);
    const got = JSON.parse(fs.readFileSync(seen, "utf8"));
    const folder = /^unix:path=(.+)\/no-bus$/.exec(got.address);
    assert.ok(folder, got.address);
    assert.equal(path.dirname(folder[1]), temp);
    assert.match(path.basename(folder[1]), /^launch-film-brand-/);
    assert.equal(got.there, false, "the bus easybrandkit was given leads somewhere");
    assert.deepEqual([got.display, got.wayland, got.made, got.socket], [null, path.join(folder[1], "no-display"), false, null]);
    assert.match(path.basename(got.first), /^launch-film-bin-/, "the stand-ins are not first on PATH");
    assert.deepEqual(fs.readdirSync(temp), [], "left in the temp folder");
  } finally {
    listening.close();
  }
});
