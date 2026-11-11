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
const { tmp, WAITS, bigPicture, noisePicture } = require("./tmp");

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

// The skill checks a film at -14 LUFS, give or take 1 LU, and the render
// brings its sound there. In one pass, aimed at -16, the bed came out at
// -15.0 and a mastered track at -15.8, so the check failed.
test("a film's sound is brought to -14 LUFS, with the bed and with a mastered track of the user's", { skip, timeout: 240_000 }, async () => {
  const { checkFilm } = require("../src/check");
  const loudness = async (film) => (await checkFilm(film, { lufs: -14, out: path.join(tmp(), "check") })).audio.integrated;
  const bed = await renderedFolder();
  const withBed = await loudness(path.join(bed, "film.mp4"));
  assert.ok(Math.abs(withBed + 14) <= 0.5, `the film with the bed measures ${withBed} LUFS`);
  // A track mastered as musicfit writes one: -14 LUFS, its true peak at -1.
  const dir = filmFolder({ music: "music/track.wav" });
  fs.mkdirSync(path.join(dir, "music"));
  await mustRun(["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.3:duration=7:sample_rate=48000", "-af", "lowpass=f=6000,loudnorm=I=-14:TP=-1:LRA=11", "-ar", "48000", "-ac", "2", path.join(dir, "music", "track.wav")], "a track");
  const result = await renderFilm(path.join(dir, "film.json"), { jobs: 2 });
  const withTrack = await loudness(result.output);
  assert.ok(Math.abs(withTrack + 14) <= 0.5, `the film with the track measures ${withTrack} LUFS`);
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
// Text to be found as it is by a RegExp.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Each of a page's files goes to Chrome in one DevTools message: a picture of
// more than Chrome takes in one got no answer, and the page waited out its
// load. A film that named a screenshot of 80 MB rendered when pages were
// opened from the disk.
test("a picture larger than Chrome takes in one file goes to the page as a copy no larger than the page draws it, and a smaller one as it is", { skip: !available() && "ffmpeg not found", timeout: 120_000 }, async () => {
  const { loadFilm, buildClip, brandColours } = require("../src/film");
  const { PAGE_FILE_MAX } = require("../src/chrome");
  const dir = filmFolder({ clips: [
    { kind: "screen", seconds: 2.5, image: "big.bmp", mode: "pan" },
    { kind: "screen", seconds: 2.5, image: "big.bmp", mode: "zoom", box: [3000, 2000, 600, 300] },
    { kind: "shots", seconds: 2.5, images: ["big.bmp", "brand/appstore-1.png"] },
    { kind: "screen", seconds: 2.5, image: "brand/screenshot-1.png", mode: "pan" },
    { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" },
  ] });
  assert.ok(fs.statSync(bigPicture(dir)).size > PAGE_FILE_MAX);
  const loaded = loadFilm(path.join(dir, "film.json"));
  assert.deepEqual(loaded.problems, []);
  const fonts = { css: "", head: "Inter", body: "Inter", label: "JetBrains Mono", weight: { head: 700, body: 500 } };
  const ctx = { look: "launch", port: false, fonts, colours: brandColours(loaded.brand), work: tmp(), lang: "", brand: loaded.brand, notes: [] };
  const pages = [];
  for (const clip of loaded.clips.slice(0, 4)) {
    clip.render = clip.seconds;
    pages.push(await buildClip(clip, ctx));
  }
  // The size of a picture a page is given.
  const sizeOf = (data) => {
    const file = path.join(tmp(), "picture");
    fs.writeFileSync(file, data);
    const info = probe(file);
    return [info.width, info.height];
  };
  const [pan, zoom, shots, small] = pages;
  // A pan draws the window at most 1536 px wide and pushes in by 7 %; a zoom
  // moves the camera in up to 2.8 times; a card is about 800 px tall. Each
  // copy keeps the picture's shape.
  const [panW, panH] = sizeOf(pan.files["capture.jpg"]);
  assert.ok(panW >= 1536 * 0.199 * 1.07 && panW <= 1536 * 1.07 * 1.25 && Math.abs(panW / panH - 6400 / 4200) < 0.01, `the pan's copy is ${panW}x${panH}`);
  const [zoomW] = sizeOf(zoom.files["capture.jpg"]);
  assert.ok(zoomW > 2 * panW && zoomW < 6400, `the zoom's copy is ${zoomW} wide`);
  const [, shotH] = sizeOf(shots.files["shot-0.jpg"]);
  assert.ok(shotH >= 800 && shotH <= 1200, `the card's copy is ${shotH} tall`);
  for (const data of [pan.files["capture.jpg"], zoom.files["capture.jpg"], shots.files["shot-0.jpg"]]) assert.ok(data.length < PAGE_FILE_MAX, `${data.length} bytes`);
  // A picture Chrome takes as it is goes as it is.
  assert.ok(shots.files["shot-1.png"].equals(fs.readFileSync(path.join(dir, "brand", "appstore-1.png"))));
  assert.ok(small.files["capture.png"].equals(fs.readFileSync(path.join(dir, "brand", "screenshot-1.png"))));
});

// A zoom onto a small box draws the capture up to about 4 times the
// window's width, so a detailed picture of 5900 px was copied as it was, and
// the copy, still 68 MB, failed the clip in the page's own name for it.
test("a copy still larger than Chrome takes in one file is made smaller until it fits", { skip: !available() && "ffmpeg not found", timeout: 180_000 }, async () => {
  const { loadFilm, buildClip, brandColours } = require("../src/film");
  const { PAGE_FILE_MAX } = require("../src/chrome");
  const dir = filmFolder({ clips: [{ kind: "screen", seconds: 2.5, image: "noise.png", mode: "zoom", box: [100, 100, 300, 200] }, { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] });
  const file = noisePicture(dir, "noise.png", 5900, 3000, { alpha: true });
  assert.ok(fs.statSync(file).size > PAGE_FILE_MAX);
  const loaded = loadFilm(path.join(dir, "film.json"));
  assert.deepEqual(loaded.problems, []);
  const fonts = { css: "", head: "Inter", body: "Inter", label: "JetBrains Mono", weight: { head: 700, body: 500 } };
  const ctx = { look: "launch", port: false, fonts, colours: brandColours(loaded.brand), work: tmp(), lang: "", brand: loaded.brand, notes: [] };
  const clip = loaded.clips[0];
  clip.render = clip.seconds;
  const page = await buildClip(clip, ctx);
  const data = page.files["capture.png"];
  assert.ok(data.length <= PAGE_FILE_MAX, `${data.length} bytes`);
  const copy = path.join(tmp(), "copy.png");
  fs.writeFileSync(copy, data);
  const info = probe(copy);
  // As large as fits, in the picture's shape.
  assert.ok(info.width > 4000 && info.width < 5900 && Math.abs(info.width / info.height - 5900 / 3000) < 0.01, `the copy is ${info.width}x${info.height}`);
});

test("a film whose screenshot is larger than Chrome takes in one file renders", { skip, timeout: 240_000 }, async () => {
  const dir = filmFolder({ clips: [{ kind: "screen", seconds: 2.5, image: "big.bmp", mode: "pan" }, { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] });
  bigPicture(dir);
  const result = await renderFilm(path.join(dir, "film.json"), { jobs: 1 });
  assert.ok(Math.abs(probe(result.output).duration - 5) < 0.15);
});

test("a render that fails keeps the earlier film", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  // ffmpeg -y empties the file it writes before it fails: the film, as the
  // sound goes in.
  const ffmpeg = standIn(`case "$*" in *"-map 1:a"*) for last; do :; done; : > "$last"; echo 'stand-in: no sound today' >&2; exit 1;; esac`);
  const r = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json")], { encoding: "utf8", timeout: 200_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /adding the sound: ffmpeg failed: stand-in: no sound today\n/);
  // The last line says the film's folder is as it was.
  assert.ok(r.stderr.endsWith(`\nlaunch-film: ${dir} is as it was.\n`), r.stderr);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(leftBy(r.pid), []);
  // So does a render whose sound cannot be measured.
  const measuring = standIn(`case "$*" in *print_format=json*) echo 'stand-in: no measure today' >&2; exit 1;; esac`);
  const m = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json")], { encoding: "utf8", timeout: 200_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: measuring } });
  assert.equal(m.status, 1, m.stderr);
  assert.match(m.stderr, /measuring the sound: ffmpeg failed: stand-in: no measure today\n/);
  assert.ok(m.stderr.endsWith(`\nlaunch-film: ${dir} is as it was.\n`), m.stderr);
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(leftBy(m.pid), []);
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

test("a render whose ffmpeg stops reading its frames and then fails says so, and does not wait forever", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  // It reads nothing while the pipe fills up, then stops, as an ffmpeg does
  // that has lost its disk while it works.
  const ffmpeg = standIn(`case "$*" in *image2pipe*) sleep 4; echo 'stand-in: No space left on device' >&2; exit 1;; esac`);
  const r = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json"), "--jobs", "1"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  assert.equal(r.status, 1, `${r.signal || r.status}: ${r.stderr}`);
  assert.match(r.stderr, /^launch-film: rendering clip 1: ffmpeg failed: stand-in: No space left on device\n/m);
  assert.deepEqual(snap(dir), before);
});

test("a render whose ffmpeg cannot be started says so in a line of its own before any work", { skip, timeout: 240_000 }, async () => {
  const dir = await renderedFolder();
  const before = snap(dir);
  // The same with an --output of a kind that ffmpeg is tried on first, where
  // the render was refused as one ffmpeg cannot write a .avi file in.
  for (const output of [[], ["--output", path.join(dir, "film.avi")]]) {
    const r = spawnSync(process.execPath, [cli, "render", path.join(dir, "film.json"), "--jobs", "1", ...output], { encoding: "utf8", timeout: 120_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: path.join(dir, "no-such-ffmpeg") } });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film needs ffmpeg, and LAUNCH_FILM_FFMPEG points to ${path.join(dir, "no-such-ffmpeg")}, which is not there. ` +
      "Set LAUNCH_FILM_FFMPEG to an ffmpeg 4.4 or newer, or unset it and install one (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg).\n", output.join(" "));
  }
  assert.deepEqual(snap(dir), before);
});

// A stand-in Chrome on the DevTools pipe. It answers every call, but leaves
// Target.createTarget unanswered with STAND_IN=no-tab, as a Chrome too busy
// to answer, or is killed there with STAND_IN=killed, as by the system when
// it runs out of memory; and it never says that a page has loaded.
function pipeChrome() {
  const dir = tmp();
  const script = path.join(dir, "chrome.js");
  fs.writeFileSync(script, `const fs = require("fs");
let buf = Buffer.alloc(0);
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (let i; (i = buf.indexOf(0)) >= 0; ) {
    const msg = JSON.parse(buf.subarray(0, i).toString());
    buf = buf.subarray(i + 1);
    if (msg.method === "Browser.close") process.exit(0);
    if (msg.method === "Target.createTarget" && process.env.STAND_IN === "no-tab") continue;
    if (msg.method === "Target.createTarget" && process.env.STAND_IN === "killed") process.kill(process.pid, "SIGKILL");
    const result = msg.method === "Target.createTarget" ? { targetId: "t" } : msg.method === "Target.attachToTarget" ? { sessionId: "s" } : {};
    fs.writeSync(4, JSON.stringify({ id: msg.id, result }) + "\\0");
  }
});
${WAITS}`);
  const chrome = path.join(dir, "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  // The CLI's waits on Chrome, 60 s for an answer and 30 s for a page to
  // load, cut to a moment and a half; but for each Chrome's start, which a
  // loaded machine can take a while over: its first call, which launch()
  // sends as it starts it, two Chromes at once when two clips render.
  const stub = path.join(dir, "stub.js");
  fs.writeFileSync(stub, `if (/launch-film\\.js$/.test(process.argv[1] || "")) {
  const real = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    if (ms === 60000 && /\\n\\s+at launch \\(/.test(new Error().stack)) return real(fn, ms, ...rest);
    return real(fn, ms === 60000 || ms === 30000 ? 1500 : ms, ...rest);
  };
}`);
  return { chrome, env: { LAUNCH_FILM_CHROME: chrome, NODE_OPTIONS: `--require ${stub}` } };
}

test("a Chrome too slow to answer, or one that cannot be started, ends the render with what did not answer and what to do", { skip: process.platform === "win32" ? "the stand-in Chrome is a shell script" : !available() && "ffmpeg not found", timeout: 180_000 }, () => {
  const dir = filmFolder({ clips: [FILM.clips[0]] });
  const two = filmFolder();
  const before = snap(dir);
  const beforeTwo = snap(two);
  const { chrome, env } = pipeChrome();
  const renderOf = (folder) => (more, ...args) => spawnSync(process.execPath, [cli, "render", path.join(folder, "film.json"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env, ...more } });
  const render = renderOf(dir);
  const busy = "most often because the machine is too busy: run again once it is less busy";
  const ended = `launch-film: ${dir} is as it was.\n`;
  // A film of one clip renders one clip at a time with any --jobs, so the
  // default of two adds nothing.
  const tab = render({ STAND_IN: "no-tab" });
  assert.equal(tab.status, 1, tab.stderr);
  assert.equal(tab.stderr, `launch-film: rendering clip 1: Chrome did not answer Target.createTarget within 60 s, ${busy}\n${ended}`);
  // With two clips at once it adds that one at a time eases the machine.
  // Either clip can be the first whose wait runs out.
  const both = renderOf(two)({ STAND_IN: "no-tab" });
  assert.equal(both.status, 1, both.stderr);
  assert.match(both.stderr, new RegExp(`^launch-film: rendering clip [12]: ${escape(`Chrome did not answer Target.createTarget within 60 s, ${busy}, or with --jobs 1 to render one clip at a time\nlaunch-film: ${two} is as it was.\n`)}$`));
  // And not with one at a time.
  const load = renderOf(two)({}, "--jobs", "1");
  assert.equal(load.status, 1, load.stderr);
  assert.equal(load.stderr, `launch-film: rendering clip 1: the page did not load within 30 s, ${busy}\nlaunch-film: ${two} is as it was.\n`);
  // One killed by a signal says which, where it said "exit null", and was
  // not too slow: two clips at once add nothing.
  const killed = renderOf(two)({ STAND_IN: "killed" });
  assert.equal(killed.status, 1, killed.stderr);
  assert.match(killed.stderr, new RegExp(`^launch-film: rendering clip [12]: ${escape(`Chrome was stopped by SIGKILL, most often because the system ran out of memory\nlaunch-film: ${two} is as it was.\n`)}$`));
  // One that cannot be run failed nothing, and the run ended with 0 and no
  // word, as if the film had been made. It is refused before any work.
  fs.chmodSync(chrome, 0o644);
  const none = render({});
  assert.equal(none.status, 1, none.stderr);
  assert.equal(none.stderr, `launch-film needs Chrome, and LAUNCH_FILM_CHROME points to ${chrome}, which is a file without the permission to run it, which chmod +x gives. ` +
    "Set LAUNCH_FILM_CHROME to the Chrome program itself, or unset it and install Google Chrome or Chromium.\n");
  assert.deepEqual(snap(dir), before);
  assert.deepEqual(snap(two), beforeTwo);
  for (const r of [tab, both, load, killed, none]) assert.deepEqual(leftBy(r.pid), []);
});

test("a page script that Chrome ends at its time limit is told of as that, not as Chrome's \"Internal error\"", async () => {
  const page = (after, err) => ({ call: () => new Promise((resolve, reject) => setTimeout(() => reject(err), after)) });
  const answered = () => Object.assign(new Error("Internal error"), { answered: true });
  await assert.rejects(evaluate(page(80, answered()), "1", 50), { message: "the page's script did not finish within 0.05 s, most often because the machine is too busy: run again once it is less busy", slow: true });
  // Chrome's own answer before the limit, and a call that got none, are as they were.
  await assert.rejects(evaluate(page(0, answered()), "1", 5000), { message: "Internal error" });
  await assert.rejects(evaluate(page(80, new Error("Chrome stopped (exit 1)")), "1", 50), { message: "Chrome stopped (exit 1)" });
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
