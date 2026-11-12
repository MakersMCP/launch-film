"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { once } = require("events");
const { spawnSync } = require("child_process");
const { readBrand, pickLook } = require("../src/brand");
const { planFilm, copyFrom, markEnd, findNumber, withoutName, fit } = require("../src/plan");
const { loadFilm, checkMusic, shellWord, musicfitCommand, trackNote } = require("../src/film");
const { MOODS, Bus, SR, writeWav } = require("../src/audio");
const { available } = require("../src/ffmpeg");
const { tmp } = require("./tmp");

const fixture = path.join(__dirname, "fixtures", "acme");
const words = JSON.parse(fs.readFileSync(path.join(fixture, "words.json"), "utf8"));

test("brand.json is read with absolute paths and its colours sorted out", () => {
  const brand = readBrand(path.join(fixture, "brand.json"));
  assert.equal(brand.name, "Acme Notes");
  assert.equal(brand.host, "acme-notes.example");
  assert.equal(brand.accent, "#5B4FE9");
  assert.equal(brand.darkSite, false);
  assert.equal(brand.headingFont, "Inter");
  assert.ok(path.isAbsolute(brand.logos[0].file) && fs.existsSync(brand.logos[0].file));
  assert.equal(brand.phoneScreens.length, 1);
  assert.ok(brand.appIcon);
});

test("the copy comes from the page's own words", () => {
  const brand = readBrand(path.join(fixture, "brand.json"));
  const copy = copyFrom(brand, words);
  assert.equal(copy.name, "Acme Notes");
  assert.equal(copy.promise, "Notes that think with you");
  assert.equal(copy.statement, "Write once and find it anywhere");
  assert.deepEqual(copy.features.map((f) => f.title), ["Instant search", "Private by design", "Shared spaces"]);
  assert.deepEqual(copy.features.map((f) => f.icon), ["lightning", "shield-check", "users-three"]);
  assert.deepEqual(copy.stat, { value: "12,000+", text: "teams worldwide" });
});

test("the plan is whole bars of the look's music and 20-40 s long", () => {
  const brand = readBrand(path.join(fixture, "brand.json"));
  for (const look of ["launch", "aurora", "gridline", "pop", "journal"]) {
    const film = planFilm(brand, words, { look, filmDir: fixture });
    const bar = 240 / MOODS[look].bpm;
    const seconds = film.clips.reduce((s, c) => s + c.bars * bar, 0);
    assert.ok(seconds >= 20 && seconds <= 42, `${look}: ${seconds}`);
    assert.equal(film.clips[0].scene.type, "opener");
    assert.equal(film.clips[film.clips.length - 1].kind, "logo");
    assert.ok(film.clips.some((c) => c.kind === "screen"));
  }
});

