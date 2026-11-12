"use strict";
// The stills' pages are tested as HTML; making them needs Chrome and ffmpeg
// and is skipped when either is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { findChrome } = require("../src/chrome");
const { available, probe, readPixels } = require("../src/ffmpeg");
const { makeStills, parseTargets, galleryClips, TARGETS } = require("../src/stills");
const motion = require("../src/motion");
const { readBrand } = require("../src/brand");
const { planFilm } = require("../src/plan");
const { tmp, bigPicture } = require("./tmp");
const { windowPart, stillPictures } = require("../src/stills");
const { stillHtml } = require("../src/motion");

const skip = !findChrome() ? "Chrome not found" : !available() ? "ffmpeg not found" : false;
const noShell = process.platform === "win32" ? "the stand-in ffmpeg is a shell script" : skip;
const fixture = path.join(__dirname, "fixtures", "acme");
const fonts = { css: "", head: "Inter", body: "Inter", label: "JetBrains Mono", weight: { head: 700, body: 500 } };

test("targets: their names and sizes, and one that is not a target", () => {
  assert.deepEqual(parseTargets(), ["ph", "og", "x", "play", "chrome"]);
  assert.deepEqual(parseTargets("og, x,og"), ["og", "x"]);
  assert.throws(() => parseTargets("tiktok"), /choose from ph, og, x, play, chrome/);
  const sizes = Object.values(TARGETS).flat().filter((t) => t.kind !== "frames").map((t) => `${t.name} ${t.W}x${t.H}`);
  assert.deepEqual(sizes, ["ph-1 1270x760", "ph-thumbnail 240x240", "og 1200x630", "x 1600x900", "play-feature 1024x500", "chrome-small 440x280", "chrome-marquee 1400x560"]);
});

test("the gallery takes the film's scenes but the opener and the screen the first picture shows", () => {
  const clip = (kind, type) => ({ kind, scene: type ? { type } : undefined });
  const clips = [clip("scene", "opener"), clip("screen"), clip("scene", "headline"), clip("scene", "features"), clip("shots"), clip("scene", "number"), clip("logo")];
  const kinds = (list) => list.map((c) => (c.scene ? c.scene.type : c.kind));
  assert.deepEqual(kinds(galleryClips(clips, { heroScreen: true })), ["headline", "features", "shots", "number", "logo"]);
  // Six would be one too many: a screen goes before a scene does.
  assert.deepEqual(kinds(galleryClips(clips, { heroScreen: false })), ["headline", "features", "shots", "number", "logo"]);
  const longer = [...clips.slice(0, 3), clip("phone"), ...clips.slice(3)];
  const g = galleryClips(longer, { heroScreen: true });
  assert.equal(g.length, 5);
  assert.equal(g[g.length - 1].kind, "logo");
  assert.ok(!g.some((c) => c.kind === "phone"), "a phone goes before a scene");
});

test("every look lays out a hero, a hero with no words and a tile", () => {
  for (const look of Object.keys(motion.LOOKS)) {
    const hero = motion.stillHtml({ kind: "hero", look, W: 1920, H: 1008, brand: { accent: "#5B4FE9" }, fonts, mark: { file: "mark.png", w: 560, h: 240, ground: "#FFFFFF" },
      name: "Acme Notes", title: "Notes that *think* with you", site: "acme-notes.example", screen: { file: "screen.png", w: 2880, h: 1800 }, shots: [] });
    assert.match(hero.html, /class="st-win"/, look);
    assert.match(hero.html, /<span class="mk">think<\/span>/, look);
    assert.match(hero.html, /acme-notes\.example/, look);
    assert.ok(!/undefined|NaN/.test(hero.html), `${look}: undefined or NaN in the hero`);
    const bare = motion.stillHtml({ kind: "hero", look, W: 1920, H: 768, brand: {}, fonts, mark: null, name: "Acme Notes", title: "Notes", site: "acme-notes.example", words: false,
      screen: null, shots: [{ file: "shot-0.png", w: 1290, h: 2796 }] });
    assert.ok(!/class="[^"]*st-(title|site)|acme-notes\.example/.test(bare.html), `${look}: the words are left out`);
    assert.match(bare.html, /class="st-shot"/, look);
    const tile = motion.stillHtml({ kind: "tile", look, W: 1920, H: 1222, brand: {}, fonts, mark: { file: "icon.png", w: 360, h: 360, icon: true, ground: "#5B4FE9" }, name: "Acme Notes", title: "x", site: "y" });
    assert.match(tile.html, /st-mark icon/, look);
    assert.ok(!/class="[^"]*st-(title|site)/.test(tile.html), `${look}: a tile has no words`);
  }
});

