"use strict";
// ─── stills ────────────────────────────────────────────────────────────────
// Launch pictures at the exact sizes stores and sites ask for, made from a
// film's plan: its look and words, the brand's mark and its real screens.
// Product Hunt's gallery is a hero picture and then frames of the film's own
// scenes; the link, post and store pictures are the hero laid out in their
// own shapes; the small tiles hold the mark alone, as the Chrome Web Store
// asks for promo tiles with no text.

const fs = require("fs");
const path = require("path");
const motion = require("./motion");
const { loadFilm, buildClip, markFor, brandColours, pagePicture } = require("./film");
const { resolveFonts } = require("./scene");
const { snapshots } = require("./chrome");
const { probe, pictureSize, coverPng } = require("./ffmpeg");
const { prepareIcon, prepareLogo } = require("./logo");
const { markEnd } = require("./plan");
const { within, reason, save } = require("./out");
// A name film.json gives, and a path made from one, on one line and cut when
// long (confine.js).
const { said, saidPath } = require("./confine");

// What each target makes. kind: hero (mark, promise and screen), tile (the
// mark alone) or frames (the film's scenes, for the rest of a gallery).
const TARGETS = {
  ph: [
    { name: "ph-1", W: 1270, H: 760, kind: "hero", use: "Product Hunt gallery, the first picture" },
    { name: "ph", W: 1270, H: 760, kind: "frames", use: "Product Hunt gallery" },
    { name: "ph-thumbnail", W: 240, H: 240, kind: "tile", use: "Product Hunt thumbnail" },
  ],
  og: [{ name: "og", W: 1200, H: 630, kind: "hero", use: "og:image, the picture a shared link shows" }],
  x: [{ name: "x", W: 1600, H: 900, kind: "hero", use: "a picture for a post on X" }],
  play: [{ name: "play-feature", W: 1024, H: 500, kind: "hero", use: "Google Play feature graphic" }],
  chrome: [
    { name: "chrome-small", W: 440, H: 280, kind: "tile", use: "Chrome Web Store small promo tile" },
    { name: "chrome-marquee", W: 1400, H: 560, kind: "hero", words: false, use: "Chrome Web Store marquee promo tile" },
  ],
};

