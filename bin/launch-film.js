#!/usr/bin/env node
"use strict";
// launch-film: a launch film from a website or an App Store page.

const fs = require("fs");
const path = require("path");
const { listen, within, shown, said, aftermath, noticed, stopping, exit, reason, save } = require("../src/out");

const HELP = `launch-film: a 20-40 second launch film made from a product's own site.

Usage:
  launch-film <url> [options]          Read the brand, plan the film, render it.
  launch-film plan <url> [options]     Read the brand and write film.json only.
  launch-film render <film.json>       Render a film.json (after editing it).
  launch-film frames <film.mp4>        Save stills of each clip and a contact sheet.
  launch-film check <film.mp4>         Check a render by measuring it: size, frame
                                       rate, length, black, still and silent
                                       stretches, loudness, peaks, cuts on the beat.
  launch-film stills <url|film.json>   Launch pictures at the sizes Product Hunt,
                                       link previews, X, Google Play and the
                                       Chrome Web Store ask for.
  launch-film looks                    List the looks.
  launch-film types                    List the scene types and their fields.
  launch-film icons <word>             Find icon names for a scene.
  launch-film doctor                   Check that Chrome and ffmpeg 4.4 or newer
                                       are found.

Options:
  --out <dir>          Folder for the brand, film.json and the film
                       (default: ./launch-film-<site>).
  --brand <path>       Use a kit you already have: an easybrandkit folder
                       or its brand.json.
  --words <file>       Use a words.json you already have instead of reading
                       the page again.
  --easybrandkit <cmd> The easybrandkit to run: a command, or the path of
                       its scripts/easybrandkit.js (default:
                       LAUNCH_FILM_EASYBRANDKIT, an easybrandkit on PATH,
                       else easybrandkit with npx).
                       Install it with npm install -g easybrandkit.
  --look <name>        launch, aurora, gridline, pop or journal (default: picked
                       from the brand).
  --seconds <n>        Aim for this length, 20-40 (default 30).
  --aspect <ratio>     16:9 (default) or 9:16.
  --jobs <n>           Clips rendered at once (default 2).
  --no-music           Plan the film without the music bed (plan, the
                       one-go command and stills <url>; a render plays what
                       "music" in film.json says). In film.json, "music" is
                       true (the look's bed), false (none), { "volume": 0.55 }
                       (the bed at another level) or the path of your own
                       track, from film.json's folder or absolute, at least
                       as long as the film.
  --no-sfx             Plan the film without the sound effects (a render
                       plays what "sfx" in film.json says).
  --keep               Keep the work files (each clip's MP4).

Check options (CHECK.md, check.json, sheet.png and wave.png go to --out,
default check/ next to the film; it exits with 1 when the film fails):
  --expect <WxH@fps>   The size and frame rate, like 1920x1080@30.
  --seconds <n>        The length: 30 (give or take half a second) or 28-32.
  --lufs <n>           The integrated loudness, like -14 (give or take 1 LU).
  --cues <file>        The music's cues.json, to check the cuts on the beat.
  --cuts <list|file>   The cuts in seconds (3.2,7.5) or a JSON file, when the
                       film has no timeline from launch-film.
  --allow <stretches>  Stretches meant to hold still, black or silent, in
                       seconds, like 27-30,0-0.5.

Stills options (the pictures and STILLS.md go to stills/ next to film.json):
  --for <targets>      Any of ph, og, x, play, chrome (default: all of them).

A run that fails or is stopped leaves the folder it writes to as it was.
Everything renders on this machine with Chrome and ffmpeg. No account or key.
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--version" || a === "-v") out.flags.version = true;
    else if (/^--no-/.test(a)) out.flags[a.slice(5)] = false;
    else if (a === "--keep") out.flags.keep = true;
    else if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=");
      out.flags[key] = inline !== undefined ? inline : argv[++i];
    } else out._.push(a);
  }
  return out;
}

const say = (text) => process.stderr.write(text);
// A command given wrong: said, and the process ends.
function fail(message) {
  // A stop ends the process by its own signal once it has cleaned up.
  if (stopping()) return;
  say(`launch-film: ${said(message)}\n`);
  // At once, or once the Chrome and ffmpeg still running have stopped.
  exit(1);
}
// A run that failed: said with what became of its folder. A Ctrl-C reaches
// ffmpeg or ffprobe as well, and one that ends them while launch-film waits
// on them fails the run before launch-film's own handler for the signal has
// run: that comes once the event loop polls again, so the failure waits that
// long and, when it was a stop, the stop is told of instead.
function failed(err) {
  const message = err && err.message ? err.message : String(err);
  setImmediate(() => setImmediate(() => {
    if (stopping()) return;
    // A failure that says itself what became of its folder is not told of
    // twice.
    const folders = aftermath().filter((f) => !message.includes(f));
    say(`launch-film: ${said(message)}\n${folders.length ? `launch-film: ${folders.join(" and ")}.\n` : ""}`);
    exit(1);
  }));
}
// A path as it is once the run that makes it has ended, from here.
const where = (file) => path.relative(process.cwd(), shown(file)) || shown(file);
const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};

function normaliseUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return /^[a-z0-9.-]+$/i.test(u.hostname) && u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}

// The film's folder: --out, else launch-film-<site> here.
function folderFor(url, flags) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return path.resolve(flags.out || `launch-film-${host.replace(/[^a-z0-9.-]/gi, "-")}`);
}

// Reads the brand and the page and plans the film, in the run's part
// folder: brand/, words.json and film.json take the place of the folder's
// own when the run ends well.
async function makePlan(url, flags, run) {
  const { runEasybrandkit, readBrand } = require("../src/brand");
  const { readWords } = require("../src/words");
  const { planFilm } = require("../src/plan");
  const { isStoreUrl, appStoreId, storeBrand } = require("../src/store");
  // A words.json given is read first, so a wrong one stops the run before
  // anything is fetched.
  let given = null;
  if (flags.words) {
    try {
      given = JSON.parse(fs.readFileSync(path.resolve(flags.words), "utf8"));
    } catch (err) {
      throw new Error(`--words ${flags.words}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
    }
  }
  // The film refers to the brand by a path from its own folder. A kit is
  // copied as plain files, its links followed, so this run never writes
  // where a link leads (a brand/ that links to a kit other films share).
  const local = run.folder("brand");
  const copy = (from) => {
    try {
      fs.cpSync(from, local, { recursive: true, dereference: true });
    } catch (err) {
      throw new Error(`copying the brand kit ${from} to ${local}: ${reason(err)}`);
    }
  };
  let brandFile;
  let storeWords = null;
  if (flags.brand) {
    brandFile = path.resolve(flags.brand);
    if (isDir(brandFile)) brandFile = path.join(brandFile, "brand.json");
    if (!fs.existsSync(brandFile)) throw new Error(`no brand.json at ${brandFile}`);
    copy(path.dirname(brandFile));
    brandFile = path.join(local, path.basename(brandFile));
  } else {
    // easybrandkit makes its kit again where an earlier one is, keeping the
    // files that are not a kit's: it works on a copy of the folder's own.
    if (isDir(path.join(run.dir, "brand"))) copy(path.join(run.dir, "brand"));
    if (isStoreUrl(url)) {
      // easybrandkit reads a store listing and the maker's site it names.
      // When it cannot, an App Store listing is read here from Apple's
      // lookup API.
      say(`Reading the store listing with easybrandkit...\n`);
      try {
        brandFile = await runEasybrandkit(url, local, { command: flags.easybrandkit, log: (t) => flags.verbose && say(t) });
        const kit = JSON.parse(fs.readFileSync(brandFile, "utf8"));
        const listing = (kit.stores || []).find((s) => s && /appstore|googleplay/i.test(String(s.type)) && s.ok !== false);
        if (!listing) throw new Error("easybrandkit read no store listing from it");
        kit.app = { name: listing.name || kit.name || "", by: listing.by || "", site: listing.site || "" };
        save(brandFile, JSON.stringify(kit, null, 2) + "\n");
      } catch (err) {
        if (!appStoreId(url)) throw err;
        say(`easybrandkit could not read the listing (${err.message.split(". ")[0]}); reading it from the App Store instead.\n`);
        fs.rmSync(local, { recursive: true, force: true });
        const made = await storeBrand(url, local, { runEasybrandkit: (u, d, o) => runEasybrandkit(u, d, { ...o, command: flags.easybrandkit }), log: say });
        brandFile = made.brandFile;
      }
    } else {
      say(`Reading the brand of ${url} with easybrandkit...\n`);
      brandFile = await runEasybrandkit(url, local, { command: flags.easybrandkit, log: (t) => flags.verbose && say(t) });
    }
  }
  const brand = readBrand(brandFile);
  // A kit made from an App Store page carries the listing's description.
  if (!storeWords && brand.app && brand.stores[0]) storeWords = require("../src/store").wordsFromListing({ name: brand.name, description: brand.stores[0].description });
  let words;
  if (flags.words) words = given;
  else if (storeWords) words = storeWords;
  else {
    say(`Reading the words on the page...\n`);
    words = await readWords(brand.url || url, { log: say });
  }
  save(run.out("words.json"), JSON.stringify(words, null, 2) + "\n");
  const seconds = Math.min(40, Math.max(20, Number(flags.seconds) || 30));
  const film = planFilm(brand, words, { look: flags.look, seconds, aspect: flags.aspect === "9:16" ? "9:16" : "16:9", filmDir: run.part });
  if (flags.music === false) film.music = false;
  if (flags.sfx === false) film.sfx = false;
  const filmFile = run.out("film.json");
  save(filmFile, JSON.stringify(film, null, 2) + "\n");
  for (const note of brand.notes) say(`note: ${note}\n`);
  say(`Planned ${film.clips.length} clips in the ${film.look} look: ${where(filmFile)}\n`);
  return { filmFile };
}

