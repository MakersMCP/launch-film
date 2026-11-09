"use strict";
// ─── the out folder ────────────────────────────────────────────────────────
// A run makes its files in a part folder (.launch-film-part-<pid>-<hex>)
// and puts them in place only once it has ended well. The part folder is
// inside the folder the files go to when that folder is there, and next to
// it when the run makes it, so it is on the same disk and gets the same mode
// and default ACL (it is made with mkdirSync: mkdtemp's 0700 would shut out
// the others a default ACL lets in). To put the files in place, each earlier
// file or folder the run replaces is moved aside into the part folder, the
// new one is moved in, and the part folder, with the earlier files in it,
// is removed last: at no moment are both gone. A run that fails, is refused
// or is stopped removes its part folder and the folders it made for it, so
// the folder is left as it was and nothing is added to it.
//
// A run names its outputs as it writes them; anything else in its part
// folder is a work file and goes with it. A run started inside another's
// part folder (the render inside the one-go command) puts its files there,
// and they go in with the other run's when that one ends well.
//
// Two runs that put their files in one folder at once take turns (lock): the
// one that ends later replaces the other's files whole. A run that adds its
// files to a folder already there (frames/, stills/, check/) takes that
// folder's lock as well, so it takes turns with a run that puts its files in
// that folder alone. A folder the files go into that is on another disk (one
// a link leads to) takes them through a part folder of its own, so every
// move is a rename on one disk. The earlier files a run moves aside go in
// the .old of a part folder that is in the folder they come from, by their
// paths from it.
//
// A stop (Ctrl-C, SIGTERM, SIGHUP) passes its signal on to the Chrome,
// ffmpeg and easybrandkit the runs started, kills those still running after
// STOP_WAIT, with the Chrome easybrandkit started (watch), removes every
// part folder and temp folder, and ends the process by the same signal. A
// failed run ends the process the same way, with SIGTERM to them and exit
// code 1 (exit). Either way the CLI's last line says which folder was left
// as it was (told). A run killed outright (SIGKILL) cannot remove its part
// folder: a later run that ends well in the same place removes it, once its
// process is gone and nothing in it has changed for STALE. One killed while
// it put its files in place can hold earlier files in its .old: that part
// folder is never removed, but kept under a name no run removes, with a
// note of what is in it (sweep). Only this user's own part folders and temp
// folders are looked at: in a folder others write to as well (/tmp), what
// another user left, or put there to look like a run's, is left alone.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PART = /^\.launch-film-part-(\d+)-[0-9a-f]{8}$/;
const STALE = 15 * 60 * 1000;
const STOP_WAIT = 400;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
// The commit lock, how long a run waits for another's commit to end (a
// commit takes a moment), and the age past which a lock was left by a run
// killed outright, whatever process now has its pid.
const LOCK = ".launch-film-commit";
const LOCK_WAIT = 10 * 1000;
const LOCK_STALE = 60 * 1000;

// The runs begun and not ended, the temp folders (each with what to do
// before it is removed) and the processes to stop with them, and every part
// folder with the folder its files go to.
const open = new Set();
const temps = new Map();
const children = new Set();
const places = [];
// What became of the folders of the runs a stop or a failure ended, and
// what the runs that ended well found left by runs killed outright.
const told = [];
const found = [];
let stopping = null;
// A failed run is ending the process (exit).
let ending = false;
let hooked = false;
let listening = false;

