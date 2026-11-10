"use strict";
// ─── the film ──────────────────────────────────────────────────────────────
// film.json in, an MP4 out: each clip is a page rendered on its own (two at a
// time), the clips are joined with short crossfades that start on the cut,
// and one sound track (the music bed, or the user's own track in its place,
// and every clip's effects at their times) is laid under the whole film.

const fs = require("fs");
const os = require("os");
const path = require("path");
const motion = require("./motion");
const { parseScene, resolveFonts, iconSvg } = require("./scene");
const { renderPage, PAGE_FILE_MAX } = require("./chrome");
const { input, picture, whole, writePicture, run, mustRun, pictureSize, readPixels, readSound, loudnessOf } = require("./ffmpeg");
const { prepareLogo, prepareIcon } = require("./logo");
const { readBrand } = require("./brand");
const audio = require("./audio");
const { within, tempDir, release, save, reason } = require("./out");
const confine = require("./confine");

const FPS = 25;
// A crossfade between clips, starting on the cut.
const FADE = 0.4;
const KINDS = new Set(["scene", "screen", "phone", "scroll", "shots", "logo"]);

// Reads and checks a film.json; returns { film, dir, brand, clips, problems }.
function loadFilm(file) {
  const dir = path.dirname(path.resolve(file));
  let film;
  try {
    film = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { problems: [`${file} is not valid JSON: ${err.message}`] };
  }
  const problems = [];
  const knownLook = Object.hasOwn(motion.LOOKS, String(film.look));
  if (!knownLook) problems.push(`"look" must be one of ${Object.keys(motion.LOOKS).join(", ")}`);
  if (film.aspect && !["16:9", "9:16"].includes(film.aspect)) problems.push('"aspect" must be "16:9" or "9:16"');
  // With LAUNCH_FILM_CONFINE set, a file named outside the film's folder is
  // a problem like any other (confine.js).
  const outside = (name) => confine.outside(dir, name, "film.json");
  const unconfined = (name, what) => `${what} "${confine.said(name)}" ${outside(name)}, and LAUNCH_FILM_CONFINE allows only files in it`;
  let brand = null;
  if (film.brand && outside(film.brand)) problems.push(unconfined(film.brand, '"brand"'));
  else if (film.brand) {
    try {
      brand = readBrand(path.resolve(dir, film.brand));
    } catch (err) {
      problems.push(`the brand could not be read from ${film.brand}: ${err.message}`);
    }
  }
  const mood = (knownLook && audio.MOODS[film.look]) || audio.MOODS.launch;
  const bar = 240 / mood.bpm;
  const clips = Array.isArray(film.clips) ? film.clips : [];
  if (!clips.length) problems.push('"clips" is empty');
  const out = [];
  clips.forEach((c, i) => {
    const at = `clips[${i}]`;
    if (!c || !KINDS.has(c.kind)) {
      problems.push(`${at}.kind must be one of ${[...KINDS].join(", ")}`);
      return;
    }
    const seconds = c.seconds !== undefined ? Number(c.seconds) : Number(c.bars || 2) * bar;
    if (!(seconds >= 2 && seconds <= 12)) problems.push(`${at} must last 2-12 seconds (it is ${seconds.toFixed(2)})`);
    const fileOf = (rel, what) => {
      if (rel && outside(rel)) {
        problems.push(unconfined(rel, `${at}.${what}`));
        return null;
      }
      const abs = rel ? path.resolve(dir, rel) : null;
      if (!abs || !fs.existsSync(abs)) problems.push(`${at}.${what} "${rel || ""}" is not a file`);
      return abs;
    };
    const clip = { ...c, index: i, seconds };
    if (c.kind === "scene") {
      const { scene, problems: p } = parseScene(c.scene, { look: film.look, portrait: film.aspect === "9:16", brand: brandColours(brand) });
      p.forEach((msg) => problems.push(`${at}.scene: ${msg}`));
      clip.parsed = scene;
    } else if (c.kind === "shots") {
      const list = Array.isArray(c.images) ? c.images : [];
      if (list.length < 1 || list.length > 3) problems.push(`${at}.images must list 1-3 pictures`);
      clip.imageFiles = list.slice(0, 3).map((rel, k) => fileOf(rel, `images[${k}]`));
    } else if (c.kind === "logo") {
      if (c.icon) clip.iconFile = fileOf(c.icon, "icon");
      else clip.logoFile = fileOf(c.logo, "logo");
    } else {
      clip.imageFile = fileOf(c.image, "image");
      if (c.kind === "screen" && c.mode === "zoom" && !(Array.isArray(c.box) && c.box.length === 4 && c.box.every((v) => v >= 0))) {
        problems.push(`${at}.box must be [x, y, w, h] in the picture's pixels for a zoom`);
      }
    }
    out.push(clip);
  });
  const total = out.reduce((s, c) => s + c.seconds, 0);
  if (total > 90) problems.push(`the film would last ${total.toFixed(1)} s; keep it under 90`);
  const music = musicOf(film.music, dir, problems);
  return { film, dir, brand, clips: out, bar, music, seconds: total, problems };
}

