"use strict";
// What a page in launch-film's Chrome may reach: Chrome's sandbox, and the
// files and addresses each of its two browsers lets a page have.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { findChrome, chromeArgs, launch, evaluate } = require("../src/chrome");
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
