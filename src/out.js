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
// STOP_WAIT, removes every part folder and temp folder, and ends the process
// by the same signal. A failed run ends the process the same way, with
// SIGTERM to them and exit code 1 (exit). Either way the CLI's last line
// says which folder was left as it was (told). A run killed outright
// (SIGKILL) cannot remove its part folder: a later run that ends well in the
// same place removes it, once its process is gone and nothing in it has
// changed for STALE. One killed while it put its files in place can hold
// earlier files in its .old: that part folder is never removed, but kept
// under a name no run removes, with a note of what is in it (sweep).

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

// When a process started, in ms, where /proc tells (Linux), else null.
function startOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
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
    if (s && leftBehind(pid, s.mtimeMs)) {
      // Moved aside before it is removed, so of two runs that find it left
      // only one takes it over.
      const aside = path.join(dir, `${LOCK}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.renameSync(at, aside);
        remove(aside);
      } catch {
        // Taken over by the other.
      }
      continue;
    }
    if (Date.now() - since > LOCK_WAIT) {
      throw Object.assign(new Error(`another launch-film run has been putting its files in ${shown(dir)} for ${LOCK_WAIT / 1000} s. ` +
        `If no other launch-film run is at work there, remove ${shown(at)} and run again`), { at: null });
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
  if (!stuck.length && !left.length) return new Error(`${start} ${shown(run.dir)} is as it was${held ? "; close the file and run again" : ""}.`);
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
// renamed keeps its own name, and sweep never removes it either.
function keepFolder(folder, files, what) {
  const home = shown(path.dirname(folder));
  try {
    fs.writeFileSync(path.join(folder, "launch-film-kept.txt"), `${what}:\n${files.map((f) => `  ${f}`).join("\n")}\n` +
      `They are in .old here, each by its path from ${home}. Put back the ones you want, then remove this folder: launch-film leaves it alone.\n`);
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
  // A run inside another's part folder: its outputs go in with that run's.
  const outer = [...open].filter((r) => inside(run.dir, r.part)).sort((a, b) => b.part.length - a.part.length)[0];
  if (outer) {
    const top = path.relative(outer.part, run.dir).split(path.sep)[0];
    if (top) output(outer, top, false);
    else for (const name of names) output(outer, name, run.outputs.get(name));
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
// runs each time just before it is removed: Chrome's profile takes the
// socket folder Chrome links from it along (chrome.js).
function tempDir(prefix, before = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  temps.set(dir, before);
  hook();
  return dir;
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

// A process the runs stop with them: Chrome, ffmpeg, easybrandkit.
function track(child) {
  if (!child || !child.pid) return child;
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (stopping) signal(child, "SIGKILL");
  else if (ending) signal(child, "SIGTERM");
  return child;
}

// Asks the processes the runs started to stop with the signal `name`, so
// Chrome takes its helpers with it and npx passes it on to easybrandkit,
// and calls then() once they have gone or STOP_WAIT has passed.
function settle(name, then) {
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
  for (const child of children) signal(child, "SIGKILL");
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

// Removes the part folders in `folder` that runs killed outright left: not
// a run's of this process that has not ended, nothing in them changed for
// STALE, and their process gone, or its pid now this process's (in a
// container every run can have the same pid). One whose .old holds earlier
// files (the run was killed while it put its files in place) is kept for
// them instead, and said once the run ends (noticed).
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
    if (!m || !entry.isDirectory() || ours.has(at)) continue;
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

module.exports = { begin, within, shown, said, aftermath, noticed, tempDir, release, track, listen, exit, stopping: () => stopping, sweep, STALE, LOCK };
