"use strict";
// ─── the film ──────────────────────────────────────────────────────────────
// film.json in, an MP4 out: each clip is a page rendered on its own (two at a
// time), the clips are joined with short crossfades that start on the cut,
// and one sound track (the music bed, or the user's own track in its place,
// and every clip's effects at their times) is laid under the whole film, at
// the loudness social apps play at.

const fs = require("fs");
const os = require("os");
const path = require("path");
const motion = require("./motion");
const { parseScene, resolveFonts, iconSvg } = require("./scene");
const { renderPage, PAGE_FILE_MAX } = require("./chrome");
const { input, picture, whole, writePicture, run, mustRun, pictureSize, readPixels, readSound, loudnessOf, loudnormPass, levelOf } = require("./ffmpeg");
const { prepareLogo, prepareIcon } = require("./logo");
const { readBrand } = require("./brand");
const audio = require("./audio");
const { within, heldBackIn, tempDir, release, save, reason } = require("./out");
const confine = require("./confine");

const FPS = 25;
// A crossfade between clips, starting on the cut.
const FADE = 0.4;
// The film's sound: -14 LUFS (LUFS), the loudness YouTube, X and most
// social apps play at and the skill checks a film at, its true peak at -1.5
// dBTP or under (TRUE_PEAK), as LOUDNORM gives them to loudnorm. loudnorm
// measures the sound (ffmpeg.js loudnormPass), and one gain sets it to -14
// (addSound), so the sound keeps the rise and fall it was made with: a
// track's build and drop, the bed's opening a few dB under its groove
// (audio.js). loudnorm's own second pass did not: when the peaks a gain
// raises pass its limit, as they do with nearly every sound, it works in its
// dynamic mode, which turns quiet stretches up and loud ones down, and it
// flattened a track's drop from 9.5 dB over its build to 2.8. The gain
// raises the peaks too, and the AAC encoder lifts a sharp hit by as much as
// two and a half dB in the films measured, so a limiter on the sound at four
// times its rate holds the peaks at CEILING, and the film is measured once
// encoded, as check measures it, and encoded again with the gain moved
// toward -14, up or down, and the limiter set lower by what the encoded
// film's true peak passed -1.7 dBTP, a fifth of a dB under TRUE_PEAK. Of
// these encodes, TRIES at most, the one nearest -14 LUFS at TRUE_PEAK or
// under is kept.
const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";
const LUFS = -14;
const TRUE_PEAK = -1.5;
const CEILING = -3.5;
const TRIES = 6;
// The most the gain moves the sound, in dB, either way.
const GAIN_MAX = 30;
const KINDS = new Set(["scene", "screen", "phone", "scroll", "shots", "logo"]);
// Why a file that is a list of others for ffmpeg to open is refused, with
// LAUNCH_FILM_CONFINE set (confine.js listOf).
const LISTED = "whose files ffmpeg would open wherever they are, and LAUNCH_FILM_CONFINE allows only files in film.json's folder";

