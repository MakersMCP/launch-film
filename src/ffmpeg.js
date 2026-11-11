"use strict";
// ─── ffmpeg ────────────────────────────────────────────────────────────────
// ffmpeg encodes the frames, reads and writes pictures as raw pixels, joins
// the clips and lays the sound under them. LAUNCH_FILM_FFMPEG and
// LAUNCH_FILM_FFPROBE point at other builds.
//
// ffmpeg reads a picture's name with a % in it as a numbered sequence (in a
// folder named take%d, logo.png is looked for as take1/logo.png), both when
// it reads a picture and when it writes one. So a picture whose name has a %
// is read with the pattern turned off, and every picture is written with
// -update 1, which takes its name as it is; ffmpeg 4.4 has both. Only such a
// name is read that way, since it makes ffmpeg pick the decoder by the
// name's extension where it otherwise reads what the file holds: a JPEG
// saved as .png still reads.
//
// ffmpeg 4.4 that cannot write the whole of a picture, as on a full disk,
// leaves it cut short and still exits with 0, so every picture written is
// read back to its end (writePicture).

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { track } = require("./out");
const { short } = require("./programs");

const FFMPEG = process.env.LAUNCH_FILM_FFMPEG || "ffmpeg";
const FFPROBE = process.env.LAUNCH_FILM_FFPROBE || "ffprobe";

function available() {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  const m = /ffmpeg version (\S+)/.exec(r.stdout || "");
  return m ? m[1] : "unknown";
}

const PICTURE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

// The arguments that open `file` as an input (see above).
function input(file) {
  return String(file).includes("%") && PICTURE.test(file) ? ["-f", "image2", "-pattern_type", "none", "-i", file] : ["-i", file];
}

// The arguments that write one picture to `file` (see above).
const picture = (file) => ["-update", "1", file];

// Whether a picture ffmpeg wrote is whole: a PNG ends with its IEND chunk
// and a JPEG with its end marker. Another kind only has to be there.
function whole(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(12, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const ext = path.extname(file).toLowerCase();
    if (ext === ".png") return tail.length === 12 && tail.toString("latin1", 4, 8) === "IEND";
    if (ext === ".jpg" || ext === ".jpeg") return tail.length >= 2 && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9;
    return size > 0;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Writes one picture to `file` with ffmpeg (`args` up to the output), and
// fails, after `what` it was doing, when it is not whole. A picture ffmpeg
// found no frame for, as at a time past the end of a video's picture, is
// said as `none`: ffmpeg 4.4 then writes nothing and ends well, where newer
// builds fail, and either was told of as a disk that is full or in ffmpeg's
// own words. The file is cleared first, so that one left there is never
// taken for the new one.
async function writePicture(args, file, what, { none = null, ...opts } = {}) {
  fs.rmSync(file, { force: true });
  const r = await run([...args, ...picture(file)], opts);
  if (r.short) throw Object.assign(new Error(r.short), { short: true });
  const nothing = !fs.existsSync(file) && (r.code === 0 || /Nothing was written into output file|Output file is empty/.test(r.stderr));
  if (nothing && none) throw new Error(`${what}: ${none}`);
  if (r.code !== 0) throw new Error(`${what}: ${why(r)}`);
  if (nothing) throw new Error(`${what}: ffmpeg wrote no picture`);
  if (!whole(file)) throw new Error(`${what}: the picture was cut short, most often because the disk is full`);
  return r;
}

// Why a run of ffmpeg or ffprobe ({ code, signal, stderr }) failed: the end
// of its own words, else the signal that ended it, else its exit code. One
// killed outright with no word was most often ended by the system running
// out of memory.
function why(r, { lines = 3, name = "ffmpeg" } = {}) {
  const said = String(r.stderr || "").trim().split("\n").slice(-lines).join(" | ");
  if (said) return `${name} failed: ${said}`;
  if (r.signal) return `${name} was stopped by ${r.signal}${r.signal === "SIGKILL" ? ", most often because the system ran out of memory" : ""}`;
  return `${name} failed with exit code ${r.code}`;
}

// What ffmpeg and ffprobe say, on 4.4 as on newer builds, when what they
// were given holds nothing of the kind asked for, as a picture given as a
// sound, or is no file they read at all, as a text file. Anything else they
// fail with is said in their own words: a build that refuses the file, as
// a guard of a hosted service does by its name, is no file without sound.
const NOTHING = /does not contain any stream|Invalid data found when processing input/;

// Why a synchronous run of ffmpeg or ffprobe (spawnSync's result) that
// failed could not read its input, in its own words, or null when the input
// holds nothing it reads. One that could not be started, as when there is
// no ffprobe, says so.
function unread(r, name) {
  if (r.error) {
    const said = { ENOENT: "no such file", EACCES: "permission denied" }[r.error.code];
    return r.error.code === "ETIMEDOUT" ? `${name} did not end in time` : `${name} could not be started: ${said ? `${said} (${r.error.code})` : r.error.message}`;
  }
  const said = String(r.stderr || "");
  return NOTHING.test(said) ? null : why({ code: r.status, signal: r.signal, stderr: said }, { lines: 1, name });
}

// A synchronous run (spawnSync's result) that a signal ended: an error that
// says so, after `what` it was doing. Its own timeout's is not one; the
// caller tells of that.
function stoppedSync(r, name, what) {
  if (!r.signal || (r.error && r.error.code === "ETIMEDOUT")) return null;
  return Object.assign(new Error(`${what}: ${why({ signal: r.signal }, { name })}`), { signal: r.signal });
}

// Runs ffmpeg and resolves { code, signal, stderr } (the end of it). A
// filter's own report (ebur128's summary) needs loglevel "info".
//
// A process the system had no file descriptor for (EMFILE, ENFILE) comes
// back from spawn with no pipes, and its error comes next: its error listener
// is the first thing set, and its pipes are touched only when it has them.
// Touched as they were, they threw, and the error had no listener, which
// ended launch-film with Node's stack trace.
function run(args, { input = null, timeout = 0, loglevel = "error" } = {}) {
  return new Promise((resolve) => {
    const child = track(spawn(FFMPEG, ["-hide_banner", "-nostats", "-loglevel", loglevel, "-y", ...args], { stdio: [input ? "pipe" : "ignore", "ignore", "pipe"] }));
    child.on("error", (err) => resolve({ code: -1, signal: null, stderr: err.message, short: short(err, "ffmpeg") }));
    if (!child.stderr) return;
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-6000)));
    let timer = null;
    let late = false;
    if (timeout) {
      timer = setTimeout(() => {
        late = true;
        child.kill("SIGKILL");
      }, timeout);
      timer.unref();
    }
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stderr: late ? `${stderr}\nit took longer than ${Math.round(timeout / 1000)} s` : stderr });
    });
    if (input) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

