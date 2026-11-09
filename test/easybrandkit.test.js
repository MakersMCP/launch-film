"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { easybrandkitCommands, runEasybrandkit } = require("../src/brand");

const { tmp, shortTmp } = require("./tmp");

// Runs fn with PATH set to dir alone and LAUNCH_FILM_EASYBRANDKIT unset.
async function withPath(dir, fn) {
  const saved = [process.env.LAUNCH_FILM_EASYBRANDKIT, process.env.PATH];
  delete process.env.LAUNCH_FILM_EASYBRANDKIT;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_EASYBRANDKIT;
    else process.env.LAUNCH_FILM_EASYBRANDKIT = saved[0];
    process.env.PATH = saved[1];
  }
}

// A stand-in for npx: it notes each package it is asked for in npx.log and
// runs the shell line given for that package ($3 is the URL, $5 the folder).
async function withFakeNpx(cases, fn) {
  const dir = tmp();
  const npx = path.join(dir, "npx");
  const lines = Object.entries(cases).map(([spec, line]) => `  "${spec}") ${line} ;;`);
  fs.writeFileSync(npx, ["#!/bin/sh", 'echo "$2" >> "$0.log"', 'case "$2" in', ...lines, "esac", ""].join("\n"), { mode: 0o755 });
  await withPath(dir, () => fn(dir, () => fs.readFileSync(`${npx}.log`, "utf8").trim().split("\n")));
}

const NOT_ON_NPM = 'echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://registry.npmjs.org/easybrandkit - Not found" >&2; exit 1';
const WRITES_KIT = '/bin/mkdir -p "$5" && echo "{}" > "$5/brand.json"';
const CANNOT_OPEN = 'echo "Opening $3..."; echo "easybrandkit: Could not open $3: net::ERR_NAME_NOT_RESOLVED" >&2; exit 1';
const noShell = process.platform === "win32" && "the stand-in npx is a shell script";

test("the easybrandkit to run: a script path, a command, one on PATH, else npm and then GitHub through npx", async () => {
  const dir = tmp();
  const script = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(script, "");
  assert.deepEqual(easybrandkitCommands(script), [[process.execPath, script]]);
  assert.deepEqual(easybrandkitCommands("my-easybrandkit --flag"), [["my-easybrandkit", "--flag"]]);
  await withPath(dir, () => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    assert.deepEqual(easybrandkitCommands(), [[npx, "-y", "easybrandkit@0.4.0"], [npx, "-y", "github:EminBudak/easybrandkit#v0.4.0"]]);
    const installed = path.join(dir, process.platform === "win32" ? "easybrandkit.cmd" : "easybrandkit");
    fs.writeFileSync(installed, "", { mode: 0o755 });
    assert.deepEqual(easybrandkitCommands(), [[installed]]);
  });
});

test("when npx cannot fetch easybrandkit from npm, it is fetched from GitHub", { skip: noShell }, async () => {
  await withFakeNpx({ "easybrandkit@0.4.0": NOT_ON_NPM, "github:EminBudak/easybrandkit#v0.4.0": WRITES_KIT }, async (dir, asked) => {
    assert.equal(await runEasybrandkit("https://example.com", path.join(dir, "out")), path.join(dir, "out", "brand.json"));
    assert.deepEqual(asked(), ["easybrandkit@0.4.0", "github:EminBudak/easybrandkit#v0.4.0"]);
  });
  await withFakeNpx({ "easybrandkit@0.4.0": NOT_ON_NPM, "github:EminBudak/easybrandkit#v0.4.0": NOT_ON_NPM }, async (dir) => {
    await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out")), /could not be fetched \(npm error code E404\)\. Install easybrandkit \(npm install -g easybrandkit\)/);
  });
});

test("an easybrandkit that ran and failed is not run again", { skip: noShell }, async () => {
  await withFakeNpx({ "easybrandkit@0.4.0": CANNOT_OPEN, "github:EminBudak/easybrandkit#v0.4.0": WRITES_KIT }, async (dir, asked) => {
    await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out")), /easybrandkit failed \(exit 1\).*Could not open https:\/\/example\.com/);
    assert.deepEqual(asked(), ["easybrandkit@0.4.0"]);
  });
});

test("a bot check says what to do instead", async () => {
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, 'process.stderr.write("https://example.com answered with a bot check, so no kit was saved.\\n"); process.exit(1);');
  await assert.rejects(runEasybrandkit("https://example.com", path.join(dir, "out"), { command: fake }), /bot check.*ask for the logo file and the main colors/);
});