// Reads and checks a film.json; returns { film, dir, brand, clips, problems }.
function loadFilm(file) {
  const dir = path.dirname(path.resolve(file));
  let film;
  try {
    film = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { problems: [`${file} is not valid JSON: ${err.message}`] };
  }
  if (!film || typeof film !== "object" || Array.isArray(film)) return { problems: [`${file} must hold an object, such as { "look": "launch", "clips": [] }`] };
  const problems = [];
  // A value of another kind than a field takes is named with the field: a
  // number where a path goes ended the run in Node's own words, which name
  // neither, and "false" for sfx played the effects without a word.
  const shown = (value) => confine.said(JSON.stringify(value));
  const knownLook = Object.hasOwn(motion.LOOKS, String(film.look));
  if (!knownLook) problems.push(`"look" must be one of ${Object.keys(motion.LOOKS).join(", ")}`);
  if (film.aspect && !["16:9", "9:16"].includes(film.aspect)) problems.push('"aspect" must be "16:9" or "9:16"');
  // With LAUNCH_FILM_CONFINE set, a file named outside the film's folder is
  // a problem like any other (confine.js).
  const outside = (name) => confine.outside(dir, name, "film.json");
  const unconfined = (name, what) => `${what} "${confine.said(name)}" ${outside(name)}, and LAUNCH_FILM_CONFINE allows only files in it`;
  let brand = null;
  if (film.brand && typeof film.brand !== "string") problems.push(`"brand" must be the path of a brand.json (it is ${shown(film.brand)})`);
  else if (film.brand && outside(film.brand)) problems.push(unconfined(film.brand, '"brand"'));
  else if (film.brand) {
    try {
      brand = readBrand(path.resolve(dir, film.brand));
    } catch (err) {
      // A file error names the file, which film.json named: it is said once.
      problems.push(`the brand could not be read from ${confine.said(film.brand)}: ${confine.oneLine(reason(err))}`);
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
      if (rel && typeof rel !== "string") {
        problems.push(`${at}.${what} must be the path of a picture (it is ${shown(rel)})`);
        return null;
      }
      if (rel && outside(rel)) {
        problems.push(unconfined(rel, `${at}.${what}`));
        return null;
      }
      const abs = rel ? path.resolve(dir, rel) : null;
      const list = abs && fs.existsSync(abs) ? confine.listOf(abs) : null;
      if (!abs || !fs.existsSync(abs)) problems.push(`${at}.${what} "${confine.said(rel || "")}" is not a file`);
      else if (list) problems.push(`${at}.${what} "${confine.said(rel)}" is ${list}, ${LISTED}: give the picture itself`);
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
  if (![undefined, null, true, false].includes(film.sfx)) problems.push(`"sfx" must be true or false (it is ${shown(film.sfx)})`);
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
    if (v !== undefined && !(n >= 0 && n <= 2)) problems.push(`"music" "volume" must be a number from 0 to 2 (it is ${confine.said(JSON.stringify(v))})`);
    return { bed: true };
  }
  problems.push(`"music" must be true, false, { "volume": 0.55 } or the path of an audio file (it is ${confine.said(JSON.stringify(value))})`);
  return { bed: true };
}

// A path as one word of a command line that an agent runs as it is, or null
// when no quoting holds in every shell it may run it in. Bare when no shell
// reads anything in it. For a POSIX shell, in single quotes, inside which
// nothing is expanded or run. On Windows in double quotes, as cmd.exe takes no
// single quotes, with / for every \, which Node takes too, since Git Bash
// reads \\ there as one \. Inside double quotes cmd.exe, PowerShell and Git
// Bash still expand %, $, ` and !, so a path that holds one gets null. So
// does one with a line break or another control character in it, which
// would break the line the command is printed on.
function shellWord(file, platform = process.platform) {
  if (CONTROL.test(file)) return null;
  if (platform === "win32") {
    const name = String(file).replace(/\\/g, "/");
    if (/^[\w.:/-]+$/.test(name)) return name;
    return /[%$`!"]/.test(name) ? null : `"${name}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(file) ? file : `'${String(file).replace(/'/g, "'\\''")}'`;
}

// A name as a message shows it, on one line (confine.js).
const { CONTROL, oneLine } = confine;

// The musicfit command that fits a track to the film, `seconds` long with
// its hit at `hit`, into `folder`, as the refusal of a short track gives it:
// `from` is the track to fit, by its path, or null when it was not found,
// and `name` the name of that track, when known, else `of` says which track
// the word in its place stands for. Each path is one word the
// shell takes as it is (shellWord). In the place of a path that was not
// found, or that no quoting holds, goes a word in angle brackets, quoted
// the same way, so a shell that runs the command reads no quote, ; or $( )
// in it, and no < or > as a file to read or write; what to put there is said
// after the command. A name no quoting holds either goes in the sentence
// alone, after the plain word <track>. A name is shown on one line, and cut
// in the middle when it is long.
function musicfitCommand({ from, name = "", of = "the track it was made from", folder, seconds, hit }, platform = process.platform) {
  const shown = name ? confine.said(name) : "";
  const stand = shellWord(`<${shown || "track"}>`, platform) ? `<${shown || "track"}>` : "<track>";
  const words = [[from, stand, shown || of], [folder, "<folder>"]].map(([file, word, which]) => {
    const quoted = file && shellWord(file, platform);
    if (quoted) return { text: quoted };
    return { text: shellWord(word, platform), said: file ? `${word} being ${oneLine(file)} quoted for your shell` : `${word} being the path of ${which}` };
  });
  const said = words.filter((w) => w.said).map((w) => w.said);
  return `npx musicfit@latest ${words[0].text} --length ${+seconds.toFixed(3)} --hit ${+hit.toFixed(3)} --fps ${FPS} --out ${words[1].text}${said.length ? `, ${said.join(" and ")}` : ""}`;
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

// The track an earlier fit of musicfit's was made from, when `track` is such
// a fit: a file musicfit writes (fitted.wav or mix.wav) in `folder`, where the
// fit the refusal asks for goes, or one that a cues.json of musicfit's beside
// it lists. null when it is not one, else { name, track }: the name of the
// track it was fitted from, as that cues.json gives it ("" when none does),
// and its path when it is found beside the fit or beside film.json (`dir`).
// With LAUNCH_FILM_CONFINE set, a path outside film.json's folder is not
// looked at: the command would tell whether any file of the machine is
// there.
function earlierFit(track, folder, dir) {
  const beside = path.dirname(track);
  let cues = null;
  try {
    const read = JSON.parse(fs.readFileSync(path.join(beside, "cues.json"), "utf8"));
    if (read && typeof read === "object" && read.musicfit !== undefined) cues = read;
  } catch {
    // No cues.json of musicfit's there.
  }
  const name = path.basename(track);
  const listed = Boolean(cues) && [cues.file, cues.mix].includes(name);
  if (!listed && !(beside === folder && ["fitted.wav", "mix.wav"].includes(name))) return null;
  const was = cues && typeof cues.track === "string" ? cues.track.trim() : "";
  const isTrack = (file) => {
    try {
      return fs.statSync(file).isFile() && file !== track;
    } catch {
      return false;
    }
  };
  const found = was ? [beside, dir].map((d) => path.resolve(d, was)).find((file) => !confine.outside(dir, file, "film.json") && isTrack(file)) : null;
  return { name: path.basename(was), track: found || null };
}

// The user's own track, when film.json names one, read before anything
// renders: its sound for the film's length, decoded, and its loudness over
// it. Returns { track, problems }: a file that is missing, has no sound
// ffmpeg can read, is shorter than the film or is silent is a problem, and
// each problem says what to give instead.
async function checkMusic(loaded) {
  const { music, seconds: total, clips, dir } = loaded;
  if (!music || !music.track) return { track: null, problems: [] };
  // The path on one line, and cut when long, in every refusal (confine.js):
  // as a path, so that a track's folder is said whole.
  const at = `"music" "${confine.saidPath(music.name)}"`;
  const refuse = (problem) => ({ track: null, problems: [problem] });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(music.name)) return refuse(`${at} is an address: download the track and give the path of the file, from film.json's folder or absolute`);
  // In the folder, the track named from there, or fitted there: a fit made
  // next to the film's folder, as makersmcp's fit_music makes one by
  // default, is outside it. The track is not looked at, nor named in the
  // command, as it may be any file of the machine (earlierFit).
  const close = clips.length ? total - clips[clips.length - 1].seconds : 0;
  const outside = confine.outside(dir, music.name, "film.json");
  if (outside) {
    return refuse(`${at} ${outside}, and LAUNCH_FILM_CONFINE allows only files in it: copy the track into that folder and give its path from there, or fit it into that folder with ` +
      `${musicfitCommand({ from: null, of: "the track to fit", folder: path.join(dir, "music"), seconds: total, hit: close })}, then set "music" in film.json to "music/fitted.wav"`);
  }
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
    if (end) return refuse(`${at} is a link to ${confine.saidPath(end)}, which is not there: ${instead}`);
    // A relative path is read from film.json's folder, which may not be
    // where the user stood when they wrote it: the message says where it
    // looked.
    return refuse(path.isAbsolute(music.name) ? `${at} is not a file: ${instead}`
      : `${at} is not a file. It was looked for at ${confine.saidPath(music.track)}, as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)`);
  }
  // A good file the user may not read would read as a file with no sound.
  try {
    fs.accessSync(music.track, fs.constants.R_OK);
  } catch (err) {
    return refuse(`${at} cannot be read: ${reason(err)}. Make it readable, or give a copy of it you can read`);
  }
  const list = confine.listOf(music.track);
  if (list) return refuse(`${at} is ${list}, ${LISTED}: give the track itself`);
  // A second past the film's end, so a track as long as the film shows it.
  const sound = readSound(music.track, { seconds: total + 1 });
  if (!sound) return refuse(`${at} has no sound ffmpeg can read: give an audio file, such as a WAV, MP3, M4A or FLAC file, or a video with sound`);
  // An ffmpeg that would not read it says why, as a guard does that opens
  // no file whose name has a % in it.
  if (sound.failed) return refuse(`${at} could not be read: ${sound.failed}`);
  // musicfit gives a length to the millisecond: half a frame short is whole.
  if (sound.seconds < total - 0.5 / FPS) {
    // In a folder of its own in the film's: the path set in film.json stays
    // good, whatever else musicfit is asked to do next to the film. The
    // command is written to be run as it is, from any folder
    // (musicfitCommand).
    const folder = path.join(dir, "music");
    const fit = earlierFit(music.track, folder, dir);
    // An earlier fit is not fitted again: musicfit refuses a track it would
    // replace, and a fit's faded end would play twice.
    const was = fit && fit.name ? confine.said(fit.name) : "";
    const again = !fit ? "" : was ? `That track is musicfit's earlier fit of ${was}, so fit ${was} again: ` : "That track is an earlier fit, so fit the track it was made from again: ";
    const command = musicfitCommand({ from: fit ? fit.track : music.track, name: fit ? fit.name : "", folder, seconds: total, hit: close });
    return { track: null, problems: [`${at} lasts ${sound.seconds.toFixed(2)} s and the film ${total.toFixed(2)} s: give a track at least as long as the film. ${again}` +
      `musicfit makes one exactly that long with its hit on the beat you choose, such as the last clip at ${close.toFixed(2)} s: ${command}, then set "music" in film.json to "music/fitted.wav"`] };
  }
  const level = await loudnessOf(music.track, { seconds: total });
  if (!(level.integrated > -70)) return refuse(`${at} is silent over the film's ${total.toFixed(2)} s: give a track with sound in it, or false for no music`);
  return { track: { ...sound, ...level, name: music.name }, problems: [] };
}

// What the render's note says of the user's track (checkMusic's), in a film
// `seconds` long. Its path is shown on one line, and cut in the middle when
// it is longer than a path gets, as one made to run to thousands of
// characters is.
function trackNote(track, seconds) {
  const under = (audio.TRACK_LUFS - track.integrated) - 20 * Math.log10(audio.trackGain(track));
  return `The music is ${confine.saidPath(track.name)}${under > 0.05 ? `, ${under.toFixed(1)} dB under the bed's level so its peaks stay under full scale` : ", at the bed's level"}, ` +
    `from the film's first frame to its end at ${seconds.toFixed(2)} s, faded out over the last second.`;
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
// or, when it is larger than Chrome takes in one file (chrome.js), a copy of
// what the page shows of it, `part(width, height)` ({ x, y, w, h }, the whole
// picture when not given), that fits `maxW` x `maxH`, the most the page draws
// it at, and is never larger than the picture, written to `out` (a PNG, or a
// JPEG by its name). A screenshot of 80 MB rendered when pages were opened
// from the disk, and then failed. A copy that is still too large, as one of a
// detailed picture a zoom draws nearly at its own size, is made smaller until
// it fits, its size going with its pixels; `named` says which picture of the
// film's it is, should none fit.
async function pagePicture(file, { maxW, maxH = Infinity, part = null, out, what, named = file }) {
  if (fs.statSync(file).size <= PAGE_FILE_MAX) return fs.readFileSync(file);
  const info = pictureSize(file);
  const shown = part ? part(info.width, info.height) : { x: 0, y: 0, w: info.width, h: info.height };
  const crop = part ? `crop=${shown.w}:${shown.h}:${shown.x}:${shown.y},` : "";
  let k = Math.min(1, maxW / shown.w, maxH / shown.h);
  for (let tries = 0; tries < 4; tries++) {
    const size = (n) => Math.max(2, 2 * Math.round((n * k) / 2));
    await writePicture([...input(file), "-vf", `${crop}scale=${size(shown.w)}:${size(shown.h)}:flags=lanczos`, "-frames:v", "1", ...(/\.jpe?g$/i.test(out) ? ["-q:v", "2"] : [])], out, what);
    const bytes = fs.statSync(out).size;
    if (bytes <= PAGE_FILE_MAX) return fs.readFileSync(out);
    // A tenth to spare.
    k *= Math.sqrt((0.9 * PAGE_FILE_MAX) / bytes);
  }
  throw new Error(`${named} is more than the ${PAGE_FILE_MAX / 1048576} MB Chrome takes in one file, even as a smaller copy: give a smaller picture, or a JPEG`);
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
    if (blurred.short) throw Object.assign(new Error(blurred.short), { short: true });
    // The blurred ground is left out when it could not be made whole.
    const hasSoft = blurred.code === 0 && whole(soft);
    const page = motion.screenHtml({ mode: clip.mode === "zoom" ? "zoom" : "pan", look, port, seconds, accent: brandAccent, brand: colours,
      image: { file: `capture${ext}`, w: info.width, h: info.height }, soft: hasSoft ? "soft.jpg" : null, box: clip.box || null,
      side: clip.side || "center", phone: info.height > info.width, fonts });
    // With a quarter to spare, as the phone's screen below.
    const capture = await pagePicture(clip.imageFile, { maxW: page.drawnW * 1.25, out: path.join(work, `capture-${clip.index}${ext}`), what: `clip ${clip.index + 1}`,
      named: `clips[${clip.index}].image "${confine.said(clip.image)}"` });
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
    for (const [k, im] of images.entries()) {
      files[im.file] = await pagePicture(im.src, { maxW: Infinity, maxH: page.drawnH * 1.25, out: path.join(work, `shot-${clip.index}-${k}${path.extname(im.file)}`), what: `clip ${clip.index + 1}`,
        named: `clips[${clip.index}].images[${k}] "${confine.said(clip.images[k])}"` });
    }
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
      if (refused.length) notes.push(`${what} uses ${confine.said(path.basename(t.icon || t.logo))}: ${refused.join("; ")}.`);
      return mark;
    } catch (err) {
      if (!err.refused) throw err;
      refused.push(`${confine.said(path.basename(t.icon || t.logo))} was passed over (${err.message})`);
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

// The joined clips (`video`) and the film's sound (`wav`) written as the
// film `out`, `seconds` long, at LUFS with its true peak at TRUE_PEAK or
// under (above). `tries(n)` names the file the nth encode is written to:
// the one kept is renamed to `out`, and the others are removed as soon as a
// better one is made. Returns the level the film measures, { integrated,
// truePeak }.
async function addSound({ video, wav, out, seconds, tries }) {
  // Silence measures no level, and its gain stays at 0.
  const measured = await loudnormPass(wav, LOUDNORM);
  const fits = (level) => level.truePeak <= TRUE_PEAK;
  const off = (level) => Math.abs(level.integrated - LUFS);
  // Of two encodes, one at TRUE_PEAK or under is the better, then the one
  // nearer LUFS; of two that pass TRUE_PEAK, the one that passes it less.
  const better = (a, b) => !b || (fits(a) !== fits(b) ? fits(a) : fits(a) ? off(a) < off(b) : a.truePeak < b.truePeak);
  let gain = measured ? Math.max(-GAIN_MAX, Math.min(GAIN_MAX, LUFS - measured.integrated)) : 0;
  let ceiling = CEILING;
  let best = null;
  let last = null;
  for (let n = 0; n < TRIES; n++) {
    const file = tries(n);
    const limiter = `aformat=channel_layouts=stereo,aresample=192000,alimiter=limit=${(10 ** (ceiling / 20)).toFixed(4)}:attack=1:release=50:level=false,aresample=48000`;
    await mustRun(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", `volume=${gain.toFixed(2)}dB,${limiter}`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", seconds.toFixed(3), "-movflags", "+faststart", file], "adding the sound");
    const level = await levelOf(file);
    // Silence is kept as it is: no gain makes it louder.
    if (!(level.integrated > -70) || !(level.truePeak > -Infinity)) {
      if (best) fs.rmSync(best.file, { force: true });
      best = { file, level };
      break;
    }
    if (better(level, best && best.level)) {
      if (best) fs.rmSync(best.file, { force: true });
      best = { file, level };
    } else fs.rmSync(file, { force: true });
    if (fits(level) && off(level) <= 0.2) break;
    // The limiter takes a part of what a gain adds, so the next gain goes by
    // how far the last one moved the loudness, while the ceiling stayed.
    let slope = 1;
    if (last && last.ceiling === ceiling && Math.abs(gain - last.gain) >= 0.1) slope = Math.min(1, Math.max(0.25, (level.integrated - last.integrated) / (gain - last.gain)));
    last = { gain, ceiling, integrated: level.integrated };
    // A fifth of a dB to spare, as the encoder's lift varies a little from
    // one encode to the next.
    if (level.truePeak > TRUE_PEAK - 0.2) ceiling = Math.max(-12, ceiling - (level.truePeak - (TRUE_PEAK - 0.2)));
    gain = Math.max(-GAIN_MAX, Math.min(GAIN_MAX, gain + Math.max(-12, Math.min(12, (LUFS - level.integrated) / slope))));
    // A sound whose loudness no gain moves, as clicks the limiter holds at
    // its ceiling, is as loud as it gets once the gain is at its end.
    if (gain === last.gain && ceiling === last.ceiling) break;
  }
  fs.renameSync(best.file, out);
  return best.level;
}

// The name of the timeline written next to the film `out`.
const timelineOf = (out) => path.basename(out).replace(/\.mp4$/i, "") + ".timeline.json";

// Renders film.json to an MP4. Returns { output, seconds, clips, notes }.
async function renderFilm(file, { output = null, jobs = 2, log = () => {}, keep = false, offline = false } = {}) {
  const out = path.resolve(output || path.join(path.dirname(path.resolve(file)), "film.mp4"));
  const unfit = await outputProblem(out, Boolean(output));
  if (unfit) throw new Error(unfit);
  const loaded = loadFilm(file);
  if (loaded.problems.length) throw new Error(`film.json has problems:\n  - ${loaded.problems.join("\n  - ")}`);
  const { track, problems } = await checkMusic(loaded);
  if (problems.length) throw new Error(`film.json has problems:\n  - ${problems.join("\n  - ")}`);
  // An earlier film or timeline the commit would not replace is refused
  // now, not once every clip has rendered (out.js heldBack).
  const held = heldBackIn(path.dirname(out), [path.basename(out), timelineOf(out)]);
  if (held) throw new Error(held);
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
      // words do not, and a Chrome too slow to answer or short of memory,
      // when more than one clip renders at once (pool), that one at a time
      // eases the machine. A system short of file descriptors or processes
      // is no clip's.
      const r = await renderPage({ html: page.html, files: page.files, output: mp4, seconds: clip.render, W: page.W, H: page.H, fps: FPS })
        .catch((err) => Promise.reject(err.short ? err : new Error(`rendering clip ${clip.index + 1}: ${err.message}${(err.slow || err.memory) && Math.min(jobs, clips.length) > 1 ? ", or with --jobs 1 to render one clip at a time" : ""}`)));
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
    if (track) notes.push(trackNote(track, total));
    const bed = film.music === false ? null : track ? audio.trackBus({ left: track.left, right: track.right, seconds: total, gain: audio.trackGain(track) })
      : audio.music({ look, seconds: total, cuts: clips.map((c) => c.start), seed: clips.length }).bus;
    const wav = path.join(work, "sound.wav");
    audio.writeWav(wav, audio.mixFilm({ seconds: total, music: bed, cues, musicGain: film.music && film.music.volume !== undefined ? Number(film.music.volume) : 0.55 }));
    const timeline = { film: path.relative(path.dirname(out), path.resolve(file)), seconds: +total.toFixed(3), look,
      clips: clips.map((c) => ({ index: c.index + 1, kind: c.kind, type: c.parsed ? c.parsed.type : undefined, start: +c.start.toFixed(3), seconds: +c.seconds.toFixed(3) })) };
    // Each encode is made in the part folder, under a name no output can
    // have (out.js), so what is not kept goes with it.
    await addSound({ video, wav, out: job.out(path.basename(out)), seconds: total, tries: (n) => path.join(job.part, `.launch-film-sound-${n}${path.extname(out)}`) });
    save(job.out(timelineOf(out)), JSON.stringify(timeline, null, 2) + "\n");
    return { output: out, seconds: total, clips: timeline.clips, notes };
  } finally {
    if (!keep) release(work);
    else log(`work files kept in ${work}\n`);
  }
}

module.exports = { loadFilm, checkMusic, shellWord, musicfitCommand, trackNote, renderFilm, addSound, buildClip, markFor, brandColours, pagePicture, FPS, FADE };
