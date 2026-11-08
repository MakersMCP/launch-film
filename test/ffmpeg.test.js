"use strict";
// The ffmpeg helpers: pictures whose names ffmpeg could read as a numbered
// sequence. Skipped where ffmpeg is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { available, probe, readPixels, writePng, coverPng, mustRun } = require("../src/ffmpeg");

const skip = !available() ? "ffmpeg not found" : false;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-ffmpeg-"));

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
