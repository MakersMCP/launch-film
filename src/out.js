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
// A stop (Ctrl-C, SIGTERM, SIGHUP) passes its signal on to the Chrome,
// ffmpeg and easybrandkit the runs started, kills those still running after
// STOP_WAIT, removes every part folder and temp folder, and ends the process
// by the same signal. A failed run ends the process the same way, with
// SIGTERM to them and exit code 1 (exit). Either way the CLI's last line
// says which folder was left as it was (told). A run killed outright
// (SIGKILL) cannot remove its part folder: a later run that ends well in the
// same place removes it, once its process is gone and nothing in it has
// changed for STALE.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PART = /^\.launch-film-part-(\d+)-[0-9a-f]{8}$/;
const STALE = 15 * 60 * 1000;
const STOP_WAIT = 400;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];

// The runs begun and not ended, the temp folders and the processes to stop
// with them, and every part folder with the folder its files go to.
const open = new Set();
const temps = new Set();
const children = new Set();
const places = [];
// What became of the folders of the runs a stop or a failure ended.
const told = [];
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
  const part = path.join(home, `.launch-film-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(part);
  places.push([part, target]);
  const run = {
    dir: target,
    part,
    existed: Boolean(there),
    made,
    outputs: new Map(),
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

// Moves one entry; on Windows a file another program holds open may be let
// go of in a moment, so a refused move is tried again a few times.
function move(from, to, moved, rel) {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to);
      moved.push([from, to]);
      return;
    } catch (err) {
      if (process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(err.code) && tries < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      throw Object.assign(err, { at: rel });
    }
  }
}

// Puts one output in place: a file, or a folder named whole, replaces the
// one there (moved aside into `old`); another folder takes its files in one
// by one, so the files there that this run does not make stay.
function place(from, to, rel, whole, old, moved) {
  const isFolder = fs.lstatSync(from).isDirectory();
  const there = lstat(to);
  if (there && isFolder && !isDir(to)) throw Object.assign(new Error("a file is where this run puts a folder"), { at: rel });
  if (there && !isFolder && there.isDirectory()) throw Object.assign(new Error("a folder is where this run puts a file"), { at: rel });
  if (there && isFolder && !whole) {
    for (const name of fs.readdirSync(from)) if (!name.startsWith(".")) place(path.join(from, name), path.join(to, name), path.join(rel, name), false, old, moved);
    return;
  }
  if (there) {
    const aside = path.join(old, rel);
    fs.mkdirSync(path.dirname(aside), { recursive: true });
    move(to, aside, moved, rel);
  }
  move(from, to, moved, rel);
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
      fs.renameSync(part, dir);
      return finish(run, names);
    } catch (err) {
      // Made meanwhile by another run: the files go in one by one, below.
      if (!lstat(dir)) throw failed(run, err, [], []);
    }
  }
  const old = path.join(part, ".old");
  fs.mkdirSync(old, { recursive: true });
  const moved = [];
  try {
    for (const name of names) place(path.join(part, name), path.join(dir, name), name, run.outputs.get(name), old, moved);
  } catch (err) {
    // Undone in reverse: each new file back into the part folder, each
    // earlier one back from .old.
    const stuck = [];
    const left = [];
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch {
        if (inside(to, old)) stuck.push(path.relative(part, to));
        else left.push(shown(to));
      }
    }
    throw failed(run, err, stuck, left);
  }
  finish(run, names);
}

// Why a commit failed, said for the person who runs it again.
function failed(run, err, stuck, left) {
  run.said = true;
  const at = shown(path.join(run.dir, err.at || ""));
  const held = ["EBUSY", "EPERM", "EACCES"].includes(err.code);
  const why = held ? `${at} is held open by another program, or may not be changed (${err.code})` : `${at}: ${err.message}`;
  const start = `could not put the new files in ${shown(run.dir)}: ${why}.`;
  if (!stuck.length && !left.length) return new Error(`${start} ${shown(run.dir)} is as it was${held ? "; close the file and run again" : ""}.`);
  return new Error(`${start}${stuck.length ? ` Some of the earlier files could not be put back; they are in ${keep(run, stuck)}.` : ""}` +
    `${left.length ? ` These new files could not be taken out again: ${left.join(", ")}.` : ""}`);
}

// A part folder holding earlier files that could not be put back is kept,
// under a name no run removes, with a note of what is in it.
function keep(run, stuck) {
  ended(run);
  const kept = path.join(path.dirname(run.part), path.basename(run.part).replace(/^\.launch-film-part-/, "launch-film-kept-"));
  try {
    fs.writeFileSync(path.join(run.part, "launch-film-kept.txt"), `launch-film could not put these earlier files back in ${shown(run.dir)}:\n${stuck.map((f) => `  ${f}`).join("\n")}\n` +
      "They are in .old here. Move them where they belong, then remove this folder: launch-film leaves it alone.\n");
    fs.renameSync(run.part, kept);
    return shown(kept);
  } catch {
    return shown(run.part);
  }
}

function finish(run, names) {
  ended(run);
  remove(run.part);
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
// exit when it has not been (or could not be).
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  temps.add(dir);
  hook();
  return dir;
}

function release(dir) {
  if (remove(dir)) temps.delete(dir);
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
  for (const dir of temps) remove(dir);
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

function sweep(folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const m = PART.exec(entry.name);
    if (!m || !entry.isDirectory() || Number(m[1]) === process.pid) continue;
    const at = path.join(folder, entry.name);
    if (running(Number(m[1])) || Date.now() - touched(at) < STALE) continue;
    remove(at);
  }
}

module.exports = { begin, within, shown, aftermath, tempDir, release, track, listen, exit, stopping: () => stopping, sweep, STALE };