const lstat = (at) => fs.lstatSync(at, { throwIfNoEntry: false });
const isDir = (at) => {
  try {
    return fs.statSync(at).isDirectory();
  } catch {
    return false;
  }
};
const inside = (at, folder) => {
  const rel = path.relative(folder, at);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const partName = () => `.launch-film-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const uid = () => (typeof process.getuid === "function" ? process.getuid() : null);

// Whether `at` is a folder of this user's own, and not a link to one. A
// system without users (Windows) has every folder its user's.
function mine(at) {
  const s = lstat(at);
  return Boolean(s) && s.isDirectory() && (uid() === null || s.uid === uid());
}

// A name on one line: a line break or another control character in it,
// and a backslash, are written escaped.
const ESCAPES = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const plain = (name) => String(name).replace(/[\\\p{Cc}\u2028\u2029]/gu, (c) => ESCAPES[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Whether it is gone: a folder another program is still writing to, or
// holds open (on Windows), may stay.
function remove(at) {
  try {
    fs.rmSync(at, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

function stoppedError() {
  return Object.assign(new Error("stopped"), { stopped: true });
}

// A path or a message with the part folders in it, as the paths will be
// once the runs have ended well: the innermost run's first.
function shown(text) {
  let s = String(text);
  for (let i = places.length - 1; i >= 0; i--) s = s.split(places[i][0]).join(places[i][1]);
  return s;
}

// A failure's message, as shown(), with a file in a part folder named as
// the new one: the run made it, and the earlier file of that name, which
// it does not touch, is as it was. A path in quotes is only shown().
function said(text) {
  const mark = "\u0001";
  let s = String(text);
  for (let i = places.length - 1; i >= 0; i--) {
    const [part, target] = places[i];
    s = s.split(part + path.sep).join(`${mark}${target}${path.sep}`).split(part).join(target);
  }
  return s.replace(/\u0001+/g, mark).replace(/(^|[\s(])\u0001/g, "$1the new ").split(mark).join("");
}

// However the process ends, no part folder of a run that has not ended is
// left behind, no temp folder, and no process the runs started.
function hook() {
  if (hooked) return;
  hooked = true;
  process.on("exit", endAll);
}

// Begins a run that makes files for the folder `dir`. run.out(name) is
// where it writes the output `name` (a file, or a folder it adds its files
// to), run.folder(name) where it writes a folder that replaces the one of
// that name; run.part is its part folder, for work files.
function begin(dir) {
  if (stopping) throw stoppedError();
  const target = path.resolve(dir);
  const there = lstat(target);
  if (there && !isDir(target)) throw new Error(`${shown(target)} is a file, not a folder`);
  const home = there ? target : path.dirname(target);
  const made = [];
  // Up to the root at most: on Windows a drive that is not there has none.
  for (let at = home; !fs.existsSync(at) && path.dirname(at) !== at; at = path.dirname(at)) made.push(at);
  fs.mkdirSync(home, { recursive: true });
  const part = path.join(home, partName());
  fs.mkdirSync(part);
  places.push([part, target]);
  const run = {
    dir: target,
    part,
    existed: Boolean(there),
    made,
    outputs: new Map(),
    // Part folders made in folders on another disk, as the run commits.
    stages: [],
    ended: false,
    // Its failure has said what became of its folder.
    said: false,
    out: (name) => output(run, name, false),
    folder: (name) => output(run, name, true),
    commit: () => commit(run),
    discard: () => discard(run),
  };
  open.add(run);
  hook();
  return run;
}

function output(run, name, whole) {
  if (!name || name !== path.basename(name) || name.startsWith(".launch-film-")) throw new Error(`"${name}" cannot be an output's name`);
  run.outputs.set(name, whole || run.outputs.get(name) || false);
  return path.join(run.part, name);
}

// Runs fn(run) and puts its outputs in place when it resolves; removes them
// when it throws.
async function within(dir, fn) {
  const run = begin(dir);
  try {
    const result = await fn(run);
    run.commit();
    return result;
  } catch (err) {
    run.discard();
    throw err;
  }
}

function ended(run) {
  run.ended = true;
  open.delete(run);
}

// Renames; on Windows a file another program holds open (a virus scanner
// looking at a new file) may be let go of in a moment, so a refused rename
// is tried again a few times, unless `done()` says there is no point.
function rename(from, to, done = () => false) {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(err.code) && tries < 5 && !done()) {
        pause(100);
        continue;
      }
      throw err;
    }
  }
}

// Moves one entry, and notes the move so it can be undone.
function move(from, to, moved, rel) {
  try {
    rename(from, to);
  } catch (err) {
    throw Object.assign(err, { at: rel });
  }
  moved.push([from, to]);
}

