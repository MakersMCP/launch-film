"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-"));
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
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-")), "kit");
  fs.cpSync(fixture, dir, { recursive: true });
  const kit = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "brand.json"), text || JSON.stringify({ ...kit, name: "Other Notes" }));
  return dir;
}

// A plan run on a film's folder that fails: the folder is as it was.
function planFails(args, said) {
  const dir = filmFolder();
  const before = snap(dir);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, ...args);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, said);
  assert.deepEqual(snap(dir), before);
}

test("a plan given another kit and a words.json that is not there leaves the folder as it was", () => {
  planFails(["--brand", otherKit(), "--words", path.join(os.tmpdir(), "launch-film-no-such-words.json")], /--words .*no-such-words\.json: no such file/);
});

test("a plan whose easybrandkit fails leaves the folder's kit as it was", () => {
  planFails(["--easybrandkit", failingEasybrandkit(fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-")))], /easybrandkit failed \(exit 1\): easybrandkit: Could not open the page/);
});

test("a plan whose easybrandkit fails leaves a kit that brand/ links to as it was", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  // brand/ links to a kit other films share.
  const dir = filmFolder();
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-")), "shared-kit");
  fs.renameSync(path.join(dir, "brand"), shared);
  fs.symlinkSync(shared, path.join(dir, "brand"));
  const [before, kit] = [snap(dir, { links: true }), snap(shared)];
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", failingEasybrandkit(fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-"))));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(snap(shared), kit);
  assert.deepEqual(snap(dir, { links: true }), before);
});

test("a plan given a kit that cannot be read leaves the folder's kit as it was", () => {
  planFails(["--brand", otherKit("{ this is not JSON")], /JSON/);
});

test("a plan that fails makes no folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-"));
  const r = cli("plan", "https://acme-notes.example", "--out", path.join(base, "films", "acme"), "--easybrandkit", failingEasybrandkit(base));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(fs.readdirSync(base), ["easybrandkit.js"]);
});

test("a Ctrl-C that ends ffprobe as launch-film waits on it is told of as a stop", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  // frames reads the film with ffprobe first. Ctrl-C reaches every process
  // of the group at once, so it ends ffprobe while launch-film waits on it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-cli-"));
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
