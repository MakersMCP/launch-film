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

const { tmp, shortTmp, stillRunning, WAITS } = require("./tmp");
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

test("an earlier folder replaced whole goes, with a folder in it the user made read-only", { skip: (process.platform === "win32" || process.getuid() === 0) && "a folder its user may not write in" }, async () => {
  const dir = tmp();
  write(dir, { "brand/brand.json": "old kit", "brand/notes/a.txt": "mine", "brand/notes/deep/b.txt": "mine too", "film.mp4": "old film" });
  fs.chmodSync(path.join(dir, "brand", "notes", "deep"), 0o000);
  fs.chmodSync(path.join(dir, "brand", "notes"), 0o555);
  try {
    await out.within(dir, async (run) => make(run));
    assert.deepEqual(snap(dir), { "brand/": "folder", "brand/brand.json": "new kit", "film.mp4": "new film", "frames/": "folder", "frames/clip-1-a.jpg": "new 1" });
    assert.deepEqual(out.noticed(), []);
  } finally {
    // So a test that fails does not stop its folder from going.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
  }
});

// Runs fn with every removal of a folder named as a part folder refused.
async function withPartStuck(fn) {
  const real = fs.rmSync;
  fs.rmSync = (at, ...rest) => {
    if (path.basename(String(at)).startsWith(".launch-film-part-")) throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${at}'`), { code: "EPERM" });
    return real(at, ...rest);
  };
  try {
    return await fn();
  } finally {
    fs.rmSync = real;
  }
}

test("earlier files that still cannot be removed are kept and said, and no later run tells of a killed run", async () => {
  const dir = tmp();
  write(dir, { "brand/brand.json": "old kit" });
  await withPartStuck(() => out.within(dir, async (run) => {
    fs.mkdirSync(run.folder("brand"));
    fs.writeFileSync(path.join(run.part, "brand", "brand.json"), "new kit");
  }));
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1, fs.readdirSync(dir).join(", "));
  const why = "operation not permitted (EPERM)";
  assert.deepEqual(out.noticed(), [`the earlier files this run replaced in ${dir} could not be removed (${why}), so they are in ${path.join(dir, kept[0])}; launch-film-kept.txt there lists them`]);
  const inKept = snap(path.join(dir, kept[0]));
  assert.equal(inKept[".old/brand/brand.json"], "old kit");
  assert.match(inKept["launch-film-kept.txt"], new RegExp(`^launch-film replaced these earlier files in ${escape(dir)} and could not remove them \\(${escape(why)}\\):\n {2}brand/brand\\.json\n`));
  assert.equal(fs.readFileSync(path.join(dir, "brand", "brand.json"), "utf8"), "new kit");
  // Twenty minutes on, a run that ends well there leaves it alone and says nothing of it.
  age(path.join(dir, kept[0]));
  await out.within(dir, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a later check"));
  assert.deepEqual(out.noticed(), []);
  assert.ok(fs.existsSync(path.join(dir, kept[0])));
  // With no earlier files in it, the note names the folder and says why.
  const other = tmp();
  let part = null;
  await withPartStuck(() => out.within(other, async (run) => {
    part = run.part;
    fs.writeFileSync(run.out("CHECK.md"), "a check");
  }));
  assert.deepEqual(out.noticed(), [`${part}, a folder of this run's in ${other}, could not be removed: ${why}`]);
});

// fs.renameSync failing on the calls given, as a file held open would.
async function withRenameFailing(calls, fn) {
  const real = fs.renameSync;
  let n = 0;
  fs.renameSync = (from, to) => {
    n++;
    if (calls.includes(n)) throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: "EIO" });
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
    /^Error: could not put the new files in .*: .*frames\/clip-1-a\.jpg: i\/o error \(EIO\)\. .* is as it was\.$/));
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
  // As the CLI says it: that folder stays where it is, under its own name.
  assert.equal(out.said(err.message), err.message);
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

// A part folder as a run killed while it put its files in place leaves it,
// 20 minutes ago, in `dir`, with earlier files `names` in its .old.
function leftWithEarlier(dir, names) {
  const at = path.join(dir, ".launch-film-part-4194000-0badc0de");
  for (const name of names) write(at, { [`.old/${name}`]: "earlier" });
  age(at);
  return at;
}

