"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const { fromHtml, decode, readWords, fromChrome, webPage } = require("../src/words");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { findChrome, chromeArgs, opened, OPENERS } = require("../src/chrome");
// Ends what the tests start and removes their temp folders: Chrome's too.
const { tmp } = require("./tmp");

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

// Chrome opens an address of any kind as a page, a file of this machine's
// among them, where a script can read the machine's files: a kit gave its
// own brand.json, a page as well, as the site's address. Only a web page is
// read, and an address of another kind is not fetched or opened at all.
test("only an http or https page is read: another address is refused before it is fetched or opened", async () => {
  for (const url of ["file:///etc/hostname", " FILE:///etc/hostname", "file://localhost/etc/hostname", "data:text/html,<h1>Acme</h1>", "javascript:alert(1)",
    "chrome://version", "view-source:https://acme-notes.example/", "about:blank", "acme-notes.example"]) {
    const said = [];
    await assert.rejects(readWords(url, { log: (text) => said.push(text) }),
      { message: `the page ${url} could not be read (it is not an http or https address): give the site's address, or a words.json with --words` }, url);
    assert.deepEqual(said, [], url);
  }
  assert.ok(webPage("http://acme-notes.example/") && webPage("HTTPS://acme-notes.example/"));
  // Chrome is not even started for one: with none to be found, the refusal
  // is still the address's.
  const saved = process.env.LAUNCH_FILM_CHROME;
  process.env.LAUNCH_FILM_CHROME = "/nonexistent";
  try {
    await assert.rejects(fromChrome("file:///etc/hostname"), { message: "it is not an http or https address", unread: true });
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CHROME;
    else process.env.LAUNCH_FILM_CHROME = saved;
  }
});

// The browser that reads a site's words may open no file of the machine's.
test("the browser that reads a site's words is not let read files", () => {
  assert.ok(!chromeArgs({ network: true, profile: "/p" }).includes("--allow-file-access-from-files"));
});

// A page that went on to an address that is no web page's shows words that
// are not the page's: none, for about:blank.
test("a page that goes on to an address that is not a web page's is not read in Chrome", { skip: !findChrome() && "Chrome not found" }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><title>Acme Notes</title><p>Write once and find it anywhere.</p><script>location.href = "about:blank";</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const said = [];
    const words = await readWords(`http://127.0.0.1:${server.address().port}/`, { log: (text) => said.push(text) });
    assert.equal(said.join(""), "Chrome could not read the page (it went on to about:blank, which is not a web page).\n");
    assert.equal(words.title, "Acme Notes");
    assert.deepEqual(words.paragraphs, ["Write once and find it anywhere."]);
  } finally {
    server.close();
  }
});

// Chrome hands a mailto:, news: or snews: address to xdg-email or xdg-open,
// found on PATH, without asking: a page that went to mailto: as it loaded
// started the user's mail program. These stand-ins come first on PATH and
// only note how they were started, so even without launch-film's own, no
// real program starts here.
function recorders() {
  const dir = tmp();
  const log = path.join(dir, "log");
  for (const name of OPENERS) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> '${log}'\n`, { mode: 0o755 });
  return { dir, said: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}

test("a page that goes to a mailto: address as it loads, or opens one in a window, starts no program, and a plan says the page tried", { skip: (!findChrome() && "Chrome not found") || (process.platform !== "linux" && "the stand-ins are Linux's"), timeout: 180_000 }, async () => {
  const rec = recorders();
  const saved = process.env.PATH;
  process.env.PATH = `${rec.dir}${path.delimiter}${saved}`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const go = req.url === "/open" ? 'window.open("mailto:open@acme-notes.example")' : 'location.href = "mailto:hello@acme-notes.example?subject=Hi"';
    res.end(`<!doctype html><html lang="en"><title>Acme Notes</title><h1>Notes that think with you</h1><p>Write once and find it anywhere.</p><script>${go};</script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const page of ["/load", "/open"]) {
      const words = await readWords(`${base}${page}`);
      assert.equal(words.headings[0].text, "Notes that think with you", page);
    }
    assert.equal(rec.said(), "", "a program on PATH was started");
    assert.ok(opened().includes("mailto:hello@acme-notes.example?subject=Hi"));
    // A plan says so.
    const kit = path.join(tmp(), "kit");
    fs.cpSync(path.join(__dirname, "fixtures", "acme"), kit, { recursive: true });
    const brandFile = path.join(kit, "brand.json");
    fs.writeFileSync(brandFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(brandFile, "utf8")), url: `${base}/load` }));
    const out = tmp();
    const plan = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--brand", kit, "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
      let said = "";
      child.stderr.on("data", (d) => (said += d));
      child.on("close", (code) => resolve({ code, said }));
    });
    assert.equal(plan.code, 0, plan.said);
    assert.match(plan.said, /^note: The page tried to open mailto:hello@acme-notes\.example\?subject=Hi, which is not a web address: it was not opened\.$/m);
    assert.equal(rec.said(), "", "a program on PATH was started");
  } finally {
    process.env.PATH = saved;
    server.close();
  }
});

// A page can make Chrome save a file of its choosing, of any size, into the
// Downloads folder of the user it runs as: a site a plan read left one there,
// where nothing removed it.
test("a page that makes Chrome save a file saves none, by readWords or by a plan", { skip: !findChrome() && "Chrome not found", timeout: 180_000 }, async () => {
  let asked = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/file.bin") {
      asked++;
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="planted.desktop"' });
      return res.end("[Desktop Entry]\nType=Application\nExec=sh -c 'echo planted'\n");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html lang="en"><title>Acme Notes</title><h1>Notes that think with you</h1><p>Write once and find it anywhere.</p><script>addEventListener("load", () => (location.href = "/file.bin"));</script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // Every file under a folder, by its path from it.
  const files = (dir) => fs.readdirSync(dir, { recursive: true }).filter((name) => fs.statSync(path.join(dir, name)).isFile());
  const run = (args, home) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, TMPDIR: tmp() } });
    let said = "";
    child.stdout.on("data", (d) => (said += d));
    child.stderr.on("data", (d) => (said += d));
    child.on("close", (code) => resolve({ code, said }));
  });
  try {
    const home = tmp();
    const read = await run(["-e", `require(${JSON.stringify(path.join(__dirname, "..", "src", "words.js"))}).readWords(${JSON.stringify(url)}).then((w) => console.log(w.headings[0].text))`], home);
    assert.equal(read.code, 0, read.said);
    assert.match(read.said, /Notes that think with you/);
    const kit = path.join(tmp(), "kit");
    fs.cpSync(path.join(__dirname, "fixtures", "acme"), kit, { recursive: true });
    const brandFile = path.join(kit, "brand.json");
    fs.writeFileSync(brandFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(brandFile, "utf8")), url }));
    const out = path.join(tmp(), "film");
    const planHome = tmp();
    const plan = await run([path.join(__dirname, "..", "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--brand", kit, "--out", out], planHome);
    assert.equal(plan.code, 0, plan.said);
    // Chrome was sent to the file each time, and saved it nowhere.
    assert.ok(asked >= 2, `the file was asked for ${asked} times`);
    for (const dir of [home, planHome]) {
      assert.ok(!fs.existsSync(path.join(dir, "Downloads")), `${dir}/Downloads was made`);
      assert.deepEqual(files(dir).filter((name) => /planted/.test(name)), []);
    }
    assert.deepEqual(files(out).filter((name) => /planted/.test(name)), []);
  } finally {
    server.close();
  }
});