test("stills come out at their exact sizes from a film's plan", { skip }, async () => {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  const brand = readBrand(path.join(dir, "brand", "brand.json"));
  const words = JSON.parse(fs.readFileSync(path.join(fixture, "words.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify(planFilm(brand, words, { filmDir: dir })));
  const r = await makeStills(path.join(dir, "film.json"));
  const names = r.files.map((f) => f.name);
  assert.deepEqual(names.filter((n) => !/^ph-[2-9]/.test(n)), ["ph-1.png", "ph-thumbnail.png", "og.png", "x.png", "play-feature.png", "chrome-small.png", "chrome-marquee.png"]);
  const gallery = names.filter((n) => /^ph-\d/.test(n)).length;
  assert.ok(gallery >= 3 && gallery <= 6, `${gallery} gallery pictures`);
  for (const f of r.files) {
    const info = probe(f.file);
    assert.deepEqual([info.width, info.height], [f.W, f.H], f.name);
    assert.equal(info.pixFmt, "rgb24", `${f.name} is opaque`);
  }
  // The hero is a picture, not a blank.
  const px = readPixels(path.join(r.dir, "og.png"), 320);
  const lum = [];
  for (let i = 0; i < px.data.length; i += 4) lum.push(px.data[i] + px.data[i + 1] + px.data[i + 2]);
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  assert.ok(Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length) > 20, "og.png has something on it");
  const md = fs.readFileSync(path.join(r.dir, "STILLS.md"), "utf8");
  assert.match(md, /\| og\.png \| 1200x630 \| og:image/);
  assert.ok(!/[\u2013\u2014]/.test(md), "STILLS.md has no dashes");
  assert.ok(!fs.readdirSync(r.dir).some((n) => n.startsWith(".work")), "the work files are gone");
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

test("a stills run that fails keeps the earlier pictures", { skip: noShell, timeout: 240_000 }, async () => {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  const words = JSON.parse(fs.readFileSync(path.join(fixture, "words.json"), "utf8"));
  const film = planFilm(readBrand(path.join(dir, "brand", "brand.json")), words, { filmDir: dir });
  const filmFile = path.join(dir, "film.json");
  fs.writeFileSync(filmFile, JSON.stringify(film));
  await makeStills(filmFile, { targets: "og,x" });
  // New words, so a picture made again is not the same file.
  film.clips[0].scene.text = "Notes that link themselves";
  fs.writeFileSync(filmFile, JSON.stringify(film));
  const before = snap(dir);
  // og.png is made again, then x.png fails, emptied first as ffmpeg -y does.
  const ffmpeg = path.join(tmp(), "ffmpeg");
  fs.writeFileSync(ffmpeg, `#!/bin/sh\ncase "$*" in *x.png*) for last; do :; done; : > "$last"; echo 'stand-in: no x today' >&2; exit 1;; esac\nexec '${(process.env.LAUNCH_FILM_FFMPEG || "ffmpeg").replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "launch-film.js"), "stills", filmFile, "--for", "og,x"],
    { encoding: "utf8", timeout: 200_000, env: { ...process.env, LAUNCH_FILM_FFMPEG: ffmpeg } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /making .*stills\/x\.png: ffmpeg failed: stand-in: no x today/);
  assert.ok(!/launch-film-part/.test(r.stderr), "the message names the picture where it goes");
  assert.deepEqual(snap(dir), before);
});

// A film of the test brand in a folder of its own: `change` is made to its
// brand.json first.
function plannedFolder(change = (kit) => kit) {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  const kitFile = path.join(dir, "brand", "brand.json");
  fs.writeFileSync(kitFile, JSON.stringify(change(JSON.parse(fs.readFileSync(kitFile, "utf8")))));
  const words = JSON.parse(fs.readFileSync(path.join(fixture, "words.json"), "utf8"));
  const filmFile = path.join(dir, "film.json");
  fs.writeFileSync(filmFile, JSON.stringify(planFilm(readBrand(kitFile), words, { filmDir: dir })));
  return { dir, filmFile };
}

// A stand-in for ffmpeg that cuts short the picture of that name, as ffmpeg
// 4.4 does on a full disk while it exits with 0.
function cuts(name) {
  const file = path.join(tmp(), "ffmpeg");
  const real = (process.env.LAUNCH_FILM_FFMPEG || "ffmpeg").replace(/'/g, "'\\''");
  fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in *"-update 1"*${name}) for last; do :; done; '${real}' "$@" || exit $?; size=$(wc -c < "$last"); head -c $((size / 2)) "$last" > "$last.cut" && mv "$last.cut" "$last"; exit 0;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return file;
}
const stills = (args, env) => spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "launch-film.js"), "stills", ...args], { encoding: "utf8", timeout: 200_000, env: { ...process.env, ...env } });

test("an app icon or a square logo that cannot be written, as on a full disk, fails the stills", { skip: noShell, timeout: 240_000 }, async () => {
  // The app icon, then a brand with no app and a square logo of its own.
  let { dir, filmFile } = plannedFolder();
  let r = stills([filmFile, "--for", "og"], { LAUNCH_FILM_FFMPEG: cuts("icon.png") });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^launch-film: writing a picture: the picture was cut short, most often because the disk is full\n/);
  assert.ok(!fs.existsSync(path.join(dir, "stills")));
  const square = tmp();
  const made = spawnSync(process.env.LAUNCH_FILM_FFMPEG || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=white:s=400x400", "-vf", "drawbox=x=100:y=100:w=200:h=200:color=0x5B4FE9:t=fill", "-frames:v", "1", "-update", "1", path.join(square, "logo-square.png")], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  ({ dir, filmFile } = plannedFolder((kit) => ({ ...kit, stores: [], links: [], logos: [...kit.logos, { file: path.join(square, "logo-square.png"), where: "footer", kind: "img", background: "#FFFFFF", width: 400, height: 400 }] })));
  r = stills([filmFile, "--for", "ph"], { LAUNCH_FILM_FFMPEG: cuts("square.png") });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^launch-film: writing a picture: the picture was cut short, most often because the disk is full\n/);
  assert.ok(!fs.existsSync(path.join(dir, "stills")));
});

test("a picture that cannot be saved is named as the new one, with the reason", { skip, timeout: 240_000 }, async () => {
  const { dir, filmFile } = plannedFolder();
  const stub = path.join(tmp(), "stub.js");
  fs.writeFileSync(stub, `const fs = require("fs");
const real = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (String(file).endsWith(".raw.png")) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  return real(file, ...rest);
};
`);
  const r = stills([filmFile, "--for", "og"], { NODE_OPTIONS: `--require ${stub}` });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.split("\n").slice(-3, -1).join("\n"), `launch-film: making the new ${path.join(dir, "stills", "og.png")}: no space left on device (ENOSPC)\nlaunch-film: ${path.join(dir, "stills")} was not made.`);
});

// A name film.json gives can hold a line break, after which the rest of a
// message read as a line of launch-film's own, and can run to thousands of
// characters: the stills say a picture's name on one line and cut, and the
// path made from it on one line. Here the copy of every picture fails, as
// one too large for Chrome does, in the words it is given.
test("a picture of the stills is named on one line and cut, as film.json gives it", { skip: !available() && "ffmpeg not found", timeout: 120_000 }, () => {
  const { dir, filmFile } = plannedFolder();
  const film = JSON.parse(fs.readFileSync(filmFile, "utf8"));
  const index = film.clips.findIndex((c) => c.kind === "screen");
  assert.ok(index >= 0, "the plan has a screen clip");
  const name = `shots/a\nlaunch-film: Made 7 stills: ${"x".repeat(120)}.png`;
  fs.mkdirSync(path.join(dir, "shots"));
  fs.copyFileSync(path.join(fixture, "screenshot-1.png"), path.join(dir, name));
  film.clips[index].image = name;
  fs.writeFileSync(filmFile, JSON.stringify(film));
  const stub = path.join(tmp(), "copy-fails.js");
  fs.writeFileSync(stub, `const film = require(${JSON.stringify(path.join(__dirname, "..", "src", "film.js"))});
film.pagePicture = async (file, { named, what }) => {
  throw new Error(named + " | " + what);
};
`);
  const script = `require(${JSON.stringify(path.join(__dirname, "..", "src", "stills.js"))}).makeStills(process.argv[1], { targets: "og" }).then(() => process.stdout.write("made"), (err) => process.stdout.write(err.message));`;
  const r = spawnSync(process.execPath, ["--require", stub, "-e", script, filmFile], { encoding: "utf8", timeout: 100_000 });
  // On one line, and cut in the middle past 100 characters, or a path past 300.
  const said = (text, room) => {
    const line = text.replace(/\n/g, "\\n");
    return line.length > room ? `${line.slice(0, room / 2)}...${line.slice(-(room / 2 - 10))}` : line;
  };
  assert.equal(r.stdout, `clips[${index}].image "${said(name, 100)}" | making a copy of ${said(path.join(dir, name), 300)}`, r.stderr);
});

// The stills' pages are given their files as a clip's page is: a screenshot
// of more than Chrome takes in one file goes as a copy, as large as a still
// draws it. Given as it was, it failed the stills.
test("the stills of a film whose screenshot is larger than Chrome takes in one file are made", { skip, timeout: 240_000 }, async () => {
  const { dir, filmFile } = plannedFolder();
  const film = JSON.parse(fs.readFileSync(filmFile, "utf8"));
  const screen = film.clips.find((c) => c.kind === "screen");
  assert.ok(screen, "the plan has a screen clip");
  screen.image = path.basename(bigPicture(dir));
  fs.writeFileSync(filmFile, JSON.stringify(film));
  const r = stills([filmFile, "--for", "og"], {});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([probe(path.join(dir, "stills", "og.png")).width, probe(path.join(dir, "stills", "og.png")).height], [1200, 630]);
});

// The hero's window draws the site's screen at the window's width, cut from
// the top. A tall screen larger than Chrome takes in one file went as a copy
// that fit 2400 x 2400 whole: 400 px wide for a 2000 x 12000 picture, which
// the window then drew more than twice as wide, blurred.
test("a tall screen larger than Chrome takes in one file goes to the stills as the top their window shows, as wide as the window draws it", { skip: !available() && "ffmpeg not found", timeout: 120_000 }, async () => {
  const dir = tmp();
  const src = bigPicture(dir, "tall.bmp", [2000, 12000]);
  assert.deepEqual(windowPart(2000, 12000), { x: 0, y: 0, w: 2000, h: 1600 });
  // A picture of the window's own shape is shown whole, and a wide one by its middle.
  assert.deepEqual(windowPart(1440, 900), { x: 0, y: 0, w: 1440, h: 900 });
  assert.deepEqual(windowPart(10000, 1000), { x: 4050, y: 0, w: 1900, h: 1000 });
  const files = await stillPictures({ screen: { file: "screen.jpg", src, w: 2000, h: 12000, named: 'clips[1].image "tall.bmp"' }, work: tmp() });
  const copy = path.join(tmp(), "screen.jpg");
  fs.writeFileSync(copy, files["screen.jpg"]);
  const { width, height } = probe(copy);
  assert.deepEqual([width, height], [2000, 1600]);
  // og's window, laid out 1920 px wide, with a quarter to spare.
  const fonts = { css: "", head: "Inter", body: "Inter", label: "JetBrains Mono", weight: { head: 700, body: 500 } };
  const { html } = stillHtml({ kind: "hero", look: "launch", W: 1920, H: 1008, brand: {}, fonts, mark: null, name: "Acme", title: "Notes that think", site: "acme.example", screen: { file: "screen.jpg", w: 2000, h: 12000 }, shots: [] });
  const drawn = Number(/class="st-win" style="[^"]*width:(\d+)px/.exec(html)[1]);
  assert.ok(width >= drawn * 1.25, `the copy is ${width} px wide and the window ${drawn}`);
});