test("a planned film.json loads without problems", () => {
  const brand = readBrand(path.join(fixture, "brand.json"));
  const film = planFilm(brand, words, { filmDir: fixture });
  const file = path.join(fixture, ".film-test.json");
  fs.writeFileSync(file, JSON.stringify(film));
  try {
    const loaded = loadFilm(file);
    assert.deepEqual(loaded.problems, []);
    assert.equal(loaded.clips.length, film.clips.length);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a broken film.json says what is wrong", () => {
  const file = path.join(fixture, ".film-bad.json");
  fs.writeFileSync(file, JSON.stringify({ look: "neon", clips: [{ kind: "scene", scene: { type: "headline" } }, { kind: "screen", image: "nope.png" }] }));
  try {
    const { problems } = loadFilm(file);
    assert.match(problems.join("\n"), /"look" must be one of/);
    assert.match(problems.join("\n"), /clips\[1\]\.image "nope.png" is not a file/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("the look follows the brand", () => {
  const base = { headingFont: "Inter", bodyFont: "Inter", stores: [], accent: "#3366FF", darkSite: false };
  assert.equal(pickLook({ ...base, darkSite: true }), "launch");
  assert.equal(pickLook({ ...base, darkSite: true, accent: "#8B5CF6" }), "aurora");
  assert.equal(pickLook({ ...base, headingFont: "Playfair Display" }), "journal");
  assert.equal(pickLook({ ...base, stores: [{}], accent: "#FF4F7B" }), "pop");
  assert.equal(pickLook(base), "gridline");
});

test("text helpers", () => {
  assert.equal(markEnd("Ship software faster."), "Ship *software faster*.");
  assert.equal(markEnd("Notes that think with you"), "Notes that *think* with you");
  assert.equal(withoutName("Acme Notes | Notes that think with you", "Acme Notes"), "Notes that think with you");
  assert.equal(fit("one two three four", 9), "one two");
  assert.equal(findNumber(["Founded in 2015", "Loved by 2M+ creators every day"]).value, "2M+");
  assert.equal(findNumber(["We have 3 offices"]), null);
});

test("easybrandkit's headings come first, with the page's line under each", () => {
  const { copyFrom: copy } = require("../src/plan");
  const brand = { name: "Linear", host: "linear.app", profiles: [], description: "",
    text: { title: "", description: "", headings: [{ level: 1, text: "Plan and build" }, { level: 2, text: "Intake and integrations" }, { level: 2, text: "Planning and monitoring" }] } };
  const read = { headings: [{ level: 3, text: "Faster app launch", after: "Render UI before vehicle_state sync." },
    { level: 2, text: "Intake and integrations", after: "Turn feedback into issues." }, { level: 2, text: "Planning and monitoring", after: "Plan from idea to launch." }] };
  const c = copy(brand, read);
  assert.deepEqual(c.features.map((f) => [f.title, f.text]), [["Intake and integrations", "Turn feedback into issues"], ["Planning and monitoring", "Plan from idea to launch"]]);
});

// A film of two clips, 5 s long, its last clip at 2.5 s, in a folder of its
// own (named `name` when given) with the test brand: loadFilm's answer for
// each "music" value given.
function filmWithMusic(name = "") {
  const dir = path.join(tmp(), name);
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  const file = path.join(dir, "film.json");
  const load = (music) => {
    fs.writeFileSync(file, JSON.stringify({ brand: "brand/brand.json", look: "launch", ...(music === undefined ? {} : { music }), clips: [
      { kind: "scene", seconds: 2.5, scene: { type: "opener", title: "Acme Notes" } },
      { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png", site: "acme-notes.example" }] }));
    return loadFilm(file);
  };
  return { dir, load };
}

test("film.json's music is checked before anything renders", async () => {
  const { dir, load } = filmWithMusic();
  for (const value of [undefined, true, false, { volume: 0.4 }, { volume: 2 }, {}]) assert.deepEqual(load(value).problems, [], JSON.stringify(value));
  const kinds = '"music" must be true, false, { "volume": 0.55 } or the path of an audio file';
  for (const value of [3, "", ["a.wav"], { file: "a.wav" }]) assert.deepEqual(load(value).problems, [`${kinds} (it is ${JSON.stringify(value)})`], JSON.stringify(value));
  assert.deepEqual(load({ volume: "loud" }).problems, ['"music" "volume" must be a number from 0 to 2 (it is "loud")']);
  assert.deepEqual(load({ volume: 3 }).problems, ['"music" "volume" must be a number from 0 to 2 (it is 3)']);
  // The track's file is read when the film renders, so stills of a film
  // whose track has moved are still made.
  const missing = load("nope.wav");
  assert.deepEqual(missing.problems, []);
  // Each refusal says where the track was looked for and what to give.
  assert.deepEqual((await checkMusic(missing)).problems, [`"music" "nope.wav" is not a file. It was looked for at ${path.join(dir, "nope.wav")}, ` +
    "as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)"]);
  const elsewhere = path.join(os.tmpdir(), "launch-film-no-such-track.wav");
  assert.deepEqual((await checkMusic(load(elsewhere))).problems, [`"music" ${JSON.stringify(elsewhere)} is not a file: give the path of a track (true plays the look's own music, false none)`]);
  // A path is said whole as long as a path gets: one in a project's folder
  // was cut in the middle, where its folders are named.
  const deep = path.join(os.tmpdir(), "launch-film-no-such-folder", "a".repeat(150), "track.wav");
  assert.deepEqual((await checkMusic(load(deep))).problems, [`"music" ${JSON.stringify(deep)} is not a file: give the path of a track (true plays the look's own music, false none)`]);
  assert.deepEqual((await checkMusic(load("brand"))).problems, ['"music" "brand" is a folder, not a file: give the path of the track in it']);
  assert.deepEqual((await checkMusic(load("https://example.com/a.mp3"))).problems, ['"music" "https://example.com/a.mp3" is an address: download the track and give the path of the file, from film.json\'s folder or absolute']);
  assert.deepEqual((await checkMusic(load(true))).problems, []);
});

// A number where a path goes ended the run in Node's own words, which name
// no clip and no field, and "sfx": "false" played the effects without a word.
test("a value of another kind than its field takes is refused by the field, before anything renders", () => {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  const file = path.join(dir, "film.json");
  const load = (film) => {
    fs.writeFileSync(file, typeof film === "string" ? film : JSON.stringify(film));
    return loadFilm(file).problems;
  };
  const clips = [{ kind: "screen", seconds: 2.5, image: 3 }, { kind: "shots", seconds: 2.5, images: ["brand/appstore-1.png", true] },
    { kind: "logo", seconds: 2.5, logo: 5 }, { kind: "logo", seconds: 2.5, icon: { file: "x.png" } }];
  assert.deepEqual(load({ brand: 5, look: "launch", sfx: "false", clips }), ['"brand" must be the path of a brand.json (it is 5)',
    "clips[0].image must be the path of a picture (it is 3)", "clips[1].images[1] must be the path of a picture (it is true)",
    "clips[2].logo must be the path of a picture (it is 5)", 'clips[3].icon must be the path of a picture (it is {"file":"x.png"})',
    '"sfx" must be true or false (it is "false")']);
  for (const sfx of [undefined, null, true, false]) assert.deepEqual(load({ look: "launch", sfx, clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }), [], String(sfx));
  for (const brand of [undefined, null, "", false]) assert.deepEqual(load({ look: "launch", brand, clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }), [], String(brand));
  for (const film of ["null", "[]", "3", '"film"']) assert.deepEqual(load(film), [`${file} must hold an object, such as { "look": "launch", "clips": [] }`], film);
  // So must the brand.json it names.
  for (const kit of ["null", "[1, 2]", "3"]) {
    fs.writeFileSync(path.join(dir, "kit.json"), kit);
    assert.throws(() => readBrand(path.join(dir, "kit.json")), { message: "kit.json must hold an object, as easybrandkit's brand.json does" }, kit);
    assert.deepEqual(load({ look: "launch", brand: "kit.json", clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }),
      ["the brand could not be read from kit.json: kit.json must hold an object, as easybrandkit's brand.json does"], kit);
  }
  // A long value is said on one line and cut, as a name is.
  const [music] = load({ look: "launch", music: Array(3000).fill("a"), clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] });
  assert.ok(music.length < 300, `${music.length} characters`);
});

test("a track's path that leads to something other than a file is refused as what it is, not as one that is not there", { skip: process.platform === "win32" && "pipes, sockets and links" }, async () => {
  const { dir, load } = filmWithMusic();
  const instead = "give the path of a track (true plays the look's own music, false none)";
  const refusal = async (value) => (await checkMusic(load(value))).problems;
  assert.equal(spawnSync("mkfifo", [path.join(dir, "pipe.wav")]).status, 0);
  assert.deepEqual(await refusal("pipe.wav"), [`"music" "pipe.wav" is a pipe, not a file: ${instead}`]);
  assert.deepEqual(await refusal("/dev/null"), [`"music" "/dev/null" is a device, not a file: ${instead}`]);
  const server = net.createServer().listen(path.join(dir, "s.wav"));
  await once(server, "listening");
  try {
    assert.deepEqual(await refusal("s.wav"), [`"music" "s.wav" is a socket, not a file: ${instead}`]);
  } finally {
    server.close();
  }
  // A link whose track is gone, also at the end of a chain of links, and a
  // circle of links.
  fs.symlinkSync("gone.wav", path.join(dir, "link.wav"));
  fs.symlinkSync("link.wav", path.join(dir, "chain.wav"));
  for (const name of ["link.wav", "chain.wav"]) assert.deepEqual(await refusal(name), [`"music" "${name}" is a link to ${path.join(dir, "gone.wav")}, which is not there: ${instead}`]);
  fs.symlinkSync("round-b.wav", path.join(dir, "round-a.wav"));
  fs.symlinkSync("round-a.wav", path.join(dir, "round-b.wav"));
  assert.deepEqual(await refusal("round-a.wav"), [`"music" "round-a.wav" is a link that never reaches a file, through too many links one after another: ${instead}`]);
  // A track in a folder the user may not open is one that cannot be read.
  if (process.getuid() === 0) return;
  fs.mkdirSync(path.join(dir, "locked"));
  fs.writeFileSync(path.join(dir, "locked", "t.wav"), "");
  fs.chmodSync(path.join(dir, "locked"), 0o000);
  try {
    assert.deepEqual(await refusal("locked/t.wav"), ['"music" "locked/t.wav" cannot be read: permission denied (EACCES). Make it readable, or give a copy of it you can read']);
  } finally {
    fs.chmodSync(path.join(dir, "locked"), 0o755);
  }
});

// Where launch-film runs for others, who give it the film.json or the
// brand.json, LAUNCH_FILM_CONFINE is set and such a file may name only files
// in its own folder. A name made to slip past a check of its length, "/" and
// then "./" thousands of times, or one that climbs with "..", drew a file of
// the machine's into the film.
test("with LAUNCH_FILM_CONFINE set, a film.json or brand.json that names a file outside its own folder is refused", { skip: process.platform === "win32" && "links need rights on Windows" }, async () => {
  const { dir } = filmWithMusic();
  const elsewhere = path.join(tmp(), "private.png");
  fs.copyFileSync(path.join(fixture, "screenshot-1.png"), elsewhere);
  fs.copyFileSync(path.join(fixture, "brand.json"), path.join(path.dirname(elsewhere), "brand.json"));
  const long = `/${"./".repeat(2100)}${elsewhere.slice(1)}`;
  const climb = `${"../".repeat(30)}${elsewhere.slice(1)}`;
  const said = (name) => (name.length > 100 ? `${name.slice(0, 50)}...${name.slice(-40)}` : name);
  const saidPath = (name) => (name.length > 300 ? `${name.slice(0, 150)}...${name.slice(-140)}` : name);
  // A folder in the film's folder that a link leads out of.
  fs.symlinkSync(path.dirname(elsewhere), path.join(dir, "linked"));
  const film = { brand: "brand/brand.json", look: "launch", clips: [
    { kind: "screen", seconds: 2.5, image: long },
    { kind: "screen", seconds: 2.5, image: climb },
    // An absolute name in the folder is taken, and so is one that climbs back in.
    { kind: "shots", seconds: 2.5, images: [path.join(dir, "brand", "appstore-1.png"), "linked/private.png"] },
    { kind: "logo", seconds: 2.5, logo: "brand/../brand/logo-header.png" }] };
  const file = path.join(dir, "film.json");
  fs.writeFileSync(file, JSON.stringify(film));
  const saved = process.env.LAUNCH_FILM_CONFINE;
  try {
    // Run by its user, launch-film reads any file, as before.
    for (const value of [undefined, "", "0"]) {
      if (value === undefined) delete process.env.LAUNCH_FILM_CONFINE;
      else process.env.LAUNCH_FILM_CONFINE = value;
      assert.deepEqual(loadFilm(file).problems, [], String(value));
    }
    process.env.LAUNCH_FILM_CONFINE = "1";
    const rule = "and LAUNCH_FILM_CONFINE allows only files in it";
    assert.deepEqual(loadFilm(file).problems, [
      `clips[0].image "${said(long)}" is outside film.json's folder, ${rule}`,
      `clips[1].image "${said(climb)}" is outside film.json's folder, ${rule}`,
      `clips[2].images[1] "linked/private.png" leads out of film.json's folder through a link, ${rule}`]);
    // The brand and the track, which only a render reads, whether or not a
    // file is there.
    const brand = `${"../".repeat(30)}${path.join(path.dirname(elsewhere), "brand.json").slice(1)}`;
    // The refusal of the track says what to do: a fit made next to the
    // film's folder, as makersmcp's fit_music makes one, is outside it.
    const fit = `npx musicfit@latest '<track>' --length 2.5 --hit 0 --fps 25 --out ${shellWord(path.join(dir, "music"))}, <track> being the path of the track to fit`;
    for (const music of [long, "../no-such-track.wav", "../musicfit-track/fitted.wav"]) {
      fs.writeFileSync(file, JSON.stringify({ ...film, brand, music, clips: film.clips.slice(3) }));
      const loaded = loadFilm(file);
      assert.deepEqual(loaded.problems, [`"brand" "${said(brand)}" is outside film.json's folder, ${rule}`]);
      assert.deepEqual((await checkMusic(loaded)).problems, [`"music" "${saidPath(music)}" is outside film.json's folder, ${rule}: copy the track into that folder and give its path from there, ` +
        `or fit it into that folder with ${fit}, then set "music" in film.json to "music/fitted.wav"`]);
    }
    // A kit's files, by each place brand.json names one.
    const kit = path.join(dir, "brand", "brand.json");
    const raw = JSON.parse(fs.readFileSync(kit, "utf8"));
    fs.symlinkSync(elsewhere, path.join(dir, "brand", "shot.png"));
    raw.logos[0].file = climb;
    raw.screenshots[0].file = "shot.png";
    raw.stores[0].assets[0].file = long;
    fs.writeFileSync(kit, JSON.stringify(raw));
    assert.throws(() => readBrand(kit), { message: `brand.json names files outside its folder, which LAUNCH_FILM_CONFINE does not allow: logos[0].file "${said(climb)}" is outside brand.json's folder, ` +
      `screenshots[0].file "shot.png" leads out of brand.json's folder through a link, stores[0].assets[0].file "${said(long)}" is outside brand.json's folder` });
    delete process.env.LAUNCH_FILM_CONFINE;
    assert.equal(readBrand(kit).logos[0].file, elsewhere);
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CONFINE;
    else process.env.LAUNCH_FILM_CONFINE = saved;
  }
});

// A name film.json or brand.json gives can hold a line break, after which
// the rest of a message read as a line of launch-film's own, and can run to
// thousands of characters, which a message printed whole.
test("every refusal of a name film.json or brand.json gives shows it on one line, cut in the middle when it is long", { skip: process.platform === "win32" && "links need rights on Windows" }, async () => {
  const { dir, load } = filmWithMusic();
  // A path is said whole up to 300 characters, and a refusal can name two.
  const lines = (problems) => {
    for (const problem of problems) {
      assert.doesNotMatch(problem, /[\p{Cc}\u2028\u2029]/u, problem);
      assert.ok(problem.length < 1000, `${problem.length} characters: ${problem.slice(0, 200)}`);
    }
    return problems;
  };
  const forged = "a\nlaunch-film: Rendered 30.0 s: film.mp4";
  const long = `songs/${forged}/${"./".repeat(2000)}a.wav`;
  // A track that is not there, by a short name and by a long one.
  const [short] = lines((await checkMusic(load(`songs/${forged}.wav`))).problems);
  assert.equal(short, `"music" "songs/a\\nlaunch-film: Rendered 30.0 s: film.mp4.wav" is not a file. It was looked for at ${path.join(dir, "songs", "a\\nlaunch-film: Rendered 30.0 s: film.mp4.wav")}, ` +
    "as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)");
  const [cut] = lines((await checkMusic(load(long))).problems);
  assert.ok(cut.startsWith(`"music" "${`songs/a\\nlaunch-film: Rendered 30.0 s: film.mp4/${"./".repeat(80)}`.slice(0, 150)}...${`${"./".repeat(2000)}a.wav`.slice(-140)}" is not a file. `), cut);
  // A link to a track that is not there.
  fs.symlinkSync(`gone\n${"x".repeat(200)}.wav`, path.join(dir, "link.wav"));
  lines((await checkMusic(load("link.wav"))).problems);
  // A clip's picture and the brand that are not there.
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ brand: `brand/${forged}/${"./".repeat(2000)}brand.json`, look: "launch",
    clips: [{ kind: "screen", seconds: 2.5, image: `brand/${forged}.png` }, { kind: "logo", seconds: 2.5, logo: long }] }));
  const problems = lines(loadFilm(path.join(dir, "film.json")).problems);
  assert.equal(problems.length, 3, problems.join(" | "));
  assert.ok(problems[0].startsWith("the brand could not be read from brand/a\\nlaunch-film: Rendered 30.0 s: film.mp4/./..."), problems[0]);
  assert.ok(problems[0].endsWith(": no such file or directory (ENOENT)"), problems[0]);
  assert.equal(problems[1], 'clips[0].image "brand/a\\nlaunch-film: Rendered 30.0 s: film.mp4.png" is not a file');
  // A scene's icon that is not one.
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ look: "launch", clips: [{ kind: "scene", seconds: 2.5, scene: { type: "features",
    items: [{ icon: forged, title: "A" }, { icon: "lightning", title: "B" }] } }] }));
  const [icon] = lines(loadFilm(path.join(dir, "film.json")).problems);
  assert.ok(icon.startsWith('clips[0].scene: items[0].icon "a\\nlaunch-film: rendered 30.0 s: film.mp4" is not an icon'), icon);
  // With LAUNCH_FILM_CONFINE set: a track and a kit's file outside, and a
  // track inside film.json's folder that is not there.
  const saved = process.env.LAUNCH_FILM_CONFINE;
  process.env.LAUNCH_FILM_CONFINE = "1";
  try {
    lines((await checkMusic(load(`../${forged}.wav`))).problems);
    const [inside] = lines((await checkMusic(load(`${"./".repeat(2100)}missing.wav`))).problems);
    assert.match(inside, /^"music" "(\.\/){75}\.\.\.\/(\.\/){64}missing\.wav" is not a file\. It was looked for at /);
    const kit = path.join(dir, "brand", "brand.json");
    const raw = JSON.parse(fs.readFileSync(kit, "utf8"));
    raw.logos[0].file = `../${forged}/${"./".repeat(2000)}logo.png`;
    fs.writeFileSync(kit, JSON.stringify(raw));
    assert.throws(() => readBrand(kit), (err) => lines([err.message]).length === 1);
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CONFINE;
    else process.env.LAUNCH_FILM_CONFINE = saved;
  }
});

// A file in film.json's folder can be a list of other files that ffmpeg
// opens wherever they are: ffmpeg 4.4.2 read an HLS playlist given as the
// track, whose one part was a sound outside the folder, into the film.
test("with LAUNCH_FILM_CONFINE set, a track or a picture that is a list of other files for ffmpeg to open is refused", async () => {
  const { dir } = filmWithMusic();
  const outside = path.join(tmp(), "other-job.wav");
  fs.writeFileSync(outside, "");
  fs.mkdirSync(path.join(dir, "music"));
  fs.writeFileSync(path.join(dir, "music", "track.m3u8"), `#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\n${outside}\n#EXT-X-ENDLIST\n`);
  // A DASH manifest saved as a picture, found past its first 200 KB, an
  // ffconcat list with a byte order mark, and an IMF composition.
  fs.writeFileSync(path.join(dir, "brand", "screen.png"), `<?xml version="1.0"?>\n<!--${" ".repeat(200_000)}-->\n<MPD><BaseURL>${outside}</BaseURL></MPD>\n`);
  fs.writeFileSync(path.join(dir, "brand", "mark.png"), `\ufeffffconcat version 1.0\nfile ${outside}\n`);
  fs.writeFileSync(path.join(dir, "brand", "cpl.png"), `<?xml version="1.0"?>\n<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"></CompositionPlaylist>\n`);
  // A picture whose bytes hold such a mark only past a NUL byte is a picture.
  fs.writeFileSync(path.join(dir, "brand", "past.png"), Buffer.concat([fs.readFileSync(path.join(fixture, "logo-header.png")), Buffer.from("\0#EXTM3U <MPD")]));
  const file = path.join(dir, "film.json");
  fs.writeFileSync(file, JSON.stringify({ brand: "brand/brand.json", look: "launch", music: "music/track.m3u8", clips: [
    { kind: "screen", seconds: 2.5, image: "brand/screen.png" }, { kind: "shots", seconds: 2.5, images: ["brand/past.png"] },
    { kind: "logo", seconds: 2.5, logo: "brand/mark.png" }] }));
  const kit = path.join(dir, "brand", "brand.json");
  const raw = JSON.parse(fs.readFileSync(kit, "utf8"));
  raw.screenshots[0].file = "cpl.png";
  fs.writeFileSync(kit, JSON.stringify(raw));
  const saved = process.env.LAUNCH_FILM_CONFINE;
  try {
    delete process.env.LAUNCH_FILM_CONFINE;
    assert.deepEqual(loadFilm(file).problems, []);
    process.env.LAUNCH_FILM_CONFINE = "1";
    const rule = "whose files ffmpeg would open wherever they are, and LAUNCH_FILM_CONFINE allows only files in film.json's folder";
    const loaded = loadFilm(file);
    assert.deepEqual(loaded.problems, ["the brand could not be read from brand/brand.json: brand.json names lists of other files where pictures go, whose files ffmpeg would open wherever they are, " +
      'which LAUNCH_FILM_CONFINE does not allow: screenshots[0].file "cpl.png" is an IMF composition playlist',
      `clips[0].image "brand/screen.png" is a DASH manifest, ${rule}: give the picture itself`, `clips[2].logo "brand/mark.png" is an ffconcat list, ${rule}: give the picture itself`]);
    assert.deepEqual((await checkMusic(loaded)).problems, [`"music" "music/track.m3u8" is an HLS playlist, ${rule}: give the track itself`]);
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CONFINE;
    else process.env.LAUNCH_FILM_CONFINE = saved;
  }
});

// ffmpeg skips an ID3v2 tag at a file's start before it looks for its kind,
// and reads past every tag there before it reads a list: ffmpeg 4.4.2 read
// an HLS playlist behind a tag of 10 bytes, whose header has a NUL byte, and
// 4.4.2 and 8.0.1 a DASH manifest so, each naming a sound outside the folder.
// ffmpeg's probe looks past the first tag only, where a second tag with no
// NUL in its header can hold the manifest's mark, while the manifest past it
// names its root with a prefix, as <d:MPD.
test("with LAUNCH_FILM_CONFINE set, a list of other files behind ID3v2 tags is refused as the track or a picture", async () => {
  const { dir } = filmWithMusic();
  const outside = path.join(tmp(), "other-job.m4a");
  fs.writeFileSync(outside, "");
  // A tag of `size` bytes after its header, or, given `mark`, one with no NUL
  // in its header and the mark in its body, as ffmpeg's probe reads it.
  const tag = (size = 0, mark = null) => {
    if (mark === null) return Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...Buffer.alloc(size)]);
    const body = Buffer.alloc(2 ** 21 + 2 ** 14 + 2 ** 7 + 1, 0x20);
    body.write(mark);
    return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 1, 1, 1, 1, 1, 1]), body]);
  };
  const hls = `#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\n${outside}\n#EXT-X-ENDLIST\n`;
  const mpd = (p = "") => `<?xml version="1.0"?>\n<${p}MPD xmlns${p ? `:${p.slice(0, -1)}` : ""}="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static">` +
    `<${p}Period><${p}AdaptationSet mimeType="audio/mp4"><${p}Representation id="a" bandwidth="1"><${p}BaseURL>${outside}</${p}BaseURL></${p}Representation></${p}AdaptationSet></${p}Period></${p}MPD>\n`;
  const files = {
    "music/hls.wav": [tag(), hls],
    "music/dash.wav": [tag(), mpd()],
    "music/footer.wav": [Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 2]), Buffer.alloc(12), mpd()],
    "music/two.wav": [tag(), tag(20), hls],
    "music/marked.wav": [tag(), tag(0, "<MPD "), mpd("d:")],
    "brand/hls.png": [tag(), hls],
    "brand/dash.png": [tag(), mpd()],
  };
  fs.mkdirSync(path.join(dir, "music"));
  for (const [name, parts] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.concat(parts.map((p) => Buffer.from(p))));
  // A track whose tag holds such a mark only in a frame past a NUL is a track.
  const song = new Bus(6);
  for (let i = 0; i < song.length; i++) song.L[i] = song.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  writeWav(path.join(dir, "music", "song.wav"), song);
  fs.writeFileSync(path.join(dir, "music", "tagged.wav"), Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20]), Buffer.from("TIT2\0\0\0\x0a\0\0\0<MPD>#EXT", "latin1"),
    fs.readFileSync(path.join(dir, "music", "song.wav"))]));
  const file = path.join(dir, "film.json");
  const film = (music, image) => fs.writeFileSync(file, JSON.stringify({ look: "launch", music, clips: [
    { kind: "screen", seconds: 2.5, image }, { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }));
  const saved = process.env.LAUNCH_FILM_CONFINE;
  const rule = "whose files ffmpeg would open wherever they are, and LAUNCH_FILM_CONFINE allows only files in film.json's folder";
  try {
    process.env.LAUNCH_FILM_CONFINE = "1";
    for (const [track, list] of [["hls", "an HLS playlist"], ["dash", "a DASH manifest"], ["footer", "a DASH manifest"], ["two", "an HLS playlist"], ["marked", "a DASH manifest"]]) {
      film(`music/${track}.wav`, "brand/screenshot-1.png");
      const loaded = loadFilm(file);
      assert.deepEqual(loaded.problems, [], track);
      assert.deepEqual((await checkMusic(loaded)).problems, [`"music" "music/${track}.wav" is ${list}, ${rule}: give the track itself`], track);
    }
    for (const [picture, list] of [["hls", "an HLS playlist"], ["dash", "a DASH manifest"]]) {
      film(false, `brand/${picture}.png`);
      assert.deepEqual(loadFilm(file).problems, [`clips[0].image "brand/${picture}.png" is ${list}, ${rule}: give the picture itself`], picture);
    }
    film("music/tagged.wav", "brand/screenshot-1.png");
    assert.deepEqual(loadFilm(file).problems, []);
    if (available()) assert.deepEqual((await checkMusic(loadFilm(file))).problems, []);
    delete process.env.LAUNCH_FILM_CONFINE;
    film("music/dash.wav", "brand/dash.png");
    assert.deepEqual(loadFilm(file).problems, []);
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CONFINE;
    else process.env.LAUNCH_FILM_CONFINE = saved;
  }
});