async function render(filmFile, flags) {
  const { renderFilm } = require("../src/film");
  const started = Date.now();
  const result = await renderFilm(filmFile, {
    output: flags.output || null,
    jobs: Math.max(1, Math.min(4, Number(flags.jobs) || 2)),
    keep: Boolean(flags.keep),
    log: say,
  });
  for (const note of result.notes) say(`note: ${shown(note)}\n`);
  say(`Rendered ${result.seconds.toFixed(1)} s in ${((Date.now() - started) / 1000).toFixed(0)} s: ${shown(result.output)}\n`);
  return result;
}

async function frames(file, flags) {
  const { saveFrames } = require("../src/frames");
  const r = await saveFrames(file, { out: flags.out });
  say(`Saved ${r.stills.length} stills and a contact sheet: ${shown(r.sheet)}\n`);
  return r;
}

async function main() {
  const { _: args, flags } = parseArgs(process.argv.slice(2));
  // Ctrl-C or a signal stops the run and leaves its folder as it was.
  listen();
  if (flags.version) {
    process.stdout.write(`${require("../package.json").version}\n`);
    return;
  }
  if (flags.help || !args.length) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...rest] = args;
  if (command === "looks") {
    const { LOOKS } = require("../src/motion");
    for (const [name, look] of Object.entries(LOOKS)) process.stdout.write(`${name.padEnd(9)} ${look.about}. Suits ${look.suits}.\n`);
    return;
  }
  if (command === "types") {
    const { catalog } = require("../src/scene");
    for (const t of catalog()) {
      const fields = [...t.fields, ...(t.items ? [`items (${t.items.count.join("-")}): ${Array.isArray(t.items.fields) ? t.items.fields.join(", ") : t.items.fields}`] : [])];
      process.stdout.write(`${t.type.padEnd(11)} ${t.about}${fields.length ? `\n${" ".repeat(12)}fields: ${fields.join("; ")}` : ""}\n`);
    }
    return;
  }
  if (command === "icons") {
    const { iconSearch } = require("../src/scene");
    process.stdout.write(`${iconSearch(rest[0] || "").join("\n")}\n`);
    return;
  }
  if (command === "doctor") {
    const { findChrome } = require("../src/chrome");
    const { available } = require("../src/ffmpeg");
    const chrome = findChrome();
    const ffmpeg = available();
    const node = Number(process.versions.node.split(".")[0]);
    // ffmpeg 4.3 has no scdet for check and frames, 4.2 no xfade for the
    // render. A version it does not say plainly (a build from git) passes.
    const v = /^n?(\d+)\.(\d+)/.exec(ffmpeg || "");
    const oldFfmpeg = Boolean(v) && Number(v[1]) * 100 + Number(v[2]) < 404;
    process.stdout.write(`node    ${process.versions.node}${node >= 22 ? "" : " (22 or newer is needed)"}\nchrome  ${chrome || "not found: install Chrome or set LAUNCH_FILM_CHROME"}\n` +
      `ffmpeg  ${ffmpeg ? `${ffmpeg}${oldFfmpeg ? " (4.4 or newer is needed)" : ""}` : "not found: install ffmpeg or set LAUNCH_FILM_FFMPEG"}\n`);
    if (!chrome || !ffmpeg || oldFfmpeg || node < 22) process.exitCode = 1;
    return;
  }
  if (command === "render") {
    if (!rest[0]) fail("give the film.json to render");
    await render(path.resolve(rest[0]), flags);
    return;
  }
  if (command === "frames") {
    if (!rest[0]) fail("give the film's MP4");
    await frames(path.resolve(rest[0]), flags);
    return;
  }
  if (command === "check") {
    if (!rest[0]) fail("give the film's MP4 to check");
    const { checkFilm } = require("../src/check");
    const r = await checkFilm(path.resolve(rest[0]), { out: flags.out, expect: flags.expect, seconds: flags.seconds, lufs: flags.lufs, cues: flags.cues, cuts: flags.cuts, allow: flags.allow });
    for (const c of r.checks.filter((x) => x.status === "fail" || x.status === "warn")) say(`  ${c.status.padEnd(5)} ${c.name}: ${c.found}${c.expected ? ` (asked for ${c.expected})` : ""}\n`);
    say(`${r.pass ? "PASS" : "FAIL"}${r.warnings.length ? `, ${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}` : ""}: ${where(path.join(r.dir, "CHECK.md"))}\n`);
    if (!r.pass) process.exitCode = 1;
    return;
  }
  if (command === "stills") {
    if (!rest[0]) fail("give the site's address or a film.json, e.g. launch-film stills example.com --for ph,og");
    const { makeStills, parseTargets } = require("../src/stills");
    parseTargets(flags.for);
    let r;
    if (/\.json$/i.test(rest[0])) {
      const filmFile = path.resolve(rest[0]);
      if (!fs.existsSync(filmFile)) fail(`${rest[0]} is not a file`);
      r = await makeStills(filmFile, { targets: flags.for, log: say });
    } else {
      const url = normaliseUrl(rest[0]);
      if (!url) fail(`"${rest[0]}" is not an address or a film.json`);
      // The plan and the stills are one run: both go in, or neither.
      r = await within(folderFor(url, flags), async (run) => {
        const { filmFile } = await makePlan(url, flags, run);
        return makeStills(filmFile, { targets: flags.for, log: say });
      });
    }
    for (const note of r.notes) say(`note: ${shown(note)}\n`);
    say(`Made ${r.files.length} stills: ${where(path.join(r.dir, "STILLS.md"))}\n`);
    return;
  }
  const isPlan = command === "plan";
  const url = normaliseUrl(isPlan ? rest[0] : command);
  if (!url) fail(isPlan ? "give the site's address, e.g. launch-film plan example.com" : `"${command}" is not a command or an address. Run launch-film --help.`);
  // The plan, the film and its frames are one run: all go in, or none.
  await within(folderFor(url, flags), async (run) => {
    const { filmFile } = await makePlan(url, flags, run);
    if (isPlan) return;
    const result = await render(filmFile, flags);
    await frames(result.output, { out: path.join(run.part, "frames") });
  });
}

// A run that ended well says last what it found left by runs killed
// outright.
main().then(() => {
  for (const note of noticed()) say(`note: ${note}\n`);
}, failed);
