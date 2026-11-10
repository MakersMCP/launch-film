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
const { loadFilm, checkMusic, shellWord } = require("../src/film");
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
  assert.deepEqual((await checkMusic(load("brand"))).problems, ['"music" "brand" is a folder, not a file: give the path of the track in it']);
  assert.deepEqual((await checkMusic(load("https://example.com/a.mp3"))).problems, ['"music" "https://example.com/a.mp3" is an address: download the track and give the path of the file, from film.json\'s folder or absolute']);
  assert.deepEqual((await checkMusic(load(true))).problems, []);
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
  assert.ok(short.endsWith(`npx musicfit@latest <track> --length 5 --hit 2.5 --fps 25 --out ${path.join(dir, "music")}, then set "music" in film.json to "music/fitted.wav"`), short);
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
  const command = /: (npx musicfit@latest <track> .*), then set "music" in film\.json to "music\/fitted\.wav"$/.exec(short);
  assert.ok(command, short);
  // Each word as the shell hands it to musicfit, printed in its place.
  const here = tmp();
  const r = spawnSync("sh", ["-c", command[1].replace("npx musicfit@latest <track>", "printf '%s\\n' track")], { cwd: here, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").slice(0, -1), ["track", "--length", "5", "--hit", "2.5", "--fps", "25", "--out", path.join(dir, "music")]);
  assert.deepEqual(fs.readdirSync(here), [], "nothing in the folder's name was run");
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
