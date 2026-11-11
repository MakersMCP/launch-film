"use strict";
// ─── the words ─────────────────────────────────────────────────────────────
// A film made without a brief takes its words from the product's own page:
// its title and description, its headline, the headings of its sections with
// the line under each, and the numbers it is proud of. They are read from
// the page's HTML; a page that builds its text in the browser is read in
// Chrome instead.

const { launch, evaluate } = require("./chrome");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", middot: "\u00b7", bull: "\u2022", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", times: "\u00d7" };
function decode(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
const textOf = (html) => decode(String(html).replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
  .replace(/\s+/g, " ").trim();
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : "";
};

// The words a page's HTML holds. The order of headings and paragraphs is the
// page's, so a section's heading is followed by its own line.
function fromHtml(html) {
  const out = { lang: "", title: "", description: "", siteName: "", ogTitle: "", ogDescription: "", headings: [], ctas: [], paragraphs: [], jsonld: [] };
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) out.lang = attr(htmlTag[0], "lang").slice(0, 2).toLowerCase();
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) out.title = textOf(title[1]);
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(m[0], "property") || attr(m[0], "name")).toLowerCase();
    const content = attr(m[0], "content").replace(/\s+/g, " ").trim();
    if (!content) continue;
    if (key === "description" && !out.description) out.description = content;
    else if ((key === "og:description" || key === "twitter:description") && !out.ogDescription) out.ogDescription = content;
    else if ((key === "og:title" || key === "twitter:title") && !out.ogTitle) out.ogTitle = content;
    else if (key === "og:site_name" && !out.siteName) out.siteName = content;
  }
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      for (const item of [data, ...(Array.isArray(data) ? data : []), ...((data && data["@graph"]) || [])]) {
        if (item && typeof item === "object" && !Array.isArray(item)) out.jsonld.push({ name: item.name || "", description: item.description || "", slogan: item.slogan || "" });
      }
    } catch {
      // Not JSON.
    }
  }
  const body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  for (const m of body.matchAll(/<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = textOf(m[2]);
    if (!text) continue;
    const tag = m[1].toLowerCase();
    if (tag === "p") out.paragraphs.push(text);
    else out.headings.push({ level: Number(tag[1]), text, after: "" });
    // The first paragraph after a heading is its line.
    if (tag === "p" && out.headings.length) {
      const last = out.headings[out.headings.length - 1];
      if (!last.after) last.after = text;
    }
  }
  for (const m of body.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const cls = attr(`<x ${m[2]}>`, "class");
    if (m[1].toLowerCase() === "a" && !/btn|button|cta|primary/i.test(cls)) continue;
    const text = textOf(m[3]);
    if (text && text.length <= 30 && !out.ctas.includes(text)) out.ctas.push(text);
  }
  return out;
}

// The same read in Chrome, from the page as it shows: only visible text.
const IN_PAGE = String.raw`(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const meta = (k) => { const m = document.querySelector('meta[property="' + k + '"],meta[name="' + k + '"]'); return m ? clean(m.content) : ""; };
  const out = { lang: (document.documentElement.lang || "").slice(0, 2).toLowerCase(), title: clean(document.title), description: meta("description"), siteName: meta("og:site_name"),
    ogTitle: meta("og:title") || meta("twitter:title"), ogDescription: meta("og:description") || meta("twitter:description"), headings: [], ctas: [], paragraphs: [], jsonld: [] };
  const inChrome = (el) => el.closest("nav,footer,header [role=navigation],dialog,[aria-modal=true]");
  for (const el of document.querySelectorAll("h1,h2,h3,h4,p")) {
    if (!seen(el) || inChrome(el)) continue;
    const text = clean(el.innerText);
    if (!text) continue;
    if (el.tagName === "P") {
      out.paragraphs.push(text);
      const last = out.headings[out.headings.length - 1];
      if (last && !last.after) last.after = text;
    } else out.headings.push({ level: Number(el.tagName[1]), text, after: "" });
  }
  for (const el of document.querySelectorAll("a,button")) {
    if (!seen(el) || inChrome(el)) continue;
    const cls = String(el.className || "");
    const s = getComputedStyle(el);
    const filled = s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    if (el.tagName === "A" && !/btn|button|cta|primary/i.test(cls) && !filled) continue;
    const text = clean(el.innerText);
    if (text && text.length <= 30 && !out.ctas.includes(text)) out.ctas.push(text);
  }
  return out;
})()`;

