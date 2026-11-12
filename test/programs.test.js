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
  else assert.equal(r.stderr, `${said.startsWith("launch-film ") ? "" : "launch-film: "}${said}\n`, name);
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
        const said = c.said instanceof RegExp ? new RegExp(`^${escape(`${LEAD[program]}${VARIABLE[program]} points to ${c.file}, `)}${c.said.source.replace(/^\^/, "")}.*\\. ${escape(SET[program])}\\n$`)
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

// Chrome is found on PATH the same way: a google-chrome folder first on PATH
// was taken for Chrome, while the system starts the next one.
test("on PATH the Chrome found is the one the system would start, past a folder and a file it may not run", { skip: asUser }, () => {
  const folder = tmp();
  fs.mkdirSync(path.join(folder, "google-chrome"));
  const plain = tmp();
  fs.writeFileSync(path.join(plain, "google-chrome"), "#!/bin/sh\nexit 1\n", { mode: 0o644 });
  const real = tmp();
  fs.writeFileSync(path.join(real, "google-chrome"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const doctor = (PATH) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "doctor"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH, LAUNCH_FILM_CHROME: "", CHROME_PATH: "", LAUNCH_FILM_FFMPEG: ffmpeg, LAUNCH_FILM_FFPROBE: ffprobe } });
  const chromeLine = (r) => r.stdout.split("\n").find((l) => l.startsWith("chrome  "));
  // The one that may run: doctor starts it, and it stops.
  assert.match(chromeLine(doctor(`${folder}:${plain}:${real}`)), new RegExp(`^chrome {2}${escape(path.join(real, "google-chrome"))}: `));
  // None that may: the first is named, with what is wrong with it.
  assert.equal(chromeLine(doctor(`${folder}:${plain}`)), `chrome  ${path.join(folder, "google-chrome")}, the Chrome it found, is a folder, not a program. Install Google Chrome or Chromium again, or set LAUNCH_FILM_CHROME to the Chrome program itself.`);
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
    assert.equal(r.stderr, `${LEAD[program]}${VARIABLE[program]} points to ${path.join(mount, program)}, which is on ${mount}, which is mounted noexec, so no program on it may run. ${SET[program]}\n`);
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

// A program is given two minutes to say its version, as the other kits give
// it: a machine busy with other work took more than the 20 s it once had.
test("a program that does not answer within two minutes when asked its version is told of as a machine too busy", { skip }, () => {
  const asked = path.join(tmp(), "asked");
  const stub = path.join(tmp(), "late.js");
  fs.writeFileSync(stub, `const fs = require("fs");
const cp = require("child_process");
const real = cp.spawnSync;
cp.spawnSync = (file, args, opts = {}) => {
  if (!(Array.isArray(args) && args.includes("-version"))) return real(file, args, opts);
  fs.writeFileSync(${JSON.stringify(asked)}, String(opts.timeout));
  return { error: Object.assign(new Error(\`spawnSync \${file} ETIMEDOUT\`), { code: "ETIMEDOUT", errno: -110 }), status: null, signal: "SIGTERM", stdout: "", stderr: "" };
};
`);
  const r = run("ffmpeg", { NODE_OPTIONS: `--require ${stub}` });
  refused(r, "launch-film could not start ffmpeg: it did not answer within two minutes when asked its version, most often because the machine is too busy. Run it again once it is less busy.", "a late ffmpeg");
  assert.equal(fs.readFileSync(asked, "utf8"), "120000");
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

// Node starts no process when no file descriptor is left for its pipes: it
// comes back from spawn with none, and its error comes next. Touched as they
// were, the pipes threw, and the error had no listener, which ended the run
// with Node's stack trace. This stub holds every free descriptor while a
// spawn whose arguments hold EMFILE_ON starts.
function spawnStub() {
  const stub = path.join(tmp(), "spawn-emfile.js");
  fs.writeFileSync(stub, `const cp = require("child_process");
const fs = require("fs");
const real = cp.spawn;
cp.spawn = function (file, args, opts) {
  if (!(Array.isArray(args) && args.join(" ").includes(process.env.EMFILE_ON))) return real.call(this, file, args, opts);
  const held = [];
  try { for (;;) held.push(fs.openSync("/dev/null", "r")); } catch {}
  try { return real.call(this, file, args, opts); } finally { for (const fd of held) fs.closeSync(fd); }
};
`);
  return stub;
}
const OUT_OF_FILES = "too many files are open (EMFILE). Raise the limit on open files, as ulimit -n does, and run it again.";

test("a run that runs out of file descriptors as it starts ffmpeg, Chrome or easybrandkit says so, and leaves its folder as it was", { skip }, () => {
  const { dir, film, folder } = where();
  const stub = spawnStub();
  const chrome = path.join(tmp(), "chrome");
  fs.writeFileSync(chrome, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const cli = (args, on) => {
    const temp = tmp();
    const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 120_000,
      env: { ...process.env, TMPDIR: temp, NODE_OPTIONS: `--require ${stub}`, EMFILE_ON: on, LAUNCH_FILM_CHROME: chrome } });
    return { ...r, left: fs.readdirSync(temp) };
  };
  // check's first ffmpeg, and Chrome as a render starts it.
  const out = path.join(dir, "check-emfile");
  const check = cli(["check", film, "--out", out], "scdet");
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stderr, new RegExp(`^launch-film could not start ffmpeg: ${escape(OUT_OF_FILES)}\\nlaunch-film: ${escape(out)} was not made\\.\\n$`));
  assert.ok(!fs.existsSync(out));
  const render = cli(["render", path.join(folder, "film.json")], "--remote-debugging-pipe");
  assert.equal(render.status, 1, render.stderr);
  assert.match(render.stderr, new RegExp(`(?:^|\\n)launch-film could not start Chrome: ${escape(OUT_OF_FILES)}\\nlaunch-film: ${escape(folder)} is as it was\\.\\n$`));
  assert.deepEqual(fs.readdirSync(folder), ["film.json"]);
  // easybrandkit, as a plan starts it.
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, "process.exit(1);\n");
  const plan = cli(["plan", "https://acme-notes.example", "--easybrandkit", kit, "--out", path.join(dir, "plan-emfile")], "--out");
  assert.equal(plan.status, 1, plan.stderr);
  assert.match(plan.stderr, new RegExp(`(?:^|\\n)launch-film could not start easybrandkit: ${escape(OUT_OF_FILES)}\\nlaunch-film: ${escape(path.join(dir, "plan-emfile"))} was not made\\.\\n$`));
  for (const r of [check, render, plan]) assert.deepEqual(r.left, [], "left in the temp folder");
});

