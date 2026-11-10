"use strict";
// What a page in launch-film's Chrome may reach: Chrome's sandbox, and the
// files and addresses each of its two browsers lets a page have.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const dgram = require("dgram");
const path = require("path");
const { findChrome, chromeArgs, launch, openPage, stillOf, snapshots, evaluate } = require("../src/chrome");
const { available, readPixels, writePng } = require("../src/ffmpeg");
// Ends what the tests start and removes their temp folders: Chrome's too.
const { tmp } = require("./tmp");

const root = typeof process.getuid === "function" && process.getuid() === 0;

// Chrome's sandbox does not start as root; anyone else keeps it.
test("Chrome keeps its sandbox unless launch-film runs as root", () => {
  const saved = process.getuid;
  try {
    process.getuid = () => 1000;
    for (const network of [false, true]) assert.ok(!chromeArgs({ network, profile: "/p" }).includes("--no-sandbox"), `network ${network}`);
    process.getuid = () => 0;
    for (const network of [false, true]) assert.ok(chromeArgs({ network, profile: "/p" }).includes("--no-sandbox"), `network ${network}`);
  } finally {
    process.getuid = saved;
  }
});

// What Chrome says of itself on chrome://sandbox, for both browsers.
test("Chrome says it is sandboxed, in the browser that renders and in the one that reads a site", { skip: (!findChrome() && "Chrome not found") || (process.platform !== "linux" && "chrome://sandbox is Linux's") || (root && "Chrome's sandbox does not start as root") }, async () => {
  for (const network of [false, true]) {
    const browser = await launch({ W: 800, H: 600, network });
    try {
      const page = await browser.page();
      await page.call("Page.enable");
      await page.call("Page.navigate", { url: "chrome://sandbox" });
      let text = "";
      for (let i = 0; i < 100 && !/adequately sandboxed/.test(text); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        text = String(await evaluate(page, "document.body ? document.body.innerText : ''"));
      }
      assert.match(text, /You are adequately sandboxed/, `network ${network}: ${text.slice(0, 300)}`);
    } finally {
      browser.close();
    }
  }
});

