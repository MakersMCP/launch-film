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

module.exports = { tmp, shortTmp, stillRunning, WAITS };