test("an easybrandkit that writes brand.json resolves its path", async () => {
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + "/brand.json", "{}");');
  assert.equal(await runEasybrandkit("https://example.com", path.join(dir, "out"), { command: fake }), path.join(dir, "out", "brand.json"));
});

// Run as on Windows, in a process of its own: what easybrandkitCommands
// answers with `dir` as the whole of PATH.
function commandsOnWindows(dir) {
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  const env = { ...process.env, PATH: dir };
  delete env.LAUNCH_FILM_EASYBRANDKIT;
  const r = spawnSync(process.execPath, ["-e", `Object.defineProperty(process, "platform", { value: "win32" }); process.stdout.write(JSON.stringify(require(${brand}).easybrandkitCommands()));`], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("on Windows the script behind npx.cmd and easybrandkit.cmd is run with Node, as Node starts no .cmd file without a shell", () => {
  const dir = tmp();
  const put = (rel, text = "") => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
    return file;
  };
  assert.deepEqual(commandsOnWindows(dir), [["npx.cmd", "-y", "easybrandkit@0.4.0"], ["npx.cmd", "-y", "github:EminBudak/easybrandkit#v0.4.0"]]);
  put("npx.cmd");
  const cli = put(path.join("node_modules", "npm", "bin", "npx-cli.js"));
  assert.deepEqual(commandsOnWindows(dir), [[process.execPath, cli, "-y", "easybrandkit@0.4.0"], [process.execPath, cli, "-y", "github:EminBudak/easybrandkit#v0.4.0"]]);
  const installed = put("easybrandkit.cmd");
  assert.deepEqual(commandsOnWindows(dir), [[installed]]);
  put(path.join("node_modules", "easybrandkit", "package.json"), JSON.stringify({ bin: { easybrandkit: "skills/easybrandkit/scripts/easybrandkit.js" } }));
  const script = put(path.join("node_modules", "easybrandkit", "skills", "easybrandkit", "scripts", "easybrandkit.js"));
  assert.deepEqual(commandsOnWindows(dir), [[process.execPath, script]]);
});

test("an easybrandkit Node refuses to start is told of with what to do", () => {
  // Node throws for a .cmd file on Windows, where a missing command is an event.
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  const r = spawnSync(process.execPath, ["-e", `require("child_process").spawn = () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); };
require(${brand}).runEasybrandkit("https://example.com", process.argv[1], { command: "some.cmd" }).catch((e) => process.stdout.write(e.message));`, tmp()], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^easybrandkit could not be started \(spawn EINVAL\)\. Install easybrandkit/);
});

test("easybrandkit's temp files go with a temp folder of the run's own, on Linux", { skip: process.platform !== "linux" && "the temp folder is left as it is elsewhere" }, async () => {
  // It leaves a folder in its temp folder, as a Chrome stopped as it starts
  // does.
  const temp = shortTmp();
  const dir = tmp();
  const fake = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(fake, `const fs = require("fs"); const os = require("os"); const path = require("path");
fs.mkdirSync(path.join(os.tmpdir(), "com.google.Chrome.chrome_chrome_url_fetcher_.AbCdEf"));
fs.writeFileSync(process.env.SAW, os.tmpdir());
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/brand.json", "{}");`);
  const saw = path.join(dir, "saw");
  const brand = JSON.stringify(path.join(__dirname, "..", "src", "brand.js"));
  const r = spawnSync(process.execPath, ["-e", `require(${brand}).runEasybrandkit("https://example.com", process.argv[1], { command: process.argv[2] }).then(() => process.stdout.write(String(require("fs").readdirSync(require("os").tmpdir()).length)));`, path.join(dir, "out"), fake],
    { encoding: "utf8", env: { ...process.env, TMPDIR: temp, SAW: saw } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0", "it goes as soon as easybrandkit has ended");
  assert.match(path.basename(fs.readFileSync(saw, "utf8")), /^launch-film-brand-\d+-/);
  assert.deepEqual(fs.readdirSync(temp), [], "nothing is left in the temp folder");
});

test("a temp folder too long for Chrome's socket is not given", { skip: process.platform !== "linux" && "the temp folder is left as it is elsewhere" }, () => {
  const { tempEnv } = require("../src/out");
  const room = 107 - "/com.google.Chrome.XXXXXX/SingletonSocket".length;
  assert.equal(tempEnv("/".padEnd(room, "x")).TMPDIR, "/".padEnd(room, "x"));
  assert.equal(tempEnv("/".padEnd(room + 1, "x")).TMPDIR, process.env.TMPDIR);
  assert.equal(tempEnv(null).TMPDIR, process.env.TMPDIR);
});
