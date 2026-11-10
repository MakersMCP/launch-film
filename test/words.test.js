"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const { fromHtml, decode, readWords } = require("../src/words");
const { findChrome } = require("../src/chrome");
// Ends what the tests start and removes their temp folders: Chrome's too.
require("./tmp");

const PAGE = `<!doctype html><html lang="en-US"><head>
<title>Acme Notes | Notes that think with you</title>
<meta name="description" content="Write once and find it anywhere.">
<meta property="og:site_name" content="Acme Notes">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","slogan":"Notes that link themselves"}</script>
<style>h1{color:red}</style></head><body>
<nav><h2>Menu</h2><a class="btn">Log in</a></nav>
<h1>Notes that <em>think</em> with you</h1>
<p>Write once &amp; find it anywhere.</p>
<a class="button primary" href="/start">Start free</a>
<h3>Instant search</h3><p>Find any note in a blink.</p>
<h3>Private&nbsp;by design</h3><p>Encrypted end to end.</p>
<footer><h3>Company</h3></footer>
</body></html>`;

test("the words of a page are read from its HTML", () => {
  const w = fromHtml(PAGE);
  assert.equal(w.lang, "en");
  assert.equal(w.title, "Acme Notes | Notes that think with you");
  assert.equal(w.description, "Write once and find it anywhere.");
  assert.equal(w.siteName, "Acme Notes");
  assert.equal(w.jsonld[0].slogan, "Notes that link themselves");
  assert.deepEqual(w.headings.map((h) => [h.level, h.text]), [[1, "Notes that think with you"], [3, "Instant search"], [3, "Private by design"]]);
  assert.equal(w.headings[0].after, "Write once & find it anywhere.");
  assert.equal(w.headings[1].after, "Find any note in a blink.");
  assert.deepEqual(w.ctas, ["Start free"]);
});

test("entities are decoded", () => {
  assert.equal(decode("a &amp; b &#39;c&#x27; &rsquo;"), "a & b 'c' \u2019");
});

// A page with no headline is read in Chrome as well. One that goes on to an
// address Chrome cannot open ends on Chrome's own error page, whose words
// were taken for the page's: "This site can't be reached".
test("a page that leads Chrome to its error page keeps the words its HTML holds", { skip: !findChrome() && "Chrome not found" }, async () => {
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const dead = `http://127.0.0.1:${closed.address().port}/`;
  await new Promise((resolve) => closed.close(resolve));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><title>Acme Notes</title><p>Write once and find it anywhere.</p><script>location.href = "${dead}";</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const said = [];
    const words = await readWords(`http://127.0.0.1:${server.address().port}/`, { log: (text) => said.push(text) });
    assert.equal(said.join(""), "Chrome could not read the page (it led to an address that could not be opened).\n");
    assert.equal(words.title, "Acme Notes");
    assert.deepEqual(words.headings, []);
    assert.deepEqual(words.paragraphs, ["Write once and find it anywhere."]);
  } finally {
    server.close();
  }
});
