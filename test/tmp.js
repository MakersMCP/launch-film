"use strict";
// The tests' own folders and processes. Each test file makes its folders
// inside one folder of its own in the system's temp folder, which goes once
// its tests have run, so a run of the tests leaves the temp folder as it
// found it. Each process a test starts is ended when the file's tests have
// run, whatever became of the test, so a run of the tests leaves no process
// running.
const { after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-tests-"));

// What keeps a helper process up until something ends it. A test can die
// before it ends its helpers, by a kill or a timeout, so a helper ends by
// itself in time; a bare setInterval ran on for good.
const WAITS = "setTimeout(() => process.exit(0), 60000);";

// Every process the tests start has this in its environment, however it was
// started, whatever has become of its parent. Read from /proc, so on Linux
// only.
process.env.LAUNCH_FILM_TESTS = root;
function stillRunning() {
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  return names.filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid).filter((name) => {
    try {
      return fs.readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(`LAUNCH_FILM_TESTS=${root}`);
    } catch {
      return false;
    }
  }).map(Number);
}

// A new folder for a test.
const tmp = (prefix = "t-") => fs.mkdtempSync(path.join(root, prefix));

// A pid a test may signal: a whole number above 0. Given 0 or a negative
// number, process.kill signals a whole process group, the one the tests run
// in, with what started them; a pid file read before its pid was written in
// it gave 0, and a test killed its own group.
function pidOf(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) throw new Error(`${JSON.stringify(pid)} is not the pid of a process a test started`);
  return pid;
}

// Whether a process is there and has not ended. One that has ended stays a
// zombie where nothing reaps it, as in a container whose first process is
// not an init.
function alive(pid) {
  pidOf(pid);
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
}

// Kills a process a test started, if it is still there.
function end(pid, signal = "SIGKILL") {
  pidOf(pid);
  try {
    process.kill(pid, signal);
  } catch {
    // Gone, as it should be.
  }
}

// What a stand-in runs to give a test a pid in a file: savePid(file, pid)
// writes it under another name and renames that into place, so a test that
// finds the file finds the pid whole.
const SAVES_PID = 'const savePid = (file, pid) => { const fs = require("fs"); fs.writeFileSync(file + ".part", String(pid)); fs.renameSync(file + ".part", file); };';

// The pid a stand-in saved in `file`, once one is there; none within 20 s
// fails the test.
async function pidIn(file) {
  for (const started = Date.now(); Date.now() - started < 20_000;) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // Not there yet.
    }
    if (/^[1-9]\d*$/.test(text)) return pidOf(Number(text));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no pid came in ${file} within 20 s`);
}

// A new folder whose path is short enough to hold a temp folder of a run's
// with Chrome's socket under it (out.js, tempEnv), for a test to give as
// TMPDIR. It goes when the tests have run too.
const shorts = [];
function shortTmp() {
  const dir = fs.mkdtempSync("/tmp/lf-");
  shorts.push(dir);
  return dir;
}

// One hook, as Node runs no further after hook once one has failed. The
// processes come first, as a helper left running could write in the folders.
// A helper killed as its test ended takes a moment to be gone. What is still
// running then is killed, and fails the file: a test left it behind. That is
// said last, so that the folders go all the same, each whatever becomes of
// the others.
after(async () => {
  for (let i = 0; i < 250 && stillRunning().length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const left = stillRunning().map((pid) => {
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "latin1").replace(/\0/g, " ").slice(0, 200);
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone by now.
    }
    return `${pid} ${cmd}`;
  });
  const failed = left.length ? [`these tests left processes running:\n${left.join("\n")}`] : [];
  for (const dir of [root, ...shorts]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failed.push(error.message);
    }
  }
  if (failed.length) throw new Error(failed.join("\n"));
});

// A picture in `dir` larger than Chrome takes in one file (chrome.js): a
// black 24 bit BMP, 6400 x 4200 and 80 MB long, of which only the header is
// written, so it takes next to no room on the disk.
function bigPicture(dir, name = "big.bmp") {
  const [W, H] = [6400, 4200];
  const size = 54 + W * 3 * H;
  const head = Buffer.alloc(54);
  head.write("BM", 0);
  head.writeUInt32LE(size, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(W, 18);
  head.writeInt32LE(H, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(W * 3 * H, 34);
  const file = path.join(dir, name);
  fs.writeFileSync(file, head);
  fs.truncateSync(file, size);
  return file;
}

module.exports = { tmp, shortTmp, stillRunning, WAITS, pidOf, alive, end, SAVES_PID, pidIn, bigPicture };