test("a path goes into a command line as one word the shell takes as it is", () => {
  assert.equal(shellWord("/films/acme-notes/music", "linux"), "/films/acme-notes/music");
  assert.equal(shellWord("/films/Emin's films `touch PWNED` $HOME/music", "darwin"), "'/films/Emin'\\''s films `touch PWNED` $HOME/music'");
  // On Windows in double quotes with /, which cmd.exe, PowerShell and Git
  // Bash take alike, and none at all when one of them would expand a part.
  assert.equal(shellWord("C:\\Users\\emin\\films\\music", "win32"), "C:/Users/emin/films/music");
  assert.equal(shellWord("C:\\Users\\Emin Budak\\Emin's films\\music", "win32"), '"C:/Users/Emin Budak/Emin\'s films/music"');
  for (const odd of ["C:\\films $HOME\\music", "C:\\films `x`\\music", "C:\\films %PATH%\\music", "C:\\films!\\music"]) assert.equal(shellWord(odd, "win32"), null, odd);
});

test("a track with no sound, a silent one and one shorter than the film are refused", { skip: !available() && "ffmpeg not found" }, async () => {
  const { dir, load } = filmWithMusic();
  const wav = (name, seconds, level) => {
    const bus = new Bus(seconds);
    for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = level * Math.sin((2 * Math.PI * 440 * i) / SR);
    writeWav(path.join(dir, name), bus);
    return name;
  };
  assert.deepEqual((await checkMusic(load("brand/brand.json"))).problems, ['"music" "brand/brand.json" has no sound ffmpeg can read: give an audio file, such as a WAV, MP3, M4A or FLAC file, or a video with sound']);
  const [short] = (await checkMusic(load(wav("short.wav", 1, 0.3)))).problems;
  assert.match(short, /^"music" "short\.wav" lasts 1\.00 s and the film 5\.00 s: give a track at least as long as the film\. musicfit makes one/);
  assert.ok(short.endsWith(`npx musicfit@latest ${path.join(dir, "short.wav")} --length 5 --hit 2.5 --fps 25 --out ${path.join(dir, "music")}, then set "music" in film.json to "music/fitted.wav"`), short);
  assert.deepEqual((await checkMusic(load(wav("silent.wav", 6, 0)))).problems, ['"music" "silent.wav" is silent over the film\'s 5.00 s: give a track with sound in it, or false for no music']);
  // A track as long as the film, give or take half a frame, is taken.
  for (const seconds of [6, 4.99]) {
    const { track, problems } = await checkMusic(load(wav("tone.wav", seconds, 0.3)));
    assert.deepEqual(problems, []);
    assert.ok(track.seconds >= 4.98 && track.left.length === track.right.length, `${track.seconds} s`);
    assert.ok(track.integrated > -30 && track.integrated < -5 && track.peak < 0, `${track.integrated} LUFS, peak ${track.peak}`);
  }
  // Its path may be absolute.
  assert.deepEqual((await checkMusic(load(path.join(dir, "tone.wav")))).problems, []);
});