// Chrome ends at once when it cannot start its sandbox, as in a container
// whose seccomp keeps it from making namespaces, by a signal (SIGABRT there,
// SIGTRAP elsewhere), and the run said no more than "Chrome was stopped by
// SIGABRT". Chrome says why on its stderr, which Node can read only after
// it has told of the exit.
test("a Chrome that cannot start its sandbox is told of as that, with what to do", { skip: process.platform === "win32" && "the stand-in Chrome is a shell script" }, async () => {
  const lines = {
    ABRT: "[14:14:1110/174151.699093:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:242] Zygote process exited prematurely with exit code 82 (setuid sandbox: failed to move to new namespaces)",
    TRAP: "[22:22:1110/180000.000000:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:132] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.",
  };
  const said = { ABRT: "Zygote process exited prematurely with exit code 82 (setuid sandbox: failed to move to new namespaces)", TRAP: "No usable sandbox" };
  const saved = process.env.LAUNCH_FILM_CHROME;
  try {
    for (const [signal, line] of Object.entries(lines)) {
      // Chrome writes the line as it ends, and a helper that holds its
      // stderr can write one once Chrome has gone.
      for (const write of [`echo '${line}' >&2`, `(while kill -0 $$ 2>/dev/null; do sleep 0.01; done; echo '${line}' >&2) &`]) {
        const chrome = path.join(tmp(), "chrome");
        fs.writeFileSync(chrome, `#!/bin/sh\n${write}\nkill -${signal} $$\n`, { mode: 0o755 });
        process.env.LAUNCH_FILM_CHROME = chrome;
        await assert.rejects(launch({ W: 800, H: 600 }), { message: `Chrome could not start its sandbox (${said[signal]}). Run launch-film where Chrome's sandbox can start: Google Chrome's own package sets it up, and a container needs --security-opt seccomp=unconfined` }, write);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CHROME;
    else process.env.LAUNCH_FILM_CHROME = saved;
  }
});

// A clip's page was opened from the disk in a Chrome let read every file of
// the machine's, and WebRTC sent UDP past the proxy that keeps the page
// offline: a script in a page could read the machine's files and send them
// out. Now a page gets the files of its own folder, served by launch-film,
// and nothing else.
test("a clip's page gets its own files and nothing else: no file of the machine's, no address and no UDP", { skip: !findChrome() && "Chrome not found" }, async () => {
  const dir = tmp();
  const secret = path.join(tmp(), "secret.txt");
  fs.writeFileSync(secret, "a file no page may read");
  fs.copyFileSync(path.join(__dirname, "fixtures", "acme", "logo-header.png"), path.join(dir, "pic.png"));
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    res.end("an address no page may reach");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const udp = dgram.createSocket("udp4");
  let packets = 0;
  udp.on("message", () => packets++);
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const tried = (what) => `${what}.then((r) => r.ok ? "read" : "refused " + r.status, (e) => "failed")`;
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><body><script>
    window.__tries = Promise.all([
      ${tried(`fetch("pic.png", { mode: "cors" })`)},
      ${tried(`fetch(${JSON.stringify(`file://${secret}`)})`)},
      ${tried(`fetch(${JSON.stringify(`..%2F${path.basename(path.dirname(secret))}%2Fsecret.txt`)})`)},
      ${tried(`fetch("http://127.0.0.1:${server.address().port}/")`)},
      new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("read"); i.onerror = () => resolve("failed"); i.src = ${JSON.stringify(`file://${path.join(dir, "pic.png")}`)}; }),
    ]);
    const rtc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udp.address().port}" }] });
    rtc.createDataChannel("x");
    rtc.createOffer().then((offer) => rtc.setLocalDescription(offer));
  </script></body></html>`);
  const browser = await launch({ W: 800, H: 600 });
  try {
    const { page } = await openPage(browser, dir, { W: 800, H: 600 });
    assert.deepEqual(await evaluate(page, "window.__tries"), ["read", "failed", "failed", "failed", "failed"]);
    // ICE asks a STUN server at once; two seconds is long past that.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(packets, 0, "UDP packets that reached the STUN server");
    assert.deepEqual(asked, []);
  } finally {
    browser.close();
    server.close();
    udp.close();
  }
});

// Neither browser may read the machine's files as a page from the disk can
// be let: the one that renders is given its files, and the one that reads a
// site has the site's.
test("no browser of launch-film's is let read files, and the one that renders sends no UDP past its proxy", () => {
  for (const network of [false, true]) assert.ok(!chromeArgs({ network, profile: "/p" }).includes("--allow-file-access-from-files"), `network ${network}`);
  assert.ok(chromeArgs({ network: false, profile: "/p" }).includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));
});

// A picture's own pixels, at x and y of a still: [r, g, b].
const at = (still, x, y) => [...still.data.subarray(4 * (y * still.width + x), 4 * (y * still.width + x) + 3)];
function stillPixels(png) {
  const file = path.join(tmp(), "still.png");
  fs.writeFileSync(file, png);
  return readPixels(file);
}

// The logo close draws its sheen through a CSS mask of the logo, which
// Chrome asks for as a file of the page's own: one it may not have is no
// mask, and nothing is drawn.
test("a page's CSS mask of its own picture is drawn", { skip: (!findChrome() && "Chrome not found") || (!available() && "ffmpeg not found") }, async () => {
  const dir = tmp();
  // A mask whose left half is clear and right half solid.
  const data = Buffer.alloc(40 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 20; x < 40; x++) data.writeUInt32BE(0xffffffff, 4 * (y * 40 + x));
  await writePng(path.join(dir, "mask.png"), { data, width: 40, height: 20 });
  const html = `<!doctype html><html><body style="margin:0;background:#000"><div style="width:400px;height:200px;background:#f00;-webkit-mask:url(mask.png) 0 0/100% 100%;mask:url(mask.png) 0 0/100% 100%"></div></body></html>`;
  const { png } = await stillOf({ html, files: { "mask.png": fs.readFileSync(path.join(dir, "mask.png")) }, W: 400, H: 200 });
  const still = stillPixels(png);
  assert.deepEqual(at(still, 100, 100), [0, 0, 0]);
  assert.deepEqual(at(still, 300, 100), [255, 0, 0]);
});

// Pages are served at addresses of their own: two pages with a file of one
// name, as each still's mark.png, each show their own, not the first one's
// from Chrome's cache.
test("two pages with a file of the same name each show their own", { skip: (!findChrome() && "Chrome not found") || (!available() && "ffmpeg not found") }, async () => {
  const dir = tmp();
  const colours = { red: [255, 0, 0], blue: [0, 0, 255] };
  const pages = [];
  for (const [name, rgb] of Object.entries(colours)) {
    const data = Buffer.alloc(8 * 8 * 4);
    for (let i = 0; i < 64; i++) data.set([...rgb, 255], 4 * i);
    await writePng(path.join(dir, `${name}.png`), { data, width: 8, height: 8 });
    pages.push({ html: `<!doctype html><html><body style="margin:0"><img src="mark.png" style="width:200px;height:200px;display:block"></body></html>`,
      files: { "mark.png": fs.readFileSync(path.join(dir, `${name}.png`)) }, W: 200, H: 200 });
  }
  const shots = await snapshots(pages);
  assert.deepEqual(shots.map((shot) => at(stillPixels(shot.png), 100, 100)), Object.values(colours));
});

// Each of a page's files goes to Chrome in one DevTools message. One past
// what Chrome takes in a message got no answer, and from then on Chrome
// answered nothing: the page waited out its 30 s load and the run said the
// machine was too busy.
test("a page file larger than Chrome takes in one go fails the page at once, by name", { skip: !findChrome() && "Chrome not found" }, async () => {
  const { PAGE_FILE_MAX } = require("../src/chrome");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><body><img src="pic.png"></body></html>');
  // 80 MB long, with nothing written in it: it takes no room on the disk.
  fs.writeFileSync(path.join(dir, "pic.png"), "");
  fs.truncateSync(path.join(dir, "pic.png"), 80 * 1024 * 1024);
  assert.ok(80 * 1024 * 1024 > PAGE_FILE_MAX);
  const browser = await launch({ W: 400, H: 300 });
  try {
    const started = Date.now();
    await assert.rejects(openPage(browser, dir, { W: 400, H: 300 }), { message: "the page's pic.png is 80 MB, more than the 64 MB Chrome is given in one file" });
    assert.ok(Date.now() - started < 20_000, `it took ${Date.now() - started} ms`);
    // Chrome still answers.
    assert.equal(await evaluate(await browser.page(), "1 + 1"), 2);
  } finally {
    browser.close();
  }
});

// A Chrome that answers every call, and when the page is opened asks for its
// index.html and refuses the file it is given, as Chrome does a fulfilment
// it cannot take.
function refusingChrome() {
  const file = path.join(tmp(), "chrome");
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require("fs");
const answer = (msg) => fs.writeSync(4, JSON.stringify(msg) + "\\0");
let buf = "";
fs.createReadStream("", { fd: 3 }).on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\0")) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i));
    if (msg.method === "Fetch.fulfillRequest") answer({ id: msg.id, error: { code: -32602, message: "Invalid parameters" } });
    else answer({ id: msg.id, result: msg.method === "Target.attachToTarget" ? { sessionId: "S" } : {} });
    if (msg.method === "Page.navigate") answer({ method: "Fetch.requestPaused", sessionId: "S", params: { requestId: "R", request: { url: msg.params.url } } });
    if (msg.method === "Browser.close") process.exit(0);
  }
});
setTimeout(() => process.exit(0), 60000);
`, { mode: 0o755 });
  return file;
}

test("a page file Chrome refuses fails the page at once, with Chrome's words", { skip: process.platform === "win32" && "the stand-in Chrome is a script" }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body></body></html>");
  const saved = process.env.LAUNCH_FILM_CHROME;
  process.env.LAUNCH_FILM_CHROME = refusingChrome();
  try {
    const browser = await launch({ W: 400, H: 300 });
    try {
      const started = Date.now();
      await assert.rejects(openPage(browser, dir, { W: 400, H: 300 }), { message: "Chrome did not take the page's index.html: Invalid parameters" });
      assert.ok(Date.now() - started < 20_000, `it took ${Date.now() - started} ms`);
    } finally {
      browser.close();
    }
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CHROME;
    else process.env.LAUNCH_FILM_CHROME = saved;
  }
});
