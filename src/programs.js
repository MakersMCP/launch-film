"use strict";
// ─── the programs launch-film runs ─────────────────────────────────────────
// ffmpeg, ffprobe and Chrome, each named by a variable or looked for on PATH
// (Chrome also where it installs itself). A command looks at the ones it runs
// before any work, so one that cannot be started stops it there, with no
// folder made and nothing left in the temp folder, and is named with the
// variable or the PATH entry that gave it, what is wrong with it and how to
// point to one that works. The system says little: ENOENT for a script whose
// interpreter or a program whose loader is missing, EACCES for a folder, and a
// file that is no program it hands to /bin/sh, which reads it as a script. So
// a program is looked at as the system would start it, through links, with
// this user's permissions and by what its first bytes say it is, and on PATH
// it passes over what the system passes over. ffmpeg and ffprobe are then
// asked their version, which shows a library they need that is missing and a
// program that is not them; Chrome is asked only when it is a program itself,
// not a script that starts one, as Google Chrome's own google-chrome is, since
// a script in Chrome's place need not answer it.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getSystemErrorMap } = require("util");

const WINDOWS = process.platform === "win32";
const SYSTEM = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform] || process.platform;

// The system's words for an error, as "too many symbolic links encountered".
const worded = (err) => (getSystemErrorMap().get(err.errno) || [])[1] || err.code || String(err.message || err);

const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

// What keeps the system from reaching a path on the way to it: a file where a
// folder should be, or a folder this user may not enter. "" when nothing does.
function inTheWay(file) {
  const folders = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    folders.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of folders) {
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      return "";
    }
    if (!stat.isDirectory()) return `is not there, as ${dir} is a file, not a folder`;
    try {
      fs.accessSync(dir, fs.constants.X_OK);
    } catch {
      return `is in ${dir}, a folder this user may not enter`;
    }
  }
  return "";
}

// The point a file system that runs no program is mounted at, when `file` is
// on one (mounted noexec, as /tmp and /dev/shm are on some servers). Linux
// only; "" elsewhere and when its file system runs programs.
function noexecMount(file) {
  if (process.platform !== "linux") return "";
  let info;
  try {
    info = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
  let at = file;
  try {
    at = fs.realpathSync(file);
  } catch {
    // As it is named.
  }
  let found = null;
  for (const line of info.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 7) continue;
    // A space, a tab, a line break or a backslash in it is written \040,
    // \011, \012 or \134.
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const inside = at === point || at.startsWith(point.endsWith("/") ? point : `${point}/`);
    // The deepest mount point holds the file; of two at one point, the one
    // mounted last.
    if (inside && (!found || point.length >= found.point.length)) found = { point, noexec: fields[5].split(",").includes("noexec") };
  }
  return found && found.noexec ? found.point : "";
}

// The processors of ELF programs by their number, and this machine's.
const MACHINES = { 3: "32-bit x86", 8: "MIPS", 20: "32-bit PowerPC", 21: "64-bit PowerPC", 22: "IBM Z", 40: "32-bit ARM", 62: "x86-64", 183: "64-bit ARM", 243: "RISC-V", 258: "LoongArch" };
const ARCH = { ia32: 3, mips: 8, mipsel: 8, ppc: 20, ppc64: 21, s390x: 22, arm: 40, x64: 62, arm64: 183, riscv64: 243, loong64: 258 };

function readAt(fd, offset, length) {
  const bytes = Buffer.alloc(Math.max(0, Math.min(length, 1 << 16)));
  return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, offset));
}

// An ELF program's processor and the loader it names (PT_INTERP).
function elfOf(fd, head) {
  const wide = head[4] === 2;
  const little = head[5] !== 2;
  const u16 = (b, at) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (b, at) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  const word = (b, at) => (wide ? Number(little ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at)) : u32(b, at));
  const machine = u16(head, 18);
  let loader = "";
  try {
    const table = word(head, wide ? 0x20 : 0x1c);
    const size = u16(head, wide ? 0x36 : 0x2a);
    const count = Math.min(u16(head, wide ? 0x38 : 0x2c), 128);
    const headers = readAt(fd, table, size * count);
    for (let i = 0; i < count; i++) {
      if (u32(headers, i * size) !== 3) continue;
      const offset = word(headers, i * size + (wide ? 8 : 4));
      const length = word(headers, i * size + (wide ? 32 : 16));
      loader = readAt(fd, offset, Math.min(length, 4096)).toString("latin1").replace(/\0[\s\S]*$/, "");
      break;
    }
  } catch {
    // A header cut short: no loader known.
  }
  return { machine, loader };
}

