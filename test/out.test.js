"use strict";
// The out folder (src/out.js), with plain files: a run that ends well puts
// its files in place, one that fails or is stopped leaves the folder as it
// was.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const out = require("../src/out");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-out-"));
const noSignals = process.platform === "win32" && "POSIX signals";
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Files and folders as { "a/b.txt": content, "a/": "folder" }, hidden ones too.
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}
function snap(dir) {
  const seen = {};
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const s = fs.lstatSync(file);
      if (s.isSymbolicLink()) seen[key] = `link to ${fs.readlinkSync(file)}`;
      else if (s.isDirectory()) {
        seen[`${key}/`] = "folder";
        walk(file, key);
      } else seen[key] = fs.readFileSync(file, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return seen;
}
const EARLIER = { "film.mp4": "old film", "notes.txt": "mine", "frames/clip-1-a.jpg": "old 1", "frames/clip-7-a.jpg": "old 7", "brand/brand.json": "old kit", "brand/logo-01.png": "old logo" };

// Writes a new film, a frame and a brand kit, with a work file and a file
// it does not name as an output.
function make(run) {
  fs.writeFileSync(run.out("film.mp4"), "new film");
  fs.mkdirSync(run.out("frames"));
  fs.writeFileSync(path.join(run.part, "frames", "clip-1-a.jpg"), "new 1");
  fs.mkdirSync(run.folder("brand"));
  fs.writeFileSync(path.join(run.part, "brand", "brand.json"), "new kit");
  fs.writeFileSync(path.join(run.part, ".scan-video.txt"), "work");
  fs.writeFileSync(path.join(run.part, "stray.txt"), "not an output");
}

test("a run that ends well replaces its files and keeps the others", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  assert.equal(await out.within(dir, async (run) => (make(run), 7)), 7);
  assert.deepEqual(snap(dir), {
    "brand/": "folder", "brand/brand.json": "new kit",
    "film.mp4": "new film",
    "frames/": "folder", "frames/clip-1-a.jpg": "new 1", "frames/clip-7-a.jpg": "old 7",
    "notes.txt": "mine",
  });
});

test("a run that makes its folder puts it there whole, or makes nothing", async () => {
  const base = tmp();
  const dir = path.join(base, "films", "acme");
  await out.within(dir, async (run) => make(run));
  assert.deepEqual(Object.keys(snap(base)), ["films/", "films/acme/", "films/acme/brand/", "films/acme/brand/brand.json", "films/acme/film.mp4", "films/acme/frames/", "films/acme/frames/clip-1-a.jpg"]);
  const other = path.join(base, "new", "deep", "film");
  await assert.rejects(out.within(other, async (run) => {
    make(run);
    throw new Error("the render failed");
  }), /the render failed/);
  assert.ok(!fs.existsSync(path.join(base, "new")), "the folders made for it are gone");
});

test("a run that fails leaves the folder exactly as it was", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  await assert.rejects(out.within(dir, async (run) => {
    make(run);
    throw new Error("ffmpeg failed");
  }), /ffmpeg failed/);
  assert.deepEqual(snap(dir), before);
});

// fs.renameSync failing on the calls given, as a file held open would.
async function withRenameFailing(calls, fn) {
  const real = fs.renameSync;
  let n = 0;
  fs.renameSync = (from, to) => {
    n++;
    if (calls.includes(n)) throw Object.assign(new Error("i/o error"), { code: "EIO" });
    return real(from, to);
  };
  try {
    return await fn();
  } finally {
    fs.renameSync = real;
  }
}

test("a commit that cannot finish puts every earlier file back", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  // The outputs go in the order they were named: film.mp4 aside, the new
  // one in, then the third move, the earlier frame aside, fails.
  await withRenameFailing([3], () => assert.rejects(out.within(dir, async (run) => make(run)),
    /^Error: could not put the new files in .*: .*frames\/clip-1-a\.jpg: i\/o error\. .* is as it was\.$/));
  assert.deepEqual(snap(dir), before);
});

