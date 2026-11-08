"use strict";
// check measures films that ffmpeg makes here: skipped when ffmpeg is
// missing. The rules and readers are tested without it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { available, mustRun, probe } = require("../src/ffmpeg");
const { checkFilm, parseExpect, parseSeconds, parseAllow, judgeStretches } = require("../src/check");
const { readCues } = require("../src/cues");
const { detectCuts, givenCuts, saveFrames } = require("../src/frames");
const draw = require("../src/draw");

const skip = !available() ? "ffmpeg not found" : false;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-check-"));
const status = (r, name) => (r.checks.find((c) => c.name === name) || {}).status;
const root = path.join(__dirname, "..");

// ffmpeg 4.4 (Ubuntu 22.04's) takes only info and verbose for ebur128's
// framelog, and refuses the whole filter for any other value. The value it
// refuses is put together here, so this file does not hold it.
const REFUSED = ["framelog", "quiet"].join("=");
const REFUSED_PATTERN = new RegExp(["framelog", "\\s*=\\s*", "quiet"].join(""));

// A stand-in for ffmpeg: a line of sh that may answer for it first (it
// sees the arguments as "$@"), then the ffmpeg the tests run. The CLI reads
// LAUNCH_FILM_FFMPEG once, when it starts, so the stand-in is given to a
// CLI run of its own.
function standIn(dir, line) {
  const file = path.join(dir, "ffmpeg");
  const real = process.env.LAUNCH_FILM_FFMPEG || "ffmpeg";
  fs.writeFileSync(file, `#!/bin/sh\n${line}\nexec '${real.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return file;
}
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 180_000, env: { ...process.env, ...env } });
const noShell = process.platform === "win32" ? "the stand-in ffmpeg is a shell script" : skip;

// A small film with what check looks for: cuts at 2, 3, 6 and 9 s, black
// from 2 to 3 s, a still picture from 6 to 9 s, silence from 4 to 6 s.
async function film(dir, { name = "film.mp4", gain = 1, audio = true, codec = ["-c:a", "aac", "-b:a", "128k"] } = {}) {
  const file = path.join(dir, name);
  const v = ["testsrc2=s=320x180:r=30:d=2", "color=c=black:s=320x180:r=30:d=1", "testsrc=s=320x180:r=30:d=3", "smptebars=s=320x180:r=30:d=3", "testsrc2=s=320x180:r=30:d=3,hue=h=90"];
  const a = ["sine=f=440:r=48000:d=4", "anullsrc=r=48000:cl=mono:d=2", `sine=f=880:r=48000:d=6,volume=${gain}`];
  const inputs = [...v, ...(audio ? a : [])].flatMap((s) => ["-f", "lavfi", "-i", s]);
  const graph = `[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[v]${audio ? ";[5:a][6:a][7:a]concat=n=3:v=0:a=1,aformat=channel_layouts=stereo[a]" : ""}`;
  await mustRun([...inputs, "-filter_complex", graph, "-map", "[v]", ...(audio ? ["-map", "[a]", ...codec] : []), "-c:v", "libx264", "-pix_fmt", "yuv420p", file], "making a test film");
  return file;
}

// Beats every half second at 30 fps, moved by `shift` frames.
function cues(dir, shift = 0) {
  const file = path.join(dir, `cues-${shift}.json`);
  const beats = Array.from({ length: 24 }, (_, i) => i * 15 + shift);
  fs.writeFileSync(file, JSON.stringify({ fps: 30, beats, bars: beats.filter((_, i) => i % 4 === 0), hits: [270 + shift], frames: 360, bpm: 120 }));
  return file;
}

test("the options read as they are written", () => {
  assert.deepEqual(parseExpect("1920x1080@30"), { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(parseExpect("1080x1920"), { width: 1080, height: 1920, fps: null });
  assert.deepEqual(parseExpect("@29.97"), { width: null, height: null, fps: 29.97 });
  assert.throws(() => parseExpect("big"), /should look like 1920x1080@30/);
  assert.deepEqual(parseSeconds("30"), { min: 29.5, max: 30.5, text: "30 s, give or take 0.5" });
  assert.deepEqual(parseSeconds("28-32"), { min: 28, max: 32, text: "28 to 32 s" });
  assert.throws(() => parseSeconds("thirty"), /a length like 30/);
  assert.deepEqual(parseAllow("27-30, 0-0.5"), [{ from: 27, to: 30 }, { from: 0, to: 0.5 }]);
  assert.throws(() => parseAllow("27"), /a stretch in seconds/);
});

test("cues.json is read in seconds, and a broken one says what is wrong", () => {
  const dir = tmp();
  const c = readCues(cues(dir));
  assert.equal(c.fps, 30);
  assert.equal(c.beats[1], 0.5);
  assert.deepEqual(c.hits, [9]);
  assert.equal(c.seconds, 12);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ beats: [0, "x"] }));
  assert.throws(() => readCues(bad), /"fps" must be.*"beats" must be a list of frame numbers/);
});

test("stretches: the ends and short holds pass, long ones warn, a film mostly black fails", () => {
  const frame = 0.05;
  const s = (from, to) => ({ from, to, seconds: to - from });
  assert.equal(judgeStretches("black", [s(0, 0.8), s(28.5, 30)], 30, [], frame).status, "pass");
  assert.equal(judgeStretches("still", [s(12, 13.5), s(25, 30)], 30, [], frame).status, "pass");
  assert.equal(judgeStretches("still", [s(12, 15)], 30, [], frame).status, "warn");
  assert.equal(judgeStretches("still", [s(12, 15)], 30, [{ from: 11.5, to: 15.5 }], frame).stretches[0].verdict, "meant");
  assert.equal(judgeStretches("black", [s(5, 22)], 30, [], frame).status, "fail");
  // A film of slides is still on purpose: it warns, never fails.
  assert.equal(judgeStretches("still", [s(1, 9), s(10, 18), s(19, 27)], 30, [], frame).status, "warn");
  assert.equal(judgeStretches("silence", [s(0, 30)], 30, [], frame).status, "fail");
});

test("hard cuts and soft changes are told apart in the frames' differences", () => {
  const frames = [];
  const at = (i) => +(i / 25).toFixed(3);
  for (let i = 0; i < 100; i++) frames.push({ t: at(i), score: 0.2, mafd: 0.3 });
  // A hard cut at frame 30.
  frames[30].score = 42;
  // A still stretch, then a crossfade from frame 60.
  for (let i = 55; i < 60; i++) frames[i].mafd = 0;
  for (let i = 60; i < 70; i++) frames[i].mafd = 1.2;
  const found = detectCuts(frames);
  assert.deepEqual(found.map((c) => [c.at, c.hard]), [[1.2, true], [2.4, false]]);
});

test("cuts can be given as seconds, as frames or as a timeline", () => {
  const dir = tmp();
  assert.deepEqual(givenCuts("0, 3.2,7.5"), [0, 3.2, 7.5]);
  const frames = path.join(dir, "cuts.json");
  fs.writeFileSync(frames, JSON.stringify({ fps: 25, cuts: [0, 50, 125] }));
  assert.deepEqual(givenCuts(frames), [0, 2, 5]);
  const timeline = path.join(dir, "film.timeline.json");
  fs.writeFileSync(timeline, JSON.stringify({ clips: [{ start: 0 }, { start: 3.871 }] }));
  assert.deepEqual(givenCuts(timeline), [0, 3.871]);
  assert.throws(() => givenCuts("soon"), /not a list of seconds or a file/);
});

test("the pixel face has every glyph it lists, seven rows of five", () => {
  for (const [ch, rows] of Object.entries(draw.FACE)) {
    assert.equal(rows.length, 7, ch);
    assert.ok(rows.every((r) => r >= 0 && r < 32), ch);
  }
  const c = draw.canvas(200, 40, "#000000");
  assert.equal(draw.text(c, 2, 2, "PASS -14", "#FFFFFF", 2), draw.textWidth("PASS -14", 2));
  assert.ok(c.data.some((v, i) => i % 4 === 0 && v === 255), "the text was drawn");
});

test("a film is checked by measuring it", { skip }, async () => {
  const dir = tmp();
  const file = await film(dir);
  const r = await checkFilm(file, { expect: "320x180@30", seconds: "12", lufs: "-14", cues: cues(dir) });
  assert.equal(status(r, "size"), "pass");
  assert.equal(status(r, "frame rate"), "pass");
  assert.equal(status(r, "length"), "pass");
  assert.equal(status(r, "black"), "warn");
  assert.equal(status(r, "still picture"), "warn");
  assert.equal(status(r, "silence"), "warn");
  assert.equal(status(r, "loudness"), "fail");
  assert.equal(status(r, "true peak"), "pass");
  assert.equal(status(r, "clipping"), "pass");
  assert.equal(status(r, "cuts on beats"), "pass");
  assert.equal(r.pass, false);
  assert.deepEqual(r.cuts.map((c) => c.at), [0, 2, 3, 6, 9]);
  const black = r.checks.find((c) => c.name === "black").stretches[0];
  assert.ok(Math.abs(black.from - 2) < 0.05 && Math.abs(black.to - 3) < 0.05, JSON.stringify(black));
  const report = fs.readFileSync(path.join(r.dir, "CHECK.md"), "utf8");
  assert.match(report, /^# film\.mp4: FAIL \(loudness\)/);
  assert.ok(!/[\u2013\u2014]/.test(report), "CHECK.md has no dashes");
  const saved = JSON.parse(fs.readFileSync(path.join(r.dir, "check.json"), "utf8"));
  assert.equal(saved.pass, false);
  assert.deepEqual(saved.failed, ["loudness"]);
  const sheet = probe(path.join(r.dir, "sheet.png"));
  assert.ok(sheet.width > 1000 && sheet.height > 300, `sheet ${sheet.width}x${sheet.height}`);
  const wave = probe(path.join(r.dir, "wave.png"));
  assert.deepEqual([wave.width, wave.height], [1600, 440]);
});

test("cuts off the beat fail, and stretches given as meant pass", { skip }, async () => {
  const dir = tmp();
  const file = await film(dir);
  const off = await checkFilm(file, { cues: cues(dir, 4), out: path.join(dir, "off") });
  assert.equal(status(off, "cuts on beats"), "fail");
  assert.ok(off.cuts.filter((c) => c.verdict === "off").length === 4);
  const meant = await checkFilm(file, { allow: "2-3,4-6,6-9", out: path.join(dir, "meant") });
  assert.equal(status(meant, "black"), "pass");
  assert.equal(status(meant, "still picture"), "pass");
  assert.equal(status(meant, "silence"), "pass");
  assert.equal(meant.pass, true);
});

test("sound at full scale is clipping", { skip }, async () => {
  const dir = tmp();
  const file = await film(dir, { name: "loud.mkv", gain: 40, codec: ["-c:a", "pcm_s16le"] });
  const r = await checkFilm(file, {});
  assert.equal(status(r, "clipping"), "fail");
  assert.equal(r.pass, false);
});

test("a film with no sound fails a loudness check and only notes it otherwise", { skip }, async () => {
  const dir = tmp();
  const file = await film(dir, { audio: false });
  assert.equal(status(await checkFilm(file, { lufs: "-14", out: path.join(dir, "a") }), "sound"), "fail");
  const r = await checkFilm(file, { out: path.join(dir, "b") });
  assert.equal(status(r, "sound"), "info");
  assert.equal(probe(path.join(r.dir, "wave.png")).width, 1600);
});

test("a timeline next to the film gives its cuts", { skip }, async () => {
  const dir = tmp();
  const file = await film(dir);
  fs.writeFileSync(path.join(dir, "film.timeline.json"), JSON.stringify({ clips: [{ index: 1, kind: "scene", type: "opener", start: 0, seconds: 2 }, { index: 2, kind: "screen", start: 2, seconds: 10 }] }));
  const r = await checkFilm(file, {});
  assert.deepEqual(r.cuts.map((c) => [c.at, c.source, c.label]), [[0, "timeline", "scene opener"], [2, "timeline", "screen"]]);
});

test("check and frames take a film in a folder whose name ffmpeg could misread", { skip }, async () => {
  // An apostrophe, a colon and a backslash once broke the filters' notes
  // file, and a %d the stills, which ffmpeg read as a numbered sequence.
  // Windows takes none of a colon or a backslash in a name.
  const names = ["it's here", "Ay\u015fe'nin filmi", "q'u'o,t,e[s];f", "take%d", "50% off", ...(process.platform === "win32" ? [] : ["x'y:z", "a:b c,d[e];f", "back\\slash"])];
  for (const name of names) {
    const base = tmp();
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    const file = await film(dir);
    const r = await checkFilm(file, { lufs: "-22" });
    assert.equal(r.pass, true, `${name}: ${r.failed.join(", ")}`);
    assert.ok(r.audio.integrated < -20, `${name}: ${r.audio.integrated}`);
    assert.deepEqual(fs.readdirSync(path.join(dir, "check")).sort(), ["CHECK.md", "check.json", "sheet.png", "wave.png"], name);
    assert.equal(probe(path.join(dir, "check", "sheet.png")).height > 100, true, name);
    // No timeline: frames reads the cuts from the picture.
    const f = await saveFrames(file);
    assert.equal(f.cuts.length, 5, name);
    assert.deepEqual(fs.readdirSync(path.join(dir, "frames")).sort(), [...f.stills.map((x) => path.basename(x.file)), "sheet.jpg"].sort(), name);
    // Nothing went anywhere else.
    assert.deepEqual(fs.readdirSync(base), [name]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["check", "film.mp4", "frames"], name);
  }
});

test("no file of the kit asks ebur128 for a framelog value ffmpeg 4.4 refuses", () => {
  // Every .js file, as a host that looks for that value reads the installed
  // kit: hidden folders and node_modules aside.
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".js") && REFUSED_PATTERN.test(fs.readFileSync(file, "utf8"))) found.push(path.relative(root, file));
    }
  };
  walk(root);
  assert.deepEqual(found, []);
});

test("check runs on an ffmpeg that refuses ebur128's newer framelog value, as 4.4 does", { skip: noShell }, async () => {
  const dir = tmp();
  const file = await film(dir);
  // 4.4.2's own words for it, and its exit.
  const ffmpeg = standIn(dir, `case "$*" in *${REFUSED}*) echo '[Parsed_ebur128_0] Unable to parse option value "quiet"' >&2; echo 'Error setting option framelog to value quiet.' >&2; exit 1;; esac`);
  const r = cli(["check", file, "--lufs", "-22"], { LAUNCH_FILM_FFMPEG: ffmpeg });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^PASS, 3 warnings: /m);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "check", "check.json"), "utf8"));
  assert.ok(Math.abs(saved.audio.integrated - -21.6) <= 0.3, `integrated ${saved.audio.integrated}`);
});

// Every file in a folder, hidden ones too, with its bytes.
function snap(dir) {
  const seen = {};
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (fs.lstatSync(file).isDirectory()) walk(file, `${rel}${name}/`);
      else seen[`${rel}${name}`] = fs.readFileSync(file).toString("base64");
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return seen;
}

test("a check that cannot read the sound adds nothing and keeps an earlier report", { skip: noShell }, async () => {
  const dir = tmp();
  const file = await film(dir);
  const ffmpeg = standIn(tmp(), `case "$*" in *ebur128*) echo 'stand-in: the sound cannot be read' >&2; exit 1;; esac`);
  // Into a folder of its own: the folder is not made, and the last line
  // says so.
  const fresh = cli(["check", file, "--out", path.join(dir, "new", "check")], { LAUNCH_FILM_FFMPEG: ffmpeg });
  assert.equal(fresh.status, 1);
  assert.equal(fresh.stderr, `launch-film: reading the sound: ffmpeg failed: stand-in: the sound cannot be read\nlaunch-film: ${path.join(dir, "new", "check")} was not made.\n`);
  assert.ok(!fs.existsSync(path.join(dir, "new")), "no folder is made");
  // Over an earlier report: it stays as it was.
  assert.equal(cli(["check", file]).status, 0);
  const before = snap(dir);
  const again = cli(["check", file, "--lufs", "-14"], { LAUNCH_FILM_FFMPEG: ffmpeg });
  assert.equal(again.status, 1);
  assert.match(again.stderr, new RegExp(`\\nlaunch-film: ${path.join(dir, "check").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is as it was\\.\\n$`));
  assert.deepEqual(snap(dir), before);
});

test("an ffmpeg killed outright says so", { skip: noShell }, async () => {
  const dir = tmp();
  const file = await film(dir);
  // As the system kills it when it runs out of memory.
  const ffmpeg = standIn(tmp(), `case "$*" in *scdet*) kill -9 $$;; esac`);
  const r = cli(["check", file], { LAUNCH_FILM_FFMPEG: ffmpeg });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^launch-film: reading the picture: ffmpeg was stopped by SIGKILL, most often because the system ran out of memory\n/);
});