// Whether an address is a web page's, http or https. Only such a page is
// read: Chrome opens an address of another kind as well, a file of this
// machine's (file:) among them, and its scripts can read the machine's
// files from there.
function webPage(address) {
  try {
    return ["http:", "https:"].includes(new URL(String(address)).protocol);
  } catch {
    return false;
  }
}

// A page Chrome cannot open is shown as Chrome's own error page, whose words
// are Chrome's ("Press space to play" offline), so it is a page not read:
// one whose address failed, and one that went on to an address that failed.
// A page that went on to an address that is no web page's (about:blank) is
// not read either: its words are not the page's.
//
// The Chrome is looked at first, as a command looks at the programs it runs
// before any work (programs.js): one that cannot be started is told of in
// those words, and the plan goes on with the words of the page's HTML, as it
// does when no Chrome is found.
async function fromChrome(url) {
  const unread = (why) => Object.assign(new Error(why), { unread: true });
  if (!webPage(url)) throw unread("it is not an http or https address");
  const chrome = require("./programs").check("chrome");
  if (chrome.problem) throw new Error(chrome.problem);
  const browser = await launch({ W: 1440, H: 900, network: true });
  try {
    const page = await browser.page();
    await page.call("Page.enable");
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => {
      const on = (msg) => {
        if (msg.sessionId === page.sessionId && msg.method === "Page.loadEventFired") {
          browser.off(on);
          resolve(true);
        }
      };
      browser.on(on);
      setTimeout(() => resolve(false), 30_000).unref();
    });
    const { errorText } = await page.call("Page.navigate", { url });
    if (errorText) throw unread(errorText);
    await loaded;
    // Pages that fetch their text after load get a moment more.
    await new Promise((r) => setTimeout(r, 2500));
    // The address and the words in one go, so the words are of the page
    // whose address passed.
    const seen = await evaluate(page, `({ at: document.URL, words: ${IN_PAGE} })`);
    const at = String(seen.at);
    if (/^chrome-error:/.test(at)) throw unread("it led to an address that could not be opened");
    if (!webPage(at)) throw unread(`it went on to ${at.length > 80 ? `${at.slice(0, 80)}...` : at}, which is not a web page`);
    return seen.words;
  } finally {
    browser.close();
  }
}

// The page's words: from its HTML, or from Chrome when the HTML has no
// headline. A page neither of them could read stops the plan, which went on
// with no words of the page's, or with those of Chrome's error page. An
// address that is not a web page's is refused before either is tried.
async function readWords(url, { log = () => {} } = {}) {
  if (!webPage(url)) throw new Error(`the page ${url} could not be read (it is not an http or https address): give the site's address, or a words.json with --words`);
  let words = null;
  // Why the page was not read: what Chrome said of an address it could not
  // open, else what the fetch said.
  let why = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept-Language": "en;q=0.9,*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const type = res.headers.get("content-type") || "";
    if (res.ok && /html/i.test(type)) words = fromHtml(await res.text());
    else why = res.ok ? `${type || "a file of no type"}, not HTML` : `HTTP ${res.status}`;
  } catch (err) {
    // Node says "fetch failed", and why in its cause.
    why = (err.cause && err.cause.message) || err.message;
    log(`The page could not be fetched (${why}); reading it in Chrome.\n`);
  }
  const enough = (w) => w && w.headings.some((h) => h.level === 1) && w.headings.length >= 3;
  if (!enough(words)) {
    try {
      const seen = await fromChrome(url);
      if (seen && (!words || seen.headings.length > words.headings.length)) words = { ...(words || {}), ...seen, jsonld: (words && words.jsonld) || [] };
    } catch (err) {
      if (err.unread) why = err.message;
      log(`Chrome could not read the page (${err.message.replace(/\.$/, "")}).\n`);
    }
  }
  if (!words) throw new Error(`the page ${url} could not be read (${why}): check the address and the network, or give a words.json with --words`);
  return words;
}

module.exports = { readWords, fromChrome, fromHtml, decode, webPage };
