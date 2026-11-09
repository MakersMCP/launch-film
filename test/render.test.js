"use strict";
// Renders in Chrome and encodes with ffmpeg: skipped when either is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { findChrome, launch, openPage, evaluate } = require("../src/chrome");
const { FFMPEG, available, probe, readPixels, mustRun } = require("../src/ffmpeg");
const { renderFilm } = require("../src/film");
const audio = require("../src/audio");
const { tmp } = require("./tmp");

const skip = !findChrome() ? "Chrome not found" : !available() ? "ffmpeg not found" : false;
const noShell = process.platform === "win32" ? "the stand-in ffmpeg is a shell script" : skip;
const cli = path.join(__dirname, "..", "bin", "launch-film.js");
const fixture = path.join(__dirname, "fixtures", "acme");
const TIMELINE = fs.readFileSync(path.join(__dirname, "..", "src", "runtime", "timeline.js"), "utf8");

async function withPage(body, fn) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><script>${TIMELINE}</script></head><body>${body}</body></html>`);
  const browser = await launch({ W: 800, H: 600 });
  try {
    const { page } = await openPage(browser, dir, { W: 800, H: 600 });
    return await fn((expr) => evaluate(page, expr));
  } finally {
    browser.close();
  }
}

test("the timeline seeks tweens to a time", { skip }, async () => {
  await withPage(`<div id="a" style="width:100px;height:20px"></div><div id="b"></div><span id="c">0</span>
    <p id="t" style="font-size:40px;width:600px">Notes that think</p>`, async (js) => {
    await js(`window.tl = gsap.timeline({ paused: true });
      tl.from("#a", { y: 100, opacity: 0, duration: 1, ease: "none" }, 0.5);
      tl.fromTo("#b", { x: 0 }, { x: 200, duration: 1, ease: "none" }, 1);
      tl.to("#b", { x: "+=50", duration: 1, ease: "none" }, 2);
      const o = { v: 0 };
      tl.to(o, { v: 100, duration: 1, ease: "none", onUpdate() { document.getElementById("c").textContent = Math.round(o.v); } }, 0);
      window.split = new SplitText("#t", { type: "words", mask: "words" });
      tl.from(split.words, { yPercent: 100, duration: 0.5, stagger: 0.25, ease: "none" }, 0);
      true`);
    const at = (s) => js(`tl.seek(${s}); [getComputedStyle(a).opacity, a.style.transform, b.style.transform, c.textContent, split.words.map((w) => w.style.transform)]`);
    let [op, ta, tb, count, words] = await at(0);
    assert.equal(op, "0");
    assert.equal(ta, "translate(0px, 100px)");
    assert.equal(tb, "none");
    assert.equal(count, "0");
    assert.equal(words.length, 3);
    assert.equal(words[2], "translate(0%, 100%)");
    [op, ta, tb, count, words] = await at(1);
    assert.equal(op, "0.5");
    assert.equal(ta, "translate(0px, 50px)");
    assert.equal(count, "100");
    assert.equal(words[0], "none");
    [op, ta, tb] = await at(1.5);
    assert.equal(tb, "translate(100px, 0px)");
    // The relative tween starts where the fromTo ended.
    [op, ta, tb] = await at(2.5);
    assert.equal(tb, "translate(225px, 0px)");
    [op, ta, tb] = await at(4);
    assert.equal(op, "1");
    assert.equal(ta, "none");
    assert.equal(tb, "translate(250px, 0px)");
    // Words sit in masks that clip them.
    assert.equal(await js(`getComputedStyle(split.words[0].parentElement).overflow`), "clip");
  });
});

test("eases, yoyo and an inline transform the element already has", { skip }, async () => {
  await withPage(`<div id="n" style="transform:rotate(-90deg)"></div><div id="y"></div><div id="k" style="transform:translateX(-50%)"></div>`, async (js) => {
    await js(`window.tl = gsap.timeline({ paused: true });
      tl.to("#n", { rotation: 0, duration: 1, ease: "power2.out" }, 0);
      tl.to("#y", { y: -10, duration: 1, ease: "sine.inOut", yoyo: true, repeat: 3 }, 0);
      tl.from("#k", { y: 40, duration: 1 }, 0); true`);
    const at = (s) => js(`tl.seek(${s}); [n.style.transform, y.style.transform, k.style.transform]`);
    let [n, y, k] = await at(0.5);
    assert.equal(n, "rotate(-11.25deg)");
    assert.equal(y, "translate(0px, -5px)");
    assert.match(k, /^translate\(-50%, 0%\) translate\(0px, /);
    [n, y, k] = await at(1.5);
    assert.equal(n, "none");
    assert.equal(y, "translate(0px, -5px)");
    [n, y, k] = await at(10);
    assert.equal(y, "none");
    assert.equal(k, "translate(-50%, 0%)");
    const eases = await js(`["expo.out", "back.out(1.7)", "power3.inOut", "none", "steps(4)"].map((e) => +gsap.parseEase(e)(0.5).toFixed(4))`);
    assert.deepEqual(eases, [0.9688, 1.0875, 0.5, 0.5, 0.5]);
  });
});

// A film of two clips, 5 s long, with the test brand.
const FILM = {
  version: 1, brand: "brand/brand.json", look: "launch", aspect: "16:9", music: true, sfx: true,
  clips: [
    { kind: "scene", seconds: 2.5, scene: { type: "opener", title: "Acme Notes", text: "Notes that think with you" } },
    { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png", site: "acme-notes.example" },
  ],
};
// A folder holding the test brand and film.json, with `change` made to it.
function filmFolder(change = {}) {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...FILM, ...change }));
  return dir;
}

// A film's sound, decoded to mono floats at 48 kHz.
function soundOf(file) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  const out = new Float32Array(r.stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readFloatLE(4 * i);
  return out;
}

// A film rendered once, for the tests that need an earlier render: each
// gets a copy of its folder.
let rendered = null;
async function renderedFolder() {
  if (!rendered) {
    const dir = filmFolder();
    await renderFilm(path.join(dir, "film.json"), { jobs: 2 });
    rendered = dir;
  }
  const copy = tmp();
  fs.cpSync(rendered, copy, { recursive: true });
  return copy;
}

test("a short film renders with picture and sound", { skip, timeout: 240_000 }, async () => {
  const dir = filmFolder();
  const result = await renderFilm(path.join(dir, "film.json"), { jobs: 2 });
  rendered = dir;
  const info = probe(result.output);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.ok(info.audio, "the film has sound");
  assert.ok(Math.abs(info.duration - 5) < 0.15, `duration ${info.duration}`);
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, "film.timeline.json"), "utf8"));
  assert.deepEqual(timeline.clips.map((c) => c.start), [0, 2.5]);
  // A still from each clip is a picture, not a blank frame.
  for (const at of [1.6, 4.2]) {
    const still = path.join(dir, `still-${at}.png`);
    await mustRun(["-ss", String(at), "-i", result.output, "-frames:v", "1", still], "a still");
    const px = readPixels(still, 320);
    const lum = [];
    for (let i = 0; i < px.data.length; i += 4) lum.push(px.data[i] + px.data[i + 1] + px.data[i + 2]);
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const spread = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
    assert.ok(spread > 20, `the still at ${at} s has something on it (spread ${spread.toFixed(1)})`);
  }
});

test("a film plays the track film.json names, in place of the bed", { skip, timeout: 240_000 }, async () => {
  const dir = filmFolder({ music: "music/tone.wav", sfx: false });
  // 6 s of a 440 Hz tone: the beds hold nothing like it.
  const tone = new audio.Bus(6);
  for (let i = 0; i < tone.length; i++) tone.L[i] = tone.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / audio.SR);
  fs.mkdirSync(path.join(dir, "music"));
  audio.writeWav(path.join(dir, "music", "tone.wav"), tone);
  const result = await renderFilm(path.join(dir, "film.json"), { jobs: 2 });
  assert.ok(result.notes.some((n) => /^The music is music\/tone\.wav, at the bed's level, from the film's first frame to its end at 5\.00 s/.test(n)), result.notes.join(" | "));
  const sound = soundOf(result.output);
  // A 440 Hz tone crosses zero 880 times a second; a bed many times more.
  let crossings = 0;
  for (let i = audio.SR + 1; i < 4 * audio.SR; i++) if ((sound[i - 1] < 0) !== (sound[i] < 0)) crossings++;
  assert.ok(Math.abs(crossings / 3 - 880) < 20, `${(crossings / 3).toFixed(0)} zero crossings a second`);
  // Faded out at the end.
  const peak = (from, to) => sound.subarray(Math.round(from * audio.SR), Math.round(to * audio.SR)).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
  const end = sound.length / audio.SR;
  assert.ok(peak(end - 0.05, end) < 0.1 * peak(1, 4), `the last 50 ms peak at ${peak(end - 0.05, end).toFixed(3)} against ${peak(1, 4).toFixed(3)}`);
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
  walk(dir, "");
  return seen;
}
// What a CLI run of that process id left in the temp folder.
const leftBy = (pid) => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("launch-film-") && n.includes(`-${pid}-`));
// A stand-in for ffmpeg: a line of sh that may answer for it first ("$@"
// are the arguments), then the ffmpeg the tests run.
function standIn(line) {
  const file = path.join(tmp(), "ffmpeg");
  const real = process.env.LAUNCH_FILM_FFMPEG || "ffmpeg";
  fs.writeFileSync(file, `#!/bin/sh\n${line}\nexec '${real.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  return file;
}

