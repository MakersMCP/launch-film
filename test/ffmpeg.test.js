"use strict";
// The ffmpeg helpers: pictures whose names ffmpeg could read as a numbered
// sequence, and what a run of ffmpeg that failed says. Skipped where ffmpeg
// is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { available, why, probe, readPixels, writePng, coverPng, mustRun, whole } = require("../src/ffmpeg");

const skip = !available() ? "ffmpeg not found" : false;
const { tmp } = require("./tmp");

test("a picture in a folder named like a numbered sequence is read and written as it is", { skip }, async () => {
  const base = tmp();
  const dir = path.join(base, "take%d");
  fs.mkdirSync(dir);
  // A picture of 64x48 whose left half is red.
  const data = Buffer.alloc(64 * 48 * 4);
  for (let i = 0; i < 64 * 48; i++) data.set(i % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], 4 * i);
  const file = path.join(dir, "logo.png");
  await writePng(file, { data, width: 64, height: 48 });
  assert.deepEqual(fs.readdirSync(base), ["take%d"]);
  assert.deepEqual(fs.readdirSync(dir), ["logo.png"]);
  const info = probe(file);
  assert.deepEqual([info.width, info.height], [64, 48]);
  const px = readPixels(file);
  assert.deepEqual([...px.data.subarray(0, 4)], [255, 0, 0, 255]);
  await coverPng(file, path.join(dir, "cover.png"), 32, 32);
  assert.deepEqual([probe(path.join(dir, "cover.png")).width, probe(path.join(dir, "cover.png")).height], [32, 32]);
  // A JPEG saved under a .png name still reads where the name has no %.
  const jpeg = path.join(base, "photo.jpg");
  await mustRun(["-f", "lavfi", "-i", "color=c=red:s=40x30", "-frames:v", "1", jpeg], "a test picture");
  fs.renameSync(jpeg, path.join(base, "photo.png"));
  assert.equal(readPixels(path.join(base, "photo.png")).width, 40);
});

test("a failed run of ffmpeg says why: its words, the signal that ended it, or its exit code", () => {
  assert.equal(why({ code: 1, signal: null, stderr: "a\nb\nc\nNo space left on device\n" }), "ffmpeg failed: b | c | No space left on device");
  assert.equal(why({ code: null, signal: "SIGKILL", stderr: "" }), "ffmpeg was stopped by SIGKILL, most often because the system ran out of memory");
  assert.equal(why({ code: null, signal: "SIGTERM", stderr: "" }, { name: "ffprobe" }), "ffprobe was stopped by SIGTERM");
  assert.equal(why({ code: 1, signal: null, stderr: "" }), "ffmpeg failed with exit code 1");
});

// On a full disk ffmpeg 4.4.2 said a line again with its note that it had,
// and the failure ended in its words and no word of what to do.
test("a run of ffmpeg that fills the disk names the disk, with what to do, and leaves out its notes of lines said again", () => {
  const stderr = "av_interleaved_write_frame(): No space left on device\n    Last message repeated 1 times\nError writing trailer of /films/acme/film.mp4: No space left on device\n";
  assert.equal(why({ code: 1, signal: null, stderr }, { out: "/films/acme/film.mp4" }), "ffmpeg failed: av_interleaved_write_frame(): No space left on device | " +
    "Error writing trailer of /films/acme/film.mp4: No space left on device. The disk of /films/acme is full: free some room and run again");
  assert.equal(why({ code: 1, signal: null, stderr }), "ffmpeg failed: av_interleaved_write_frame(): No space left on device | Error writing trailer of /films/acme/film.mp4: No space left on device");
  // A file in a temp folder of the run's own, as a clip is, goes with the
  // run: the disk is named by the temp folder.
  const { tempDir, release } = require("../src/out");
  const work = tempDir("launch-film-work-");
  try {
    assert.equal(why({ code: 1, signal: null, stderr: "Could not write header for output file #0: No space left on device" }, { lines: 2, out: path.join(work, "clip-00.mp4") }),
      `ffmpeg failed: Could not write header for output file #0: No space left on device. The disk of ${require("os").tmpdir()} is full: free some room and run again`);
  } finally {
    release(work);
  }
});

test("a picture cut short is told from a whole one", { skip }, async () => {
  const dir = tmp();
  const png = path.join(dir, "a.png");
  await writePng(png, { data: Buffer.alloc(16 * 16 * 4, 255), width: 16, height: 16 });
  const jpg = path.join(dir, "a.jpg");
  await mustRun(["-f", "lavfi", "-i", "color=c=red:s=40x30", "-frames:v", "1", "-update", "1", jpg], "a test picture");
  assert.ok(whole(png) && whole(jpg));
  for (const file of [png, jpg]) {
    const data = fs.readFileSync(file);
    fs.writeFileSync(file, data.subarray(0, data.length - 3));
    assert.ok(!whole(file), `${path.basename(file)} cut short`);
  }
  assert.ok(!whole(path.join(dir, "missing.png")));
});