test("the musicfit command a short track's refusal gives runs in a shell as it is, whatever the film's folder is named", { skip: (process.platform === "win32" || !available()) && "a POSIX shell, and ffmpeg" }, async () => {
  const { dir, load } = filmWithMusic("Emin's films `touch PWNED` $HOME");
  const bus = new Bus(1);
  for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  writeWav(path.join(dir, "short.wav"), bus);
  const [short] = (await checkMusic(load("short.wav"))).problems;
  const command = /: (npx musicfit@latest .*), then set "music" in film\.json to "music\/fitted\.wav"$/.exec(short);
  assert.ok(command, short);
  // Each word as the shell hands it to musicfit, printed in its place: the
  // track it refused, then the length, the hit and the folder.
  const here = tmp();
  const r = spawnSync("sh", ["-c", command[1].replace("npx musicfit@latest", "printf '%s\\n'")], { cwd: here, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").slice(0, -1), [path.join(dir, "short.wav"), "--length", "5", "--hit", "2.5", "--fps", "25", "--out", path.join(dir, "music")]);
  assert.deepEqual(fs.readdirSync(here), [], "nothing in the folder's name was run");
});

// A film that grew since its track was fitted: the track film.json names is
// musicfit's fitted.wav in the music folder the refusal's command writes to.
// musicfit refuses to fit a track it would replace, and a fit's faded end
// fitted again would play twice, so the command names the track it was made
// from, which musicfit's cues.json beside it gives.
test("the musicfit command for a short earlier fit names the track it was fitted from, not the fit", { skip: (process.platform === "win32" || !available()) && "a POSIX shell, and ffmpeg" }, async () => {
  const { dir, load } = filmWithMusic();
  const wav = (file, seconds) => {
    const bus = new Bus(seconds);
    for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    writeWav(file, bus);
  };
  const music = path.join(dir, "music");
  fs.mkdirSync(music);
  wav(path.join(music, "fitted.wav"), 1);
  const refusal = async () => (await checkMusic(load("music/fitted.wav"))).problems[0];
  const lead = '"music" "music/fitted.wav" lasts 1.00 s and the film 5.00 s: give a track at least as long as the film. ';
  const then = 'then set "music" in film.json to "music/fitted.wav"';
  const tail = `musicfit makes one exactly that long with its hit on the beat you choose, such as the last clip at 2.50 s: npx musicfit@latest`;
  // Without a cues.json, by what it is.
  assert.equal(await refusal(), `${lead}That track is an earlier fit, so fit the track it was made from again: ${tail} '<track>' --length 5 --hit 2.5 --fps 25 --out ${music}, ` +
    `<track> being the path of the track it was made from, ${then}`);
  // With musicfit's cues.json, by the track it names.
  fs.writeFileSync(path.join(music, "cues.json"), JSON.stringify({ musicfit: "0.2.1", track: "song.wav", file: "fitted.wav", fps: 25 }));
  const nameOnly = await refusal();
  assert.equal(nameOnly, `${lead}That track is musicfit's earlier fit of song.wav, so fit song.wav again: ${tail} '<song.wav>' --length 5 --hit 2.5 --fps 25 --out ${music}, ` +
    `<song.wav> being the path of song.wav, ${then}`);
  // A shell that runs it as it is reads no < or > in it, so it makes no file.
  const here = tmp();
  const command = /: (npx musicfit@latest .*?), <song\.wav> being/.exec(nameOnly)[1];
  const r = spawnSync("sh", ["-c", command.replace("npx musicfit@latest", "printf '%s\\n'")], { cwd: here, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n")[0], "<song.wav>");
  assert.deepEqual(fs.readdirSync(here), []);
  // Beside film.json, or beside the fit, by its whole path.
  for (const place of [dir, music]) {
    wav(path.join(place, "song.wav"), 8);
    assert.equal(await refusal(), `${lead}That track is musicfit's earlier fit of song.wav, so fit song.wav again: ${tail} ${path.join(place, "song.wav")} --length 5 --hit 2.5 --fps 25 --out ${music}, ${then}`);
    fs.rmSync(path.join(place, "song.wav"));
  }
  // A fit kept elsewhere is one all the same, when its cues.json lists it.
  const kept = path.join(dir, "fits");
  fs.mkdirSync(kept);
  fs.renameSync(path.join(music, "fitted.wav"), path.join(kept, "fitted.wav"));
  fs.renameSync(path.join(music, "cues.json"), path.join(kept, "cues.json"));
  assert.match((await checkMusic(load("fits/fitted.wav"))).problems[0], /That track is musicfit's earlier fit of song\.wav, so fit song\.wav again: .* '<song\.wav>' --length 5/);
  // A track of the user's in the music folder is fitted as it is.
  wav(path.join(music, "mine.wav"), 1);
  assert.match((await checkMusic(load("music/mine.wav"))).problems[0], new RegExp(`5\\.00 s: give a track at least as long as the film\\. musicfit makes one .*: npx musicfit@latest ${path.join(music, "mine.wav").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --length 5`));
});

// A track's name in cues.json is anyone's: an apostrophe in a song's title
// broke the command a shell runs as it is, and a ; or a $( ) in it ran a
// command of its own there. In place of a track not to be found, the
// command has a word quoted as a path is, and nothing in it is run.
test("the musicfit command for an earlier fit whose track is not found runs in a shell as it is, whatever that track is named", { skip: (process.platform === "win32" || !available()) && "a POSIX shell, and ffmpeg" }, async () => {
  const { dir, load } = filmWithMusic();
  const music = path.join(dir, "music");
  fs.mkdirSync(music);
  const bus = new Bus(1);
  for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  writeWav(path.join(music, "fitted.wav"), bus);
  // An npx that prints what it was given, a word a line, and runs nothing.
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "npx"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  for (const name of ["Don't Stop Me Now.mp3", "Don't Stop; touch PWNED; It's Over $(touch PWNED2) `touch PWNED3`.mp3", "two\nlines.mp3"]) {
    fs.writeFileSync(path.join(music, "cues.json"), JSON.stringify({ musicfit: "0.2.1", track: name, file: "fitted.wav", fps: 25 }));
    const [refusal] = (await checkMusic(load("music/fitted.wav"))).problems;
    // A line break in the name is written escaped, so the refusal is one line.
    assert.ok(!refusal.includes("\n"), refusal);
    const shown = name.replace("\n", "\\n");
    assert.ok(refusal.includes(`That track is musicfit's earlier fit of ${shown}, so fit ${shown} again: `), refusal);
    const command = /: (npx musicfit@latest .* --out \S+), /.exec(refusal);
    assert.ok(command, refusal);
    const here = tmp();
    const r = spawnSync("sh", ["-c", command[1]], { cwd: here, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split("\n").slice(0, -1), ["musicfit@latest", `<${shown}>`, "--length", "5", "--hit", "2.5", "--fps", "25", "--out", music], name);
    assert.deepEqual(fs.readdirSync(here), [], `something in ${JSON.stringify(name)} was run`);
  }
});

// On Windows no quoting holds a %, $, ` or ! in every shell, nor a ", so a
// track's name with one goes after the command alone, behind a plain word.
test("on Windows a track's name that no quoting holds is named after the command, behind a plain <track>", () => {
  const folder = "C:\\Users\\emin\\films\\music";
  assert.equal(musicfitCommand({ from: null, name: "Don't Stop.mp3", folder, seconds: 5, hit: 2.5 }, "win32"),
    "npx musicfit@latest \"<Don't Stop.mp3>\" --length 5 --hit 2.5 --fps 25 --out C:/Users/emin/films/music, <Don't Stop.mp3> being the path of Don't Stop.mp3");
  for (const name of ["100% mix.mp3", "$(x).mp3", "say \"hi\".mp3", "wow!.mp3", "a `b`.mp3"]) {
    assert.equal(musicfitCommand({ from: null, name, folder, seconds: 5, hit: 2.5 }, "win32"),
      `npx musicfit@latest "<track>" --length 5 --hit 2.5 --fps 25 --out C:/Users/emin/films/music, <track> being the path of ${name}`, name);
  }
  // A path with a line break in it is named after the command too, escaped.
  assert.equal(musicfitCommand({ from: "/films/two\nlines.wav", folder: "/films/music", seconds: 5, hit: 2.5 }, "linux"),
    "npx musicfit@latest '<track>' --length 5 --hit 2.5 --fps 25 --out /films/music, <track> being /films/two\\nlines.wav quoted for your shell");
});

// With LAUNCH_FILM_CONFINE set, film.json may name only files in its own
// folder, and the track an earlier fit's cues.json names is held to it too:
// the command named a track elsewhere by its path only when a file was
// there, so a cues.json could learn whether any path of the machine was.
test("with LAUNCH_FILM_CONFINE set, the command for an earlier fit names no track outside film.json's folder by its path", { skip: !available() && "ffmpeg" }, async () => {
  const { dir, load } = filmWithMusic();
  const music = path.join(dir, "music");
  fs.mkdirSync(music);
  const wav = (file, seconds) => {
    const bus = new Bus(seconds);
    for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    writeWav(file, bus);
  };
  wav(path.join(music, "fitted.wav"), 1);
  const elsewhere = path.join(tmp(), "song.wav");
  wav(elsewhere, 8);
  const commandFor = async (track) => {
    fs.writeFileSync(path.join(music, "cues.json"), JSON.stringify({ musicfit: "0.2.1", track, file: "fitted.wav", fps: 25 }));
    return /: npx musicfit@latest (\S+) --length/.exec((await checkMusic(load("music/fitted.wav"))).problems[0])[1];
  };
  const climbs = path.relative(music, elsewhere);
  const saved = process.env.LAUNCH_FILM_CONFINE;
  try {
    delete process.env.LAUNCH_FILM_CONFINE;
    assert.equal(await commandFor(elsewhere), shellWord(elsewhere));
    assert.equal(await commandFor(climbs), shellWord(elsewhere));
    process.env.LAUNCH_FILM_CONFINE = "1";
    for (const track of [elsewhere, climbs, path.join(path.dirname(elsewhere), "nothing-there.wav")]) assert.equal(await commandFor(track), `'<${path.basename(track)}>'`, track);
    // One in film.json's folder is named by its path as before.
    wav(path.join(dir, "song.wav"), 8);
    assert.equal(await commandFor("song.wav"), shellWord(path.join(dir, "song.wav")));
  } finally {
    if (saved === undefined) delete process.env.LAUNCH_FILM_CONFINE;
    else process.env.LAUNCH_FILM_CONFINE = saved;
  }
});

// A film.json's music is anyone's where others give launch-film their
// film.json: a name of thousands of characters ran on in the render's note.
// It is a path, said whole as long as a path gets: a track's absolute path
// in a project's folder was cut in the middle, where its folders are named.
test("the render's note shows the track's path on one line, cut in the middle only when it is longer than a path gets", () => {
  assert.equal(trackNote({ name: "music/a\nb.wav", integrated: -14, peak: -3 }, 5), "The music is music/a\\nb.wav, at the bed's level, from the film's first frame to its end at 5.00 s, faded out over the last second.");
  const project = `/home/someone/Documents/Projects/${"Launch films of the year/".repeat(6)}music/track.wav`;
  assert.ok(project.length > 150 && project.length < 300);
  assert.equal(trackNote({ name: project, integrated: -14, peak: -3 }, 5), `The music is ${project}, at the bed's level, from the film's first frame to its end at 5.00 s, faded out over the last second.`);
  const long = `/${"./".repeat(2100)}x.wav`;
  const note = trackNote({ name: long, integrated: -14, peak: -3 }, 5);
  assert.equal(note, `The music is ${long.slice(0, 150)}...${long.slice(-140)}, at the bed's level, from the film's first frame to its end at 5.00 s, faded out over the last second.`);
});

test("a track the user may not read is refused for that, not as a file with no sound", { skip: (process.platform === "win32" || process.getuid() === 0 || !available()) && "a file its user may not read, and ffmpeg" }, async () => {
  const { dir, load } = filmWithMusic();
  const bus = new Bus(6);
  for (let i = 0; i < bus.length; i++) bus.L[i] = bus.R[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const file = path.join(dir, "noread.wav");
  writeWav(file, bus);
  fs.chmodSync(file, 0o000);
  assert.deepEqual((await checkMusic(load("noread.wav"))).problems, ['"music" "noread.wav" cannot be read: permission denied (EACCES). Make it readable, or give a copy of it you can read']);
});
