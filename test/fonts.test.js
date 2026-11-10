"use strict";
// The fonts cache, with Google Fonts stood in for by a fetch of our own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadFont, cacheDir } = require("../src/fonts");
const { familyName } = require("../src/brand");
const { tmp } = require("./tmp");

const CSS = "/* latin */\n@font-face {\n  font-family: 'Acme Sans';\n  font-weight: 400;\n  src: url(https://fonts.gstatic.com/s/acme.woff2) format('woff2');\n}\n";

test("a family is cached whole, and a cached file cut short is fetched again", async () => {
  const saved = [process.env.LAUNCH_FILM_CACHE, global.fetch];
  process.env.LAUNCH_FILM_CACHE = tmp();
  let fetched = 0;
  global.fetch = async (url) => {
    fetched++;
    return { ok: true, status: 200, text: async () => CSS, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, url };
  };
  try {
    const css = await loadFont("Acme Sans", [400]);
    assert.match(css, /src: url\(data:font\/woff2;base64,AQID\)/);
    // Only the whole file is there: written under a name of its own, then renamed.
    assert.deepEqual(fs.readdirSync(cacheDir()), ["Acme_Sans-400.css"]);
    const file = path.join(cacheDir(), "Acme_Sans-400.css");
    assert.equal(fs.readFileSync(file, "utf8"), css);
    fetched = 0;
    assert.equal(await loadFont("Acme Sans", [400]), css);
    assert.equal(fetched, 0, "a whole file is read from the cache");
    // A file an older release left cut short, killed mid-write.
    fs.writeFileSync(file, css.slice(0, 60));
    assert.equal(await loadFont("Acme Sans", [400]), css);
    assert.ok(fetched > 0, "fetched again");
    assert.equal(fs.readFileSync(file, "utf8"), css);
  } finally {
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_CACHE;
    else process.env.LAUNCH_FILM_CACHE = saved[0];
    global.fetch = saved[1];
  }
});

test("a cached family is whole or not there: a write cut off midway leaves nothing a later run would read", async () => {
  const saved = [process.env.LAUNCH_FILM_CACHE, global.fetch, fs.writeFileSync];
  process.env.LAUNCH_FILM_CACHE = tmp();
  global.fetch = async (url) => ({ ok: true, status: 200, text: async () => CSS, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, url });
  // As a disk that fills up, or a run killed, while the cache is written.
  fs.writeFileSync = (file, data, ...rest) => {
    saved[2](file, String(data).slice(0, 40), ...rest);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  };
  try {
    const css = await loadFont("Acme Sans", [400]);
    assert.match(css, /src: url\(data:font\/woff2;base64,AQID\)/, "the run has its font all the same");
    fs.writeFileSync = saved[2];
    assert.deepEqual(fs.readdirSync(cacheDir()), []);
  } finally {
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_CACHE;
    else process.env.LAUNCH_FILM_CACHE = saved[0];
    global.fetch = saved[1];
    fs.writeFileSync = saved[2];
  }
});

// Google Fonts answered "Open  Sans", with two spaces, with 400, and that
// noted Open Sans as missing in the cache that every later run shares, so
// every later film, anyone's where launch-film runs for others, drew it in
// a fallback. Google tells names apart by case, as a Mac's file names do
// not. A stand-in Google that has Open Sans, by that name alone.
function google() {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (/fonts\.gstatic\.com/.test(url)) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, url };
    const family = new URL(url).searchParams.get("family").split(":")[0];
    if (family !== "Open Sans" || google.down) return { ok: false, status: 400, url };
    return { ok: true, status: 200, text: async () => CSS.replace("Acme Sans", "Open Sans"), url };
  };
  return { asked, fetch };
}

test("a family's name is asked for and kept in one form, so a name spelt otherwise notes no other family as missing", async () => {
  const saved = [process.env.LAUNCH_FILM_CACHE, global.fetch];
  process.env.LAUNCH_FILM_CACHE = tmp();
  const { asked, fetch } = google();
  global.fetch = fetch;
  try {
    assert.match(await loadFont("Open  Sans", [400]), /font-family: 'Open Sans'/);
    assert.ok(asked.every((url) => !/Open\+\+Sans/.test(url)), asked.join("\n"));
    fs.rmSync(path.join(cacheDir(), "Open_Sans-400.css"));
    // Names Google does not have, as it spells them.
    for (const name of ["open sans", "OPEN SANS", "Open Sans Pro"]) assert.equal(await loadFont(name, [400]), "", name);
    assert.match(await loadFont("Open Sans", [400]), /font-family: 'Open Sans'/);
    // On a Mac the names of these notes would be one file but for case.
    const notes = fs.readdirSync(cacheDir()).filter((f) => f.endsWith(".missing")).map((f) => f.toLowerCase());
    assert.equal(new Set(notes).size, 3, notes.join(" "));
    // A brand's typeface is read in that one form too.
    assert.equal(familyName("Open  Sans, sans-serif"), "Open Sans");
  } finally {
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_CACHE;
    else process.env.LAUNCH_FILM_CACHE = saved[0];
    global.fetch = saved[1];
  }
});

test("a family noted as missing is asked for again a day later", async () => {
  const saved = [process.env.LAUNCH_FILM_CACHE, global.fetch];
  process.env.LAUNCH_FILM_CACHE = tmp();
  const { asked, fetch } = google();
  global.fetch = fetch;
  try {
    // Google refused it once, as a fault of its own can.
    google.down = true;
    assert.equal(await loadFont("Open Sans", [400]), "");
    google.down = false;
    const [note] = fs.readdirSync(cacheDir()).filter((f) => f.endsWith(".missing"));
    asked.length = 0;
    assert.equal(await loadFont("Open Sans", [400]), "", "within the day");
    assert.deepEqual(asked, []);
    const then = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(cacheDir(), note), then, then);
    assert.match(await loadFont("Open Sans", [400]), /font-family: 'Open Sans'/);
  } finally {
    google.down = false;
    if (saved[0] === undefined) delete process.env.LAUNCH_FILM_CACHE;
    else process.env.LAUNCH_FILM_CACHE = saved[0];
    global.fetch = saved[1];
  }
});