test("a commit whose undo fails too keeps the earlier files in a folder of its own", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  // The third move fails, and so does putting the earlier film.mp4 back
  // (the fifth: the new film.mp4 out again, then the earlier one in).
  const err = await withRenameFailing([3, 5], () => out.within(dir, async (run) => make(run)).catch((e) => e));
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1);
  assert.match(err.message, new RegExp(`Some of the earlier files could not be put back; they are in .*${kept[0]}\\.$`));
  const inKept = snap(path.join(dir, kept[0]));
  assert.equal(inKept[".old/film.mp4"], "old film");
  assert.match(inKept["launch-film-kept.txt"], new RegExp(`^launch-film could not put these earlier files back in ${escape(dir)}:\n {2}film\.mp4\nThey are in \.old here, each by its path from ${escape(dir)}\.`));
  // The rest is as it was.
  assert.ok(!fs.existsSync(path.join(dir, "film.mp4")));
  assert.equal(fs.readFileSync(path.join(dir, "frames", "clip-1-a.jpg"), "utf8"), "old 1");
  assert.equal(fs.readFileSync(path.join(dir, "brand", "brand.json"), "utf8"), "old kit");
});

test("a commit whose undo fails and whose folder cannot be kept by name says where the earlier files really are", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  // As above, and renaming the part folder to keep it fails too (the sixth).
  const err = await withRenameFailing([3, 5, 6], () => out.within(dir, async (run) => make(run)).catch((e) => e));
  const parts = fs.readdirSync(dir).filter((n) => n.startsWith(".launch-film-part-"));
  assert.equal(parts.length, 1);
  assert.ok(err.message.endsWith(`Some of the earlier files could not be put back; they are in ${path.join(dir, parts[0])}.`), err.message);
  assert.equal(fs.readFileSync(path.join(dir, parts[0], ".old", "film.mp4"), "utf8"), "old film");
  // A later run that ends well there keeps that folder for them.
  age(path.join(dir, parts[0]));
  await out.within(dir, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a later check"));
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0], ".old", "film.mp4"), "utf8"), "old film");
  out.noticed();
});

// Every file and folder in `at` made `minutes` older, as a part folder left
// that long ago.
function age(at, minutes = 20) {
  const when = Date.now() / 1000 - minutes * 60;
  for (const e of fs.readdirSync(at, { withFileTypes: true })) {
    if (e.isDirectory()) age(path.join(at, e.name), minutes);
    else fs.utimesSync(path.join(at, e.name), when, when);
  }
  fs.utimesSync(at, when, when);
}

// A run killed outright (SIGKILL) as it makes its `kill`th move while it
// puts a new film.mp4 in `dir`; with `made`, `dir` is made, with an earlier
// film in it, while the run works, as by another run.
function killedInCommit(dir, kill, made = false) {
  const script = `
const fs = require("fs");
const path = require("path");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [dir, kill, made] = process.argv.slice(1);
const real = fs.renameSync;
let n = 0;
fs.renameSync = (from, to) => {
  if (++n === Number(kill)) process.kill(process.pid, "SIGKILL");
  return real(from, to);
};
out.within(dir, async (run) => {
  fs.writeFileSync(run.out("film.mp4"), "new film");
  if (made === "made") {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "film.mp4"), "old film");
  }
});
`;
  const r = spawnSync(process.execPath, ["-e", script, dir, String(kill), made ? "made" : ""], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.signal, "SIGKILL", r.stderr);
}