// ffmpeg 4.4 on a full disk writes as much of a picture as fits and exits
// with 0. This stand-in writes each picture, then cuts it to half.
const CUTS_PICTURES = `case "$*" in *"-update 1"*) for last; do :; done; '${(process.env.LAUNCH_FILM_FFMPEG || "ffmpeg").replace(/'/g, "'\\''")}' "$@" || exit $?; ` +
  `size=$(wc -c < "$last"); head -c $((size / 2)) "$last" > "$last.cut" && mv "$last.cut" "$last"; exit 0;; esac`;

test("a clip whose picture ffmpeg cuts short leaves out the blurred ground, and fails for the phone's screen and the logo", { skip: process.platform === "win32" ? "the stand-in ffmpeg is a shell script" : !available() && "ffmpeg not found" }, () => {
  // Each clip's page is made as a render makes it, with the stand-in: the
  // CLI reads LAUNCH_FILM_FFMPEG once, as it starts, so in a process of its
  // own. The logo's mark cut short is the disk's fault, not the logo's: no
  // other logo is tried for it.
  const dir = filmFolder({ clips: [
    { kind: "screen", seconds: 2.5, image: "brand/screenshot-1.png", mode: "pan" },
    { kind: "phone", seconds: 2.5, image: "brand/appstore-1.png" },
    { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" },
  ] });
  const script = `
const fs = require("fs");
const path = require("path");
const { loadFilm, buildClip, brandColours } = require(${JSON.stringify(path.join(__dirname, "..", "src", "film.js"))});
const loaded = loadFilm(process.argv[1]);
const fonts = { css: "", head: "Inter", body: "Inter", label: "JetBrains Mono", weight: { head: 700, body: 500 } };
(async () => {
  const said = [];
  for (const clip of loaded.clips) {
    clip.render = clip.seconds;
    const work = fs.mkdtempSync(path.join(process.argv[2], "work-"));
    const ctx = { look: "launch", port: false, fonts, colours: brandColours(loaded.brand), work, lang: "", brand: loaded.brand, notes: [] };
    said.push(await buildClip(clip, ctx).then((page) => ({ files: Object.keys(page.files), soft: page.html.includes("soft.jpg") }), (err) => ({ error: err.message })));
  }
  process.stdout.write(JSON.stringify(said));
})();
`;
  const r = spawnSync(process.execPath, ["-e", script, path.join(dir, "film.json"), tmp()], { encoding: "utf8", timeout: 120_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: standIn(CUTS_PICTURES) } });
  assert.equal(r.status, 0, r.stderr);
  const [screen, phone, logo] = JSON.parse(r.stdout);
  assert.deepEqual(screen, { files: ["capture.png"], soft: false });
  assert.deepEqual(phone, { error: "clip 2: the picture was cut short, most often because the disk is full" });
  assert.deepEqual(logo, { error: "writing a picture: the picture was cut short, most often because the disk is full" });
});