// What a file holds, from its first bytes: { empty }, { script: { program,
// rest } } from its #! line, { elf }, { windows }, { macos }, { text } for
// text with no #! line, { binary } for anything else, {} when it cannot be
// read.
function kindOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = readAt(fd, 0, 4096);
    if (!head.length) return { empty: true };
    if (head[0] === 0x23 && head[1] === 0x21) {
      // The system takes the program up to a space or a tab, a carriage
      // return a file saved on Windows leaves there included.
      const end = head.indexOf(0x0a);
      const [, program, rest] = /^[ \t]*([^ \t]*)[ \t]*(.*?)[ \t]*$/s.exec(head.subarray(2, end < 0 ? head.length : end).toString("latin1"));
      return { script: { program, rest } };
    }
    if (head.length >= 52 && head.readUInt32BE(0) === 0x7f454c46) return { elf: elfOf(fd, head) };
    if (head[0] === 0x4d && head[1] === 0x5a) return { windows: true };
    const magic = head.length >= 8 ? head.readUInt32BE(0) : 0;
    // Mach-O, 32 and 64 bits in either byte order, and a universal file of a
    // few of them, which a Java class file, of the same magic, is not.
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic) || ((magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 20)) return { macos: true };
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    } catch {
      return { binary: true };
    }
    return /[\0-\x08\x0e-\x1a\x1c-\x1f\x7f]/.test(text) ? { binary: true } : { text: true };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A program this user may run, as a file.
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The first program by `name` on PATH, as the system finds it, or "".
function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const file = path.resolve(dir || ".", name);
    if (runnable(file)) return file;
  }
  return "";
}

// What is wrong with a script's #! line, or "". `depth` keeps a script that
// names itself, or a ring of them, from being followed for good.
function scriptTrouble({ program, rest }, depth) {
  if (!program) return "is a script whose #! line names no program";
  if (program.endsWith("\r")) return "is a script with Windows line ends, so its #! line names a program whose name ends in a carriage return, which is not there";
  if (depth > 4) return "";
  const looked = look(program, depth + 1);
  if (looked.missing) return `is a script whose #! line names ${program}, which is not there`;
  if (looked.folder) return `is a script whose #! line names ${program}, a folder`;
  if (looked.trouble && !looked.script) return `is a script whose #! line names ${program}, which may not be run`;
  // env looks the program it starts up on PATH.
  if (path.basename(program) === "env") {
    const words = rest.replace(/^-S\s*/, "").split(/[ \t]+/).filter((w) => w && !w.startsWith("-") && !w.includes("="));
    const wanted = words[0];
    if (wanted && !wanted.includes("/") && !onPath(wanted)) return `is a script whose #! line has env start ${wanted}, which is not on your PATH`;
    if (wanted && wanted.includes("/") && !runnable(wanted)) return `is a script whose #! line has env start ${wanted}, which ${exists(wanted) ? "may not be run" : "is not there"}`;
  }
  return "";
}