// What film.json's "music" asks for: the look's bed (true, or left out), no
// music (false), the bed at another level ({ "volume": 0.55 }, from 0 to
// 2), or the user's own track (the path of a sound file, from film.json's
// folder or absolute), which checkMusic reads when the film renders.
function musicOf(value, dir, problems) {
  if (value === undefined || value === null || value === true) return { bed: true };
  if (value === false) return { bed: false };
  if (typeof value === "string" && value.trim()) return { bed: false, track: path.resolve(dir, value), name: value };
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((k) => k === "volume")) {
    const v = value.volume;
    const n = typeof v === "number" || (typeof v === "string" && v.trim()) ? Number(v) : NaN;
    if (v !== undefined && !(n >= 0 && n <= 2)) problems.push(`"music" "volume" must be a number from 0 to 2 (it is ${JSON.stringify(v)})`);
    return { bed: true };
  }
  problems.push(`"music" must be true, false, { "volume": 0.55 } or the path of an audio file (it is ${JSON.stringify(value)})`);
  return { bed: true };
}

// A path as one word of a command line that an agent runs as it is, or null
// when no quoting holds in every shell it may run it in. Bare when no shell
// reads anything in it. For a POSIX shell, in single quotes, inside which
// nothing is expanded or run. On Windows in double quotes, as cmd.exe takes no
// single quotes, with / for every \, which Node takes too, since Git Bash
// reads \\ there as one \. Inside double quotes cmd.exe, PowerShell and Git
// Bash still expand %, $, ` and !, so a path that holds one gets null.
function shellWord(file, platform = process.platform) {
  if (platform === "win32") {
    const name = String(file).replace(/\\/g, "/");
    if (/^[\w.:/-]+$/.test(name)) return name;
    return /[%$`!"]/.test(name) ? null : `"${name}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(file) ? file : `'${String(file).replace(/'/g, "'\\''")}'`;
}

// Where a link that leads nowhere ends: the first path along it that is not
// there, after as many links as lead there. null when `file` is no link.
function linkEnd(file) {
  let at = file;
  for (let hops = 0; hops < 40; hops++) {
    let s;
    try {
      s = fs.lstatSync(at);
    } catch {
      return hops ? at : null;
    }
    if (!s.isSymbolicLink()) return null;
    try {
      at = path.resolve(path.dirname(at), fs.readlinkSync(at));
    } catch {
      return null;
    }
  }
  return null;
}

// The user's own track, when film.json names one, read before anything
// renders: its sound for the film's length, decoded, and its loudness over
// it. Returns { track, problems }: a file that is missing, has no sound
// ffmpeg can read, is shorter than the film or is silent is a problem, and
// each problem says what to give instead.
async function checkMusic(loaded) {
  const { music, seconds: total, clips, dir } = loaded;
  if (!music || !music.track) return { track: null, problems: [] };
  const at = `"music" ${JSON.stringify(music.name)}`;
  const refuse = (problem) => ({ track: null, problems: [problem] });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(music.name)) return refuse(`${at} is an address: download the track and give the path of the file, from film.json's folder or absolute`);
  const outside = confine.outside(dir, music.name, "film.json");
  if (outside) return refuse(`"music" "${confine.said(music.name)}" ${outside}, and LAUNCH_FILM_CONFINE allows only files in it`);
  const instead = "give the path of a track (true plays the look's own music, false none)";
  let kind = null;
  let missed = null;
  try {
    const s = fs.statSync(music.track);
    kind = s.isFile() ? "file" : s.isDirectory() ? "folder" : s.isFIFO() ? "a pipe" : s.isSocket() ? "a socket" : "a device";
  } catch (err) {
    missed = err;
  }
  // A good file the user may not reach would read as one that is not there.
  if (missed && !["ENOENT", "ENOTDIR", "ELOOP"].includes(missed.code)) return refuse(`${at} cannot be read: ${reason(missed)}. Make it readable, or give a copy of it you can read`);
  if (kind === "folder") return refuse(`${at} is a folder, not a file: give the path of the track in it`);
  // The path was right: what is there is no file.
  if (kind && kind !== "file") return refuse(`${at} is ${kind}, not a file: ${instead}`);
  if (!kind) {
    // A link is there, though what it leads to is not: it is told of as one.
    if (missed.code === "ELOOP") return refuse(`${at} is a link that never reaches a file, through too many links one after another: ${instead}`);
    const end = linkEnd(music.track);
    if (end) return refuse(`${at} is a link to ${end}, which is not there: ${instead}`);
    // A relative path is read from film.json's folder, which may not be
    // where the user stood when they wrote it: the message says where it
    // looked.
    return refuse(path.isAbsolute(music.name) ? `${at} is not a file: ${instead}`
      : `${at} is not a file. It was looked for at ${music.track}, as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)`);
  }
  // A good file the user may not read would read as a file with no sound.
  try {
    fs.accessSync(music.track, fs.constants.R_OK);
  } catch (err) {
    return refuse(`${at} cannot be read: ${reason(err)}. Make it readable, or give a copy of it you can read`);
  }
  // A second past the film's end, so a track as long as the film shows it.
  const sound = readSound(music.track, { seconds: total + 1 });
  if (!sound) return refuse(`${at} has no sound ffmpeg can read: give an audio file, such as a WAV, MP3, M4A or FLAC file, or a video with sound`);
  // An ffmpeg that would not read it says why, as a guard does that opens
  // no file whose name has a % in it.
  if (sound.failed) return refuse(`${at} could not be read: ${sound.failed}`);
  // musicfit gives a length to the millisecond: half a frame short is whole.
  if (sound.seconds < total - 0.5 / FPS) {
    const close = clips.length ? total - clips[clips.length - 1].seconds : 0;
    // In a folder of its own in the film's: the path set in film.json stays
    // good, whatever else musicfit is asked to do next to the film. The
    // command is written to be run as it is, the folder quoted for the shell.
    const folder = path.join(dir, "music");
    const word = shellWord(folder);
    return { track: null, problems: [`${at} lasts ${sound.seconds.toFixed(2)} s and the film ${total.toFixed(2)} s: give a track at least as long as the film. ` +
      `musicfit makes one exactly that long with its hit on the beat you choose, such as the last clip at ${close.toFixed(2)} s: ` +
      `npx musicfit@latest <track> --length ${+total.toFixed(3)} --hit ${+close.toFixed(3)} --fps ${FPS} --out ${word || `<folder>, <folder> being ${folder} quoted for your shell`}, ` +
      `then set "music" in film.json to "music/fitted.wav"`] };
  }
  const level = await loudnessOf(music.track, { seconds: total });
  if (!(level.integrated > -70)) return refuse(`${at} is silent over the film's ${total.toFixed(2)} s: give a track with sound in it, or false for no music`);
  return { track: { ...sound, ...level, name: music.name }, problems: [] };
}

// The colours a brand gives the looks: its accent, a second colour, and a
// dark ground (its own dark colour, else its accent taken nearly to black).
function brandColours(brand) {
  if (!brand) return {};
  const { mix } = motion.helpers;
  const dark = brand.darkSite && brand.surface ? brand.surface : brand.darkColour;
  // A brand drawn in black and white keeps to it: its heading colour stands
  // in for an accent it does not have.
  const heading = (brand.colors.find((c) => c.role === "heading") || {}).hex || null;
  return {
    accent: brand.accent || (brand.darkSite && heading ? heading : null),
    accent2: brand.accent2,
    background: dark || (brand.accent ? mix(brand.accent, "#05070D", 0.9) : null),
    headingFont: brand.headingFont,
    bodyFont: brand.bodyFont,
  };
}

// The colour of a picture's first rows (a phone's status bar takes it).
function topColour(file) {
  const p = readPixels(file, 64);
  const rows = Math.max(1, Math.round(p.height * 0.02));
  const sum = [0, 0, 0];
  for (let y = 0; y < rows; y++) for (let x = 0; x < p.width; x++) for (let c = 0; c < 3; c++) sum[c] += p.data[4 * (y * p.width + x) + c];
  return `#${sum.map((v) => Math.round(v / (rows * p.width)).toString(16).padStart(2, "0")).join("")}`;
}

// The bytes a page is given for a picture the film names: the file as it is,
// or, when it is larger than Chrome takes in one file (chrome.js), a copy
// that fits `maxW` x `maxH`, the most the page draws it at, and is never
// larger than the picture, written to `out` (a PNG, or a JPEG by its name).
// A screenshot of 80 MB rendered when pages were opened from the disk, and
// then failed.
async function pagePicture(file, { maxW, maxH = Infinity, out, what }) {
  if (fs.statSync(file).size <= PAGE_FILE_MAX) return fs.readFileSync(file);
  const info = pictureSize(file);
  const k = Math.min(1, maxW / info.width, maxH / info.height);
  const size = (n) => Math.max(2, 2 * Math.round((n * k) / 2));
  await writePicture([...input(file), "-vf", `scale=${size(info.width)}:${size(info.height)}:flags=lanczos`, "-frames:v", "1", ...(/\.jpe?g$/i.test(out) ? ["-q:v", "2"] : [])], out, what);
  return fs.readFileSync(out);
}

// One clip's page: { html, files, cues, W, H }.
async function buildClip(clip, ctx) {
  const { look, port, fonts, colours, work } = ctx;
  const seconds = clip.render;
  const brandAccent = colours.accent || null;
  if (clip.kind === "scene") {
    const scene = { ...clip.parsed, font: colours.headingFont || "", bodyFont: colours.bodyFont || "" };
    const sceneFonts = scene.type === "code" ? await resolveFonts({ style: look, font: scene.font, bodyFont: scene.bodyFont, type: "code" }) : fonts;
    const page = motion.sceneHtml(scene, { fonts: sceneFonts, seconds, icon: iconSvg });
    if (!page) throw new Error(`clip ${clip.index + 1}: the ${scene.type} type has no drawing`);
    return { html: page.html, files: {}, cues: page.cues, W: page.W, H: page.H };
  }
  if (clip.kind === "screen") {
    const info = pictureSize(clip.imageFile);
    const ext = path.extname(clip.imageFile).toLowerCase() === ".png" ? ".png" : ".jpg";
    const soft = path.join(work, `soft-${clip.index}.jpg`);
    const blurred = await run([...input(clip.imageFile), "-vf", "scale='min(1400,iw)':-2,gblur=sigma=12", "-q:v", "5", ...picture(soft)]);
    // The blurred ground is left out when it could not be made whole.
    const hasSoft = blurred.code === 0 && whole(soft);
    const page = motion.screenHtml({ mode: clip.mode === "zoom" ? "zoom" : "pan", look, port, seconds, accent: brandAccent, brand: colours,
      image: { file: `capture${ext}`, w: info.width, h: info.height }, soft: hasSoft ? "soft.jpg" : null, box: clip.box || null,
      side: clip.side || "center", phone: info.height > info.width, fonts });
    // With a quarter to spare, as the phone's screen below.
    const capture = await pagePicture(clip.imageFile, { maxW: page.drawnW * 1.25, out: path.join(work, `capture-${clip.index}${ext}`), what: `clip ${clip.index + 1}` });
    const files = { [`capture${ext}`]: capture, ...(hasSoft ? { "soft.jpg": fs.readFileSync(soft) } : {}) };
    return { html: page.html, files, cues: page.cues, W: page.W, H: page.H };
  }
  if (clip.kind === "shots") {
    const images = clip.imageFiles.map((file, k) => {
      const info = pictureSize(file);
      return { file: `shot-${k}${path.extname(file).toLowerCase() === ".png" ? ".png" : ".jpg"}`, w: info.width, h: info.height, src: file };
    });
    const page = motion.galleryHtml({ look, port, seconds, accent: brandAccent, brand: colours, images, fonts });
    const files = {};
    for (const [k, im] of images.entries()) files[im.file] = await pagePicture(im.src, { maxW: Infinity, maxH: page.drawnH * 1.25, out: path.join(work, `shot-${clip.index}-${k}${path.extname(im.file)}`), what: `clip ${clip.index + 1}` });
    return { html: page.html, files, cues: page.cues, W: page.W, H: page.H };
  }
  if (clip.kind === "phone" || clip.kind === "scroll") {
    const info = pictureSize(clip.imageFile);
    const page = motion.deviceHtml({ mode: clip.kind, look, port, seconds, accent: brandAccent, brand: colours, image: { file: "screen.png", w: info.width, h: info.height },
      top: topColour(clip.imageFile), fonts });
    // The capture cut to what shows and made no larger than the page draws
    // it, with a quarter to spare: a whole page at 2x is tens of megapixels.
    const keepH = Math.min(info.height, Math.ceil(info.height * page.use) + 2);
    const width = 2 * Math.round(Math.min(info.width, Math.ceil(page.drawnW * 1.25)) / 2);
    const prepared = path.join(work, `device-${clip.index}.png`);
    await writePicture([...input(clip.imageFile), "-vf", `crop=${info.width}:${keepH}:0:0,scale=${width}:-2:flags=lanczos`, "-frames:v", "1"], prepared, `clip ${clip.index + 1}`);
    return { html: page.html, files: { "screen.png": fs.readFileSync(prepared) }, cues: page.cues, W: page.W, H: page.H };
  }
  // The logo close.
  const markFile = path.join(work, `mark-${clip.index}.png`);
  const mark = await markFor({ logoFile: clip.logoFile, iconFile: clip.iconFile, brand: ctx.brand, out: markFile, portrait: port, notes: ctx.notes, what: "The logo close" });
  if (!mark.file) throw new Error(`clip ${clip.index + 1}: no logo could close the film: ${mark.refused.join("; ")}`);
  const page = motion.logoHtml({ style: look, portrait: port, brand: colours, mark: { file: "mark.png", w: mark.w, h: mark.h, icon: Boolean(mark.icon) },
    ground: mark.ground, site: clip.site || "", lang: ctx.lang }, { fonts, seconds, icon: iconSvg });
  return { html: page.html, files: { "mark.png": fs.readFileSync(markFile) }, cues: page.cues, W: page.W, H: page.H };
}

// The mark a close or a still shows: the capture asked for, else the brand's
// other logo captures, else its app icon. A capture that cannot close (cut
// off, too small, not a logo) is passed over with a note. Returns the
// prepared mark ({ file, w, h, ground, icon }), or { refused } when none
// would do. A failure that is not the capture's (a full disk where the mark
// is written, an ffmpeg the system stopped) fails the run instead: it says
// nothing about the capture, and passed over for it, the film closed on
// another logo.
async function markFor({ logoFile = null, iconFile = null, brand = null, out, portrait = false, notes = [], what }) {
  const tries = iconFile ? [{ icon: iconFile }] : [...(logoFile ? [{ logo: logoFile }] : []),
    ...(brand ? brand.logos.map((l) => ({ logo: l.file })).filter((t) => t.logo !== logoFile) : []),
    ...(brand && brand.appIcon ? [{ icon: brand.appIcon.file }] : [])];
  const refused = [];
  for (const t of tries) {
    try {
      const mark = t.icon ? await prepareIcon(t.icon, out) : await prepareLogo(t.logo, out, { portrait });
      if (refused.length) notes.push(`${what} uses ${path.basename(t.icon || t.logo)}: ${refused.join("; ")}.`);
      return mark;
    } catch (err) {
      if (!err.refused) throw err;
      refused.push(`${path.basename(t.icon || t.logo)} was passed over (${err.message})`);
    }
  }
  return { file: null, refused };
}

// Runs tasks with at most `jobs` at once.
async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
  return results;
}

// The kinds of file the film is written as without a try first: H.264 and
// AAC with faststart, as the last ffmpeg call writes them.
const FILM_KINDS = new Set([".mp4", ".m4v", ".mov", ".mkv"]);

// Why the film cannot be written to `out` (--output when `given`), or null.
// Read before anything renders: the name was first used once every clip had
// rendered, and the run failed then. Another kind of file than FILM_KINDS is
// tried on a frame of nothing, in the film's own codecs, so a kind ffmpeg
// writes them in is taken and one it does not (.webm) refused. The kind is
// blamed only when ffmpeg refused the try itself and then writes the same
// frame as an .mp4: an ffmpeg that cannot be started, that a signal ended,
// or that cannot write the .mp4 either (a build without libx264) says
// nothing about the kind, so the render goes on and fails in its own words,
// as it does with a film.mp4.
async function outputProblem(out, given) {
  const named = given ? `--output ${out}` : out;
  if (path.basename(out).startsWith(".launch-film-")) return `${named}: a name that starts with .launch-film- is one of launch-film's own: give another`;
  let folder = false;
  try {
    folder = fs.statSync(out).isDirectory();
  } catch {
    // Not there yet, as a new film is not.
  }
  if (folder) return given ? `${named} is a folder: give the film's file in it, such as ${path.join(out, "film.mp4")}` : `${named} is a folder, where the film goes: move it, or give --output another file`;
  const kind = path.extname(out).toLowerCase();
  if (FILM_KINDS.has(kind)) return null;
  if (!kind) return `${named} has no extension, so ffmpeg cannot tell what kind of file to write: give a name that ends in .mp4`;
  const work = tempDir("launch-film-work-");
  const write = (name) => run(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=25", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-frames:v", "1", "-t", "0.04",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", path.join(work, name)]);
  try {
    // ffmpeg's own refusal is an exit code above 0: run() gives -1 for one
    // that could not be started, and a signal leaves the code null.
    const tried = await write(`film${kind}`);
    if (!(tried.code > 0)) return null;
    const mp4 = await write("film.mp4");
    return mp4.code === 0 ? `${named}: ffmpeg cannot write the film as a ${kind} file (H.264 video and AAC sound): give a name that ends in .mp4, .mov or .mkv` : null;
  } finally {
    release(work);
  }
}

// Renders film.json to an MP4. Returns { output, seconds, clips, notes }.
async function renderFilm(file, { output = null, jobs = 2, log = () => {}, keep = false, offline = false } = {}) {
  const out = path.resolve(output || path.join(path.dirname(path.resolve(file)), "film.mp4"));
  const unfit = await outputProblem(out, Boolean(output));
  if (unfit) throw new Error(unfit);
  const loaded = loadFilm(file);
  if (loaded.problems.length) throw new Error(`film.json has problems:\n  - ${loaded.problems.join("\n  - ")}`);
  const { track, problems } = await checkMusic(loaded);
  if (problems.length) throw new Error(`film.json has problems:\n  - ${problems.join("\n  - ")}`);
  // The clips are made in a work folder outside the film's folder; the film
  // and its timeline go in next to film.json only once both are whole. The
  // run is begun here, so a stop while the clips render says which folder
  // it left as it was.
  return within(path.dirname(out), (job) => renderInto(job, file, loaded, { out, track, jobs, log, keep, offline }));
}

async function renderInto(job, file, { film, brand, clips }, { out, track, jobs, log, keep, offline }) {
  const look = film.look;
  const port = film.aspect === "9:16";
  const colours = brandColours(brand);
  const work = keep ? fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-work-")) : tempDir("launch-film-work-");
  const notes = [...(brand ? brand.notes : [])];
  try {
    const fonts = await resolveFonts({ style: look, font: colours.headingFont || "", bodyFont: colours.bodyFont || "" }, { offline });
    if (fonts.missing.length) notes.push(`Not on Google Fonts, so the look's own typeface stood in: ${[...new Set(fonts.missing)].join(", ")}.`);
    // Every clip but the last runs on under the next one's crossfade.
    let at = 0;
    clips.forEach((c, i) => {
      c.start = at;
      c.render = c.seconds + (i < clips.length - 1 ? FADE : 0);
      at += c.seconds;
    });
    const total = at;
    const ctx = { look, port, fonts, colours, work, lang: film.lang || "", brand, notes };
    let done = 0;
    const rendered = await pool(clips, jobs, async (clip) => {
      const page = await buildClip(clip, ctx);
      const mp4 = path.join(work, `clip-${String(clip.index).padStart(2, "0")}.mp4`);
      const started = Date.now();
      // A failure says which clip it stopped, as ffmpeg's and Chrome's own
      // words do not, and a Chrome too slow to answer, when more than one
      // clip renders at once (pool), that one at a time eases the machine.
      const r = await renderPage({ html: page.html, files: page.files, output: mp4, seconds: clip.render, W: page.W, H: page.H, fps: FPS })
        .catch((err) => Promise.reject(new Error(`rendering clip ${clip.index + 1}: ${err.message}${err.slow && Math.min(jobs, clips.length) > 1 ? ", or with --jobs 1 to render one clip at a time" : ""}`)));
      done++;
      log(`clip ${clip.index + 1}/${clips.length} (${clip.kind}${clip.parsed ? ` ${clip.parsed.type}` : ""}, ${clip.seconds.toFixed(1)} s) rendered in ${((Date.now() - started) / 1000).toFixed(1)} s [${done}/${clips.length}]\n`);
      if (r.errors.length) notes.push(`clip ${clip.index + 1}: the page reported ${r.errors.slice(0, 2).join("; ")}`);
      if (r.failedFonts.length) notes.push(`clip ${clip.index + 1}: fonts failed to load: ${r.failedFonts.join(", ")}`);
      return { mp4, cues: page.cues.map((cue) => ({ ...cue, at: clip.start + cue.at })) };
    });
    // The clips joined: each crossfade starts on its clip's first frame.
    const video = path.join(work, "video.mp4");
    const inputs = rendered.flatMap((r) => ["-i", r.mp4]);
    let graph = "";
    let last = "[0:v]";
    for (let i = 1; i < clips.length; i++) {
      const label = i === clips.length - 1 ? "[v]" : `[x${i}]`;
      graph += `${last}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${clips[i].start.toFixed(3)}${label};`;
      last = label;
    }
    const map = clips.length > 1 ? ["-filter_complex", graph.replace(/;$/, ""), "-map", "[v]"] : ["-map", "0:v"];
    await mustRun([...inputs, ...map, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-t", total.toFixed(3), "-movflags", "+faststart", video], "joining the clips");
    // The sound: the bed for these cuts, or the user's own track in its
    // place, and every clip's effects.
    const cues = film.sfx === false ? [] : rendered.flatMap((r) => r.cues);
    if (track) {
      const gain = audio.trackGain(track);
      const under = (audio.TRACK_LUFS - track.integrated) - 20 * Math.log10(gain);
      notes.push(`The music is ${track.name}${under > 0.05 ? `, ${under.toFixed(1)} dB under the bed's level so its peaks stay under full scale` : ", at the bed's level"}, from the film's first frame to its end at ${total.toFixed(2)} s, faded out over the last second.`);
    }
    const bed = film.music === false ? null : track ? audio.trackBus({ left: track.left, right: track.right, seconds: total, gain: audio.trackGain(track) })
      : audio.music({ look, seconds: total, cuts: clips.map((c) => c.start), seed: clips.length }).bus;
    const wav = path.join(work, "sound.wav");
    audio.writeWav(wav, audio.mixFilm({ seconds: total, music: bed, cues, musicGain: film.music && film.music.volume !== undefined ? Number(film.music.volume) : 0.55 }));
    const timeline = { film: path.relative(path.dirname(out), path.resolve(file)), seconds: +total.toFixed(3), look,
      clips: clips.map((c) => ({ index: c.index + 1, kind: c.kind, type: c.parsed ? c.parsed.type : undefined, start: +c.start.toFixed(3), seconds: +c.seconds.toFixed(3) })) };
    await mustRun(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", total.toFixed(3), "-movflags", "+faststart", job.out(path.basename(out))], "adding the sound");
    save(job.out(path.basename(out).replace(/\.mp4$/i, "") + ".timeline.json"), JSON.stringify(timeline, null, 2) + "\n");
    return { output: out, seconds: total, clips: timeline.clips, notes };
  } finally {
    if (!keep) release(work);
    else log(`work files kept in ${work}\n`);
  }
}

module.exports = { loadFilm, checkMusic, shellWord, renderFilm, buildClip, markFor, brandColours, pagePicture, FPS, FADE };
