"use strict";
// The fonts cache, with Google Fonts stood in for by a fetch of our own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadFont, cacheDir } = require("../src/fonts");
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