test("a render that fails keeps the earlier film", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  // ffmpeg -y empties the file it writes before it fails.
  const ffmpeg = standIn(`case "$*" in *loudnorm*) for last; do :; done; : > "$last"; echo 'stand-in: no sound today' >&2; exit 1;; esac`);
  const r = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json")], { encoding: "utf8", timeout: 200_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /adding the sound: ffmpeg failed: stand-in: no sound today\n/);
  // The last line says the film's folder is as it was.
  assert.ok(r.stderr.endsWith(`\nlaunch-film: ${dir} is as it was.\n`), r.stderr);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(leftBy(r.pid), []);
});

test("a render whose clip encoder stops ends with its words and keeps the earlier film", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  // An ffmpeg that cannot write the clip stops before it reads a frame, as
  // on a full disk.
  const ffmpeg = standIn(`case "$*" in *image2pipe*) echo 'stand-in: No space left on device' >&2; exit 1;; esac`);
  const r = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json"), "--jobs", "1"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  assert.equal(r.status, 1, `${r.signal || r.status}: ${r.stderr}`);
  // It says which clip it stopped, as ffmpeg's own words do not.
  assert.match(r.stderr, /^launch-film: rendering clip 1: ffmpeg failed: stand-in: No space left on device\n/m);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(leftBy(r.pid), []);
});

test("a render stopped with SIGTERM leaves the folder and the temp folder as they were", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  const child = spawn(process.execPath, [cli, "render", path.join(dir, "film.json"), "--jobs", "1"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  // Stopped while the second clip renders.
  await new Promise((resolve) => child.stderr.on("data", (d) => {
    stderr += d;
    if (/clip 1\//.test(stderr)) resolve();
  }));
  child.kill("SIGTERM");
  const { signal } = await ended;
  assert.equal(signal, "SIGTERM", stderr);
  // Stopped while its clips render, it says which folder it left as it was.
  assert.ok(stderr.endsWith(`\nlaunch-film: stopped, so ${dir} is as it was\n`), stderr);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(leftBy(child.pid), []);
  // No Chrome of it runs on: none names its profile.
  if (process.platform === "linux") {
    const running = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes(`launch-film-chrome-${child.pid}-`);
      } catch {
        return false;
      }
    });
    assert.deepEqual(running, []);
  }
});
