"use strict";
// What test/tmp.js does once a test file's tests have run, seen from outside:
// each test here runs a test file of its own, with a temp folder of its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmp } = require("./tmp");

const needsProc = process.platform !== "linux" && "/proc tells which processes the tests started";
const HELPER = 'const helper = spawn(process.execPath, ["-e", WAITS], { stdio: "ignore" }); helper.unref(); made.helper = helper.pid;';
const LOCKED = 'made.locked = path.join(tmp(), "locked"); fs.mkdirSync(made.locked); fs.writeFileSync(path.join(made.locked, "file"), ""); fs.chmodSync(made.locked, 0o500);';

// Runs a test file with one test, which makes a short folder and does what
// `leaves` says. Gives how the file ended, what it said, what it made and its
// temp folder.
function runFile(t, leaves) {
  const dir = tmp();
  const temp = path.join(dir, "temp");
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(dir, "file.test.js"), `"use strict";
const test = require("node:test");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { tmp, shortTmp, WAITS } = require(${JSON.stringify(path.join(__dirname, "tmp.js"))});
test("a test", () => {
  const made = { short: shortTmp() };
  ${leaves}
  fs.writeFileSync("made.json", JSON.stringify(made));
});
`);
  // Node runs no test file from inside another one while this is set.
  const env = { ...process.env, TMPDIR: temp };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "file.test.js"], { cwd: dir, env, encoding: "utf8", timeout: 180000 });
  const made = JSON.parse(fs.readFileSync(path.join(dir, "made.json"), "utf8"));
  // The short folder is outside this file's own folders, and a read-only one
  // would keep them from going.
  t.after(() => {
    fs.rmSync(made.short, { recursive: true, force: true });
    if (made.locked && fs.existsSync(made.locked)) fs.chmodSync(made.locked, 0o700);
  });
  return { status: run.status, said: run.stdout, temp, made };
}

test("a test file that leaves nothing passes, and its folders go", { skip: process.platform === "win32" && "a short folder is made in /tmp" }, (t) => {
  const { status, said, temp, made } = runFile(t, "");
  assert.equal(status, 0, said);
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.ok(!fs.existsSync(made.short), "the short folder is gone");
});

test("a test that leaves a helper fails its file, the helper is ended, and the file's folders go all the same", { skip: needsProc }, async (t) => {
  const { status, said, temp, made } = runFile(t, HELPER);
  assert.equal(status, 1, said);
  assert.match(said, new RegExp(`these tests left processes running:\\s+${made.helper} `));
  const running = () => {
    try {
      return fs.readFileSync(`/proc/${made.helper}/cmdline`, "latin1") !== "";
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 50 && running(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!running(), "the helper is gone");
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.ok(!fs.existsSync(made.short), "the short folder is gone");
});

test("a folder that cannot be removed fails its file, and neither the other folders nor the helper's name are lost", { skip: needsProc || (process.getuid() === 0 && "root removes anything") }, (t) => {
  const { status, said, made } = runFile(t, `${HELPER} ${LOCKED}`);
  assert.equal(status, 1, said);
  assert.match(said, new RegExp(`these tests left processes running:\\s+${made.helper} `));
  assert.match(said, /EACCES/);
  assert.ok(!fs.existsSync(made.short), "the short folder is gone");
});