// What is at `file` as a program: { missing } when nothing is there, and
// `trouble`, what keeps it from being one that runs, or "" when nothing does
// (it may still fail to start, which only running it shows). `skip` is set
// when the system, looking on PATH, passes over it for the next one: a
// folder, a file it may not run, and one whose interpreter or loader is not
// there.
function look(file, depth = 0) {
  let link;
  try {
    link = fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ELOOP") return { trouble: "goes round a loop of links", skip: true };
    if (err.code === "ENAMETOOLONG") return { trouble: "is a path longer than the system takes", skip: true };
    // Nothing there, also when a file stands where a folder should be or a
    // folder on the way may not be entered: the system passes over it on
    // PATH as over nothing at all (missing).
    const way = ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(err.code) ? inTheWay(file) : "";
    return { missing: true, trouble: way || "is not there", skip: true };
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === "ELOOP") return { trouble: "is a link in a loop of links, which leads to no file", skip: true };
    if (!link.isSymbolicLink()) return { trouble: `cannot be looked at: ${worded(err)}`, skip: true };
    const to = path.resolve(path.dirname(file), fs.readlinkSync(file));
    const next = depth < 8 && exists(to) ? look(to, depth + 1) : null;
    return { trouble: next && next.trouble ? `is a link to ${to}, which ${next.trouble}` : `is a link to ${to}, where there is nothing`, skip: true };
  }
  if (stat.isDirectory()) return { folder: true, trouble: link.isSymbolicLink() ? `is a link to the folder ${fs.realpathSync(file)}, not a program` : "is a folder, not a program", skip: true };
  if (!stat.isFile()) return { trouble: `is ${stat.isFIFO() ? "a pipe" : stat.isSocket() ? "a socket" : "a device"}, not a program`, skip: true };
  if (!WINDOWS) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      if (!(stat.mode & 0o111)) return { trouble: "is a file without the permission to run it, which chmod +x gives", skip: true };
      const mount = noexecMount(file);
      if (mount) return { trouble: `is on ${mount}, which is mounted noexec, so no program on it may run`, skip: true };
      const mine = typeof process.getuid === "function" && stat.uid === process.getuid();
      const ours = !mine && typeof process.getgroups === "function" && (process.getgroups().includes(stat.gid) || stat.gid === process.getgid());
      return { trouble: stat.mode & (mine ? 0o100 : ours ? 0o010 : 0o001) ? "is a file this user may not run" : "is a file only other users may run", skip: true };
    }
  }
  const kind = kindOf(file);
  if (kind.empty) return { trouble: "is an empty file, not a program" };
  if (kind.script) {
    const trouble = scriptTrouble(kind.script, depth);
    return { script: true, trouble, skip: Boolean(trouble) };
  }
  if (kind.elf) {
    const mine = ARCH[process.arch];
    if (WINDOWS || process.platform === "darwin") return { trouble: `is a program for Linux, not for ${SYSTEM}` };
    if (mine !== undefined && kind.elf.machine !== mine) return { trouble: `is a program for ${MACHINES[kind.elf.machine] || "another processor"}, which this ${MACHINES[mine]} machine cannot run` };
    if (kind.elf.loader && !exists(kind.elf.loader)) return { elf: true, trouble: `is a program whose loader, ${kind.elf.loader}, is not there`, skip: true };
    return { elf: true, trouble: "" };
  }
  if (kind.windows && !WINDOWS) return { trouble: `is a Windows program, which does not run on ${SYSTEM}` };
  if (kind.macos && process.platform !== "darwin") return { trouble: `is a macOS program, which does not run on ${SYSTEM}` };
  if (kind.text && !WINDOWS) return { trouble: "is a text file with no #! line, not a program" };
  if (kind.binary && !WINDOWS) return { trouble: "is not a program this system can run" };
  return { trouble: "" };
}

// The errors that say the system is short of something to start a program
// with, not that the program is wrong: what it is short of, and what to do.
const SHORT = {
  EMFILE: "too many files are open (EMFILE). Raise the limit on open files, as ulimit -n does, and run it again",
  ENFILE: "the system has too many files open (ENFILE). Run it again once fewer are",
  EAGAIN: "the system starts no more processes for now (EAGAIN). Run it again once fewer are running",
  ENOMEM: "the system has not enough memory to start it (ENOMEM). Run it again once more is free",
};