async function mustRun(args, what, opts) {
  const r = await run(args, opts);
  if (r.short) throw Object.assign(new Error(r.short), { short: true });
  if (r.code !== 0) throw new Error(`${what}: ${why(r)}`);
  return r;
}

// "30000/1001" as a number.
const rate = (r) => {
  const [a, b] = String(r || "").split("/").map(Number);
  return a && b ? a / b : Number(a) || 0;
};

// "00:00:06.000000000", as Matroska and WebM give a stream's length, in
// seconds, or 0.
function clock(text) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(text || "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// Where the picture of a file ends by its packets: the end of the latest, in
// the stream's own time, or 0 when its packets have no times.
function lastPacket(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", ...input(file)],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
  const stopped = stoppedSync(r, "ffprobe", `reading ${file}`);
  if (stopped) throw stopped;
  if (short(r.error, "ffprobe")) throw new Error(short(r.error, "ffprobe"));
  let end = 0;
  for (const line of String(r.stdout || "").split("\n")) {
    const [at, length] = line.split(",").map(Number);
    if (Number.isFinite(at)) end = Math.max(end, at + (Number.isFinite(length) ? length : 0));
  }
  return end;
}

// What ffprobe says of a file: its size, length, frame rate and sound, and
// `picture`, where its picture ends, from the film's start. A video whose
// sound runs on past its picture ends its picture before the film ends. The
// picture's own length is its stream's, which Matroska and WebM give only as
// a DURATION tag, else where its last packet ends; the film's length when
// none of them says.
function probe(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries",
    "format=duration,start_time:stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,avg_frame_rate,sample_rate,channels,duration,start_time:stream_tags=DURATION",
    "-of", "json", ...input(file)], { encoding: "utf8", timeout: 20_000 });
  const stopped = stoppedSync(r, "ffprobe", `reading ${file}`);
  if (stopped) throw stopped;
  if (short(r.error, "ffprobe")) throw new Error(short(r.error, "ffprobe"));
  // Why ffprobe could not read it, when that is not that it holds nothing.
  const failed = r.status !== 0 ? unread(r, "ffprobe") : null;
  let info;
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return { width: 0, height: 0, duration: 0, picture: 0, audio: false, fps: 0, baseFps: 0, codec: "", pixFmt: "", sar: "", audioCodec: "", sampleRate: 0, channels: 0, failed };
  }
  const video = (info.streams || []).find((s) => s.codec_type === "video") || {};
  const sound = (info.streams || []).find((s) => s.codec_type === "audio") || null;
  const format = info.format || {};
  const duration = Number(format.duration) || 0;
  const tag = Object.entries(video.tags || {}).find(([key]) => key.toUpperCase() === "DURATION");
  const own = Number(video.duration) > 0 ? Number(video.duration) : tag ? clock(tag[1]) : 0;
  let shown = own > 0 ? own + (Number(video.start_time) || 0) - (Number(format.start_time) || 0) : 0;
  // A picture alone has no length to look for.
  if (!(shown > 0) && video.codec_type && duration) {
    const end = lastPacket(file);
    if (end > 0) shown = end - (Number(format.start_time) || 0);
  }
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    duration,
    picture: shown > 0 ? shown : duration,
    audio: Boolean(sound),
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate),
    baseFps: rate(video.r_frame_rate),
    codec: video.codec_name || "",
    pixFmt: video.pix_fmt || "",
    sar: video.sample_aspect_ratio || "",
    audioCodec: sound ? sound.codec_name || "" : "",
    sampleRate: sound ? Number(sound.sample_rate) || 0 : 0,
    channels: sound ? Number(sound.channels) || 0 : 0,
    failed,
  };
}