test("a render that runs out of file descriptors as it starts a clip's encoder says so, and leaves its folder as it was", { skip: skip || (!require("../src/chrome").findChrome() && "Chrome not found"), timeout: 180_000 }, () => {
  const { folder } = where();
  const temp = tmp();
  const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "render", path.join(folder, "film.json")], { encoding: "utf8", timeout: 150_000,
    env: { ...process.env, TMPDIR: temp, NODE_OPTIONS: `--require ${spawnStub()}`, EMFILE_ON: "image2pipe" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`(?:^|\\n)launch-film could not start ffmpeg: ${escape(OUT_OF_FILES)}\\nlaunch-film: ${escape(folder)} is as it was\\.\\n$`));
  assert.deepEqual(fs.readdirSync(folder), ["film.json"]);
  assert.deepEqual(fs.readdirSync(temp), []);
});

// Each command looks at the programs it runs before any work: frames at
// ffmpeg and ffprobe, stills and the one-go command at Chrome too, a plan of
// a store's address at ffmpeg and ffprobe. render and check are held above.
test("frames, stills, the one-go command and a plan of a store's address look at the programs they run before any work", { skip }, () => {
  const { dir, film, folder } = where();
  const fixture = path.join(__dirname, "fixtures", "acme");
  const words = path.join(fixture, "words.json");
  const nothing = path.join(tmp(), "nothing");
  const cases = [
    ["frames", [film, "--out", path.join(dir, "frames-none")], "ffprobe", path.join(dir, "frames-none")],
    ["stills of a film.json", ["stills", path.join(folder, "film.json")], "chrome", path.join(folder, "stills")],
    ["stills of an address", ["stills", "acme-notes.example", "--brand", fixture, "--words", words, "--out", path.join(dir, "stills-none")], "chrome", path.join(dir, "stills-none")],
    ["the one-go command", ["acme-notes.example", "--brand", fixture, "--words", words, "--out", path.join(dir, "go-none")], "chrome", path.join(dir, "go-none")],
    ["a plan of a store's address", ["plan", "https://apps.apple.com/us/app/acme/id1234567890", "--out", path.join(dir, "store-none")], "ffprobe", path.join(dir, "store-none")],
  ];
  for (const [name, args, program, out] of cases) {
    const temp = tmp();
    const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...(name === "frames" ? ["frames"] : []), ...args], { encoding: "utf8", timeout: 60_000,
      env: { ...process.env, TMPDIR: temp, [VARIABLE[program]]: nothing } });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, `${LEAD[program]}${VARIABLE[program]} points to ${nothing}, which is not there. ${SET[program]}\n`, name);
    assert.ok(!fs.existsSync(out), `${name}: ${out} was made`);
    assert.deepEqual(fs.readdirSync(temp), [], `${name}: left in the temp folder`);
  }
  // A command given wrong is told so first, a plan's kit and words too.
  const r = spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://apps.apple.com/us/app/acme/id1234567890", "--brand", folder, "--out", path.join(dir, "store-none")],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, LAUNCH_FILM_FFPROBE: nothing } });
  assert.equal(r.stderr, `launch-film: no brand.json at ${path.join(folder, "brand.json")}\n`);
});