// What running `file` with `args` shows of it: "" when it runs, said its
// version (`said`, a pattern for its first line) when asked, else what is
// wrong with it, or { short } when the system is short of something.
function tryRun(file, args, said, name) {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) {
    if (Object.hasOwn(SHORT, r.error.code)) return { short: SHORT[r.error.code] };
    // On a machine too busy for it to start in a minute, as a program that
    // hangs is rare.
    if (r.error.code === "ETIMEDOUT") return { short: "it did not answer within 60 s when asked its version, most often because the machine is too busy. Run it again once it is less busy" };
    return { trouble: `cannot be started: ${worded(r.error)}` };
  }
  const err = String(r.stderr || "");
  const library = /error while loading shared libraries: ([^:\n]+): cannot open shared object file/.exec(err);
  if (library) return { trouble: `needs the shared library ${library[1].trim()}, which is not on this machine` };
  const old = /: ([^:\s]+): version [`']([^']+)' not found \(required by /.exec(err);
  if (old) return { trouble: `needs ${old[2]} of ${path.basename(old[1])}, which this system does not have` };
  if (r.signal) return { trouble: `was stopped by ${r.signal} as it started` };
  const first = String(r.stdout || "").split("\n")[0].trim();
  if (r.status !== 0) {
    const line = err.split("\n").map((l) => l.trim()).filter(Boolean).pop() || first;
    return { trouble: `failed when asked its version, with code ${r.status}${line ? `: ${line.slice(0, 160)}` : ""}` };
  }
  // What it says it is, as "ffprobe version 4.4.2", without the rest.
  const shown = (/^\S+ version \S+/.exec(first) || [first.slice(0, 80)])[0];
  if (said && !said.test(first)) return { trouble: `is not ${name}: asked its version, it said ${first ? `"${shown}"` : "nothing"}` };
  return { trouble: "", version: first };
}

// The programs, the variables that name them and how to get one.
const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";
const PROGRAMS = {
  ffmpeg: { variables: ["LAUNCH_FILM_FFMPEG"], bare: "ffmpeg", asked: ["-hide_banner", "-version"], said: /^ffmpeg version \S/,
    fix: (v) => (v ? `Set ${v} to an ffmpeg 4.4 or newer, or unset it and install one (${INSTALL}).` : `Install ffmpeg 4.4 or newer (${INSTALL}), or set LAUNCH_FILM_FFMPEG to one.`) },
  ffprobe: { variables: ["LAUNCH_FILM_FFPROBE"], bare: "ffprobe", asked: ["-hide_banner", "-version"], said: /^ffprobe version \S/,
    fix: (v) => (v ? `Set ${v} to the ffprobe of an ffmpeg 4.4 or newer, or unset it and install ffmpeg, which comes with one (${INSTALL}).` : `Install ffmpeg 4.4 or newer, which comes with ffprobe (${INSTALL}), or set LAUNCH_FILM_FFPROBE to one.`) },
  chrome: { variables: ["LAUNCH_FILM_CHROME", "CHROME_PATH"], asked: ["--version"], said: null,
    fix: (v) => (v ? `Set ${v} to the Chrome program itself, or unset it and install Google Chrome or Chromium.` : "Install Google Chrome or Chromium again, or set LAUNCH_FILM_CHROME to the Chrome program itself.") },
};

// Where `name` is and what is wrong with it: { file, variable, version } when
// it can be started, else { problem }, the sentence that names it, says what
// is wrong and how to point to one that works, and `detail`, the same
// without the words that name the program, for doctor's line of it.
function check(name) {
  const p = PROGRAMS[name];
  const variable = p.variables.find((v) => process.env[v]);
  const value = variable ? process.env[variable] : "";
  const lead = `launch-film needs ${name === "chrome" ? "Chrome" : name}, and `;
  const refuse = (detail) => ({ problem: `${lead}${detail}`, detail });
  const fix = p.fix(variable);
  let file;
  let where;
  if (name === "chrome") {
    const { findChrome } = require("./chrome");
    if (variable) {
      file = path.resolve(value);
      where = `${variable} points to ${file}, which`;
    } else {
      file = findChrome();
      // In makersmcp's words for it, as its playbooks read them.
      if (!file) return { problem: "Chrome was not found. Install Google Chrome or Chromium, or set LAUNCH_FILM_CHROME to its path.", detail: "not found: install Google Chrome or Chromium, or set LAUNCH_FILM_CHROME to its path" };
      where = `${file}, the Chrome it found,`;
    }
  } else if (value.includes("/") || (WINDOWS && value.includes("\\"))) {
    file = path.resolve(value);
    where = `${variable} points to ${file}, which`;
  } else {
    // A bare name is looked up on PATH as the system looks it up: past a
    // folder, a file it may not run and one whose interpreter or loader is
    // not there, to the first that may run.
    const bare = value || p.bare;
    let first = null;
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      const at = path.resolve(dir || ".", WINDOWS && !path.extname(bare) ? `${bare}.exe` : bare);
      const seen = look(at);
      if (seen.missing) continue;
      if (!seen.skip) {
        first = { at, seen };
        break;
      }
      if (!first) first = { at, seen };
    }
    if (!first) return refuse(variable ? `${variable} names ${bare}, which is not on your PATH. ${fix}` : `none is on your PATH. ${fix}`);
    file = first.at;
    where = variable ? `${variable} names ${bare}, and ${file}, the one on your PATH,` : `${file}, the ${name} on your PATH,`;
  }
  const seen = look(file);
  if (seen.trouble) return refuse(`${where} ${seen.trouble}. ${fix}`);
  if (name === "chrome") {
    // The stand-ins every Chrome starts with (chrome.js), which a temp
    // folder on a disk mounted noexec cannot run.
    try {
      require("./chrome").standIns();
    } catch (err) {
      return { problem: err.message, detail: err.message };
    }
    // Chrome is asked only when it is a program, not a script that starts one.
    if (!seen.elf) return { file, variable, version: "" };
  }
  const ran = tryRun(file, p.asked, p.said, name);
  if (ran.short) return { problem: `launch-film could not start ${name === "chrome" ? "Chrome" : name}: ${ran.short}.`, detail: `could not be started: ${ran.short}` };
  if (ran.trouble) return refuse(`${where} ${ran.trouble}. ${fix}`);
  return { file, variable, version: ran.version };
}

// The error for a program the system could not start for want of something
// (too many open files, processes or no memory), once a run is under way, or
// null for any other error: said as that, not as an input it could not read.
function short(err, name) {
  return err && Object.hasOwn(SHORT, err.code) ? `launch-film could not start ${name}: ${SHORT[err.code]}.` : null;
}

// The first problem of the programs `names`, in that order, or null.
function unstartable(names) {
  for (const name of names) {
    const c = check(name);
    if (c.problem) return c.problem;
  }
  return null;
}

module.exports = { check, unstartable, short, look, PROGRAMS };