test("a part folder left by a run killed while it put its files in place keeps the earlier files it had moved aside", async () => {
  // Killed between moving the earlier film.mp4 aside (the first move) and
  // moving the new one in (the second).
  const dir = tmp();
  write(dir, { "film.mp4": "old film" });
  killedInCommit(dir, 2);
  const left = fs.readdirSync(dir).filter((n) => n.startsWith(".launch-film-part-"));
  assert.equal(left.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, "film.mp4")));
  age(path.join(dir, left[0]));
  // A later run that ends well there, 20 minutes on, keeps it for them.
  await out.within(dir, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a later check"));
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1, fs.readdirSync(dir).join(", "));
  assert.equal(fs.readFileSync(path.join(dir, kept[0], ".old", "film.mp4"), "utf8"), "old film");
  const note = fs.readFileSync(path.join(dir, kept[0], "launch-film-kept.txt"), "utf8");
  assert.match(note, new RegExp(`^A launch-film run \\(process \\d+\\) was killed while it put its files in place in ${escape(dir)}, and left these earlier files it had moved aside:\n {2}film\.mp4\n`));
  assert.deepEqual(out.noticed(), [`a launch-film run killed while it put its files in ${dir} left earlier files in ${path.join(dir, kept[0])}; launch-film-kept.txt there lists them`]);
  assert.equal(fs.readFileSync(path.join(dir, "CHECK.md"), "utf8"), "a later check");
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(".launch-film-")), "no part folder or lock is left");
});

test("a run whose folder was made while it worked puts the earlier files aside in that folder", async () => {
  // Its part folder is next to the folder; the earlier film, which another
  // run put there meanwhile, goes aside in a part folder in the folder, so a
  // kill between the two moves leaves it where a later run there finds it.
  const base = tmp();
  const dir = path.join(base, "film");
  killedInCommit(dir, 2, true);
  const inside = fs.readdirSync(dir).filter((n) => n.startsWith(".launch-film-part-"));
  assert.equal(inside.length, 1, fs.readdirSync(dir).join(", "));
  assert.equal(fs.readFileSync(path.join(dir, inside[0], ".old", "film.mp4"), "utf8"), "old film");
  for (const n of fs.readdirSync(base)) if (n.startsWith(".launch-film-part-")) age(path.join(base, n));
  age(path.join(dir, inside[0]));
  await out.within(dir, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a later check"));
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(dir, kept[0], "launch-film-kept.txt"), "utf8"), new RegExp(`in place in ${escape(dir)}, and left`));
  assert.deepEqual(fs.readdirSync(base), ["film"], "the run's own part folder next to it is gone");
  out.noticed();
});

test("a run inside another's part folder goes in with it, or not at all", async () => {
  for (const ends of ["well", "badly"]) {
    const dir = tmp();
    write(dir, EARLIER);
    const before = snap(dir);
    const run = out.begin(dir);
    fs.writeFileSync(run.out("film.json"), "plan");
    // The render and the frames, as the one-go command makes them.
    await out.within(run.part, async (r) => fs.writeFileSync(r.out("film.mp4"), "new film"));
    await out.within(path.join(run.part, "frames"), async (r) => fs.writeFileSync(r.out("clip-2-a.jpg"), "new 2"));
    assert.equal(out.shown(path.join(run.part, "frames", "clip-2-a.jpg")), path.join(dir, "frames", "clip-2-a.jpg"));
    if (ends === "badly") {
      run.discard();
      assert.deepEqual(snap(dir), before);
      continue;
    }
    run.commit();
    assert.deepEqual(snap(dir), { ...before, "film.json": "plan", "film.mp4": "new film", "frames/clip-2-a.jpg": "new 2" });
  }
});

test("a part folder left by a run killed outright goes when a later run ends well", async () => {
  const dir = tmp();
  // A process that has ended, for a pid no process has.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const old = Date.now() / 1000 - 20 * 60;
  const left = (name, { pid, age }) => {
    const at = path.join(dir, `.launch-film-part-${pid}-${name}`);
    write(at, { "film.mp4": "half a film" });
    if (age) for (const p of [path.join(at, "film.mp4"), at]) fs.utimesSync(p, old, old);
    return at;
  };
  const stale = left("aaaaaaaa", { pid: gone, age: true });
  const fresh = left("bbbbbbbb", { pid: gone, age: false });
  const alive = left("cccccccc", { pid: process.ppid, age: true });
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.ok(!fs.existsSync(stale), "the stale one is gone");
  assert.ok(fs.existsSync(fresh), "one changed in the last 15 minutes stays");
  assert.ok(fs.existsSync(alive), "one whose process runs stays");
});