// A sound file's first `seconds`, decoded as 48 kHz stereo floats ({ left,
// right, seconds }), or null when ffmpeg finds no sound in it, or { failed }
// with ffmpeg's own words when it could not read it for another reason. A
// mono file plays on both sides. The length is the decoded one: a file's
// header can be wrong about it (a VBR MP3 without a Xing header).
function readSound(file, { seconds }) {
  const r = spawnSync(FFMPEG, ["-v", "error", ...input(file), "-vn", "-t", seconds.toFixed(3), "-ac", "2", "-ar", "48000", "-f", "f32le", "-"],
    { maxBuffer: Math.ceil(seconds * 48000) * 8 + (1 << 20), timeout: 120_000 });
  const stopped = stoppedSync(r, "ffmpeg", `reading ${file}`);
  if (stopped) throw stopped;
  if (r.error) throw new Error(short(r.error, "ffmpeg") || `reading ${file}: ${r.error.message}`);
  if (r.status !== 0) {
    const failed = unread(r, "ffmpeg");
    return failed ? { failed } : null;
  }
  if (!r.stdout || r.stdout.length < 8) return null;
  const n = Math.floor(r.stdout.length / 8);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = r.stdout.readFloatLE(8 * i);
    right[i] = r.stdout.readFloatLE(8 * i + 4);
  }
  return { left, right, seconds: n / 48000 };
}

// The loudness of a sound file's first `seconds`, by ebur128: { integrated
// (LUFS), peak (the sample peak, dBFS) }. Digital silence measures -70 LUFS
// and a peak of -inf. framelog=verbose keeps the line for every 100 ms out
// of the info level the summary is read at.
async function loudnessOf(file, { seconds }) {
  const r = await run([...input(file), "-vn", "-t", seconds.toFixed(3), "-af", "ebur128=peak=sample:framelog=verbose", "-f", "null", "-"], { loglevel: "info" });
  if (r.short) throw Object.assign(new Error(r.short), { short: true });
  if (r.code !== 0) throw new Error(`measuring ${file}: ${why(r, { lines: 2 })}`);
  const num = (re) => {
    const m = re.exec(r.stderr);
    return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
  };
  return { integrated: num(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf) LUFS/), peak: num(/Sample peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf) dBFS/) };
}

