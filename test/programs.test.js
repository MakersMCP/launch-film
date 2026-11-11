"use strict";
// An ffmpeg, ffprobe or Chrome that cannot be started stops a command before
// any work, with one line that names the variable or the PATH entry that gave
// it, what is wrong with it and how to point to one that works, and leaves no
// folder and nothing in the temp folder. Before, such a run said the video
// could not be read, gave the system's own words (spawn /opt/ffmpeg EACCES),
// or stopped at its first clip.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmp } = require("./tmp");
const { makeCases, onPath } = require("./programs-cases");

const root = path.join(__dirname, "..");
const ffmpeg = onPath(process.env.LAUNCH_FILM_FFMPEG || "ffmpeg");
const ffprobe = onPath(process.env.LAUNCH_FILM_FFPROBE || "ffprobe");
const skip = process.platform !== "linux" ? "the cases are Linux's" : !ffmpeg || !ffprobe ? "ffmpeg not found" : false;
const asUser = skip || (process.getuid() === 0 && "root may run what others may not");

const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";
const LEAD = { ffmpeg: "launch-film needs ffmpeg, and ", ffprobe: "launch-film needs ffprobe, and ", chrome: "launch-film needs Chrome, and " };
const VARIABLE = { ffmpeg: "LAUNCH_FILM_FFMPEG", ffprobe: "LAUNCH_FILM_FFPROBE", chrome: "LAUNCH_FILM_CHROME" };
const SET = {
  ffmpeg: `Set LAUNCH_FILM_FFMPEG to an ffmpeg 4.4 or newer, or unset it and install one (${INSTALL}).`,
  ffprobe: `Set LAUNCH_FILM_FFPROBE to the ffprobe of an ffmpeg 4.4 or newer, or unset it and install ffmpeg, which comes with one (${INSTALL}).`,
  chrome: "Set LAUNCH_FILM_CHROME to the Chrome program itself, or unset it and install Google Chrome or Chromium.",
};
const INSTALL_ONE = {
  ffmpeg: `Install ffmpeg 4.4 or newer (${INSTALL}), or set LAUNCH_FILM_FFMPEG to one.`,
  ffprobe: `Install ffmpeg 4.4 or newer, which comes with ffprobe (${INSTALL}), or set LAUNCH_FILM_FFPROBE to one.`,
};

// A film for check and frames, and a film.json for render and stills; none
// of them is read.
let base = null;
function where() {
  if (base) return base;
  const dir = tmp();
  const film = path.join(dir, "film.mp4");
  const made = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1", "-pix_fmt", "yuv420p", film], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  const folder = path.join(dir, "film");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "film.json"), JSON.stringify({ look: "launch", clips: [{ kind: "scene", seconds: 3, scene: { type: "headline", title: "A title" } }] }));
  base = { dir, film, folder, cases: makeCases(path.join(dir, "cases")) };
  return base;
}

// Runs a command that needs `program` with `env`: check for ffmpeg and
// ffprobe, render for Chrome. Returns what it said, and whether it made its
// folder or left anything in its temp folder.
function run(program, env) {
  const { dir, film, folder } = where();
  const temp = tmp();
  const out = path.join(dir, `out-${path.basename(temp)}`);
  const args = program === "chrome" ? ["render", path.join(folder, "film.json")] : ["check", film, "--out", out];
  const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, TMPDIR: temp, ...env } });
  return { ...r, made: fs.existsSync(out) || fs.readdirSync(folder).join(",") !== "film.json", left: fs.readdirSync(temp) };
}