// A plan given its kit and the page's words starts no Chrome, so a Chrome
// that cannot be started is nothing to it. One that reads the page in
// Chrome, as one given a kit and no words does when the page's HTML has too
// few headings, looks at that Chrome as it is about to start it, and goes on
// with the words of the HTML.
test("a plan looks at Chrome only as it is about to start it to read the page, and goes on without it", { skip: asUser }, async () => {
  const http = require("http");
  const { dir } = where();
  const { cases } = where();
  const noRun = cases.find((k) => k.name === "a file without the execute bit").file;
  const fixture = path.join(__dirname, "fixtures", "acme");
  const plan = (args, env) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ...env } });
  const given = plan(["--brand", fixture, "--words", path.join(fixture, "words.json"), "--out", path.join(dir, "given")], { LAUNCH_FILM_CHROME: noRun, CHROME_PATH: noRun });
  assert.equal(given.status, 0, given.stderr);
  assert.match(given.stderr, /^Planned \d+ clips in the \w+ look: /m);
  // A page whose HTML holds one heading.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html lang="en"><title>Acme Notes</title><h1>Notes that think with you</h1><p>Write once and find it anywhere.</p>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const kit = path.join(tmp(), "kit");
    fs.cpSync(fixture, kit, { recursive: true });
    const brandFile = path.join(kit, "brand.json");
    fs.writeFileSync(brandFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(brandFile, "utf8")), url: `http://127.0.0.1:${server.address().port}/` }));
    const read = await new Promise((resolve) => {
      const child = require("child_process").spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--brand", kit, "--out", path.join(dir, "read")],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LAUNCH_FILM_CHROME: noRun } });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      child.on("close", (code) => resolve({ code, said }));
    });
    assert.equal(read.code, 0, read.said);
    assert.ok(read.said.includes(`Chrome could not read the page (${LEAD.chrome}LAUNCH_FILM_CHROME points to ${noRun}, which is a file without the permission to run it, which chmod +x gives. ${SET.chrome.replace(/\.$/, "")}).\n`), read.said);
    assert.match(read.said, /^Planned \d+ clips in the \w+ look: /m);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "read", "words.json"), "utf8")).headings[0].text, "Notes that think with you");
  } finally {
    server.close();
  }
});

// Node's spawn starts a program named without an extension on Windows as
// that name with .com, else .exe, added (libuv's search_path), so such a
// name given in LAUNCH_FILM_FFMPEG, or found on PATH, is looked at so too,
// where it was refused as not there.
test("on Windows a program named without .exe is looked at as spawn starts it, with .com and then .exe", () => {
  const { named } = require("../src/programs");
  assert.deepEqual(named("C:\\ffmpeg\\bin\\ffmpeg", "win32"), ["C:\\ffmpeg\\bin\\ffmpeg.com", "C:\\ffmpeg\\bin\\ffmpeg.exe"]);
  assert.deepEqual(named("C:\\ffmpeg\\bin\\ffmpeg.exe", "win32"), ["C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\ffmpeg\\bin\\ffmpeg.exe.com", "C:\\ffmpeg\\bin\\ffmpeg.exe.exe"]);
  assert.deepEqual(named("C:\\tools\\my.ffmpeg", "win32"), ["C:\\tools\\my.ffmpeg", "C:\\tools\\my.ffmpeg.com", "C:\\tools\\my.ffmpeg.exe"]);
  assert.deepEqual(named("/usr/bin/ffmpeg", "linux"), ["/usr/bin/ffmpeg"]);
  assert.deepEqual(named("/opt/homebrew/bin/ffmpeg", "darwin"), ["/opt/homebrew/bin/ffmpeg"]);
});