// Puts one output in place: a file, or a folder named whole, replaces the
// one there (moved aside into the `old` folder of ctx, by its path from
// ctx.home); another folder takes its files in one by one, so the files
// there that this run does not make stay. A folder on another disk than the
// new files gets them through a part folder of its own in it, the earlier
// files aside there too.
function place(ctx, from, to, rel, whole) {
  const isFolder = fs.lstatSync(from).isDirectory();
  const there = lstat(to);
  if (there && isFolder && !isDir(to)) throw Object.assign(new Error("a file is where this run puts a folder"), { at: rel });
  if (there && !isFolder && there.isDirectory()) throw Object.assign(new Error("a folder is where this run puts a file"), { at: rel });
  if (there && isFolder && !whole) {
    // A run that puts its files in this folder alone (frames, stills or
    // check on their own) takes turns with this one.
    ctx.unlocks.push(lock(to, ctx.run.dir));
    let into = ctx;
    let source = from;
    if (fs.statSync(to).dev !== fs.statSync(from).dev) {
      source = path.join(to, partName());
      fs.mkdirSync(source);
      ctx.run.stages.push(source);
      for (const name of fs.readdirSync(from)) if (!name.startsWith(".")) fs.cpSync(path.join(from, name), path.join(source, name), { recursive: true });
      into = { ...ctx, old: path.join(source, ".old"), home: to };
    }
    for (const name of fs.readdirSync(source)) if (!name.startsWith(".")) place(into, path.join(source, name), path.join(to, name), path.join(rel, name), false);
    return;
  }
  if (there) {
    const aside = path.join(ctx.old, path.relative(ctx.home, to));
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    move(to, aside, ctx.moved, rel);
  }
  move(from, to, ctx.moved, rel);
}

// A process's fields in /proc/<pid>/stat after its name (Linux), else null:
// [1] is its parent's pid, [19] when it started in clock ticks since boot.
function statOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

// When a process started, in ms, where /proc tells (Linux), else null.
function startOf(pid) {
  try {
    const ticks = Number((statOf(pid) || [])[19]);
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))[1]);
    // The clock ticks a hundred times a second on Linux.
    return Number.isFinite(ticks) && boot ? (boot + ticks / 100) * 1000 : null;
  } catch {
    return null;
  }
}

// Whether a lock made at `made` and holding `pid` (0 when it never got one)
// was left by a process killed outright: its process is gone, or the pid is
// this process's own or that of a process started after the lock was made
// (a pid used again, as in a container where every run has the same one),
// or the lock is older than a commit takes.
function leftBehind(pid, made) {
  if (Date.now() - made > LOCK_STALE) return true;
  if (!pid) return Date.now() - made > 2000;
  if (pid === process.pid || !running(pid)) return true;
  const started = startOf(pid);
  return started !== null && started > made + 2000;
}