// A CLI-like process: it listens for signals, begins a run in `dir` and
// writes into it, starts a child it tracks, says "ready" and waits.
const RUNNER = `
const fs = require("fs");
const { spawn } = require("child_process");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [dir, how] = process.argv.slice(1);
out.listen();
// The child says "on" once it listens; a stubborn one lets SIGTERM go.
const child = out.track(spawn(process.execPath, ["-e", (how === "stubborn" ? 'process.on("SIGTERM", () => {}); ' : "") + 'process.stdout.write("on"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "ignore"] }));
child.stdout.once("data", () => {
  if (how === "fails") {
    // The run waits on its child, and fails when the stop ends it, as a
    // render does when its ffmpeg is stopped; the CLI then says nothing more.
    out.within(dir, async (run) => {
      fs.writeFileSync(run.out("film.mp4"), "new film");
      process.stdout.write(\`ready \${child.pid}\\n\`);
      await new Promise((resolve, reject) => child.on("exit", () => reject(new Error("ffmpeg stopped"))));
    }).catch(() => out.stopping() || process.exit(1));
    return;
  }
  const run = out.begin(dir);
  fs.writeFileSync(run.out("film.mp4"), "new film");
  process.stdout.write(\`ready \${child.pid}\\n\`);
  if (how === "exit") process.exit(1);
});
setInterval(() => {}, 1000);
`;

function runner(dir, how) {
  const child = spawn(process.execPath, ["-e", RUNNER, dir, how], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ready = new Promise((resolve) => child.stdout.on("data", (d) => /ready (\d+)/.test(String(d)) && resolve(Number(/ready (\d+)/.exec(String(d))[1]))));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, ready, ended };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // One that has ended stays a zombie where nothing reaps it, as in a
  // container whose first process is not an init.
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};
// Whether it is gone within a second: one killed outright as the run ends
// takes a moment to be gone on a loaded machine.
async function gone(pid) {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
}

test("a run stopped by SIGTERM removes what it built, stops its child and ends by the signal", { skip: noSignals }, async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  const r = runner(dir, "plain");
  const pid = await r.ready;
  r.child.kill("SIGTERM");
  const { signal, stderr } = await r.ended;
  assert.equal(signal, "SIGTERM");
  assert.match(stderr, new RegExp(`^launch-film: stopped, so ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is as it was\\n$`));
  assert.deepEqual(snap(dir), before);
  assert.ok(await gone(pid), "the child is gone");
});

test("a run that fails as the stop ends its child is told of as stopped", { skip: noSignals }, async () => {
  const base = tmp();
  const dir = path.join(base, "film");
  const r = runner(dir, "fails");
  await r.ready;
  r.child.kill("SIGINT");
  const { signal, stderr } = await r.ended;
  assert.equal(signal, "SIGINT");
  assert.equal(stderr, `launch-film: stopped, so ${dir} was not made\n`);
  assert.deepEqual(fs.readdirSync(base), []);
});

test("a second SIGTERM during the clean-up does not cut it short", { skip: noSignals }, async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  // The child lets SIGTERM go, so the clean-up waits for it, then kills it.
  const r = runner(dir, "stubborn");
  const pid = await r.ready;
  r.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  r.child.kill("SIGTERM");
  const { signal } = await r.ended;
  assert.equal(signal, "SIGTERM");
  assert.deepEqual(snap(dir), before);
  assert.ok(await gone(pid), "the child is gone");
});

test("a run cut short by process.exit leaves the folder as it was", { skip: noSignals }, async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  const r = runner(dir, "exit");
  const pid = await r.ready;
  const { code } = await r.ended;
  assert.equal(code, 1);
  assert.deepEqual(snap(dir), before);
  assert.ok(await gone(pid), "the child is gone");
});