function refused(r, said, name) {
  assert.equal(r.status, 1, `${name}: ${r.stderr}`);
  if (said instanceof RegExp) assert.match(r.stderr, said, name);
  else assert.equal(r.stderr, `launch-film: ${said}\n`, name);
  assert.ok(!r.made, `${name}: a folder was made`);
  assert.deepEqual(r.left, [], `${name}: left in the temp folder`);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each case, by its name, given by the variable of each program.
const NAMES = ["nothing there", "a folder", "a link to a folder", "a link to nothing", "a loop of links", "a path through a file", "a file without the execute bit",
  "execute bits for other users only", "in a folder this user may not enter", "an empty file", "a text file with no #! line", "a script whose #! program is not there",
  "a script whose #! program is a folder", "a script whose #! program may not be run", "a script whose env program is not on PATH", "a Windows program", "a macOS program",
  "a program for another processor", "a program whose loader is missing", "a program that needs a library that is missing", "ffprobe in ffmpeg's place", "ffmpeg in ffprobe's place"];
for (const name of NAMES) {
  test(`an ffmpeg, ffprobe or Chrome that is ${name} is refused before any work, with what is wrong with it`, { skip: asUser }, (t) => {
    const c = where().cases.find((k) => k.name === name);
    if (!c) return t.skip("this machine's ffmpeg is no program to make it from");
    if (c.before) c.before();
    try {
      for (const program of ["ffmpeg", "ffprobe", "chrome"].filter((p) => !c.only || c.only === p)) {
        const r = run(program, { [VARIABLE[program]]: c.file });
        const said = c.said instanceof RegExp ? new RegExp(`^launch-film: ${escape(`${LEAD[program]}${VARIABLE[program]} points to ${c.file}, `)}${c.said.source.replace(/^\^/, "")}.*\\. ${escape(SET[program])}\\n$`)
          : `${LEAD[program]}${VARIABLE[program]} points to ${c.file}, ${c.said}. ${SET[program]}`;
        refused(r, said, `${program}: ${name}`);
      }
    } finally {
      if (c.after) c.after();
    }
  });
}

test("an ffmpeg or ffprobe named by a name that is not on PATH, and none on PATH at all, are refused", { skip }, () => {
  const empty = tmp();
  for (const program of ["ffmpeg", "ffprobe"]) {
    refused(run(program, { [VARIABLE[program]]: "launch-film-no-such-program" }), `${LEAD[program]}${VARIABLE[program]} names launch-film-no-such-program, which is not on your PATH. ${SET[program]}`, program);
    refused(run(program, { PATH: empty, LAUNCH_FILM_FFMPEG: "", LAUNCH_FILM_FFPROBE: "", ...(program === "ffprobe" ? { LAUNCH_FILM_FFMPEG: ffmpeg } : {}) }),
      `${LEAD[program]}none is on your PATH. ${INSTALL_ONE[program]}`, `${program} with nothing on PATH`);
  }
  // Chrome, found nowhere, in the words makersmcp reads.
  const r = run("chrome", { PATH: empty, LAUNCH_FILM_FFMPEG: ffmpeg, LAUNCH_FILM_FFPROBE: ffprobe, LAUNCH_FILM_CHROME: "", CHROME_PATH: "" });
  refused(r, "Chrome was not found. Install Google Chrome or Chromium, or set LAUNCH_FILM_CHROME to its path.", "chrome with nothing on PATH");
});

// The system passes over a folder or a file it may not run on PATH, for the
// next program of that name, but runs one that is no program.
test("on PATH the program named is the one the system would start, past a folder and a file it may not run", { skip: asUser }, () => {
  const { cases } = where();
  const folder = path.dirname(cases.find((k) => k.name === "a folder").file);
  const plain = path.dirname(cases.find((k) => k.name === "a file without the execute bit").file);
  const empty = path.dirname(cases.find((k) => k.name === "an empty file").file);
  // Each holds `program`: given under its name, with no other on PATH.
  const as = (name, from) => {
    const dir = tmp();
    fs.cpSync(path.join(from, "program"), path.join(dir, name), { recursive: true });
    return dir;
  };
  const nothing = tmp();
  for (const program of ["ffmpeg", "ffprobe"]) {
    const others = program === "ffprobe" ? { LAUNCH_FILM_FFMPEG: ffmpeg } : { LAUNCH_FILM_FFPROBE: ffprobe };
    const unset = { LAUNCH_FILM_FFMPEG: "", LAUNCH_FILM_FFPROBE: "", ...others };
    const dir = as(program, folder);
    refused(run(program, { ...unset, PATH: `${dir}:${nothing}` }), `${LEAD[program]}${path.join(dir, program)}, the ${program} on your PATH, is a folder, not a program. ${INSTALL_ONE[program]}`, `${program}: a folder`);
    const noRun = as(program, plain);
    refused(run(program, { ...unset, PATH: `${noRun}:${nothing}` }),
      `${LEAD[program]}${path.join(noRun, program)}, the ${program} on your PATH, is a file without the permission to run it, which chmod +x gives. ${INSTALL_ONE[program]}`, `${program}: a file it may not run`);
    // With a real one after them, that one runs.
    const real = tmp();
    fs.symlinkSync(program === "ffmpeg" ? ffmpeg : ffprobe, path.join(real, program));
    const passed = run(program, { ...unset, PATH: `${dir}:${noRun}:${real}` });
    assert.equal(passed.status, 0, passed.stderr);
    // An empty file is run, by the shell, so it is the one named.
    const blank = as(program, empty);
    refused(run(program, { ...unset, PATH: `${blank}:${real}` }), `${LEAD[program]}${path.join(blank, program)}, the ${program} on your PATH, is an empty file, not a program. ${INSTALL_ONE[program]}`, `${program}: an empty file`);
  }
});

test("a program on a disk mounted noexec is refused as that", { skip: asUser || (spawnSync("unshare", ["-rm", "true"]).status !== 0 && "unshare -rm cannot make a mount namespace here") }, () => {
  const { dir, film } = where();
  const mount = tmp();
  for (const program of ["ffmpeg", "ffprobe"]) {
    const out = path.join(dir, `noexec-${program}`);
    const script = `mount -t tmpfs -o noexec,size=1m none '${mount}' && printf '#!/bin/sh\\nexit 0\\n' > '${mount}/${program}' && chmod 755 '${mount}/${program}' && exec "$@"`;
    const r = spawnSync("unshare", ["-rm", "sh", "-c", script, "sh", process.execPath, path.join(root, "bin", "launch-film.js"), "check", film, "--out", out],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, [VARIABLE[program]]: path.join(mount, program) } });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${LEAD[program]}${VARIABLE[program]} points to ${path.join(mount, program)}, which is on ${mount}, which is mounted noexec, so no program on it may run. ${SET[program]}\n`);
    assert.ok(!fs.existsSync(out));
  }
});

// Node starts no program with no file descriptor left: this stub takes all
// but three, which loading launch-film needs one at a time.
test("a run that has no file descriptor left to start ffmpeg says so and what to do", { skip }, () => {
  const stub = path.join(tmp(), "fds.js");
  fs.writeFileSync(stub, `const fs = require("fs");\nconst held = [];\ntry { for (;;) held.push(fs.openSync("/dev/null", "r")); } catch {}\nfor (let i = 0; i < 3 && held.length; i++) fs.closeSync(held.pop());\n`);
  const r = run("ffmpeg", { NODE_OPTIONS: `--require ${stub}` });
  refused(r, "launch-film could not start ffmpeg: too many files are open (EMFILE). Raise the limit on open files, as ulimit -n does, and run it again.", "EMFILE");
});

test("doctor says what is wrong with each program on its line, and exits with 1", { skip }, () => {
  const { cases } = where();
  const file = (name) => cases.find((k) => k.name === name).file;
  const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "doctor"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, LAUNCH_FILM_FFMPEG: file("a folder"), LAUNCH_FILM_FFPROBE: file("an empty file"), LAUNCH_FILM_CHROME: file("a text file with no #! line") } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`^chrome {2}LAUNCH_FILM_CHROME points to ${escape(file("a text file with no #! line"))}, which is a text file with no #! line, not a program\\. ${escape(SET.chrome)}$`, "m"));
  assert.match(r.stdout, new RegExp(`^ffmpeg {2}LAUNCH_FILM_FFMPEG points to ${escape(file("a folder"))}, which is a folder, not a program\\. ${escape(SET.ffmpeg)}$`, "m"));
  assert.match(r.stdout, new RegExp(`^ffprobe LAUNCH_FILM_FFPROBE points to ${escape(file("an empty file"))}, which is an empty file, not a program\\. ${escape(SET.ffprobe)}$`, "m"));
});

// Once a run is under way, a program the system cannot start for want of a
// file descriptor was a film that could not be read.
test("a run that runs out of file descriptors once it is under way says so, not that its film could not be read", { skip }, () => {
  const stub = path.join(tmp(), "fds.js");
  fs.writeFileSync(stub, `const cp = require("child_process");
const real = cp.spawnSync;
cp.spawnSync = (file, args, ...rest) => (Array.isArray(args) && args.includes("-show_entries") ? { error: Object.assign(new Error(\`spawnSync \${file} EMFILE\`), { code: "EMFILE", errno: -24 }), status: null, signal: null, stdout: "", stderr: "" } : real(file, args, ...rest));
`);
  refused(run("ffprobe", { NODE_OPTIONS: `--require ${stub}` }), "launch-film could not start ffprobe: too many files are open (EMFILE). Raise the limit on open files, as ulimit -n does, and run it again.", "EMFILE under way");
});