test("a part folder's note is never written through a link, and each earlier file is listed on a line of its own", { skip: process.platform === "win32" && "links need rights on Windows" }, async () => {
  // As another user could leave it in a folder both write to, such as /tmp:
  // the note's name links to a file of the user's, and a name in .old holds
  // line breaks.
  const shared = tmp();
  const theirs = path.join(tmp(), "authorized_keys");
  fs.writeFileSync(theirs, "the user's own key\n");
  const left = leftWithEarlier(shared, ["film.mp4", "x\nssh-ed25519 AAAA added\nx"]);
  fs.symlinkSync(theirs, path.join(left, "launch-film-kept.txt"));
  const when = Date.now() / 1000 - 20 * 60;
  fs.lutimesSync(path.join(left, "launch-film-kept.txt"), when, when);
  fs.utimesSync(left, when, when);
  await out.within(path.join(shared, "check"), async (run) => fs.writeFileSync(run.out("CHECK.md"), "a check"));
  assert.equal(fs.readFileSync(theirs, "utf8"), "the user's own key\n");
  const kept = fs.readdirSync(shared).filter((n) => n.startsWith("launch-film-kept-"));
  assert.equal(kept.length, 1, "the earlier files are kept all the same");
  assert.ok(fs.lstatSync(path.join(shared, kept[0], "launch-film-kept.txt")).isSymbolicLink(), "the link is left as it was");
  out.noticed();
  // Without the link, the note lists each name escaped, on its own line.
  const other = tmp();
  leftWithEarlier(other, ["film.mp4", "x\nssh-ed25519 AAAA added\nx"]);
  await out.within(path.join(other, "check"), async (run) => fs.writeFileSync(run.out("CHECK.md"), "a check"));
  const note = fs.readFileSync(path.join(other, fs.readdirSync(other).find((n) => n.startsWith("launch-film-kept-")), "launch-film-kept.txt"), "utf8").split("\n");
  assert.deepEqual(note.slice(1, 3), ["  film.mp4", "  x\\nssh-ed25519 AAAA added\\nx"]);
  assert.match(note[3], /^They are in \.old here/);
  out.noticed();
});

test("a part folder or a temp folder that is not this user's own is left alone", { skip: process.platform === "win32" && "no users to tell apart" }, () => {
  // Run as if by another user, in a process of its own: every folder the
  // tests made belongs to someone else then. A part folder left with earlier
  // files is neither kept nor removed, and a temp folder named as a Chrome
  // profile a killed run left, whose link leads to a socket folder the user
  // has, is not followed.
  const shared = tmp();
  const left = leftWithEarlier(shared, ["film.mp4"]);
  const plain = path.join(shared, ".launch-film-part-4194001-0badc0de");
  write(plain, { "film.mp4": "half a film" });
  age(plain);
  const temp = tmp();
  const socket = path.join(temp, "com.google.Chrome.UsErSk");
  write(socket, { SingletonSocket: "" });
  const planted = path.join(temp, "launch-film-chrome-4194000-aB3dE6");
  fs.mkdirSync(planted);
  fs.symlinkSync(path.join(socket, "SingletonSocket"), path.join(planted, "SingletonSocket"));
  const before = [snap(shared), snap(temp)];
  const script = `
const fs = require("fs");
const uid = process.getuid() + 1;
process.getuid = () => uid;
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const { closeProfile } = out;
out.within(process.argv[1] + "/check", async (run) => fs.writeFileSync(run.out("CHECK.md"), "a check")).then(() => {
  const made = out.tempDir("launch-film-chrome-", (dir) => closeProfile(dir));
  out.release(made);
  process.stdout.write(JSON.stringify(out.noticed()));
});
`;
  const r = spawnSync(process.execPath, ["-e", script, shared], { encoding: "utf8", timeout: 20_000, env: { ...process.env, TMPDIR: temp } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "[]");
  const { "check/": made, "check/CHECK.md": report, ...rest } = snap(shared);
  assert.deepEqual([made, report], ["folder", "a check"]);
  assert.deepEqual([rest, snap(temp)], before);
  assert.ok(fs.existsSync(left));
});

test("a run inside another's part folder leaves what killed runs left to that run, so one that fails after it leaves the folder as it was", async () => {
  const dir = tmp();
  write(dir, { "film.json": "earlier plan" });
  leftWithEarlier(dir, ["film.mp4"]);
  const before = snap(dir);
  // The one-go command: the render, inside the plan's part folder, ends
  // well; then the frames fail.
  await assert.rejects(out.within(dir, async (run) => {
    fs.writeFileSync(run.out("film.json"), "new plan");
    await out.within(run.part, async (r) => fs.writeFileSync(r.out("film.mp4"), "new film"));
    throw new Error("saving a still: ffmpeg failed");
  }), /saving a still/);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(out.noticed(), []);
  // One that ends well sees to it, once.
  await out.within(dir, async (run) => {
    fs.writeFileSync(run.out("film.json"), "new plan");
    await out.within(run.part, async (r) => fs.writeFileSync(r.out("film.mp4"), "new film"));
  });
  assert.equal(out.noticed().length, 1);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("launch-film-kept-")).length, 1);
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
    await run.commit();
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
const child = out.track(spawn(process.execPath, ["-e", (how === "stubborn" ? 'process.on("SIGTERM", () => {}); ' : "") + 'process.stdout.write("on"); ${WAITS}'], { stdio: ["ignore", "pipe", "ignore"] }));
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
${WAITS}
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
const browser = 'const h = require("child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" }); process.on("SIGTERM", () => { h.kill("SIGKILL"); process.exit(0); }); process.stdout.write("on"); ${WAITS}';
const child = out.track(spawn(process.execPath, ["-e", browser, helper, dir], { stdio: ["ignore", "pipe", "ignore"] }));
child.stdout.once("data", () => {
  process.stdout.write(dir);
  setTimeout(() => out.exit(1), 100);
});
${WAITS}
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
  assert.match(r.stdout, /^cannot write in .+: no such file or directory \(ENOENT\)$/);
});