test("a failed run ends once its processes have stopped, and their temp folder goes with them", { skip: noSignals }, async () => {
  // A child that has a helper writing into its temp folder, as Chrome's
  // write into its profile: asked to stop, it stops its helper first;
  // killed outright, its helper writes on for a while.
  const script = `
const { spawn } = require("child_process");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const dir = out.tempDir("launch-film-out-test-");
const helper = 'const fs = require("fs"); setInterval(() => { fs.mkdirSync(process.argv[1], { recursive: true }); fs.writeFileSync(process.argv[1] + "/state", "on"); }, 20); setTimeout(() => process.exit(0), 3000);';
const browser = 'const h = require("child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" }); process.on("SIGTERM", () => { h.kill("SIGKILL"); process.exit(0); }); process.stdout.write("on"); setInterval(() => {}, 1000);';
const child = out.track(spawn(process.execPath, ["-e", browser, helper, dir], { stdio: ["ignore", "pipe", "ignore"] }));
child.stdout.once("data", () => {
  process.stdout.write(dir);
  setTimeout(() => out.exit(1), 100);
});
setInterval(() => {}, 1000);
`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stderr);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(r.stdout && !fs.existsSync(r.stdout), `${r.stdout} is gone and nothing writes to it again`);
});

test("a folder whose drive is not there is refused at once", () => {
  // As on Windows, where a drive that is not there has no root either: no
  // folder exists and none can be made. Run on its own, with little memory,
  // so a run that looks for a folder above the root forever ends soon.
  const script = `
const fs = require("fs");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
fs.existsSync = () => false;
fs.mkdirSync = (at) => { throw Object.assign(new Error("ENOENT: no such file or directory, mkdir '" + at + "'"), { code: "ENOENT" }); };
try {
  out.begin("/no-such-drive/films/acme");
} catch (err) {
  process.stdout.write(err.message);
}`;
  const r = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, `ended by ${r.signal || r.status}: ${String(r.stderr).slice(-300)}`);
  assert.match(r.stdout, /^ENOENT: no such file or directory, mkdir '.*no-such-drive[\\/]films'$/);
});

test("a temp folder is named for its process and goes with release", () => {
  const dir = out.tempDir("launch-film-out-test-");
  assert.match(path.basename(dir), new RegExp(`^launch-film-out-test-${process.pid}-`));
  out.release(dir);
  assert.ok(!fs.existsSync(dir));
});

