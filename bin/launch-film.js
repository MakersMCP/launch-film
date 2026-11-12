#!/usr/bin/env node
"use strict";
// launch-film: a launch film from a website or an App Store page.

const fs = require("fs");
const path = require("path");
const { listen, within, heldBackIn, shown, said, aftermath, noticed, stopping, exit, reason, save, copyPlain } = require("../src/out");

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
  launch-film doctor                   Check that Chrome starts and that ffmpeg
                                       and ffprobe 4.4 or newer are found.

Options:
  --out <dir>          Folder for the brand, film.json and the film
                       (default: ./launch-film-<site>). With frames, the
                       folder for the stills (default: frames/ next to the
                       film).
  --brand <path>       Use a kit you already have: an easybrandkit folder
                       or its brand.json.
  --words <file>       Use a words.json you already have instead of reading
                       the page again.
  --easybrandkit <cmd> The easybrandkit to run: a command, or the path of
                       its skills/easybrandkit/scripts/easybrandkit.js
                       (default: LAUNCH_FILM_EASYBRANDKIT, an easybrandkit on
                       PATH, else easybrandkit with npx).
                       Install it with npm install -g easybrandkit.
  --look <name>        launch, aurora, gridline, pop or journal (default: picked
                       from the brand).
  --seconds <n>        Aim for this length, 20-40 (default 30).
  --aspect <ratio>     16:9 (default) or 9:16.
  --jobs <n>           Clips rendered at once, 1 to 4 (default 2).
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
  --verbose            Also print what easybrandkit says as it works (plan,
                       the one-go command and stills <url>).
  --output <file>      Where render writes the film (default: film.mp4 next
                       to film.json).

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
Set LAUNCH_FILM_CONFINE=1 when others give launch-film their film.json,
brand.json, kit or film: each may then name only files in its own folder,
none of them a list of other files for ffmpeg to open, such as an HLS
playlist, a kit may hold no link out of it, and check and frames refuse a
film that is such a list.
Everything renders on this machine with Chrome and ffmpeg. No account or key.
`;

// The options each command takes, as they are written. Any other is refused
// by name: an option dropped without a word reads as one that worked.
const PLANS = ["out", "brand", "words", "easybrandkit", "look", "seconds", "aspect", "no-music", "no-sfx", "verbose"];
const OPTIONS = {
  "<url>": [...PLANS, "jobs", "keep"],
  plan: PLANS,
  render: ["jobs", "keep", "output"],
  frames: ["out"],
  check: ["out", "expect", "seconds", "lufs", "cues", "cuts", "allow"],
  stills: ["for", ...PLANS],
  // Of a film.json: the plan is made already. makersmcp gives every stills
  // call its easybrandkit.
  "stills <film.json>": ["for", "easybrandkit"],
  looks: [],
  types: [],
  icons: [],
  doctor: [],
};
const SWITCHES = new Set(["keep", "verbose"]);
// What each command reads besides its options. An argument past that is
// refused by name, as an option it does not take is. The address of the
// one-go command stands where a command's name would.
const ARGUMENTS = { "<url>": "one address", plan: "one address", render: "one film.json", frames: "one film", check: "one film", stills: "one address or film.json",
  "stills <film.json>": "one address or film.json", looks: "no arguments", types: "no arguments", icons: "one word", doctor: "no arguments" };

// given holds the options as they are written, bare the options that take a
// value and came without one, valued the switches given one with =.
function parseArgs(argv) {
  const out = { _: [], flags: {}, given: [], bare: [], valued: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--version" || a === "-v") out.flags.version = true;
    else if (/^--no-/.test(a)) {
      out.flags[a.slice(5)] = false;
      out.given.push(a);
    } else if (a.startsWith("--")) {
      // The value is all that follows the first =: a folder's name can
      // hold one. Without an =, the next word is the value unless it is
      // written as an option; one with a single dash is a value (--lufs -14).
      const eq = a.indexOf("=");
      const key = a.slice(2, eq < 0 ? undefined : eq);
      out.given.push(`--${key}`);
      if (SWITCHES.has(key)) {
        out.flags[key] = true;
        if (eq >= 0) out.valued.push(key);
      } else {
        const value = eq >= 0 ? a.slice(eq + 1) : String(argv[i + 1] || "").startsWith("--") ? "" : argv[++i];
        if (value) out.flags[key] = value;
        else out.bare.push(key);
      }
    } else if (a.startsWith("-")) out.given.push(a);
    else out._.push(a);
  }
  return out;
}

// A list as it is said: "a, b and c".
const listed = (items) => `${items.slice(0, -1).join(", ")}${items.length > 1 ? " and " : ""}${items[items.length - 1]}`;

// Why an option is not one of `command`'s, or null when all of them are.
function notTaken(given, command) {
  const key = given.find((k) => !OPTIONS[command].includes(k.replace(/^--/, "")));
  if (key === undefined) return null;
  if (key === "--music") return '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute';
  if (key === "--no-music" || key === "--no-sfx") return `${key} is for a plan: a render plays what "${key.slice(5)}" in film.json says. Set it to false there and render again`;
  return `${key} is not an option of launch-film ${command}, which takes ${OPTIONS[command].length ? listed(OPTIONS[command].map((k) => `--${k}`)) : "no options"}.`;
}

// Why a value given to one of `command`'s options cannot be used, or null:
// put right without a word (an --aspect of 4:3 planned 16:9), it read as if
// it had been used. The --seconds of check is a length to check against,
// read there.
function unusable(flags, command) {
  const takes = (key) => flags[key] !== undefined && OPTIONS[command].includes(key);
  if (takes("aspect") && !["16:9", "9:16"].includes(flags.aspect)) return `--aspect "${flags.aspect}": choose 16:9 or 9:16`;
  if (takes("seconds") && command !== "check" && !(/^\d+(?:\.\d+)?$/.test(flags.seconds) && flags.seconds >= 20 && flags.seconds <= 40)) {
    return `--seconds "${flags.seconds}": give a length from 20 to 40 seconds, such as 30`;
  }
  if (takes("jobs") && !/^[1-4]$/.test(flags.jobs)) return `--jobs "${flags.jobs}": give a whole number from 1 to 4`;
  return null;
}

// The programs a command runs, looked at before any work (programs.js): one
// that cannot be started stops it there, named with what is wrong with it. A
// plan alone starts launch-film's Chrome only to read the page's words when
// its HTML lacks them, and goes on with the HTML's words when that Chrome
// cannot start (words.js), so it looks at that Chrome only then; easybrandkit
// looks at its own. It runs ffmpeg and ffprobe only for a store's address,
// when easybrandkit could not read the listing's pictures.
function programsOf(takes, address) {
  if (["<url>", "render", "stills", "stills <film.json>"].includes(takes)) return ["ffmpeg", "ffprobe", "chrome"];
  if (takes === "check" || takes === "frames") return ["ffmpeg", "ffprobe"];
  if (takes !== "plan") return [];
  const { isStoreUrl } = require("../src/store");
  return address && isStoreUrl(address) ? ["ffmpeg", "ffprobe"] : [];
}

// Why an argument past the ones a command reads is refused, or null. A first
// word that is neither a command nor an address is told of as that, below.
function oneTooMany(command, takes, rest) {
  const extra = rest[takes === "<url>" || ARGUMENTS[takes] === "no arguments" ? 0 : 1];
  if (extra === undefined || (takes === "<url>" && !normaliseUrl(command))) return null;
  return `launch-film ${takes} takes ${ARGUMENTS[takes]}, so "${extra}" would not be read.`;
}

const say = (text) => process.stderr.write(text);
// A message as the line that says it: after "launch-film: ", unless it names
// launch-film itself first, as "launch-film needs ffmpeg, and ..." does.
const lineOf = (text) => `${/^launch-film /.test(text) ? "" : "launch-film: "}${text}\n`;
// A command given wrong: said, and the process ends.
function fail(message) {
  // A stop ends the process by its own signal once it has cleaned up.
  if (stopping()) return;
  say(lineOf(said(message)));
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
    say(`${lineOf(err && err.ownWords ? shown(message) : said(message))}${folders.length ? `launch-film: ${folders.join(" and ")}.\n` : ""}`);
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

// What a plan is given, read before anything else, the programs it runs
// too: the words.json of --words, and the brand.json of the kit --brand
// names. A wrong one refuses the plan before anything is fetched or started.
// So does a plan without --brand into a folder whose brand/ holds files and
// no brand.json at all: easybrandkit, which makes its kit again in the run's
// copy of brand/ (makePlan), makes none in a folder of files that are not a
// kit's, and every release of it refuses one. A brand/ that is a link is
// left to makePlan, and so is a plan of an App Store page, which is read
// from the store when easybrandkit cannot read it. An earlier file of the
// folder's that the run would not replace, among `outputs`, refuses it too,
// before the site is read (out.js heldBack).
function planArgs(flags, url, outputs) {
  if (!flags.brand && !require("../src/store").appStoreId(url)) {
    const own = path.join(folderFor(url, flags), "brand");
    let names = [];
    try {
      if (!fs.lstatSync(own).isSymbolicLink()) names = fs.readdirSync(own);
    } catch {
      // No brand/ there, or one that makePlan tells of.
    }
    if (names.some((name) => !name.startsWith(".")) && !names.includes("brand.json")) {
      throw new Error(`${own} is not empty and holds no earlier brand kit, which a plan has easybrandkit make there: give a kit with --brand, move the files in it elsewhere, or pick another folder with --out`);
    }
  }
  const held = heldBackIn(folderFor(url, flags), outputs);
  if (held) throw new Error(held);
  let words = null;
  if (flags.words) {
    try {
      words = JSON.parse(fs.readFileSync(path.resolve(flags.words), "utf8"));
    } catch (err) {
      throw new Error(`--words ${flags.words}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
    }
  }
  let brandFile = null;
  if (flags.brand) {
    brandFile = path.resolve(flags.brand);
    if (isDir(brandFile)) brandFile = path.join(brandFile, "brand.json");
    if (!fs.existsSync(brandFile)) throw new Error(`no brand.json at ${brandFile}`);
  }
  return { words, brandFile };
}