// "ph,og" as a list of targets; all of them when none is given.
function parseTargets(text) {
  const list = String(text || Object.keys(TARGETS).join(",")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = list.filter((t) => !Object.hasOwn(TARGETS, t));
  if (unknown.length || !list.length) throw new Error(`--for "${text}": choose from ${Object.keys(TARGETS).join(", ")}`);
  return [...new Set(list)];
}

// The film's clips for the gallery after its first picture: all but the
// opener (the first picture says what it says) and the screen the first
// picture shows; at most five, the close kept last.
function galleryClips(clips, { heroScreen }) {
  const list = clips.filter((c) => !(c.kind === "scene" && c.scene && c.scene.type === "opener"));
  if (heroScreen) {
    const k = list.findIndex((c) => c.kind === "screen");
    if (k >= 0) list.splice(k, 1);
  }
  while (list.length > 5) {
    const k = list.findIndex((c, i) => i < list.length - 1 && ["screen", "phone", "scroll"].includes(c.kind));
    list.splice(k >= 0 ? k : Math.floor(list.length / 2), 1);
  }
  return list;
}

// The part of the site's screen the hero's window shows (motion.js
// stillHtml): the window takes the picture's shape, from 1.25 to 1.9 times
// as wide as it is tall, and the picture covers it from the top, so a
// taller picture shows its top and a wider one its middle.
function windowPart(w, h) {
  const ratio = Math.max(1.25, Math.min(1.9, w / h));
  const pw = Math.min(w, Math.round(h * ratio));
  return { x: Math.floor((w - pw) / 2), y: 0, w: pw, h: Math.min(h, Math.round(w / ratio)) };
}

// What the stills' pages are given for the site's screen and the store
// screenshots, by their names: the files as they are, or copies of those
// larger than Chrome takes in one file (pagePicture). A still is laid out
// 1920 px wide and at most as tall, and draws no picture larger than that,
// so a copy is at most 2400 px, with a quarter to spare: the screen as its
// window shows it, cut to that and no wider, and a screenshot whole, as its
// card shows it. A tall screen fitted whole into 2400 px was a narrow strip
// the window drew several times wider than it was.
async function stillPictures({ screen = null, shots = [], work }) {
  const files = {};
  const copy = (s, opts) => pagePicture(s.src, { ...opts, out: path.join(work, s.file), what: `making a copy of ${saidPath(s.src)}`, named: s.named });
  if (screen) files[screen.file] = await copy(screen, { maxW: 2400, part: windowPart });
  for (const s of shots) files[s.file] = await copy(s, { maxW: 2400, maxH: 2400 });
  return files;
}

const describe = (clip) => (clip.kind === "scene" ? `the ${clip.scene.type} scene` : { screen: "the site's screen", shots: "the store screenshots", phone: "the phone", scroll: "the page scrolling", logo: "the logo close" }[clip.kind]);

// Makes the stills of a film.json. Returns { dir, files, notes }. They take
// the place of the earlier pictures of the same names once all are made
// (out.js).
async function makeStills(filmFile, { targets = null, out = null, log = () => {} } = {}) {
  const chosen = parseTargets(targets);
  const loaded = loadFilm(filmFile);
  if (loaded.problems.length) throw new Error(`film.json has problems:\n  - ${loaded.problems.join("\n  - ")}`);
  const outDir = path.resolve(out || path.join(loaded.dir, "stills"));
  return within(outDir, (run) => drawStills(filmFile, loaded, { chosen, outDir, run, log }));
}

async function drawStills(filmFile, { film, brand, clips }, { chosen, outDir, run, log }) {
  // The pages' marks and pictures, in the part folder.
  const work = path.join(run.part, ".work");
  try {
    fs.mkdirSync(work);
  } catch (err) {
    throw new Error(`writing in ${run.part}: ${reason(err)}`);
  }
  const notes = [];
  const look = film.look;
  const colours = brandColours(brand);
  const fonts = await resolveFonts({ style: look, font: colours.headingFont || "", bodyFont: colours.bodyFont || "" });
  if (fonts.missing.length) notes.push(`Not on Google Fonts, so the look's own typeface stood in: ${[...new Set(fonts.missing)].join(", ")}.`);

  // The words: the opener's name and promise, else the headline, else the
  // brand's own name and description.
  const scene = (type) => clips.find((c) => c.kind === "scene" && c.scene && c.scene.type === type);
  const opener = scene("opener");
  const headline = scene("headline");
  const name = String((opener && opener.scene.title) || (brand && brand.name) || "").replace(/\*/g, "");
  let title = String((opener && opener.scene.text) || (headline && headline.scene.title) || (brand && brand.description) || "").replace(/\s+/g, " ").trim();
  if (title && !title.includes("*")) title = markEnd(title);
  const close = [...clips].reverse().find((c) => c.kind === "logo");
  const site = (close && close.site) || (brand && brand.host) || "";

  // The mark, and an app's icon for the square thumbnail.
  const mark = await markFor({ logoFile: close ? close.logoFile : null, iconFile: close ? close.iconFile : null, brand, out: path.join(work, "mark.png"), notes, what: "The stills" });
  if (!mark.file) notes.push(`No logo could be used${mark.refused.length ? ` (${mark.refused.join("; ")})` : ""}, so the name stands in for it.`);
  let icon = null;
  if (brand && brand.appIcon) {
    try {
      icon = await prepareIcon(brand.appIcon.file, path.join(work, "icon.png"));
    } catch (err) {
      // The mark serves, when the icon is what could not be used.
      if (!err.refused) throw err;
    }
  }
  // The square thumbnail's mark: the app's icon, else a square logo
  // capture (the brand's symbol on its own, often in its footer), else the
  // mark itself.
  let square = icon;
  for (const l of !square && brand ? brand.logos : []) {
    const info = probe(l.file);
    if (!info.width || !info.height || Math.abs(Math.log(info.width / info.height)) > Math.log(1.25)) continue;
    try {
      square = await prepareLogo(l.file, path.join(work, "square.png"));
      break;
    } catch (err) {
      // The next one, when this capture is what could not be used.
      if (!err.refused) throw err;
    }
  }

  // The real screens: the site's, else the store screenshots. A file that is
  // no picture is refused, as the render refuses it.
  const serve = (file, as, named) => {
    const info = pictureSize(file);
    return { file: `${as}${path.extname(file).toLowerCase() === ".png" ? ".png" : ".jpg"}`, w: info.width, h: info.height, src: file, named };
  };
  const screenClip = clips.find((c) => c.kind === "screen");
  const shotsClip = clips.find((c) => c.kind === "shots") || clips.find((c) => c.kind === "phone");
  const screen = screenClip ? serve(screenClip.imageFile, "screen", `clips[${screenClip.index}].image "${said(screenClip.image)}"`) : null;
  const shots = !shotsClip ? [] : shotsClip.imageFiles ? shotsClip.imageFiles.map((f, k) => serve(f, `shot-${k}`, `clips[${shotsClip.index}].images[${k}] "${said(shotsClip.images[k])}"`))
    : [serve(shotsClip.imageFile, "shot-0", `clips[${shotsClip.index}].image "${said(shotsClip.image)}"`)];
  const files = {
    ...(mark.file ? { "mark.png": fs.readFileSync(mark.file) } : {}),
    ...(square ? { "square.png": fs.readFileSync(square.file) } : {}),
    ...(await stillPictures({ screen, shots, work })),
  };

  // A page for each picture: the hero and the tiles laid out 1920 px wide
  // in the picture's shape, the film's frames at 1920x1080 even when the
  // film is 9:16, since a gallery picture is wide.
  const jobs = [];
  const ctx = { look, port: false, fonts, colours, work, lang: film.lang || "", brand, notes };
  for (const key of chosen) {
    for (const target of TARGETS[key]) {
      if (target.kind === "frames") {
        let n = 2;
        for (const clip of galleryClips(clips, { heroScreen: Boolean(screen) })) {
          clip.render = clip.seconds;
          if (clip.parsed) clip.parsed = { ...clip.parsed, portrait: false };
          const page = await buildClip(clip, ctx);
          // A still has no cursor crossing it.
          const html = page.html.replace("</head>", "<style>.cursor,.ripple,.tap,.touch{display:none!important}</style></head>");
          jobs.push({ name: `${target.name}-${n++}`, W: target.W, H: target.H, use: `${target.use}: ${describe(clip)}`,
            page: { html, files: page.files, W: page.W, H: page.H, at: "end", until: Math.round(clip.seconds * 1000) - 60 } });
        }
        continue;
      }
      const H = Math.round((1920 * target.H) / target.W);
      const own = target.name === "ph-thumbnail" && square ? { ...square, file: "square.png" } : mark.file ? { ...mark, file: "mark.png" } : null;
      const page = motion.stillHtml({ kind: target.kind, look, W: 1920, H, brand: colours, fonts, mark: own, name, title, site,
        words: target.words !== false, screen, shots, lang: film.lang });
      jobs.push({ name: target.name, W: target.W, H: target.H, use: target.use, page: { html: page.html, files, W: 1920, H, at: 0 } });
    }
  }
  log(`Drawing ${jobs.length} stills in the ${look} look...\n`);
  const shot = await snapshots(jobs.map((j) => j.page));
  const made = [];
  for (const [i, j] of jobs.entries()) {
    const raw = path.join(work, `${j.name}.raw.png`);
    try {
      fs.writeFileSync(raw, shot[i].png);
    } catch (err) {
      throw new Error(`making ${path.join(run.part, `${j.name}.png`)}: ${reason(err)}`);
    }
    await coverPng(raw, run.out(`${j.name}.png`), j.W, j.H);
    if (shot[i].errors.length) notes.push(`${j.name}: the page reported ${shot[i].errors.slice(0, 2).join("; ")}`);
    // Where it is once the run has ended.
    made.push({ name: `${j.name}.png`, file: path.join(outDir, `${j.name}.png`), W: j.W, H: j.H, use: j.use });
  }
  const lines = ["# Launch stills", "", `Made by launch-film from ${path.relative(outDir, path.resolve(filmFile)) || "film.json"} in the ${look} look. Every picture is an opaque PNG at the exact size its place asks for.`, "",
    "| File | Size | For |", "| --- | --- | --- |", ...made.map((f) => `| ${f.name} | ${f.W}x${f.H} | ${f.use} |`), ""];
  if (notes.length) lines.push("Notes:", "", ...notes.map((n) => `- ${n}`), "");
  save(run.out("STILLS.md"), lines.join("\n"));
  return { dir: outDir, files: made, notes };
}

module.exports = { makeStills, parseTargets, galleryClips, windowPart, stillPictures, TARGETS };