// loudnorm's first pass over a sound file, given its `filter` (loudnorm=I=
// and the rest): what it measured, as the options its second pass takes to
// set the sound to that level (":measured_I=...:offset=..."), or "" for a
// sound it measured no level in, as silence, which the second pass then takes
// as it is. In one pass loudnorm sets the level from the first seconds it
// has heard, and a film came out a LU or two away from it; with what the
// first pass measured, it lands within a few tenths.
const MEASURED = [["measured_I", "input_i", -99, 0], ["measured_TP", "input_tp", -99, 99], ["measured_LRA", "input_lra", 0, 99], ["measured_thresh", "input_thresh", -99, 0], ["offset", "target_offset", -99, 99]];
async function loudnormPass(file, filter) {
  const r = await run([...input(file), "-af", `${filter}:print_format=json`, "-f", "null", "-"], { loglevel: "info" });
  if (r.short) throw Object.assign(new Error(r.short), { short: true });
  if (r.code !== 0) throw new Error(`measuring the sound: ${why(r, { lines: 2 })}`);
  let said = null;
  try {
    said = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1));
  } catch {
    return "";
  }
  let options = "";
  for (const [option, key, min, max] of MEASURED) {
    const value = Number(said[key]);
    if (!(value >= min && value <= max)) return "";
    options += `:${option}=${value}`;
  }
  return options;
}

// A picture made exactly W x H: scaled to cover the size and cut to it from
// the middle, as an opaque PNG (stores refuse transparency).
function coverPng(from, output, W, H) {
  return writePicture([...input(from), "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`,
    "-frames:v", "1", "-pix_fmt", "rgb24"], output, `making ${output}`);
}

// A picture's size, from probe(): a file in which ffprobe finds no picture
// (a text file, a page saved as .png) fails, where its size of 0 x 0 made a
// clip that showed nothing, and so does one ffprobe could not read, with
// its words.
function pictureSize(file) {
  const info = probe(file);
  if (!info.width || !info.height) throw new Error(`${file} could not be read as a picture${info.failed ? ` (${info.failed})` : ""}`);
  return info;
}

// A picture's pixels as RGBA, at most `max` px on its long side when given:
// { data, width, height }.
function readPixels(file, max = 0) {
  const info = pictureSize(file);
  const k = max ? Math.min(1, max / Math.max(info.width, info.height)) : 1;
  const width = Math.max(1, Math.round(info.width * k));
  const height = Math.max(1, Math.round(info.height * k));
  const r = spawnSync(FFMPEG, ["-v", "error", ...input(file), "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area,format=rgba`, "-f", "rawvideo", "-"],
    { timeout: 30_000, maxBuffer: width * height * 4 + 1024 });
  const stopped = stoppedSync(r, "ffmpeg", `reading ${file}`);
  if (stopped) throw stopped;
  if (short(r.error, "ffmpeg")) throw new Error(short(r.error, "ffmpeg"));
  const failed = r.status !== 0 ? unread(r, "ffmpeg") : null;
  if (r.status !== 0 || !r.stdout || r.stdout.length !== width * height * 4) throw new Error(`${file} could not be read as a picture${failed ? ` (${failed})` : ""}`);
  return { data: r.stdout, width, height, scale: k, sourceWidth: info.width, sourceHeight: info.height };
}

// RGBA pixels written as a PNG.
function writePng(file, { data, width, height }) {
  return writePicture(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "-", "-frames:v", "1"], file, "writing a picture", { input: data });
}

// A frame encoder: JPEG frames in, an H.264 MP4 out.
function encoder({ output, fps = 25, crf = 15 }) {
  const child = track(spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-an", "-r", String(fps), "-movflags", "+faststart", output],
  { stdio: ["pipe", "ignore", "pipe"] }));
  let err = "";
  let ended = null;
  // One that cannot be started says why here, and closes as one that stopped.
  // One the system had no file descriptor for has no pipes (run, above).
  let unstarted = null;
  child.on("error", (e) => {
    err = e.message;
    unstarted = short(e, "ffmpeg");
  });
  if (child.stderr) child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
  if (child.stdin) child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve((ended = { code, signal }))));
  const failed = () => Object.assign(new Error(unstarted || why({ ...ended, stderr: err }, { lines: 2 })), { short: Boolean(unstarted) });
  return {
    // An ffmpeg that has stopped (a full disk, an output it cannot write)
    // takes no more frames: its error, not a wait for room in the pipe.
    async write(jpeg) {
      if (!child.stdin) await closed;
      else if (!ended && !child.stdin.write(jpeg)) await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), closed]);
      if (ended) throw failed();
    },
    async end() {
      if (child.stdin) child.stdin.end();
      await closed;
      if (ended.code !== 0) throw failed();
    },
    kill: () => child.kill("SIGKILL"),
  };
}

module.exports = { FFMPEG, FFPROBE, available, input, picture, whole, writePicture, why, stoppedSync, run, mustRun, probe, pictureSize, readSound, loudnessOf, loudnormPass, coverPng, readPixels, writePng, encoder };