test("a temp folder's own clean-up runs before it goes, on a stop too", { skip: noSignals }, async () => {
  // As Chrome's profile takes the socket folder Chrome links from it: the
  // clean-up reads what is in the folder, so it runs before the folder goes.
  const base = tmp();
  const script = `
const fs = require("fs");
const path = require("path");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
out.listen();
const outside = path.join(process.argv[1], "outside");
fs.mkdirSync(outside);
const dir = out.tempDir("launch-film-out-test-", (d) => fs.rmSync(fs.readFileSync(path.join(d, "points-to"), "utf8"), { recursive: true }));
fs.writeFileSync(path.join(dir, "points-to"), outside);
process.stdout.write(dir);
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ["-e", script, base], { stdio: ["ignore", "pipe", "pipe"] });
  const dir = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(String(d))));
  assert.ok(fs.existsSync(path.join(base, "outside")));
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(!fs.existsSync(dir), "the temp folder is gone");
  assert.deepEqual(fs.readdirSync(base), [], "and what its clean-up removes");
});

// Two processes that put a film, a brand kit (replaced whole) and frames
// (merged) in one folder at the same moment, `trials` times over: what each
// says, and what the folder holds after both.
const RACER = `
const fs = require("fs");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [dir, me, at] = process.argv.slice(1);
out.within(dir, async (run) => {
  fs.writeFileSync(run.out("film.mp4"), me);
  fs.mkdirSync(run.folder("brand"));
  for (const n of ["brand.json", "logo.png"]) fs.writeFileSync(run.part + "/brand/" + n, me);
  fs.mkdirSync(run.out("frames"));
  for (const n of ["1", "2"]) fs.writeFileSync(run.part + "/frames/" + n + ".jpg", me);
  while (Date.now() < Number(at)) {}
}).then(() => process.exit(0), (err) => { process.stderr.write(err.message); process.exit(1); });
`;
function racer(dir, me, at) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", RACER, dir, me, String(at)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("two runs that put their files in one folder at once take turns", async () => {
  for (let t = 0; t < 16; t++) {
    const dir = tmp();
    write(dir, { "film.mp4": "O", "brand/brand.json": "O", "brand/logo.png": "O", "frames/1.jpg": "O" });
    const at = Date.now() + 400;
    const [x, y] = await Promise.all([racer(dir, "X", at), racer(dir, "Y", at)]);
    assert.deepEqual([x, y].map((r) => r.code), [0, 0], `trial ${t}: ${x.stderr} ${y.stderr}`);
    // The one that went second replaced the other's files, every one.
    const s = snap(dir);
    const last = s["film.mp4"];
    assert.deepEqual(s, { "brand/": "folder", "brand/brand.json": last, "brand/logo.png": last, "film.mp4": last, "frames/": "folder", "frames/1.jpg": last, "frames/2.jpg": last }, `trial ${t}`);
  }
});

test("a commit waits for a run that holds the folder, and takes over from one that is gone", async () => {
  const dir = tmp();
  write(dir, { "film.mp4": "old film" });
  // Held by a process that has ended: taken over at once.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  write(dir, { [`${out.LOCK}/pid`]: gone });
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.deepEqual(snap(dir), { "film.mp4": "new film" });
  // Held by a process that runs: the commit waits for it to let go.
  const holder = spawn(process.execPath, ["-e", `
const fs = require("fs");
fs.mkdirSync(process.argv[1]);
fs.writeFileSync(process.argv[1] + "/pid", String(process.pid));
process.stdout.write("held");
setTimeout(() => { fs.rmSync(process.argv[1], { recursive: true }); process.exit(0); }, 700);`, path.join(dir, out.LOCK)], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const started = Date.now();
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "newer film"));
  assert.ok(Date.now() - started >= 400, `waited ${Date.now() - started} ms`);
  assert.deepEqual(snap(dir), { "film.mp4": "newer film" });
});

// A lock as a process killed outright leaves it: holding `pid`, made `age`
// ms ago.
function leftLock(dir, pid, age = 0) {
  write(dir, { [`${out.LOCK}/pid`]: String(pid) });
  const when = (Date.now() - age) / 1000;
  fs.utimesSync(path.join(dir, out.LOCK), when, when);
}

test("a lock whose pid is in use again is taken over: this process's own, a process started after it, or a lock a minute old", async (t) => {
  const quick = async (dir, what) => {
    const started = Date.now();
    await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
    assert.ok(Date.now() - started < 2000, `${what}: waited ${Date.now() - started} ms`);
    assert.deepEqual(snap(dir), { "film.mp4": "new film" }, what);
  };
  // In a container every run can have the same pid.
  let dir = tmp();
  write(dir, { "film.mp4": "old film" });
  leftLock(dir, process.pid);
  await quick(dir, "this process's pid");
  // Its pid is that of a process that runs, but no commit takes a minute.
  dir = tmp();
  write(dir, { "film.mp4": "old film" });
  leftLock(dir, process.ppid, 2 * 60 * 1000);
  await quick(dir, "a lock two minutes old");
  if (!fs.existsSync("/proc/self/stat")) return t.skip("no /proc to tell when a process started");
  // A process started after the lock was made has the pid now.
  const later = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    dir = tmp();
    write(dir, { "film.mp4": "old film" });
    leftLock(dir, later.pid, 30 * 1000);
    await quick(dir, "a process started after the lock");
  } finally {
    later.kill("SIGKILL");
  }
});

test("a lock another run may still hold is waited for, and the refusal names it", async () => {
  // The test runner started before the lock was made, and runs.
  const dir = tmp();
  write(dir, { "film.mp4": "old film" });
  leftLock(dir, process.ppid);
  const lock = path.join(dir, out.LOCK);
  const err = await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film")).catch((e) => e);
  assert.equal(err.message, `could not put the new files in ${dir}: another launch-film run has been putting its files in ${dir} for 10 s. ` +
    `If no other launch-film run is at work there, remove ${lock} and run again. ${dir} is as it was.`);
  assert.deepEqual(snap(dir), { "film.mp4": "old film", [`${out.LOCK}/`]: "folder", [`${out.LOCK}/pid`]: String(process.ppid) });
});

test("a lock that cannot get its pid, as on a full disk, is not left", async () => {
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (String(file).endsWith(path.join(out.LOCK, "pid"))) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return real(file, ...rest);
  };
  try {
    await assert.rejects(out.within(dir, async (run) => make(run)), new RegExp(`ENOSPC: no space left on device, write\\. ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is as it was\\.$`));
  } finally {
    fs.writeFileSync = real;
  }
  assert.deepEqual(snap(dir), before);
});

test("a run that adds its files to a folder already there takes turns with a run that holds that folder", async () => {
  // frames/ is there: a frames run on its own holds frames/'s lock, and the
  // one-go command adds its frames to it.
  const dir = tmp();
  write(dir, { "film.mp4": "old film", "frames/clip-1-a.jpg": "old 1" });
  const holder = spawn(process.execPath, ["-e", `
const fs = require("fs");
fs.mkdirSync(process.argv[1]);
fs.writeFileSync(process.argv[1] + "/pid", String(process.pid));
process.stdout.write("held");
setTimeout(() => { fs.rmSync(process.argv[1], { recursive: true }); process.exit(0); }, 700);`, path.join(dir, "frames", out.LOCK)], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const started = Date.now();
  await out.within(dir, async (run) => {
    fs.writeFileSync(run.out("film.mp4"), "new film");
    fs.mkdirSync(run.out("frames"));
    fs.writeFileSync(path.join(run.part, "frames", "clip-1-a.jpg"), "new 1");
  });
  assert.ok(Date.now() - started >= 400, `waited ${Date.now() - started} ms`);
  assert.deepEqual(snap(dir), { "film.mp4": "new film", "frames/": "folder", "frames/clip-1-a.jpg": "new 1" });
});

// A folder on another disk than the temp folder, where the system has one.
function otherDisk() {
  const dev = fs.statSync(os.tmpdir()).dev;
  for (const at of ["/dev/shm", "/run/user/" + (process.getuid ? process.getuid() : ""), "/var/tmp", "/tmp"]) {
    try {
      if (fs.statSync(at).dev !== dev) return fs.mkdtempSync(path.join(at, "launch-film-out-"));
    } catch {
      // Not here, or not writable.
    }
  }
  return null;
}

test("frames/ that links to a folder on another disk takes the new frames", { skip: process.platform === "win32" && "links need rights on Windows" }, async (t) => {
  const elsewhere = otherDisk();
  if (!elsewhere) return t.skip("no folder on another disk");
  try {
    const dir = tmp();
    write(dir, { "film.mp4": "old film" });
    write(elsewhere, { "clip-1-a.jpg": "old 1", "clip-7-a.jpg": "old 7" });
    fs.symlinkSync(elsewhere, path.join(dir, "frames"));
    // The one-go command: the frames run inside the film's run.
    await out.within(dir, async (run) => {
      fs.writeFileSync(run.out("film.mp4"), "new film");
      await out.within(path.join(run.part, "frames"), async (r) => fs.writeFileSync(r.out("clip-1-a.jpg"), "new 1"));
    });
    assert.equal(fs.readFileSync(path.join(dir, "film.mp4"), "utf8"), "new film");
    assert.ok(fs.lstatSync(path.join(dir, "frames")).isSymbolicLink(), "frames/ is still the link");
    assert.deepEqual(snap(elsewhere), { "clip-1-a.jpg": "new 1", "clip-7-a.jpg": "old 7" });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["film.mp4", "frames"]);
    // One that fails there leaves both folders as they were.
    const before = [snap(dir), snap(elsewhere)];
    await assert.rejects(out.within(dir, async (run) => {
      await out.within(path.join(run.part, "frames"), async (r) => fs.writeFileSync(r.out("clip-1-a.jpg"), "newer 1"));
      fs.writeFileSync(run.out("film.mp4"), "newer film");
      // The film cannot go in: a folder is where it goes.
      fs.renameSync(path.join(dir, "film.mp4"), path.join(dir, "film.old"));
      fs.mkdirSync(path.join(dir, "film.mp4"));
    }), /a folder is where this run puts a file/);
    fs.rmdirSync(path.join(dir, "film.mp4"));
    fs.renameSync(path.join(dir, "film.old"), path.join(dir, "film.mp4"));
    assert.deepEqual([snap(dir), snap(elsewhere)], before);
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("on Windows a new folder is put in place when another program lets go of it in a moment", () => {
  // Windows refuses to move a folder while a virus scanner looks at a new
  // file in it; the scanner lets go in a moment.
  const base = tmp();
  const script = `
const fs = require("fs");
const path = require("path");
Object.defineProperty(process, "platform", { value: "win32" });
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const dir = path.join(process.argv[1], "film");
const real = fs.renameSync;
let refused = 0;
fs.renameSync = (from, to) => {
  if (to === dir && refused < 2) {
    refused++;
    throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  }
  return real(from, to);
};
out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"))
  .then(() => process.stdout.write("put in place after " + refused + " refusals"), (err) => process.stdout.write("failed: " + err.message));
`;
  const r = spawnSync(process.execPath, ["-e", script, base], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.stdout, "put in place after 2 refusals", r.stderr);
  assert.deepEqual(snap(base), { "film/": "folder", "film/film.mp4": "new film" });
});

test("a stop removes the socket folder Chrome links from its profile", { skip: noSignals }, async () => {
  // A stand-in Chrome that makes its socket folder in the temp folder, as
  // Chrome does, and lets SIGTERM go, so the stop has to kill it.
  const temp = tmp();
  const bin = tmp();
  const fake = path.join(bin, "chrome");
  fs.writeFileSync(fake, `#!/bin/sh
trap '' TERM INT HUP
for a in "$@"; do case "$a" in --user-data-dir=*) profile="\${a#--user-data-dir=}";; esac; done
sock=$(mktemp -d "$TMPDIR/com.google.Chrome.XXXXXX")
: > "$sock/SingletonSocket"
ln -s "$sock/SingletonSocket" "$profile/SingletonSocket"
while :; do sleep 1; done
`, { mode: 0o755 });
  const script = `
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const { launch } = require(${JSON.stringify(path.join(__dirname, "..", "src", "chrome.js"))});
out.listen();
launch({ W: 100, H: 100 }).catch(() => {});
`;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, TMPDIR: temp, LAUNCH_FILM_CHROME: fake } });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  const socket = () => fs.readdirSync(temp).filter((n) => n.startsWith("com.google.Chrome."));
  for (let i = 0; i < 500 && !(socket().length && fs.readdirSync(temp).some((n) => n.startsWith("launch-film-chrome-") && fs.existsSync(path.join(temp, n, "SingletonSocket")))); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(socket().length, 1, "the stand-in made its socket folder");
  child.kill("SIGTERM");
  assert.equal(await ended, "SIGTERM");
  assert.deepEqual(fs.readdirSync(temp), [], "neither the profile nor the socket folder is left");
});