// Takes the commit lock of `dir`: a folder named LOCK in it, holding the pid
// of the process that has it. A lock left by a process killed outright is
// taken over (leftBehind). Errors name the lock by its path from `base`, the
// run's folder. Returns what lets it go.
function lock(dir, base = dir) {
  const at = path.join(dir, LOCK);
  const since = Date.now();
  for (;;) {
    let made = false;
    try {
      fs.mkdirSync(at);
      made = true;
      fs.writeFileSync(path.join(at, "pid"), String(process.pid));
      return () => remove(at);
    } catch (err) {
      // One that could not get its pid, as on a full disk, is not left.
      if (made) remove(at);
      if (made || err.code !== "EEXIST") throw Object.assign(err, { at: path.relative(base, at) });
    }
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(path.join(at, "pid"), "utf8")) || 0;
    } catch {
      // Not written yet, or let go meanwhile.
    }
    const s = lstat(at);
    // Why a lock left behind could not be moved aside: another user's in a
    // folder with the sticky bit, or one a program holds open on Windows.
    // Such a lock is waited for as one another run holds, and then refused.
    let stuck = null;
    if (s && leftBehind(pid, s.mtimeMs)) {
      // Moved aside before it is removed, so of two runs that find it left
      // only one takes it over.
      const aside = path.join(dir, `${LOCK}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.renameSync(at, aside);
        remove(aside);
        continue;
      } catch (err) {
        // Gone meanwhile: the other run took it over.
        if (err.code === "ENOENT") continue;
        stuck = err.code || err.message;
      }
    }
    if (Date.now() - since > LOCK_WAIT) {
      const whose = s && uid() !== null && s.uid !== uid() ? `, which belongs to another user (uid ${s.uid}),` : "";
      throw Object.assign(new Error(stuck ? `${shown(at)}${whose} was left by a launch-film run that is gone and cannot be moved aside (${stuck}). Remove it and run again`
        : `another launch-film run has been putting its files in ${shown(dir)} for ${LOCK_WAIT / 1000} s. If no other launch-film run is at work there, remove ${shown(at)}${whose} and run again`), { at: null });
    }
    pause(20);
  }
}

// Puts the run's outputs in place, synchronously, so no stop comes in the
// middle of it. A move that fails puts back what was moved.
function commit(run) {
  if (run.ended) return;
  if (stopping) throw stoppedError();
  const { part, dir } = run;
  const names = [...run.outputs.keys()].filter((name) => lstat(path.join(part, name)));
  if (!lstat(dir)) {
    // The run makes the folder: its part folder becomes it, less the work
    // files.
    for (const name of fs.readdirSync(part)) if (!run.outputs.has(name)) remove(path.join(part, name));
    try {
      rename(part, dir, () => Boolean(lstat(dir)));
      return finish(run, names);
    } catch (err) {
      // Made meanwhile by another run: the files go in one by one, below.
      if (!lstat(dir)) throw failed(run, err, [], []);
    }
  }
  // Another run putting its files here waits for this one, and this one for
  // it: what each finds there is read once it has its turn.
  let unlock;
  try {
    unlock = lock(dir);
  } catch (err) {
    throw failed(run, err, [], []);
  }
  // The locks of the folders already there that take files one by one,
  // held until the files are in place or put back.
  const unlocks = [];
  try {
    const ctx = { run, old: null, home: dir, moved: [], unlocks };
    try {
      // The earlier files go aside in a part folder in this folder: the
      // run's own, or, when the run's is next to it (the folder was made
      // meanwhile), one made here for them.
      let aside = part;
      if (path.dirname(part) !== dir) {
        aside = path.join(dir, partName());
        fs.mkdirSync(aside);
        run.stages.push(aside);
      }
      ctx.old = path.join(aside, ".old");
      fs.mkdirSync(ctx.old, { recursive: true });
      for (const name of names) place(ctx, path.join(part, name), path.join(dir, name), name, run.outputs.get(name));
    } catch (err) {
      // Undone in reverse: each new file back to where it came from, each
      // earlier one back from where it was put aside.
      const asides = [part, ...run.stages];
      const stuck = [];
      const left = [];
      for (const [from, to] of ctx.moved.reverse()) {
        try {
          fs.renameSync(to, from);
        } catch {
          if (asides.some((a) => inside(to, a))) stuck.push(to);
          else left.push(shown(to));
        }
      }
      throw failed(run, err, stuck, left);
    }
  } finally {
    for (const letGo of unlocks.reverse()) letGo();
    unlock();
  }
  finish(run, names);
}

// Why a commit failed, said for the person who runs it again.
function failed(run, err, stuck, left) {
  run.said = true;
  const at = shown(path.join(run.dir, err.at || ""));
  const held = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
  // A message that names its own paths (a lock another run holds) is said
  // as it is.
  const why = err.at === null ? err.message : held ? `${at} is held open by another program, or may not be changed (${err.code})` : `${at}: ${err.message}`;
  const start = `could not put the new files in ${shown(run.dir)}: ${why}.`;
  if (!stuck.length && !left.length) {
    // Told of again by a stop that comes before this failure is: a commit
    // waits for a lock for a while.
    if (![...open].some((r) => r !== run && inside(run.dir, r.part))) told.push(`${shown(run.dir)} is as it was`);
    return new Error(`${start} ${shown(run.dir)} is as it was${held ? "; close the file and run again" : ""}.`);
  }
  return new Error(`${start}${stuck.length ? ` Some of the earlier files could not be put back; they are in ${keep(run, stuck)}.` : ""}` +
    `${left.length ? ` These new files could not be taken out again: ${left.join(", ")}.` : ""}`);
}

// A part folder holding earlier files that could not be put back is kept,
// under a name no run removes, with a note of what is in it: the run's own,
// or one it made in the folder or in a folder on another disk.
function keep(run, stuck) {
  ended(run);
  const kept = [];
  for (const folder of [run.part, ...run.stages]) {
    const mine = stuck.filter((f) => inside(f, path.join(folder, ".old"))).map((f) => path.relative(path.join(folder, ".old"), f));
    if (mine.length) kept.push(keepFolder(folder, mine, `launch-film could not put these earlier files back in ${shown(path.dirname(folder))}`));
  }
  // The rest of what the run made goes.
  for (const folder of [run.part, ...run.stages]) if (lstat(folder) && !kept.includes(folder)) remove(folder);
  return kept.join(" and ");
}

// Keeps a part folder whose .old holds earlier files `files` (their paths
// from the folder it is in), under a name no run removes, with a note that
// starts with `what`. Returns where the files are: a folder that cannot be
// renamed keeps its own name, and sweep never removes it either. The note
// is made as a new file, so a link or a file of its name already there is
// never written through; the folder is kept without it then. Each file is
// listed on a line of its own, whatever its name holds.
function keepFolder(folder, files, what) {
  const home = shown(path.dirname(folder));
  try {
    fs.writeFileSync(path.join(folder, "launch-film-kept.txt"), `${what}:\n${files.map((f) => `  ${plain(f)}`).join("\n")}\n` +
      `They are in .old here, each by its path from ${home}. Put back the ones you want, then remove this folder: launch-film leaves it alone.\n`, { flag: "wx" });
  } catch {
    // Kept all the same.
  }
  const name = path.join(path.dirname(folder), path.basename(folder).replace(/^\.launch-film-part-/, "launch-film-kept-"));
  try {
    fs.renameSync(folder, name);
    return name;
  } catch {
    return folder;
  }
}

function finish(run, names) {
  ended(run);
  remove(run.part);
  for (const stage of run.stages) remove(stage);
  // A run inside another's part folder: its outputs go in with that run's,
  // and what runs killed outright left is seen to once that run has ended
  // well, so a run that fails after it leaves the folder as it was.
  const outer = [...open].filter((r) => inside(run.dir, r.part)).sort((a, b) => b.part.length - a.part.length)[0];
  if (outer) {
    const top = path.relative(outer.part, run.dir).split(path.sep)[0];
    if (top) output(outer, top, false);
    else for (const name of names) output(outer, name, run.outputs.get(name));
    return;
  }
  sweep(run.dir);
  sweep(path.dirname(run.dir));
}

// Removes a run's part folder and the folders it made for it.
function discard(run) {
  if (run.ended) return;
  // A run inside another's goes with it, and the outer one is told of; a
  // run whose commit failed has told of its folder itself.
  if (!run.said && ![...open].some((r) => r !== run && inside(run.dir, r.part))) told.push(run.existed ? `${shown(run.dir)} is as it was` : `${shown(run.dir)} was not made`);
  ended(run);
  remove(run.part);
  for (const stage of run.stages) remove(stage);
  for (const folder of run.made) {
    try {
      // Empty ones only: another run may be at work in one.
      fs.rmdirSync(folder);
    } catch {
      break;
    }
  }
}

// What became of the folders of the runs that failed, said once: the CLI
// ends its failure with it.
function aftermath() {
  const said = [...new Set(told)];
  told.length = 0;
  return said;
}

// ─── temp folders and processes ────────────────────────────────────────────
// A folder in the system's temp folder, named for the process that made it
// (<prefix><pid>-<random>), removed with release(), and on a stop or at
// exit when it has not been (or could not be). before(dir), when given,
// runs each time just before it is removed: Chrome's profile ends what
// still uses it and takes the socket folder Chrome links from it along
// (chrome.js). The first time a process makes one of a kind, it removes the
// ones of that kind whose process is gone, or whose pid is its own now,
// the same way: a run killed outright leaves them.
const swept = new Set();
function tempDir(prefix, before = null) {
  if (!swept.has(prefix)) {
    swept.add(prefix);
    sweepTemps(prefix, before);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  temps.set(dir, before);
  hook();
  return dir;
}

// The temp folders of a kind that runs killed outright left: this user's
// own, whose process is gone or has this process's pid now. A folder
// another user put in a shared temp folder under such a name is left alone,
// and before() never runs on it: a profile's link there can lead anywhere.
function sweepTemps(prefix, before) {
  const named = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)-[A-Za-z0-9]{6}$`);
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const m = named.exec(entry.name);
    const at = path.join(os.tmpdir(), entry.name);
    if (!m || !entry.isDirectory() || temps.has(at) || !mine(at)) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && running(pid)) continue;
    if (before) {
      try {
        before(at);
      } catch {
        // The folder goes all the same.
      }
    }
    remove(at);
  }
}