test("a folder the run cannot write in is named in the refusal, not the part folder, and nothing is made", { skip: (process.platform === "win32" || process.getuid() === 0) && "a folder its user may not write in" }, async () => {
  const base = tmp();
  const locked = path.join(base, "locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "film.mp4"), "old film");
  fs.chmodSync(locked, 0o555);
  try {
    // The folder itself, and a folder to be made in it.
    for (const dir of [locked, path.join(locked, "films", "check")]) {
      const err = await out.within(dir, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a check")).catch((e) => e);
      assert.equal(err.message, `cannot write in ${locked}: permission denied (EACCES)`);
    }
    assert.deepEqual(fs.readdirSync(locked), ["film.mp4"]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test("a write that fails names the file it was writing, as the new one, and a quoted path in a part folder is the new one too", async () => {
  assert.equal(out.reason(new Error("ENOSPC: no space left on device, write")), "no space left on device (ENOSPC)");
  assert.equal(out.reason(new Error("EACCES: permission denied, mkdir '/a/b'")), "permission denied (EACCES)");
  assert.equal(out.reason(new Error("ENOSPC, No space left on device '/a/brand'")), "no space left on device (ENOSPC)");
  assert.equal(out.reason(new Error("the render failed")), "the render failed");
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (path.basename(String(file)) === "film.json") throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    return real(file, ...rest);
  };
  let part = null;
  try {
    const err = await out.within(dir, async (run) => {
      part = run.part;
      out.save(run.out("film.json"), "plan");
    }).catch((e) => e);
    assert.equal(out.said(err.message), `writing the new ${path.join(dir, "film.json")}: no space left on device (ENOSPC)`);
  } finally {
    fs.writeFileSync = real;
  }
  assert.deepEqual(snap(dir), before);
  assert.equal(out.said(`ENOSPC, No space left on device '${path.join(part, "brand")}'`), `ENOSPC, No space left on device the new '${path.join(dir, "brand")}'`);
});

test("a copy is made of plain files, whatever links the folder holds", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  const base = tmp();
  const from = path.join(base, "kit");
  const elsewhere = path.join(base, "elsewhere");
  write(from, { "brand.json": "{}", "deep/inner/page.md": "page", ".launch-film-commit/pid": "1" });
  write(elsewhere, { "logo.png": "logo", "folder/a.txt": "a" });
  fs.symlinkSync(path.join(elsewhere, "logo.png"), path.join(from, "logo-link.png"));
  fs.symlinkSync(path.join(elsewhere, "folder"), path.join(from, "deep", "folder-link"));
  // A link that leads nowhere, one to a folder the copy is inside of, and a
  // file whose kind cannot be copied.
  fs.symlinkSync(path.join(base, "no-such"), path.join(from, "dangling"));
  fs.symlinkSync(from, path.join(from, "deep", "back"));
  if (spawnSync("mkfifo", [path.join(from, "pipe")]).status !== 0) fs.writeFileSync(path.join(from, "pipe.skip"), "");
  const to = path.join(base, "copy");
  // Through a link, as a brand/ that links to a kit.
  fs.symlinkSync(from, path.join(base, "link-to-kit"));
  out.copyPlain(path.join(base, "link-to-kit"), to);
  const copied = snap(to);
  delete copied["pipe.skip"];
  assert.deepEqual(copied, { "brand.json": "{}", "deep/": "folder", "deep/inner/": "folder", "deep/inner/page.md": "page", "deep/folder-link/": "folder", "deep/folder-link/a.txt": "a", "logo-link.png": "logo" });
  // Into itself it cannot go.
  assert.throws(() => out.copyPlain(from, path.join(from, "brand")), /is inside/);
  assert.ok(!fs.existsSync(path.join(from, "brand")));
});

test("a part folder takes the mode of a folder made there, which a default ACL needs", { skip: process.platform === "win32" && "no modes to tell apart" }, () => {
  const run = out.begin(tmp());
  try {
    assert.equal(fs.statSync(run.part).mode & 0o777, 0o777 & ~process.umask());
  } finally {
    run.discard();
  }
});

test("a socket folder is read only from a profile of this user's own, and given only when it is Chrome's, this user's own and right in the temp folder", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  const temp = tmp();
  const profile = (name, target) => {
    const at = path.join(temp, name);
    fs.mkdirSync(at);
    fs.symlinkSync(path.join(target, "SingletonSocket"), path.join(at, "SingletonSocket"));
    return at;
  };
  const socket = path.join(temp, "com.google.Chrome.AbCdEf");
  const other = path.join(temp, "some-folder");
  const away = path.join(tmp(), "com.google.Chrome.ZzZzZz");
  for (const folder of [socket, other, away]) fs.mkdirSync(folder);
  const good = profile("good", socket);
  const misnamed = profile("misnamed", other);
  const elsewhere = profile("elsewhere", away);
  // In a process of its own, where lstat calls one path another user's.
  const script = `
const fs = require("fs");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [theirs, ...asked] = process.argv.slice(1);
const real = fs.lstatSync;
fs.lstatSync = (at, ...rest) => {
  const s = real(at, ...rest);
  if (s && at === theirs) s.uid += 1;
  return s;
};
process.stdout.write(JSON.stringify(asked.map((at) => out.socketFolder(at))));
`;
  const ask = (theirs, ...asked) => {
    const r = spawnSync(process.execPath, ["-e", script, theirs, ...asked], { encoding: "utf8", env: { ...process.env, TMPDIR: temp } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(ask("", good, misnamed, elsewhere), [socket, null, null]);
  assert.deepEqual(ask(good, good), [null], "the profile is another user's");
  assert.deepEqual(ask(socket, good), [null], "the socket folder is another user's");
});

// A process that listens for signals and has a child that lets SIGTERM go,
// so a stop or a failure waits for it. What it does then is `how`.
const AFTER_STOP = `
const fs = require("fs");
const { spawn } = require("child_process");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [dir, how] = process.argv.slice(1);
const say = (text) => fs.writeSync(1, text + "\\n");
out.listen();
const late = () => {
  const child = out.track(spawn(process.execPath, ["-e", ${JSON.stringify(WAITS)}], { stdio: "ignore" }));
  child.once("exit", (code, signal) => say("late child ended by " + signal));
};
const stubborn = out.track(spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("on"); ${WAITS}'], { stdio: ["ignore", "pipe", "ignore"] }));
stubborn.stdout.once("data", () => {
  if (how === "late") process.once("SIGTERM", late);
  if (how === "ending") {
    out.exit(1);
    late();
  }
  if (how === "begin") {
    process.once("SIGTERM", () => {
      try {
        out.begin(dir);
        say("begun");
      } catch (err) {
        say(err.stopped ? "not begun" : err.message);
      }
    });
  }
  if (how === "commit" || how === "commit-waits") {
    out.within(dir, async (run) => {
      fs.writeFileSync(run.out("film.mp4"), "new film");
      say("ready");
      if (how === "commit") await new Promise((resolve) => process.once("SIGTERM", resolve));
    }).then(() => say("committed"), (err) => say(err.stopped ? "not committed" : err.message));
    return;
  }
  say("ready");
});
${WAITS}
`;

// Runs AFTER_STOP as `how`, sends SIGTERM once it says ready, and answers
// with what it said.
async function afterStop(dir, how) {
  const child = spawn(process.execPath, ["-e", AFTER_STOP, dir, how], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await new Promise((resolve) => child.stdout.on("data", (d) => {
    said += d;
    if (/ready/.test(said)) resolve();
  }));
  if (how !== "ending") child.kill("SIGTERM");
  const end = await ended;
  return { ...end, said: said.replace("ready\n", "") };
}

test("a process started once a stop has begun is ended at once", { skip: noSignals }, async () => {
  assert.deepEqual(await afterStop(tmp(), "late"), { code: null, signal: "SIGTERM", said: "late child ended by SIGKILL\n" });
});

test("a process started once a failed run is ending is asked to stop", { skip: noSignals }, async () => {
  assert.deepEqual(await afterStop(tmp(), "ending"), { code: 1, signal: null, said: "late child ended by SIGTERM\n" });
});

test("a process the runs started is killed when the process ends, with no run or temp folder begun", { skip: noSignals }, async () => {
  // It lets SIGTERM go, so only the kill at exit ends it.
  const script = `
const { spawn } = require("child_process");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const child = out.track(spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("on"); ${WAITS}'], { stdio: ["ignore", "pipe", "ignore"] }));
child.stdout.once("data", () => {
  process.stdout.write(String(child.pid));
  process.exit(1);
});
${WAITS}
`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(await gone(Number(r.stdout)), "the child is gone");
});

test("the check at the end of a test file sees a helper a test left running", { skip: process.platform !== "linux" && "/proc tells which processes the tests started" }, async () => {
  const helper = spawn(process.execPath, ["-e", WAITS], { stdio: "ignore" });
  try {
    assert.ok(stillRunning().includes(helper.pid));
  } finally {
    helper.kill("SIGKILL");
  }
  assert.ok(await gone(helper.pid), "it is gone");
  assert.ok(!stillRunning().includes(helper.pid));
});

test("a run begun once a stop has begun is refused and makes nothing", { skip: noSignals }, async () => {
  const dir = tmp();
  assert.equal((await afterStop(dir, "begin")).said, "not begun\n");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a run that ends well once a stop has begun puts nothing in place", { skip: noSignals }, async () => {
  // In a folder already there, and in one it makes.
  const dir = tmp();
  write(dir, EARLIER);
  const before = snap(dir);
  assert.equal((await afterStop(dir, "commit")).said, "not committed\n");
  assert.deepEqual(snap(dir), before);
  const base = tmp();
  assert.equal((await afterStop(path.join(base, "film"), "commit")).said, "not committed\n");
  assert.deepEqual(fs.readdirSync(base), []);
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
${WAITS}
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
const path = require("path");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const [dir, me, at] = process.argv.slice(1);
// Each move of a file is noted in RACER_LOG. With RACER_MOVE each takes that
// long, with RACER_TAKE the run waits that long on its way to taking over a
// lock left behind, and with RACER_LOCK as it moves that lock aside.
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const once = (name) => {
  const ms = Number(process.env[name] || 0);
  process.env[name] = "0";
  if (ms) nap(ms);
};
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (path.basename(from) === out.LOCK) once("RACER_LOCK");
  else {
    nap(Number(process.env.RACER_MOVE || 0));
    if (process.env.RACER_LOG) fs.appendFileSync(process.env.RACER_LOG, me);
  }
  return real(from, to);
};
const mkdir = fs.mkdirSync;
fs.mkdirSync = (at, ...rest) => {
  if (String(at).endsWith("-taking")) once("RACER_TAKE");
  return mkdir(at, ...rest);
};
out.within(dir, async (run) => {
  fs.writeFileSync(run.out("film.mp4"), me);
  fs.mkdirSync(run.folder("brand"));
  for (const n of ["brand.json", "logo.png"]) fs.writeFileSync(run.part + "/brand/" + n, me);
  fs.mkdirSync(run.out("frames"));
  for (const n of ["1", "2"]) fs.writeFileSync(run.part + "/frames/" + n + ".jpg", me);
  while (Date.now() < Number(at)) {}
}).then(() => process.exit(0), (err) => { process.stderr.write(err.message); process.exit(1); });
`;
function racer(dir, me, at, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", RACER, dir, me, String(at)], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
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

test("several runs that find a lock a killed run left take it over one at a time", async () => {
  const racers = ["A", "B", "C", "D", "E", "F"];
  // No frames/ yet: a run that finds it takes its lock too, which would
  // keep the runs apart whatever became of this lock.
  const earlier = { "film.mp4": "O", "brand/brand.json": "O", "brand/logo.png": "O", [`${out.LOCK}/pid`]: "4194000" };
  // Every run ended well, the folder holds one run's files and no other's,
  // and the moves of one run are never mixed with another's.
  const race = async (what, env) => {
    const dir = tmp();
    write(dir, earlier);
    const log = path.join(tmp(), "moves.log");
    const at = Date.now() + 700;
    const all = await Promise.all(env.map((extra, i) => racer(dir, racers[i], at, { RACER_LOG: log, ...extra })));
    assert.deepEqual(all.map((r) => r.code), all.map(() => 0), `${what}: ${all.map((r) => r.stderr).join(" ")}`);
    const s = snap(dir);
    const last = s["film.mp4"];
    assert.deepEqual(s, { "brand/": "folder", "brand/brand.json": last, "brand/logo.png": last, "film.mp4": last, "frames/": "folder", "frames/1.jpg": last, "frames/2.jpg": last }, what);
    const turns = fs.readFileSync(log, "utf8").replace(/(.)\1*/g, "$1");
    assert.equal(new Set(turns).size, turns.length, `${what}: the moves went ${turns}`);
  };
  for (let t = 0; t < 8; t++) await race(`six at once, trial ${t}`, racers.map(() => ({})));
  // One is held up on its way to taking the lock over, or as it moves the
  // lock aside, as on a loaded machine, until the other has taken over and
  // holds the lock; and the moves take long enough that it still does then.
  for (let t = 0; t < 3; t++) {
    await race(`held up on its way, trial ${t}`, [{ RACER_MOVE: "45" }, { RACER_MOVE: "45", RACER_TAKE: "70" }]);
    await race(`held up as it moves the lock, trial ${t}`, [{ RACER_MOVE: "45" }, { RACER_MOVE: "45", RACER_LOCK: "70" }]);
  }
});

test("a lock that lost its way to another run before it got its pid is tried again", async () => {
  const dir = tmp();
  write(dir, { "film.mp4": "old film" });
  const real = fs.writeFileSync;
  let once = true;
  fs.writeFileSync = (file, ...rest) => {
    if (once && String(file).endsWith(path.join(out.LOCK, "pid"))) {
      // The run was held up for seconds: another took the lock for one left.
      once = false;
      fs.rmSync(path.dirname(String(file)), { recursive: true });
      throw Object.assign(new Error("ENOENT: no such file or directory, open"), { code: "ENOENT" });
    }
    return real(file, ...rest);
  };
  try {
    await out.within(dir, async (run) => real(run.out("film.mp4"), "new film"));
  } finally {
    fs.writeFileSync = real;
  }
  assert.deepEqual(snap(dir), { "film.mp4": "new film" });
});

test("a lock that never got its pid is taken over once it is two seconds old, and not before", async () => {
  const lockOf = (dir, age) => {
    fs.mkdirSync(path.join(dir, out.LOCK));
    const when = (Date.now() - age) / 1000;
    fs.utimesSync(path.join(dir, out.LOCK), when, when);
  };
  let dir = tmp();
  write(dir, { "film.mp4": "old film" });
  lockOf(dir, 3000);
  let started = Date.now();
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`);
  assert.deepEqual(snap(dir), { "film.mp4": "new film" });
  dir = tmp();
  write(dir, { "film.mp4": "old film" });
  lockOf(dir, 0);
  started = Date.now();
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.ok(Date.now() - started >= 1500, `took it after ${Date.now() - started} ms`);
  assert.deepEqual(snap(dir), { "film.mp4": "new film" });
});

test("what a run killed as it took over a lock left does not stop the next one, and goes in time", async () => {
  // Killed in the few moments it holds the take-over folder: the lock is
  // still there, and that folder, a few seconds old by the next run.
  const dir = tmp();
  write(dir, { "film.mp4": "old film", [`${out.LOCK}/pid`]: "4194000" });
  fs.mkdirSync(path.join(dir, `${out.LOCK}-taking`));
  const when = (Date.now() - 6000) / 1000;
  fs.utimesSync(path.join(dir, `${out.LOCK}-taking`), when, when);
  const started = Date.now();
  await out.within(dir, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.ok(Date.now() - started < 3000, `waited ${Date.now() - started} ms`);
  assert.deepEqual(snap(dir), { "film.mp4": "new film" });
  // Killed just after: the lock it moved aside and the take-over folder are
  // left, and go once they have not changed for 15 minutes.
  const later = tmp();
  write(later, { "film.mp4": "old film" });
  for (const name of [`${out.LOCK}-taking`, `${out.LOCK}-4194000-0badc0de`]) {
    fs.mkdirSync(path.join(later, name));
    age(path.join(later, name));
  }
  fs.mkdirSync(path.join(later, `${out.LOCK}-4194001-0badc0de`));
  await out.within(later, async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"));
  assert.deepEqual(snap(later), { "film.mp4": "new film", [`${out.LOCK}-4194001-0badc0de/`]: "folder" });
});

test("a run stopped while it waits for another's lock ends at once, with its folder as it was", { skip: noSignals }, async () => {
  const dir = tmp();
  write(dir, { "film.mp4": "old film", "frames/clip-1-a.jpg": "old 1" });
  // Held by the process that runs this test, for as long as the wait lasts.
  write(dir, { [`${out.LOCK}/pid`]: String(process.ppid) });
  const script = `
const fs = require("fs");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
out.listen();
out.within(process.argv[1], async (run) => {
  fs.writeFileSync(run.out("film.mp4"), "new film");
  process.stdout.write("ready");
}).catch(() => {});
`;
  const before = snap(dir);
  const child = spawn(process.execPath, ["-e", script, dir], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = Date.now();
  child.kill("SIGTERM");
  const { signal } = await ended;
  assert.equal(signal, "SIGTERM");
  assert.ok(Date.now() - sent < 2000, `ended ${Date.now() - sent} ms after the stop`);
  assert.equal(stderr, `launch-film: stopped, so ${dir} is as it was\n`);
  assert.deepEqual(snap(dir), before);
});

test("a run stopped while it waits for a folder's lock lets go of the lock it holds", { skip: noSignals }, async () => {
  // It holds the lock of the film's folder and waits for frames/'s.
  const dir = tmp();
  write(dir, { "film.mp4": "old film", "frames/clip-1-a.jpg": "old 1", [`frames/${out.LOCK}/pid`]: String(process.ppid) });
  const script = `
const fs = require("fs");
const path = require("path");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
out.listen();
out.within(process.argv[1], async (run) => {
  fs.mkdirSync(run.out("frames"));
  fs.writeFileSync(path.join(run.part, "frames", "clip-1-a.jpg"), "new 1");
  process.stdout.write("ready");
}).catch(() => {});
`;
  const before = snap(dir);
  const child = spawn(process.execPath, ["-e", script, dir], { stdio: ["ignore", "pipe", "ignore"] });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, out.LOCK)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(path.join(dir, out.LOCK)), "it holds the folder's lock");
  child.kill("SIGTERM");
  assert.equal(await ended, "SIGTERM");
  assert.deepEqual(snap(dir), before);
});

test("a lock let go while a stop is under way is not taken: the run puts nothing in place", { skip: noSignals }, async () => {
  // The lock is held by this test's runner until the stop has begun; the
  // stop waits a moment for a child that lets SIGTERM go.
  const dir = tmp();
  write(dir, EARLIER);
  write(dir, { [`${out.LOCK}/pid`]: String(process.ppid) });
  const before = snap(dir);
  const child = spawn(process.execPath, ["-e", AFTER_STOP, dir, "commit-waits"], { stdio: ["ignore", "pipe", "ignore"] });
  let said = "";
  const ended = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => child.stdout.on("data", (d) => {
    said += d;
    if (/ready/.test(said)) resolve();
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 60));
  fs.rmSync(path.join(dir, out.LOCK), { recursive: true });
  await ended;
  assert.equal(said, "ready\nnot committed\n");
  delete before[`${out.LOCK}/`];
  delete before[`${out.LOCK}/pid`];
  assert.deepEqual(snap(dir), before);
});

test("an earlier file the user made read-only is refused by name before anything moves", { skip: (process.platform === "win32" || process.getuid() === 0) && "a file its user may not write" }, async () => {
  const dir = tmp();
  write(dir, EARLIER);
  fs.chmodSync(path.join(dir, "frames", "clip-1-a.jpg"), 0o444);
  const before = snap(dir);
  const err = await out.within(dir, async (run) => make(run)).catch((e) => e);
  const file = path.join(dir, "frames", "clip-1-a.jpg");
  assert.equal(err.message, `could not put the new files in ${dir}: ${file} may not be written (EACCES), so it was not replaced: make it writable or remove it, and run again. ${dir} is as it was.`);
  assert.deepEqual(snap(dir), before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  // A link there is replaced, whatever it leads to, and what it leads to is left.
  const other = tmp();
  const theirs = path.join(tmp(), "theirs.txt");
  fs.writeFileSync(theirs, "the user's own");
  fs.chmodSync(theirs, 0o444);
  fs.symlinkSync(theirs, path.join(other, "CHECK.md"));
  await out.within(other, async (run) => fs.writeFileSync(run.out("CHECK.md"), "a check"));
  assert.deepEqual(snap(other), { "CHECK.md": "a check" });
  assert.equal(fs.readFileSync(theirs, "utf8"), "the user's own");
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
  // Its pid is that of a process that runs and started before it, but no
  // commit takes a minute: the clock is moved on past that.
  dir = tmp();
  write(dir, { "film.mp4": "old film" });
  leftLock(dir, process.ppid);
  const now = Date.now;
  Date.now = () => now() + 61 * 1000;
  try {
    await quick(dir, "a lock a minute old");
  } finally {
    Date.now = now;
  }
  if (!fs.existsSync("/proc/self/stat")) return t.skip("no /proc to tell when a process started");
  // A process started after the lock was made has the pid now.
  const later = spawn(process.execPath, ["-e", WAITS], { stdio: "ignore" });
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

test("a lock left by a run that is gone but cannot be moved aside is waited for and refused, not tried again and again", () => {
  // As another user's lock in a folder with the sticky bit: renaming it is
  // refused. The clock runs fast after a while, so the wait ends soon; a
  // run that tried again at once forever never reached the wait.
  const dir = tmp();
  write(dir, { "film.mp4": "old film", [`${out.LOCK}/pid`]: "4194000" });
  const script = `
const fs = require("fs");
const path = require("path");
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (path.basename(from) === out.LOCK) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  return real(from, to);
};
const now = Date.now;
let calls = 0;
Date.now = () => now() + (++calls > 200 ? 11000 : 0);
out.within(process.argv[1], async (run) => fs.writeFileSync(run.out("film.mp4"), "new film"))
  .then(() => process.stdout.write("committed"), (err) => process.stdout.write(err.message + "\\n" + JSON.stringify(out.aftermath())));
`;
  const r = spawnSync(process.execPath, ["-e", script, dir], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.signal, null, "it ended on its own");
  const lock = path.join(dir, out.LOCK);
  // A stop that comes while it waits says which folder is as it was too.
  assert.equal(r.stdout, `could not put the new files in ${dir}: ${lock} was left by a launch-film run that is gone and cannot be moved aside (EPERM). Remove it and run again. ${dir} is as it was.\n` +
    JSON.stringify([`${dir} is as it was`]));
  assert.deepEqual(snap(dir), { "film.mp4": "old film", [`${out.LOCK}/`]: "folder", [`${out.LOCK}/pid`]: "4194000" });
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
    await assert.rejects(out.within(dir, async (run) => make(run)), new RegExp(`no space left on device \\(ENOSPC\\)\\. ${escape(dir)} is as it was\\.$`));
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
i=0
while [ "$i" -lt 60 ]; do sleep 1; i=$((i + 1)); done
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

// A stand-in Chrome in Node that answers every call on the DevTools pipe and
// makes its socket folder in the temp folder, linked from its profile, as
// Chrome does. "helper": it starts a helper that names the profile in its
// command line, as Chrome's helpers do, lets SIGTERM go and writes into the
// profile; its pid goes to the file STAND_IN_PID. "closing": on Ctrl-C it
// starts to close, its link going first, and then lingers until it is
// killed.
function standInChrome(dir) {
  const file = path.join(dir, "chrome");
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const sock = fs.mkdtempSync(path.join(process.env.TMPDIR, "com.google.Chrome."));
fs.writeFileSync(path.join(sock, "SingletonSocket"), "");
fs.symlinkSync(path.join(sock, "SingletonSocket"), path.join(profile, "SingletonSocket"));
if (process.env.STAND_IN === "helper") {
  const write = 'process.on("SIGTERM", () => {}); const fs = require("fs"); setInterval(() => { try { fs.mkdirSync(process.argv[1] + "/Default", { recursive: true }); fs.writeFileSync(process.argv[1] + "/Default/state", "on"); } catch {} }, 5); ${WAITS}';
  const helper = spawn(process.execPath, ["-e", write, profile, "--user-data-dir=" + profile], { stdio: "ignore" });
  fs.writeFileSync(process.env.STAND_IN_PID, String(helper.pid));
}
if (process.env.STAND_IN === "closing") {
  process.on("SIGINT", () => fs.rmSync(path.join(profile, "SingletonSocket"), { force: true }));
  process.on("SIGTERM", () => {});
}
let buf = "";
fs.createReadStream("", { fd: 3 }).on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\0")) >= 0; buf = buf.slice(i + 1)) fs.writeSync(4, JSON.stringify({ id: JSON.parse(buf.slice(0, i)).id, result: {} }) + "\\0");
});
${WAITS}
`, { mode: 0o755 });
  return file;
}

// A process that starts Chrome as a render does, says "up" once Chrome
// answers, and then fails ("fails") or waits for a signal.
const STARTS_CHROME = `
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const { launch } = require(${JSON.stringify(path.join(__dirname, "..", "src", "chrome.js"))});
out.listen();
launch({ W: 100, H: 100 }).then(() => {
  process.stdout.write("up");
  if (process.argv[1] === "fails") setTimeout(() => out.exit(1), 100);
});
${WAITS}
`;

test("a failed run ends the Chrome helpers that still write in its profile before the profile goes", { skip: process.platform !== "linux" && "/proc tells which processes use a profile" }, async () => {
  const temp = tmp();
  const pidFile = path.join(tmp(), "helper.pid");
  const env = { ...process.env, TMPDIR: temp, LAUNCH_FILM_CHROME: standInChrome(tmp()), STAND_IN: "helper", STAND_IN_PID: pidFile };
  const r = spawnSync(process.execPath, ["-e", STARTS_CHROME, "fails"], { encoding: "utf8", timeout: 20_000, env });
  const helper = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "up");
    // Had the helper lived on, it would have made the profile again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(fs.readdirSync(temp), [], "neither the profile nor the socket folder is left");
    assert.ok(await gone(helper), "the helper is gone");
  } finally {
    try {
      process.kill(helper, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
  }
});

test("a stop as Chrome starts to close removes the socket folder Chrome made", { skip: noSignals }, async () => {
  // Ctrl-C reaches Chrome too, as it closes after a clip: it unlinks its
  // socket from the profile, and is killed before it removes the folder.
  const temp = tmp();
  const env = { ...process.env, TMPDIR: temp, LAUNCH_FILM_CHROME: standInChrome(tmp()), STAND_IN: "closing" };
  const child = spawn(process.execPath, ["-e", STARTS_CHROME, "waits"], { stdio: ["ignore", "pipe", "ignore"], env });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  assert.equal(fs.readdirSync(temp).filter((n) => n.startsWith("com.google.Chrome.")).length, 1);
  child.kill("SIGINT");
  assert.equal(await ended, "SIGINT");
  assert.deepEqual(fs.readdirSync(temp), [], "neither the profile nor the socket folder is left");
});

test("a Chrome with network access keeps its temp files in its profile, and they go with it", { skip: process.platform !== "linux" && "the temp folder is left as it is elsewhere" }, async () => {
  // A stand-in that leaves in its TMPDIR what a real one stopped as it
  // starts leaves there, with nothing to tie it to that Chrome.
  const temp = shortTmp();
  const dir = tmp();
  const file = standInChrome(dir);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('let buf = "";', 'fs.mkdirSync(path.join(process.env.TMPDIR, "com.google.Chrome.chrome_chrome_url_fetcher_.AbCdEf"));\nlet buf = "";'));
  const script = `
const out = require(${JSON.stringify(path.join(__dirname, "..", "src", "out.js"))});
const { launch } = require(${JSON.stringify(path.join(__dirname, "..", "src", "chrome.js"))});
out.listen();
launch({ W: 100, H: 100, network: true }).then(() => process.stdout.write("up"));
${WAITS}
`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TMPDIR: temp, LAUNCH_FILM_CHROME: file } });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGTERM");
  assert.equal(await ended, "SIGTERM");
  assert.deepEqual(fs.readdirSync(temp), [], "neither the profile nor anything its Chrome made is left");
});

test("a run removes the temp folders of runs that are gone", () => {
  // Of their kind: one of a process that has ended, one whose pid is now
  // this process's, one of a process that runs, and one without a pid, as
  // --keep makes.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const prefix = "launch-film-sweep-test-";
  const names = [`${prefix}${gone}-aB3dE6`, `${prefix}${process.pid}-Zz9Yy8`, `${prefix}${process.ppid}-Qq1Ww2`, `${prefix}Kk4Ll5`];
  for (const name of names) fs.mkdirSync(path.join(os.tmpdir(), name));
  const cleaned = [];
  const made = out.tempDir(prefix, (dir) => cleaned.push(path.basename(dir)));
  try {
    assert.deepEqual(cleaned.sort(), names.slice(0, 2).sort(), "each goes as a temp folder of this process does");
    assert.deepEqual(names.map((n) => fs.existsSync(path.join(os.tmpdir(), n))), [false, false, true, true]);
  } finally {
    out.release(made);
    for (const name of names) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
});
