"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const audio = require("../src/audio");

const peak = (bus) => {
  let p = 0;
  for (const ch of [bus.L, bus.R]) for (const v of ch) p = Math.max(p, Math.abs(v));
  return p;
};
const finite = (bus) => [bus.L, bus.R].every((ch) => ch.every(Number.isFinite));

test("every effect the scenes ask for is drawn, finite and under full scale", () => {
  for (const name of Object.keys(audio.EFFECTS)) {
    const bus = audio.effect(name);
    assert.ok(bus.length > 0, name);
    assert.ok(finite(bus), `${name} is finite`);
    const p = peak(bus);
    assert.ok(p > 0.2 && p <= 1, `${name} peak ${p}`);
  }
});

test("the music bed lasts the film and lands a hit on the last cut", () => {
  for (const look of Object.keys(audio.MOODS)) {
    const bar = 240 / audio.MOODS[look].bpm;
    const cuts = [0, 2 * bar, 4 * bar, 6 * bar];
    const seconds = 8 * bar;
    const { bus } = audio.music({ look, seconds, cuts });
    assert.ok(bus.seconds >= seconds, look);
    assert.ok(finite(bus), look);
    // Louder after the last cut than in the bar before it: the hit.
    const rms = (from, to) => {
      let s = 0;
      for (let i = Math.round(from * audio.SR); i < Math.round(to * audio.SR); i++) s += bus.L[i] ** 2;
      return Math.sqrt(s / ((to - from) * audio.SR));
    };
    assert.ok(rms(cuts[3], cuts[3] + 0.3) > rms(cuts[3] - 0.6, cuts[3] - 0.3) * 0.8, `${look} hit`);
  }
});

test("the mix is limited and written as a float WAV", () => {
  const seconds = 3;
  const mix = audio.mixFilm({ seconds, music: null, cues: [{ sfx: "impact-bass-1", at: 0.2, volume: 2 }, { sfx: "impact-bass-2", at: 0.2, volume: 2 }, { sfx: "nope", at: 1, volume: 1 }] });
  assert.ok(peak(mix) < 1);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-test-")), "a.wav");
  audio.writeWav(file, mix);
  const head = fs.readFileSync(file).subarray(0, 44);
  assert.equal(head.toString("ascii", 0, 4), "RIFF");
  assert.equal(head.readUInt16LE(20), 3);
  assert.equal(head.readUInt16LE(22), 2);
  assert.equal(head.readUInt32LE(24), 48000);
  assert.equal(head.readUInt32LE(40), seconds * 48000 * 8);
});

test("a track takes the bed's place at the bed's level", () => {
  const seconds = 3;
  // A track longer than the film: a steady level, the right side inverted.
  const left = new Float32Array(4 * audio.SR).fill(0.5);
  const right = new Float32Array(4 * audio.SR).fill(-0.5);
  const bus = audio.trackBus({ left, right, seconds, gain: 0.8 });
  assert.equal(bus.length, seconds * audio.SR);
  // From the first frame, faded in over 10 ms.
  assert.ok(bus.L[0] > 0 && bus.L[0] < 0.01, `${bus.L[0]}`);
  assert.ok(Math.abs(bus.L[0.01 * audio.SR] - 0.4) < 1e-6);
  // At its gain a second before the end, faded out over the last second.
  const before = (seconds - 1) * audio.SR - 1;
  assert.ok(Math.abs(bus.L[before] - 0.4) < 1e-6 && Math.abs(bus.R[before] + 0.4) < 1e-6);
  assert.ok(Math.abs(bus.L[bus.length - audio.SR / 2] - 0.2) < 1e-3);
  assert.ok(bus.L[bus.length - 1] === 0 && bus.R[bus.length - 1] === 0, "the last sample is silent");
  // A track at -20 LUFS comes up to the beds' -14, unless its peaks would
  // pass -1 dBFS: one peaking at -3 dBFS comes up 2 dB.
  assert.equal(audio.TRACK_LUFS, -14);
  assert.ok(Math.abs(20 * Math.log10(audio.trackGain({ integrated: -20, peak: -10 })) - 6) < 1e-9);
  assert.ok(Math.abs(20 * Math.log10(audio.trackGain({ integrated: -20, peak: -3 })) - 2) < 1e-9);
});