function clear(dir) {
  const before = temps.get(dir);
  if (before) {
    try {
      before(dir);
    } catch {
      // The folder goes all the same.
    }
  }
  return remove(dir);
}

function release(dir) {
  if (clear(dir)) temps.delete(dir);
}

function signal(child, name) {
  try {
    child.kill(name);
  } catch {
    // Gone already.
  }
}

function kill(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already.
  }
}

// Whether a process runs, an ended one that waits to be reaped aside.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = statOf(pid);
  return !stat || stat[0] !== "Z";
}

// ─── Chrome's profiles ─────────────────────────────────────────────────────
// The processes that use a Chrome profile: Chrome names it in the command
// line of each of them, its helpers' too. Read from /proc, so on Linux only.
function usersOf(profile) {
  const flag = `--user-data-dir=${profile}`;
  const pids = [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
      const at = cmd.indexOf(flag);
      if (at >= 0 && /^[\0 ]?$/.test(cmd.charAt(at + flag.length))) pids.push(Number(name));
    } catch {
      // Gone meanwhile.
    }
  }
  return pids;
}

// Whether a folder is right in the system's temp folder.
function inTemp(folder) {
  try {
    return fs.realpathSync(path.dirname(folder)) === fs.realpathSync(os.tmpdir());
  } catch {
    return false;
  }
}

