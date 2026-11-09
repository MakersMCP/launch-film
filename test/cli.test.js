"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { tmp, shortTmp } = require("./tmp");

const root = path.join(__dirname, "..");
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 30_000 });

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
  fs.rmSync(path.join(profile, "SingletonSocket"));
  fs.rmSync(sock, { recursive: true });
  setTimeout(() => process.exit(0), 200);
});
fs.writeFileSync(process.env.STAND_IN_PID, String(process.pid));
setInterval(() => {}, 1000);
`);
  const kit = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(kit, `
const fs = require("fs");
const os = require("os");
const path = require("path");
const profile = process.env.STAND_IN_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-chrome-"));
require("child_process").spawn(process.execPath, [${JSON.stringify(chrome)}, "--headless=new", "--user-data-dir=" + profile], { stdio: "ignore" });
setInterval(() => {}, 1000);
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

test("an option a command does not take is refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const url = "https://acme-notes.example";
  const out = path.join(dir, "out");
  for (const [args, said] of [
    [["check", "film.mp4", "--outt", out], "--outt is not an option of launch-film check. Run launch-film --help."],
    [["render", film, "--music", "track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["plan", url, "--out", out, "--music=track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["render", film, "--no-music"], '--no-music is for a plan: a render plays what "music" in film.json says. Set it to false there and render again'],
    [["render", film, "--no-sfx"], '--no-sfx is for a plan: a render plays what "sfx" in film.json says. Set it to false there and render again'],
    [["render", film, "--out", out], "--out is not an option of launch-film render. Run launch-film --help."],
    [["plan", url, "--out", out, "--jobs", "1"], "--jobs is not an option of launch-film plan. Run launch-film --help."],
    [["frames", "film.mp4", "--for", "og"], "--for is not an option of launch-film frames. Run launch-film --help."],
    [["stills", film, "--look", "pop"], "--look is not an option of launch-film stills <film.json>. Run launch-film --help."],
    [[url, "--out", out, "--output", path.join(dir, "movie.mp4")], "--output is not an option of launch-film <url>. Run launch-film --help."],
    [["looks", "--everything"], "--everything is not an option of launch-film looks. Run launch-film --help."],
    [["plan", url, "--out", out, "--__proto__", "x"], "--__proto__ is not an option of launch-film plan. Run launch-film --help."],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, `launch-film: ${said}\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("every option a command takes gets past the refusal, also as makersmcp gives them", () => {
  const dir = tmp();
  const none = path.join(dir, "none.json");
  const notAnOption = /is not an option|is for a plan/;
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