// Reads the brand and the page and plans the film, in the run's part
// folder: brand/, words.json and film.json take the place of the folder's
// own when the run ends well. `inputs` is what planArgs read.
async function makePlan(url, flags, run, inputs) {
  const { runEasybrandkit, readBrand } = require("../src/brand");
  const { readWords, webPage } = require("../src/words");
  const { planFilm } = require("../src/plan");
  const { isStoreUrl, appStoreId, storeBrand } = require("../src/store");
  // The film refers to the brand by a path from its own folder. A kit is
  // copied as plain files, every link in it followed, so nothing this run
  // does to the copy reaches where a link leads (a brand/ that links to a
  // kit other films share, or a kit with a link in it). With
  // LAUNCH_FILM_CONFINE set, a link may lead only to a file in the kit, as
  // a brand.json may name only those: the copy would make what it leads to
  // the kit's own.
  const confine = require("../src/confine");
  const held = confine.confined();
  const local = run.folder("brand");
  const copy = (from) => {
    try {
      copyPlain(from, local, { held });
    } catch (err) {
      if (err.held) throw new Error(`${path.join(from, err.held)} leads out of the kit's folder through a link, and LAUNCH_FILM_CONFINE allows only files in it`);
      throw new Error(`copying the brand kit ${from} to ${local}: ${reason(err)}`);
    }
  };
  let brandFile;
  let storeWords = null;
  if (inputs.brandFile) {
    copy(path.dirname(inputs.brandFile));
    brandFile = path.join(local, path.basename(inputs.brandFile));
  } else {
    // easybrandkit makes its kit again where an earlier one is, keeping the
    // files that are not a kit's: it works on a copy of the folder's own,
    // which with LAUNCH_FILM_CONFINE set may not be a link out of the folder,
    // as film.json's brand may not.
    const own = path.join(run.dir, "brand");
    if (isDir(own)) {
      const out = held && confine.outside(run.dir, "brand", "the film");
      if (out) throw new Error(`${own} ${out}, and LAUNCH_FILM_CONFINE allows only files in it`);
      copy(own);
    }
    if (isStoreUrl(url)) {
      // easybrandkit reads a store listing and the maker's site it names.
      // When it cannot, an App Store listing is read here from Apple's
      // lookup API.
      say(`Reading the store listing with easybrandkit...\n`);
      try {
        brandFile = await runEasybrandkit(url, local, { command: flags.easybrandkit, log: (t) => flags.verbose && say(shown(t)) });
        const kit = JSON.parse(fs.readFileSync(brandFile, "utf8"));
        const listing = (kit.stores || []).find((s) => s && /appstore|googleplay/i.test(String(s.type)) && s.ok !== false);
        if (!listing) throw new Error("easybrandkit read no store listing from it");
        kit.app = { name: listing.name || kit.name || "", by: listing.by || "", site: listing.site || "" };
        save(brandFile, JSON.stringify(kit, null, 2) + "\n");
      } catch (err) {
        if (!appStoreId(url)) throw err;
        say(`easybrandkit could not read the listing (${shown(err.message.split(". ")[0])}); reading it from the App Store instead.\n`);
        fs.rmSync(local, { recursive: true, force: true });
        const made = await storeBrand(url, local, { runEasybrandkit: (u, d, o) => runEasybrandkit(u, d, { ...o, command: flags.easybrandkit }), log: say });
        brandFile = made.brandFile;
      }
    } else {
      say(`Reading the brand of ${url} with easybrandkit...\n`);
      brandFile = await runEasybrandkit(url, local, { command: flags.easybrandkit, log: (t) => flags.verbose && say(shown(t)) });
    }
  }
  const brand = readBrand(brandFile);
  // A kit made from an App Store page carries the listing's description.
  if (!storeWords && brand.app && brand.stores[0]) storeWords = require("../src/store").wordsFromListing({ name: brand.name, description: brand.stores[0].description });
  let words;
  if (flags.words) words = inputs.words;
  else if (storeWords) words = storeWords;
  else {
    // The page is the kit's own address, else the one given. A kit whose
    // address is not a web page's (a file: one, which Chrome would open with
    // this machine's files in reach) is refused as the kit's.
    if (brand.url && !webPage(brand.url)) {
      throw new Error(`${path.basename(brandFile)} gives the site's address as "${brand.url.length > 120 ? `${brand.url.slice(0, 120)}...` : brand.url}", which is not an http or https address: give a kit made from the site, or the page's words with --words`);
    }
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
  // An address no page shows that a page of the site asked for, which
  // Chrome would hand to a program of the machine: on Linux the stand-ins
  // kept it from that (chrome.js), here and in easybrandkit's Chrome.
  // The first few, and how many more times one was asked for.
  const { opened } = require("../src/chrome");
  const { list, more } = opened();
  const linux = process.platform === "linux";
  const tried = list.map((a) => `The page tried to open ${a.length > 120 ? `${a.slice(0, 120)}...` : a}, which is not a web address: ` +
    `${linux ? "it was not opened." : "Chrome hands such an address to the system, which may have opened a program for it."}`);
  if (more) tried.push(`The page tried to open such an address ${more} more time${more > 1 ? "s" : ""}: ${linux ? "none was opened." : "Chrome hands each to the system, which may have opened a program for it."}`);
  for (const note of [...brand.notes, ...tried]) say(`note: ${note}\n`);
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
  const { _: args, flags, given, bare, valued } = parseArgs(process.argv.slice(2));
  // Ctrl-C or a signal stops the run and leaves its folder as it was.
  listen();
  // A reader that stops reading, as head does once it has its lines, leaves
  // nothing to write to: the command ends as it would have, without a word,
  // where the write that failed ended it in Node's stack trace.
  process.stdout.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
    exit(process.exitCode || 0);
  });
  if (flags.version) {
    process.stdout.write(`${require("../package.json").version}\n`);
    return;
  }
  if (flags.help || (!args.length && !given.some((k) => !k.startsWith("--")))) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...rest] = args;
  const takes = command === "stills" && /\.json$/i.test(rest[0] || "") ? "stills <film.json>" : Object.hasOwn(OPTIONS, command) ? command : "<url>";
  // What a command would not read is refused before anything runs: dropped
  // without a word, it reads as if it had been done.
  const refused = notTaken(given, takes) || (bare.length ? `--${bare[0]} needs a value` : null) ||
    (valued.length ? `--${valued[0]} takes no value: give it alone, or leave it out` : null) || oneTooMany(command, takes, rest);
  if (refused) return fail(refused);
  if (flags.look !== undefined && OPTIONS[takes].includes("look")) {
    const { LOOKS } = require("../src/motion");
    if (!Object.hasOwn(LOOKS, flags.look)) return fail(`--look "${flags.look}": choose from ${Object.keys(LOOKS).join(", ")}`);
  }
  const unfit = unusable(flags, takes);
  if (unfit) return fail(unfit);
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
    const { launch, evaluate } = require("../src/chrome");
    const { check } = require("../src/programs");
    const [chrome, ffmpeg, ffprobe] = ["chrome", "ffmpeg", "ffprobe"].map(check);
    const node = Number(process.versions.node.split(".")[0]);
    // ffmpeg 4.3 has no scdet for check and frames, 4.2 no xfade for the
    // render. A version it does not say plainly (a build from git) passes.
    const version = (c) => (/^\S+ version (\S+)/.exec(c.version || "") || [])[1] || "unknown";
    const old = (c) => {
      const v = /^n?(\d+)\.(\d+)/.exec(version(c));
      return Boolean(v) && Number(v[1]) * 100 + Number(v[2]) < 404;
    };
    // Chrome is started as a render starts it, and a page in it runs a
    // script: one that is there but cannot start its sandbox, as in a
    // container whose seccomp keeps it from making namespaces, passed here
    // and failed every render.
    let unstarted = null;
    if (!chrome.problem) {
      try {
        const browser = await launch({ W: 320, H: 240 });
        try {
          await evaluate(await browser.page(), "1 + 1");
        } finally {
          browser.close();
        }
      } catch (err) {
        unstarted = err.message;
      }
    }
    // Each program on its line: its version, or what is wrong with it.
    const line = (c) => (c.problem ? c.detail : `${version(c)}${old(c) ? " (4.4 or newer is needed)" : ""}`);
    process.stdout.write(`node    ${process.versions.node}${node >= 22 ? "" : " (22 or newer is needed)"}\n` +
      `chrome  ${chrome.problem ? chrome.detail : `${chrome.file}${unstarted ? `: ${unstarted}` : ""}`}\n` +
      `ffmpeg  ${line(ffmpeg)}\n` +
      `ffprobe ${line(ffprobe)}\n`);
    if (chrome.problem || unstarted || ffmpeg.problem || old(ffmpeg) || ffprobe.problem || old(ffprobe) || node < 22) process.exitCode = 1;
    return;
  }
  // The programs the command runs can be started (programs.js), looked at
  // once what the command was given has been: a command given wrong is told
  // so first. A Ctrl-C that ended one as it was asked its version is told of
  // as the stop (failed). A plan that may start a Chrome, easybrandkit's or
  // its own for the page's words, as it may unless it is given both --brand
  // and --words, tries the stand-ins that Chrome gets first (chrome.js): on
  // a temp folder where they cannot run, it stops here, not as it starts one.
  const ready = (address = null) => {
    const program = require("../src/programs").unstartable(programsOf(takes, address));
    if (program) throw new Error(program);
    if (address && !(flags.brand && flags.words)) require("../src/chrome").standIns();
  };
  if (command === "render") {
    if (!rest[0]) return fail("give the film.json to render");
    ready();
    await render(path.resolve(rest[0]), flags);
    return;
  }
  if (command === "frames") {
    if (!rest[0]) return fail("give the film's MP4");
    ready();
    await frames(path.resolve(rest[0]), flags);
    return;
  }
  if (command === "check") {
    if (!rest[0]) return fail("give the film's MP4 to check");
    ready();
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
      if (!fs.existsSync(filmFile)) return fail(`${rest[0]} is not a file`);
      ready();
      r = await makeStills(filmFile, { targets: flags.for, log: say });
    } else {
      const url = normaliseUrl(rest[0]);
      if (!url) return fail(`"${rest[0]}" is not an address or a film.json`);
      const inputs = planArgs(flags, url, ["words.json", "film.json"]);
      ready(url);
      // The plan and the stills are one run: both go in, or neither.
      r = await within(folderFor(url, flags), async (run) => {
        const { filmFile } = await makePlan(url, flags, run, inputs);
        return makeStills(filmFile, { targets: flags.for, log: say });
      });
    }
    for (const note of r.notes) say(`note: ${shown(note)}\n`);
    say(`Made ${r.files.length} stills: ${where(path.join(r.dir, "STILLS.md"))}\n`);
    return;
  }
  const isPlan = command === "plan";
  const url = normaliseUrl(isPlan ? rest[0] : command);
  if (!url) return fail(isPlan ? "give the site's address, e.g. launch-film plan example.com" : `"${command}" is not a command or an address. Run launch-film --help.`);
  const inputs = planArgs(flags, url, ["words.json", "film.json", ...(isPlan ? [] : ["film.mp4", "film.timeline.json"])]);
  ready(url);
  // The plan, the film and its frames are one run: all go in, or none.
  await within(folderFor(url, flags), async (run) => {
    const { filmFile } = await makePlan(url, flags, run, inputs);
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