// Chrome links SingletonSocket in its profile to a socket in a temp folder
// of its own (com.google.Chrome.XXXXXX), and removes both as it closes. One
// stopped while it closes, or killed outright, leaves that folder behind,
// so the folder is read from the link while Chrome is up, and goes with the
// profile. Returns it, or null. Only a profile of this user's own is read,
// and only a folder of this user's own is given: a profile another user
// left in a shared temp folder can link anywhere.
function socketFolder(profile) {
  try {
    if (!mine(profile)) return null;
    const folder = path.dirname(fs.readlinkSync(path.join(profile, "SingletonSocket")));
    if (/^\.?(com\.google\.Chrome|org\.chromium\.Chromium)\.\w+$/.test(path.basename(folder)) && inTemp(folder) && mine(folder)) return folder;
  } catch {
    // No such link.
  }
  return null;
}

// Run just before a profile is removed: what still uses it is ended first,
// since Chrome's helpers, still closing or left by a Chrome killed outright,
// wrote into it after it was removed and so kept it, and the socket folder
// Chrome made for it (`socket`, else read from its link) goes with it.
function closeProfile(profile, socket = null) {
  const pids = usersOf(profile);
  for (const pid of pids) kill(pid);
  for (let i = 0; i < 100 && pids.some(alive); i++) pause(10);
  const folder = socket || socketFolder(profile);
  if (folder) remove(folder);
}

// The processes below `pids`, all the way down: [{ pid, start }]. Read from
// /proc (Linux); elsewhere none.
function below(pids) {
  if (!pids.length) return [];
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const kids = new Map();
  for (const name of names) {
    const stat = /^\d+$/.test(name) ? statOf(name) : null;
    if (!stat) continue;
    if (!kids.has(stat[1])) kids.set(stat[1], []);
    kids.get(stat[1]).push({ pid: Number(name), start: stat[19] });
  }
  const found = [];
  for (const queue = pids.map(String); queue.length; ) {
    for (const kid of kids.get(queue.shift()) || []) {
      found.push(kid);
      queue.push(String(kid.pid));
    }
  }
  return found;
}

// easybrandkit runs a Chrome of its own, and (0.4.0) on a stop neither ends
// it nor removes its profile: a stop sent to launch-film alone left that
// Chrome running for good, and Ctrl-C left its profile in the temp folder.
// So the processes below one started with { watch: true } are looked at
// while it runs, four times a second, and again as a stop or a failure
// begins, and the profiles in the temp folder that the Chromes among them
// use are noted with their socket folders: Ctrl-C ends easybrandkit at once,
// and its Chrome is out of its tree before launch-film can look. The stop
// or the failure ends those processes, and every process that uses one of
// those profiles wherever it has been moved since, and removes the profiles
// (Linux, where /proc tells).
const watched = new Set();
const theirs = new Map();
const below0 = [];
let watcher = null;

// The Chrome profile a process names on its command line, or null. Chrome
// writes its command line over once it runs, as one line with spaces, so
// the value ends at a NUL, or in that form at a space.
function profileOf(pid) {
  let cmd = "";
  try {
    cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  const m = /(?:^|[\0 ])--user-data-dir=([^\0]+)/.exec(cmd);
  if (!m) return null;
  return path.resolve(cmd.replace(/\0+$/, "").includes("\0") ? m[1] : m[1].split(" ")[0]);
}

function note(list) {
  for (const p of list) {
    const profile = profileOf(p.pid);
    if (!profile || temps.has(profile) || theirs.get(profile) || !inTemp(profile)) continue;
    theirs.set(profile, socketFolder(profile));
  }
  return list;
}

function watch(child) {
  if (!fs.existsSync("/proc/self/stat")) return;
  watched.add(child);
  child.once("exit", () => {
    watched.delete(child);
    // One that ended well took its Chrome and profile with it.
    for (const profile of theirs.keys()) if (!lstat(profile)) theirs.delete(profile);
  });
  if (watcher) return;
  watcher = setInterval(() => {
    if (watched.size) note(below([...watched].map((c) => c.pid)));
    else {
      clearInterval(watcher);
      watcher = null;
    }
  }, 250);
  watcher.unref();
}

// Whether a process noted as { pid, start } is still that process.
function same(p) {
  const stat = statOf(p.pid);
  return Boolean(stat) && stat[19] === p.start;
}

// Ends the processes `list` that are still the ones noted, and what uses
// the profiles noted, and removes those profiles.
function endTheirs(list) {
  for (const p of list) if (same(p)) kill(p.pid);
  below0.length = 0;
  for (const [profile, socket] of theirs) {
    closeProfile(profile, socket);
    if (mine(profile)) remove(profile);
  }
  theirs.clear();
}

// A process the runs stop with them: Chrome, ffmpeg, easybrandkit. With
// watch, the processes it starts are stopped with it too (above).
function track(child, { watch: tree = false } = {}) {
  if (!child || !child.pid) return child;
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (tree) watch(child);
  if (stopping) signal(child, "SIGKILL");
  else if (ending) signal(child, "SIGTERM");
  return child;
}

// Asks the processes the runs started to stop with the signal `name`, so
// Chrome takes its helpers with it and npx passes it on to easybrandkit,
// and calls then() once they have gone or STOP_WAIT has passed. What runs
// below the watched ones is noted first: once easybrandkit has ended, the
// system moves its Chrome out of its tree.
function settle(name, then) {
  below0.push(...note(below([...watched].map((c) => c.pid))));
  for (const child of children) signal(child, name);
  const since = Date.now();
  const wait = setInterval(() => {
    if (children.size && Date.now() - since < STOP_WAIT) return;
    clearInterval(wait);
    then();
  }, 20);
}

// Stops what is left: the processes, the runs not ended (the innermost
// first) and the temp folders.
function endAll() {
  // What runs below the watched processes is looked at before they are
  // killed, while their tree is whole, and what ran there as the stop began
  // again: a process that was only starting then can be a Chrome now.
  const now = note([...below0, ...below([...watched].map((c) => c.pid))].filter(same));
  for (const child of children) signal(child, "SIGKILL");
  endTheirs(now);
  for (const run of [...open].reverse()) discard(run);
  for (const dir of temps.keys()) clear(dir);
  temps.clear();
}

// Ctrl-C, SIGTERM or SIGHUP: the signal goes on to the processes the runs
// started, so easybrandkit under npx and Chrome can end on their own; those
// still running after STOP_WAIT are killed. Then the runs and temp folders
// are removed and the process ends by the same signal. A second signal in
// the meantime (a cancel sends one to the whole process group, and a
// supervisor may pass it on again) is let go, so the clean-up finishes.
function onSignal(name) {
  if (stopping) return;
  stopping = name;
  settle(name, () => {
    endAll();
    // Written at once: the process ends by the signal right after.
    try {
      fs.writeSync(2, `launch-film: stopped${told.length ? `, so ${[...new Set(told)].join(" and ")}` : ""}\n`);
    } catch {
      // No one to tell.
    }
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    // Where the signal does not end the process (Windows), the exit code
    // a shell gives for it.
    setTimeout(() => process.exit(128 + (os.constants.signals[name] || 0)), 500);
    try {
      process.kill(process.pid, name);
    } catch {
      // Not a signal this system sends.
    }
  });
}

// Ends the process with `code` after a run failed, once the processes the
// runs started have stopped as at Ctrl-C: Chrome killed outright left its
// helpers writing to its profile after the profile was removed. The exit
// removes the temp folders and what the runs left (endAll).
function exit(code) {
  if (stopping || ending) return;
  ending = true;
  process.exitCode = code;
  if (!children.size) process.exit(code);
  settle("SIGTERM", () => process.exit(code));
}

// Called once by the CLI: library use keeps its own signal handling.
function listen() {
  if (listening) return;
  listening = true;
  for (const s of SIGNALS) process.on(s, onSignal);
}

// ─── part folders left by runs killed outright ─────────────────────────────
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The newest time anything in a folder changed, two levels down.
function touched(folder) {
  let newest = 0;
  const look = (at, depth) => {
    const s = lstat(at);
    if (!s) return;
    newest = Math.max(newest, s.mtimeMs);
    if (depth > 0 && s.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(at);
      } catch {
        return;
      }
      for (const name of names) look(path.join(at, name), depth - 1);
    }
  };
  look(folder, 2);
  return newest;
}

// What a part folder's .old holds: the paths of its entries, a folder's
// with a / at its end.
function earlier(part) {
  const old = path.join(part, ".old");
  const list = [];
  const walk = (at, rel) => {
    let names = [];
    try {
      names = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      let inner = 0;
      try {
        inner = e.isDirectory() ? fs.readdirSync(path.join(at, e.name)).length : 0;
      } catch {
        // Listed as a folder.
      }
      if (inner) walk(path.join(at, e.name), r);
      else list.push(e.isDirectory() ? `${r}/` : r);
    }
  };
  walk(old, "");
  return list;
}

// Removes the part folders in `folder` that runs killed outright left: this
// user's own, not a run's of this process that has not ended, nothing in
// them changed for STALE, and their process gone, or its pid now this
// process's (in a container every run can have the same pid). One whose
// .old holds earlier files (the run was killed while it put its files in
// place) is kept for them instead, and said once the run ends (noticed).
function sweep(folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  const ours = new Set([...open].flatMap((r) => [r.part, ...r.stages]));
  for (const entry of entries) {
    const m = PART.exec(entry.name);
    const at = path.join(folder, entry.name);
    if (!m || !entry.isDirectory() || ours.has(at) || !mine(at)) continue;
    const pid = Number(m[1]);
    if (Date.now() - touched(at) < STALE || (pid !== process.pid && running(pid))) continue;
    const files = earlier(at);
    if (!files.length) {
      remove(at);
      continue;
    }
    const kept = keepFolder(at, files, `A launch-film run (process ${m[1]}) was killed while it put its files in place in ${shown(folder)}, and left these earlier files it had moved aside`);
    found.push(`a launch-film run killed while it put its files in ${shown(folder)} left earlier files in ${shown(kept)}; launch-film-kept.txt there lists them`);
  }
}

// What the runs that ended well found left by runs killed outright, said
// once: the CLI ends with it.
function noticed() {
  const said = [...new Set(found)];
  found.length = 0;
  return said;
}

module.exports = { begin, within, shown, said, aftermath, noticed, tempDir, release, track, listen, exit, stopping: () => stopping, sweep,
  socketFolder, closeProfile, STALE, LOCK };
