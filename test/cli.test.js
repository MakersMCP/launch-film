"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { tmp, shortTmp, WAITS, pidOf, alive, end, SAVES_PID, pidIn } = require("./tmp");
const { available, FFMPEG } = require("../src/ffmpeg");

const root = path.join(__dirname, "..");
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 30_000 });
// The same with these added to its environment, and a minute to end in.
const cliWith = (env, ...args) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });

test("help, looks and types", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:\n {2}launch-film <url> \[options\]/);
  const looks = cli("looks").stdout.trim().split("\n");
  assert.deepEqual(looks.map((l) => l.split(" ")[0]), ["launch", "aurora", "gridline", "pop", "journal"]);
  assert.match(cli("types").stdout, /^features /m);
  assert.match(cli("icons", "rocket").stdout, /rocket-launch/);
});

// A reader that closes early, as head does once it has its lines, left the
// lists to end in Node's stack trace on the write that failed.
test("looks, types, icons and help end without a word when their reader stops reading", async () => {
  for (const args of [["types"], ["looks"], ["icons", "a"], ["--help"]]) {
    const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    // Closed before the command writes, so every write it makes fails.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const [code, signal] = await new Promise((resolve) => child.on("close", (...ended) => resolve(ended)));
    assert.deepEqual([code, signal, stderr], [0, null, ""], args.join(" "));
  }
});

test("a bad address is refused plainly", () => {
  const r = cli("not a url");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a command or an address/);
});

// The words people read: the README, the skill, the CLI's help and the
// look descriptions. No dashes as punctuation and none of the stock words.
test("public text has no em or en dashes and no hype words", () => {
  const texts = {
    "README.md": fs.readFileSync(path.join(root, "README.md"), "utf8"),
    "SKILL.md": fs.readFileSync(path.join(root, "skills", "launch-film", "SKILL.md"), "utf8"),
    "THIRD_PARTY.md": fs.readFileSync(path.join(root, "THIRD_PARTY.md"), "utf8"),
    help: cli("--help").stdout,
    looks: cli("looks").stdout,
    types: cli("types").stdout,
    "bin/launch-film.js": fs.readFileSync(path.join(root, "bin", "launch-film.js"), "utf8"),
  };
  const banned = /\b(delve|unleash|seamless(ly)?|cutting-edge|game-?changer|elevate|empower|robust|harness|revolutioni[sz]e|supercharge|effortless(ly)?|stunning|magic(al)?|blazing|world-class|next-gen)\b/i;
  for (const [name, text] of Object.entries(texts)) {
    assert.ok(!/[\u2013\u2014]/.test(text), `${name} has a dash: ${(/.{0,40}[\u2013\u2014].{0,40}/.exec(text) || [""])[0]}`);
    const hit = banned.exec(text);
    assert.ok(!hit, `${name} uses "${hit && hit[0]}"`);
  }
});

// A film's folder as a plan leaves it: the test brand as brand/, words.json
// and film.json, and a film.mp4 from a render.
const os = require("os");
const crypto = require("crypto");
const fixture = path.join(root, "test", "fixtures", "acme");
function filmFolder() {
  const dir = tmp();
  fs.cpSync(fixture, path.join(dir, "brand"), { recursive: true });
  fs.copyFileSync(path.join(fixture, "words.json"), path.join(dir, "words.json"));
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ brand: "brand/brand.json", look: "launch", clips: [{ kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }));
  fs.writeFileSync(path.join(dir, "film.mp4"), "a film");
  return dir;
}
// Every file and folder in it, hidden ones too, with a hash of each file;
// with links, a link as where it leads.
function snap(dir, { links = false } = {}) {
  const seen = {};
  const walk = (at, rel) => {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      const s = fs.lstatSync(file);
      if (links && s.isSymbolicLink()) seen[key] = `link to ${fs.readlinkSync(file)}`;
      else if (s.isDirectory()) walk(file, key);
      else seen[key] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return seen;
}
// An easybrandkit that empties the folder it is given and fails, as one
// that could not open the page did.
function failingEasybrandkit(dir) {
  const file = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(file, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];' +
    ' for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) fs.rmSync(out + "/" + f, { recursive: true, force: true });' +
    ' process.stderr.write("easybrandkit: Could not open the page\\n"); process.exit(1);');
  return file;
}

// A kit of its own: the test brand under another name, or with a brand.json
// that cannot be read.
function otherKit(text) {
  const dir = path.join(tmp(), "kit");
  fs.cpSync(fixture, dir, { recursive: true });
  const kit = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "brand.json"), text || JSON.stringify({ ...kit, name: "Other Notes" }));
  return dir;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A plan run on a film's folder that fails: the folder is as it was, and
// the last line says so.
function planFails(args, said) {
  const dir = filmFolder();
  const before = snap(dir);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, ...args);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, said);
  assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
  assert.deepEqual(snap(dir), before);
}

// A plan reads what it is given before any work, so a words.json that is not
// there, or a kit with no brand.json, refuses it before it begins: the
// folder is as it was and the refusal says only why.
test("a plan given another kit and a words.json that is not there, or a kit with no brand.json, is refused before it begins", () => {
  for (const [args, said] of [[["--brand", otherKit(), "--words", path.join(os.tmpdir(), "launch-film-no-such-words.json")], `--words ${path.join(os.tmpdir(), "launch-film-no-such-words.json")}: no such file`],
    [["--brand", tmp()], "no brand.json at "]]) {
    const dir = filmFolder();
    const before = snap(dir);
    const r = cli("plan", "https://acme-notes.example", "--out", dir, ...args);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.startsWith(`launch-film: ${said}`) && r.stderr.split("\n").length === 2, r.stderr);
    assert.deepEqual(snap(dir), before);
  }
});

// easybrandkit makes no kit in a brand/ of files that are not a kit's, so a
// plan without --brand into such a folder is refused as that before it looks
// at any program or starts easybrandkit: here the Chrome and the ffmpeg it
// is given are not there, and the stand-in easybrandkit notes that it ran.
test("a plan, the one-go command and stills of an address into a folder whose brand/ holds files and no kit are refused before any program is looked at", () => {
  const ran = path.join(tmp(), "ran");
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, `require("fs").writeFileSync(${JSON.stringify(ran)}, ""); process.stderr.write("easybrandkit: it ran\\n"); process.exit(1);`);
  const nothing = path.join(tmp(), "nothing");
  for (const command of [["plan"], [], ["stills"]]) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "brand"));
    fs.writeFileSync(path.join(dir, "brand", "notes.txt"), "the user's");
    const before = snap(dir);
    const r = cliWith({ LAUNCH_FILM_CHROME: nothing, LAUNCH_FILM_FFMPEG: nothing, LAUNCH_FILM_FFPROBE: nothing }, ...command, "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${path.join(dir, "brand")} is not empty and holds no earlier brand kit, which a plan has easybrandkit make there: give a kit with --brand, move the files in it elsewhere, or pick another folder with --out\n`, command.join(" "));
    assert.deepEqual(snap(dir), before);
    assert.ok(!fs.existsSync(ran), `${command.join(" ")}: easybrandkit was started`);
  }
  // One whose brand/ holds only hidden files, or holds a brand.json, is left
  // to easybrandkit, as is one given a kit.
  for (const files of [{ ".DS_Store": "" }, { "brand.json": "{}", "notes.txt": "the user's" }]) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "brand"));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, "brand", name), text);
    const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /easybrandkit failed \(exit 1\): easybrandkit: it ran\n/, Object.keys(files).join(" "));
    fs.rmSync(ran);
  }
});

test("a plan whose easybrandkit fails leaves the folder's kit as it was", () => {
  planFails(["--easybrandkit", failingEasybrandkit(tmp())], /easybrandkit failed \(exit 1\): easybrandkit: Could not open the page/);
});

test("a plan whose easybrandkit fails leaves a kit that brand/ links to as it was", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  // brand/ links to a kit other films share.
  const dir = filmFolder();
  const shared = path.join(tmp(), "shared-kit");
  fs.renameSync(path.join(dir, "brand"), shared);
  fs.symlinkSync(shared, path.join(dir, "brand"));
  const [before, kit] = [snap(dir, { links: true }), snap(shared)];
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", failingEasybrandkit(tmp()));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(snap(shared), kit);
  assert.deepEqual(snap(dir, { links: true }), before);
});

test("a plan whose easybrandkit fails cannot reach through a link inside the folder's kit", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  // A file and a folder in brand/ that link to files other films share, as
  // an easybrandkit working on the run's copy would write and clear them.
  const dir = filmFolder();
  const shared = tmp();
  fs.mkdirSync(path.join(shared, "pages"));
  fs.writeFileSync(path.join(shared, "logo.png"), "the shared logo");
  fs.writeFileSync(path.join(shared, "pages", "home.md"), "the shared page");
  fs.symlinkSync(path.join(shared, "logo.png"), path.join(dir, "brand", "logo-01.png"));
  fs.symlinkSync(path.join(shared, "pages"), path.join(dir, "brand", "pages"));
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, 'const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];' +
    ' if (fs.lstatSync(out + "/logo-01.png").isSymbolicLink()) process.stderr.write("a link reached the copy\\n");' +
    ' fs.writeFileSync(out + "/logo-01.png", "new"); fs.writeFileSync(out + "/pages/home.md", "new"); fs.rmSync(out + "/pages/home.md");' +
    ' process.stderr.write("easybrandkit: Could not open the page\\n"); process.exit(1);');
  const [before, theirs] = [snap(dir, { links: true }), snap(shared)];
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!r.stderr.includes("a link reached the copy"), r.stderr);
  assert.deepEqual(snap(shared), theirs);
  assert.deepEqual(snap(dir, { links: true }), before);
});

test("a plan makes the folder's brand/ of plain files, however the kit it was given holds them", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  const kit = otherKit();
  const shared = tmp();
  fs.mkdirSync(path.join(shared, "pages"));
  fs.writeFileSync(path.join(shared, "pages", "home.md"), "the shared page");
  fs.renameSync(path.join(kit, "logo-header.png"), path.join(shared, "logo-header.png"));
  fs.symlinkSync(path.join(shared, "logo-header.png"), path.join(kit, "logo-header.png"));
  fs.symlinkSync(path.join(shared, "pages"), path.join(kit, "pages"));
  const dir = filmFolder();
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(kit, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.lstatSync(path.join(dir, "brand", "logo-header.png")).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(dir, "brand", "pages")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, "brand", "pages", "home.md"), "utf8"), "the shared page");
  assert.equal(fs.readdirSync(shared).length, 2);
});

test("easybrandkit's own words about the folder it was given name it as the user knows it", () => {
  // The run gives it its copy of brand/; the folder it speaks of is the
  // user's own, not a new one.
  const dir = filmFolder();
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, 'const out = process.argv[process.argv.indexOf("--out") + 1]; process.stderr.write("easybrandkit: " + out + " is not empty and holds no earlier brand kit. Pick another folder with --out.\\n"); process.exit(1);');
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.split("\n").slice(-3, -1).join("\n"), `launch-film: easybrandkit failed (exit 1): easybrandkit: ${path.join(dir, "brand")} is not empty and holds no earlier brand kit. Pick another folder with --out.\nlaunch-film: ${dir} is as it was.`);
});

test("a plan that ends well keeps the files of the user's in the folder's kit", () => {
  // easybrandkit makes its kit again where one is and leaves the other
  // files: it is given the run's copy of the folder's brand/.
  const dir = filmFolder();
  fs.writeFileSync(path.join(dir, "brand", "my-notes.txt"), "the user's own notes");
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, `const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1]; fs.cpSync(${JSON.stringify(fixture)}, out, { recursive: true, force: true });`);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit, "--words", path.join(fixture, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "brand", "my-notes.txt"), "utf8"), "the user's own notes");
});

test("a kit that cannot be copied is named, with the new folder and the reason", { skip: (process.platform === "win32" || process.getuid() === 0) && "a file its user may not read" }, () => {
  const kit = otherKit();
  fs.chmodSync(path.join(kit, "logo-header.png"), 0o000);
  planFails(["--brand", kit, "--words", path.join(fixture, "words.json")], new RegExp(`^launch-film: copying the brand kit ${escape(kit)} to the new .*/brand: permission denied \\(EACCES\\)\\n`));
});

test("a plan given a kit that cannot be read leaves the folder's kit as it was", () => {
  planFails(["--brand", otherKit("{ this is not JSON")], /JSON/);
});

// A plan given a kit and no words reads the words on the page. Offline it
// took the words of Chrome's own error page, "Press space to play", and
// ended well. Offline is a network namespace of the plan's own, where
// unshare can make one.
const offline = process.platform === "linux" && spawnSync("unshare", ["-rn", "true"]).status === 0;
// A port on this machine that nothing listens on.
async function closedPort() {
  const server = require("net").createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
for (const where of ["offline", "at an address that does not answer"]) {
  test(`a plan given a kit and no words that cannot read the page ${where} is refused by name and leaves the folder as it was`, { skip: where === "offline" && !offline && "unshare cannot make a network namespace here" }, async () => {
    const dir = filmFolder();
    const before = snap(dir);
    let url = "https://acme-notes.example/";
    let kit = otherKit();
    if (where !== "offline") {
      url = `http://127.0.0.1:${await closedPort()}/`;
      kit = otherKit(JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(fixture, "brand.json"), "utf8")), url }));
    }
    const run = [path.join(root, "bin", "launch-film.js"), "plan", url, "--out", dir, "--brand", kit];
    const r = where === "offline" ? spawnSync("unshare", ["-rn", process.execPath, ...run], { encoding: "utf8", timeout: 60_000 })
      : spawnSync(process.execPath, run, { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 1, r.stderr);
    // Chrome says why it could not open the page; with no Chrome, the fetch says.
    const why = require("../src/chrome").findChrome() ? "net::ERR_[A-Z_]+" : "[^)]+";
    assert.match(r.stderr, new RegExp(`\\nlaunch-film: the page ${escape(url)} could not be read \\(${why}\\): check the address and the network, or give a words\\.json with --words\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
    assert.deepEqual(snap(dir), before);
  });
}

// The audit's way in: a kit whose brand.json is a page as well, with a
// script in it, gives that same file as the site's address. Chrome opened it
// as a page, with the files of the machine in reach, and the script read one
// into words.json.
test("a plan refuses a kit whose address is a file of the machine's, before anything opens it", () => {
  const secret = path.join(tmp(), "secret.txt");
  fs.writeFileSync(secret, "a file no page may read");
  const kit = path.join(tmp(), "kit");
  fs.mkdirSync(kit);
  const file = path.join(kit, "brand.html");
  const script = `<h1>Acme</h1><script>fetch('file://${secret}').then(r=>r.text()).then(t=>{document.body.innerHTML='<h1>'+t+'</h1><h2>a</h2><h3>b</h3>'})</script>`;
  fs.writeFileSync(file, JSON.stringify({ url: `file://${file}`, name: script }));
  const dir = filmFolder();
  const before = snap(dir);
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--brand", file);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`^launch-film: brand\\.html gives the site's address as "${escape(`file://${file}`)}", which is not an http or https address: ` +
    `give a kit made from the site, or the page's words with --words\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
  assert.deepEqual(snap(dir), before);
});

// Where launch-film runs for others, LAUNCH_FILM_CONFINE keeps a film.json
// and a brand.json to the files in their own folders. A name made to slip
// past a check of its length drew a file of the machine's into the film.
test("with LAUNCH_FILM_CONFINE set, a render, stills and a plan refuse a file named outside its folder before anything renders", () => {
  const dir = filmFolder();
  const elsewhere = path.join(tmp(), "private.png");
  fs.copyFileSync(path.join(fixture, "screenshot-1.png"), elsewhere);
  const name = `/${"./".repeat(2100)}${elsewhere.slice(1)}`;
  const said = `${name.slice(0, 50)}...${name.slice(-40)}`;
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ brand: "brand/brand.json", look: "launch", clips: [
    { kind: "screen", seconds: 2.5, image: name }, { kind: "logo", seconds: 2.5, logo: "brand/logo-header.png" }] }));
  const before = snap(dir);
  const chrome = noteChrome();
  for (const command of ["render", "stills"]) {
    const r = cliWith({ LAUNCH_FILM_CONFINE: "1", LAUNCH_FILM_CHROME: chrome.chrome }, command, path.join(dir, "film.json"));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^launch-film: film\\.json has problems:\\n  - clips\\[0\\]\\.image "${escape(said)}" is outside film\\.json's folder, and LAUNCH_FILM_CONFINE allows only files in it\\n`), command);
    assert.deepEqual(snap(dir), before, command);
  }
  assert.ok(!chrome.started(), "a Chrome was started");
  // A plan given a kit that names one.
  const raw = JSON.parse(fs.readFileSync(path.join(fixture, "brand.json"), "utf8"));
  raw.logos[0].file = name;
  const kit = otherKit(JSON.stringify(raw));
  const r = cliWith({ LAUNCH_FILM_CONFINE: "1" }, "plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(fixture, "words.json"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, `launch-film: brand.json names files outside its folder, which LAUNCH_FILM_CONFINE does not allow: logos[0].file "${said}" is outside brand.json's folder\nlaunch-film: ${dir} is as it was.\n`);
  assert.deepEqual(snap(dir), before);
  // Run by its user, the same plan ends well.
  assert.equal(cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(fixture, "words.json")).status, 0);
});

// A plan copies the kit as plain files, every link followed: a link in the
// kit to a file outside it made that file the film's logo, in brand/ and in
// film.json, which a confined render then took as the kit's own.
test("with LAUNCH_FILM_CONFINE set, a plan refuses a kit with a link that leads out of it, given with --brand or the folder's own brand/, before anything is copied", { skip: process.platform === "win32" && "links need rights on Windows" }, () => {
  const outside = tmp();
  fs.copyFileSync(path.join(fixture, "logo-header.png"), path.join(outside, "secret.png"));
  fs.mkdirSync(path.join(outside, "pages"));
  fs.writeFileSync(path.join(outside, "pages", "home.md"), "a page of the machine's");
  const words = ["--words", path.join(fixture, "words.json")];
  const confined = (...args) => cliWith({ LAUNCH_FILM_CONFINE: "1" }, "plan", "https://acme-notes.example", ...args);
  const rule = "leads out of the kit's folder through a link, and LAUNCH_FILM_CONFINE allows only files in it";
  // A kit whose logo is a link to a file outside, and one with a link to a
  // folder outside that nothing names.
  const logo = otherKit();
  fs.rmSync(path.join(logo, "logo-header.png"));
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(logo, "logo-header.png"));
  const folder = otherKit();
  fs.symlinkSync(path.join(outside, "pages"), path.join(folder, "pages"));
  for (const [kit, name] of [[logo, "logo-header.png"], [folder, "pages"]]) {
    const dir = filmFolder();
    const before = snap(dir);
    const r = confined("--out", dir, "--brand", kit, ...words);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${path.join(kit, name)} ${rule}\nlaunch-film: ${dir} is as it was.\n`);
    assert.deepEqual(snap(dir), before);
    // Into a new folder, none is made.
    const fresh = path.join(tmp(), "film");
    assert.equal(confined("--out", fresh, "--brand", kit, ...words).status, 1);
    assert.ok(!fs.existsSync(fresh));
    // Run by its user, the plan ends well and copies what the link leads to.
    assert.equal(cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, ...words).status, 0);
    assert.ok(fs.existsSync(path.join(dir, "brand", name)) && !fs.lstatSync(path.join(dir, "brand", name)).isSymbolicLink());
  }
  // A link that stays in the kit is followed, confined too.
  const inner = otherKit();
  fs.symlinkSync("logo-header.png", path.join(inner, "logo-link.png"));
  const dir = filmFolder();
  assert.equal(confined("--out", dir, "--brand", inner, ...words).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "brand", "logo-link.png")).length, fs.statSync(path.join(fixture, "logo-header.png")).size);
  // The folder's own brand/, which a plan without --brand copies for
  // easybrandkit: a link in it, and brand/ itself a link out of the folder.
  // The stand-in easybrandkit says so if it is ever run.
  const kit = path.join(tmp(), "easybrandkit.js");
  fs.writeFileSync(kit, 'process.stderr.write("easybrandkit ran\\n"); process.exit(1);');
  const own = filmFolder();
  fs.rmSync(path.join(own, "brand", "logo-header.png"));
  fs.symlinkSync(path.join(outside, "secret.png"), path.join(own, "brand", "logo-header.png"));
  const linked = filmFolder();
  fs.renameSync(path.join(linked, "brand"), path.join(outside, "kit"));
  fs.symlinkSync(path.join(outside, "kit"), path.join(linked, "brand"));
  const theirs = snap(outside);
  for (const [film, said] of [[own, `${path.join(own, "brand", "logo-header.png")} ${rule}`],
    [linked, `${path.join(linked, "brand")} leads out of the film's folder through a link, and LAUNCH_FILM_CONFINE allows only files in it`]]) {
    const before = snap(film, { links: true });
    const r = confined("--out", film, "--easybrandkit", kit, ...words);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${said}\nlaunch-film: ${film} is as it was.\n`);
    assert.deepEqual(snap(film, { links: true }), before);
  }
  assert.deepEqual(snap(outside), theirs);
});

test("a plan that fails makes no folder", () => {
  const base = tmp();
  const r = cli("plan", "https://acme-notes.example", "--out", path.join(base, "films", "acme"), "--easybrandkit", failingEasybrandkit(base));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(path.join(base, "films", "acme"))} was not made\\.\\n$`));
  assert.deepEqual(fs.readdirSync(base), ["easybrandkit.js"]);
});

test("a Ctrl-C that ends ffprobe as launch-film waits on it is told of as a stop", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  // frames reads the film with ffprobe first. Ctrl-C reaches every process
  // of the group at once, so it ends ffprobe while launch-film waits on it.
  const dir = tmp();
  const ffprobe = path.join(dir, "ffprobe");
  fs.writeFileSync(ffprobe, `#!/bin/sh\ncase "$*" in *-version*) exec ffprobe "$@";; esac\n: > "${path.join(dir, "started")}"\nsleep 20\nexec ffprobe "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "frames", path.join(dir, "film.mp4")], {
    detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LAUNCH_FILM_FFPROBE: ffprobe } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dir, "started")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  process.kill(-pidOf(child.pid), "SIGINT");
  const { code, signal } = await ended;
  assert.deepEqual({ code, signal, stderr }, { code: null, signal: "SIGINT", stderr: "launch-film: stopped\n" });
});

// A stand-in easybrandkit that starts a stand-in Chrome and waits, with no
// handler for a signal, as easybrandkit 0.4.0. Its Chrome makes its profile
// and its socket folder in the temp folder, as Chrome does, saves its pid
// in STAND_IN_PID, lets SIGTERM go, and on Ctrl-C removes its socket folder
// and ends a moment later.
function easybrandkitWithChrome(dir) {
  const chrome = path.join(dir, "chrome.js");
  fs.writeFileSync(chrome, `
const fs = require("fs");
const path = require("path");
const profile = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const sock = fs.mkdtempSync(path.join(process.env.TMPDIR, "com.google.Chrome."));
fs.writeFileSync(path.join(sock, "SingletonSocket"), "");
fs.symlinkSync(path.join(sock, "SingletonSocket"), path.join(profile, "SingletonSocket"));
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {
  if (process.env.STAND_IN_STUBBORN) return;
  fs.rmSync(path.join(profile, "SingletonSocket"));
  fs.rmSync(sock, { recursive: true });
  setTimeout(() => process.exit(0), 200);
});
${SAVES_PID}
savePid(process.env.STAND_IN_PID, process.pid);
${WAITS}
`);
  const kit = path.join(dir, "easybrandkit.js");
  fs.writeFileSync(kit, `
const fs = require("fs");
const os = require("os");
const path = require("path");
const profile = process.env.STAND_IN_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "easybrandkit-chrome-"));
require("child_process").spawn(process.execPath, [${JSON.stringify(chrome)}, "--headless=new", "--user-data-dir=" + profile], { stdio: "ignore" });
${WAITS}
`);
  return kit;
}

test("a plan stopped while easybrandkit reads the brand ends the Chrome easybrandkit started and removes its profile", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  // With a temp folder long enough that easybrandkit keeps to it, and one
  // short enough for easybrandkit to get a temp folder of the run's own.
  for (const [how, temp] of [["SIGTERM", tmp()], ["SIGINT", tmp()], ["SIGTERM", shortTmp()], ["SIGINT", shortTmp()]]) {
    const dir = filmFolder();
    const before = snap(dir);
    const pidFile = path.join(tmp(), "chrome.pid");
    const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
      { detached: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const chrome = await pidIn(pidFile);
    try {
      if (how === "SIGTERM") {
        // To launch-film alone: easybrandkit ends, its Chrome would not.
        child.kill("SIGTERM");
      } else {
        // Ctrl-C reaches every process of the group: easybrandkit ends at
        // once and its Chrome is moved out of its tree before launch-film
        // looks, so this comes a moment into the brand, as a Ctrl-C does.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        process.kill(-pidOf(child.pid), "SIGINT");
      }
      const { signal } = await ended;
      assert.equal(signal, how, stderr);
      assert.ok(stderr.endsWith(`launch-film: stopped, so ${dir} is as it was\n`), stderr);
      for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(!alive(chrome), `${how}: easybrandkit's Chrome is gone`);
      assert.deepEqual(fs.readdirSync(temp), [], `${how}: neither its profile nor its socket folder is left`);
      assert.deepEqual(snap(dir), before);
    } finally {
      end(chrome);
    }
  }
});

test("a Chrome that outlives easybrandkit at a Ctrl-C is ended by the profile it uses in the run's own temp folder", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const dir = filmFolder();
  const temp = shortTmp();
  const pidFile = path.join(tmp(), "chrome.pid");
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
    { detached: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile, STAND_IN_STUBBORN: "1" } });
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
  const chrome = await pidIn(pidFile);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.kill(-pidOf(child.pid), "SIGINT");
    assert.equal(await ended, "SIGINT");
    for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!alive(chrome), "its Chrome is gone");
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally {
    end(chrome);
  }
});

// A plan into the test's film folder whose easybrandkit starts its Chrome,
// stopped with SIGTERM to launch-film alone once that Chrome is up: the
// Chrome's pid, what the plan said, and a way to end that Chrome. `stub` is
// loaded into the CLI first.
async function planStoppedAtChrome({ temp, env = {}, stub = "" }) {
  const dir = filmFolder();
  const before = snap(dir);
  const work = tmp();
  const pidFile = path.join(work, "chrome.pid");
  const stubFile = path.join(work, "stub.js");
  fs.writeFileSync(stubFile, stub);
  const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", easybrandkitWithChrome(tmp())],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile, NODE_OPTIONS: `--require ${stubFile}`, ...env } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const chrome = await pidIn(pidFile);
  child.kill("SIGTERM");
  const { signal } = await ended;
  assert.equal(signal, "SIGTERM", stderr);
  assert.deepEqual(snap(dir), before);
  for (let i = 0; i < 50 && alive(chrome); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return { chrome, stillRuns: alive(chrome), end: () => end(chrome) };
}

test("a stop that comes before the first look at what easybrandkit started still ends its Chrome", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  // The looks four times a second never happen here, so the stop has to
  // look for itself as it begins, while easybrandkit's tree is whole.
  const temp = tmp();
  const plan = await planStoppedAtChrome({ temp, stub: "const real = global.setInterval; global.setInterval = (fn, ms, ...rest) => (ms === 250 ? { unref() {} } : real(fn, ms, ...rest));" });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.deepEqual(fs.readdirSync(temp), [], "neither its profile nor its socket folder is left");
  } finally {
    plan.end();
  }
});

test("a Chrome of easybrandkit's that uses a profile outside the temp folder is ended and its profile left", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const profile = path.join(tmp(), "a-chrome-profile-of-the-user's");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "Preferences"), "{}");
  const plan = await planStoppedAtChrome({ temp: tmp(), env: { STAND_IN_PROFILE: profile } });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.equal(fs.readFileSync(path.join(profile, "Preferences"), "utf8"), "{}");
  } finally {
    plan.end();
  }
});

test("a profile in the temp folder that is not this user's is left, whatever a process below easybrandkit names", { skip: process.platform !== "linux" && "/proc tells what easybrandkit started" }, async () => {
  const temp = tmp();
  const plan = await planStoppedAtChrome({ temp, stub: `const fs = require("fs"); const path = require("path"); const real = fs.lstatSync; fs.lstatSync = (at, ...rest) => { const s = real(at, ...rest); if (s && path.basename(String(at)).startsWith("easybrandkit-chrome-")) s.uid += 1; return s; };` });
  try {
    assert.ok(!plan.stillRuns, "easybrandkit's Chrome is gone");
    assert.equal(fs.readdirSync(temp).filter((n) => n.startsWith("easybrandkit-chrome-")).length, 1, fs.readdirSync(temp).join(", "));
  } finally {
    plan.end();
    for (const name of fs.readdirSync(temp)) fs.rmSync(path.join(temp, name), { recursive: true, force: true });
  }
});

test("a stop while a process still writes in easybrandkit's temp folder ends within a second", { skip: process.platform !== "linux" && "easybrandkit gets a temp folder of the run's own on Linux" }, async () => {
  // easybrandkit, with no handler for a signal, ends at the stop, while the
  // process it started writes on in its temp folder, as its Chrome does: a
  // removal then waits through all its retries. makersmcp kills a canceled
  // kit a second after the stop. Three tries, as a loaded machine can take
  // that long by itself; a removal that waits takes 1.5 s every time.
  const writer = `const fs = require("fs"); const path = require("path");
const at = (i) => path.join(process.env.TMPDIR, "f" + (i % 2000));
for (let i = 0; i < 2000; i++) fs.writeFileSync(at(i), "x");
${SAVES_PID}
savePid(process.env.STAND_IN_PID, process.pid);
for (let i = 0, t = Date.now(); Date.now() - t < 20000; i++) { try { fs.writeFileSync(at(i), "x"); } catch {} }`;
  let took = Infinity;
  for (let t = 0; t < 3 && took >= 1000; t++) {
    const work = tmp();
    const kit = path.join(work, "easybrandkit.js");
    fs.writeFileSync(kit, `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: "ignore" });\n${WAITS}`);
    const dir = filmFolder();
    const before = snap(dir);
    const temp = shortTmp();
    const pidFile = path.join(work, "writer.pid");
    const child = spawn(process.execPath, [path.join(root, "bin", "launch-film.js"), "plan", "https://acme-notes.example", "--out", dir, "--easybrandkit", kit],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, STAND_IN_PID: pidFile } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const writing = await pidIn(pidFile);
    try {
      assert.match(fs.readdirSync(temp).join(" "), /launch-film-brand-\d+-/, "it writes in the run's own temp folder");
      const sent = Date.now();
      child.kill("SIGTERM");
      const { signal } = await ended;
      took = Date.now() - sent;
      assert.equal(signal, "SIGTERM", stderr);
      assert.ok(stderr.endsWith(`launch-film: stopped, so ${dir} is as it was\n`), stderr);
      for (let i = 0; i < 50 && alive(writing); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(!alive(writing), "what wrote there is gone");
      assert.deepEqual(fs.readdirSync(temp), [], "nothing is left in the temp folder");
      assert.deepEqual(snap(dir), before);
    } finally {
      end(writing);
    }
  }
  assert.ok(took < 1000, `it ended ${took} ms after the stop`);
});

test("--verbose shows easybrandkit's words with the folder as it will be, not the part folder", () => {
  // A site's address, and a store listing, which easybrandkit reads too.
  for (const url of ["https://acme-notes.example", "https://apps.apple.com/us/app/acme-notes/id1234567"]) {
    const dir = filmFolder();
    const kit = path.join(tmp(), "easybrandkit.js");
    fs.writeFileSync(kit, `const fs = require("fs"); const out = process.argv[process.argv.indexOf("--out") + 1];
fs.cpSync(${JSON.stringify(fixture)}, out, { recursive: true, force: true });
const brand = JSON.parse(fs.readFileSync(out + "/brand.json", "utf8"));
brand.stores = [{ type: "appstore", ok: true, name: "Acme Notes" }];
fs.writeFileSync(out + "/brand.json", JSON.stringify(brand));
console.log("Saved the kit to " + out);
console.log("Read " + out + "/BRAND.md for the details.");`);
    const r = cli("plan", url, "--out", dir, "--easybrandkit", kit, "--words", path.join(fixture, "words.json"), "--verbose");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`Saved the kit to ${path.join(dir, "brand")}\nRead ${path.join(dir, "brand", "BRAND.md")} for the details.\n`), r.stderr);
    assert.ok(!r.stderr.includes(".launch-film-part-"), r.stderr);
  }
});

// A run whose plan is made and whose next step fails: Chrome does not start.
for (const [what, args] of [["the one-go command", []], ["stills of an address", ["stills"]]]) {
  test(`${what} puts the plan in with what it makes, or not at all`, { skip: (process.platform === "win32" && "the stand-in Chrome is a shell script") || (!available() && "ffmpeg not found") }, () => {
    const dir = filmFolder();
    const before = snap(dir);
    const r = cliWith({ LAUNCH_FILM_CHROME: noteChrome().chrome }, ...args, "https://acme-notes.example", "--out", dir, "--brand", otherKit(), "--words", path.join(fixture, "words.json"), "--look", "journal");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Planned \d+ clips/);
    assert.match(r.stderr, /Chrome stopped \(exit 1\)/);
    assert.match(r.stderr, new RegExp(`\\nlaunch-film: ${escape(dir)} is as it was\\.\\n$`));
    assert.deepEqual(snap(dir), before);
  });
}

test("a render stops on a track it refuses, before any Chrome is started", { skip: (process.platform === "win32" && "the stand-in Chrome is a shell script") || (!available() && "ffmpeg not found") }, () => {
  const dir = filmFolder();
  fs.rmSync(path.join(dir, "film.mp4"));
  const started = path.join(tmp(), "chrome-started");
  const chrome = path.join(tmp(), "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\n: > "${started}"\nexit 1\n`, { mode: 0o755 });
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  const render = (music) => {
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, music }));
    return cliWith({ LAUNCH_FILM_CHROME: chrome }, "render", path.join(dir, "film.json"));
  };
  const missing = render("no-such-track.wav");
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(missing.stderr, `launch-film: film.json has problems:\n  - "music" "no-such-track.wav" is not a file. It was looked for at ${path.join(dir, "no-such-track.wav")}, as a path there is read from film.json's folder: give the track's path from that folder or an absolute one (true plays the look's own music, false none)\n`);
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", path.join(dir, "short.wav")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  const short = render("short.wav");
  assert.equal(short.status, 1, short.stderr);
  assert.match(short.stderr, /^launch-film: film\.json has problems:\n {2}- "music" "short\.wav" lasts 1\.00 s and the film 2\.50 s: give a track at least as long as the film\./);
  assert.ok(!fs.existsSync(path.join(dir, "film.mp4")), "no film is made");
  assert.ok(!fs.existsSync(started), "no Chrome was started");
});

// An ffmpeg or ffprobe that will not open a file whose name holds a %, as
// the guards of makersmcp's hosted service do, and runs the real one for
// the rest. A hosted user's good track named so was told to give an audio
// file.
function guarded(name, real) {
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, `#!/bin/sh
for a in "$@"; do case "$a" in *%*) echo "kits ${name}: $a: an input named with % or ending in .y is not opened" >&2; exit 1;; esac; done
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  return file;
}

test("a track or a picture that ffmpeg or ffprobe will not open is refused in their own words, and one with no sound or no picture as before", { skip: (process.platform === "win32" && "the stand-ins are shell scripts") || (!available() && "ffmpeg not found") }, () => {
  const { FFPROBE } = require("../src/ffmpeg");
  const env = { LAUNCH_FILM_FFMPEG: guarded("ffmpeg", FFMPEG), LAUNCH_FILM_FFPROBE: guarded("ffprobe", FFPROBE) };
  const dir = filmFolder();
  fs.rmSync(path.join(dir, "film.mp4"));
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", path.join(dir, "100% mix.wav")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  fs.copyFileSync(path.join(fixture, "screenshot-1.png"), path.join(dir, "50% off.png"));
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  const chrome = noteChrome();
  const render = (changes) => {
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, ...changes }));
    return cliWith({ ...env, LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"));
  };
  const track = render({ music: "100% mix.wav" });
  assert.equal(track.status, 1, track.stderr);
  assert.equal(track.stderr, `launch-film: film.json has problems:\n  - "music" "100% mix.wav" could not be read: ffmpeg failed: kits ffmpeg: ${path.join(dir, "100% mix.wav")}: an input named with % or ending in .y is not opened\n`);
  // A picture where the track goes holds no sound, as ffmpeg itself says.
  const picture = render({ music: "brand/logo-header.png" });
  assert.equal(picture.stderr, 'launch-film: film.json has problems:\n  - "music" "brand/logo-header.png" has no sound ffmpeg can read: give an audio file, such as a WAV, MP3, M4A or FLAC file, or a video with sound\n');
  // A screen clip's picture whose name holds a %.
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, music: false, clips: [{ kind: "screen", seconds: 2.5, image: "50% off.png" }] }));
  const before = snap(dir);
  const screen = cliWith({ ...env, LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"));
  assert.equal(screen.status, 1, screen.stderr);
  assert.equal(screen.stderr, `launch-film: ${path.join(dir, "50% off.png")} could not be read as a picture (ffprobe failed: kits ffprobe: ${path.join(dir, "50% off.png")}: an input named with % or ending in .y is not opened)\nlaunch-film: ${dir} is as it was.\n`);
  // With no ffprobe at all, it says so before any work.
  const none = cliWith({ LAUNCH_FILM_FFPROBE: path.join(dir, "no-such-ffprobe"), LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"));
  assert.equal(none.stderr, `launch-film needs ffprobe, and LAUNCH_FILM_FFPROBE points to ${path.join(dir, "no-such-ffprobe")}, which is not there. ` +
    "Set LAUNCH_FILM_FFPROBE to the ffprobe of an ffmpeg 4.4 or newer, or unset it and install ffmpeg, which comes with one (brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg).\n");
  assert.deepEqual(snap(dir), before);
  assert.ok(!chrome.started(), "no Chrome was started");
});

// A film ffprobe would not read for a reason of its own was said to be no
// video, as a picture and a track were: a good film read as a broken one.
test("check and frames say why ffprobe would not read a film, as a guard that opens no name with a % in it, or a film the user may not read", { skip: (process.platform === "win32" && "the stand-ins are shell scripts") || (!available() && "ffmpeg not found") }, () => {
  const { FFPROBE } = require("../src/ffmpeg");
  const dir = tmp();
  const film = path.join(dir, "50% promo.mp4");
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1", "-pix_fmt", "yuv420p", film], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  const guard = guarded("ffprobe", FFPROBE);
  for (const command of ["check", "frames"]) {
    const r = cliWith({ LAUNCH_FILM_FFPROBE: guard }, command, film, "--out", path.join(dir, command));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${film} could not be read as a video (ffprobe failed: kits ffprobe: ${film}: an input named with % or ending in .y is not opened)\n`, command);
    assert.ok(!fs.existsSync(path.join(dir, command)), command);
  }
  if (process.getuid && process.getuid() !== 0) {
    const locked = path.join(dir, "locked.mp4");
    fs.copyFileSync(film, locked);
    fs.chmodSync(locked, 0o000);
    for (const command of ["check", "frames"]) {
      const r = cliWith({}, command, locked, "--out", path.join(dir, command));
      assert.equal(r.stderr, `launch-film: ${locked} could not be read as a video (ffprobe failed: ${locked}: Permission denied)\n`, command);
    }
  }
});

// A film given to check or frames is read by ffprobe and ffmpeg as a track
// or a picture is: a DASH manifest behind an ID3v2 tag, named film.mp4, made
// both open a film of another job's.
test("with LAUNCH_FILM_CONFINE set, check and frames refuse a film that is a list of other files before ffprobe opens it", { skip: (process.platform === "win32" && "the stand-in is a shell script") || (!available() && "ffmpeg not found") }, () => {
  const { FFPROBE } = require("../src/ffmpeg");
  const dir = tmp();
  const outside = path.join(tmp(), "other-job.mp4");
  const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1", "-pix_fmt", "yuv420p", outside], { encoding: "utf8", timeout: 30_000 });
  assert.equal(made.status, 0, made.stderr);
  const film = path.join(dir, "film.mp4");
  fs.writeFileSync(film, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]), Buffer.from(`<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ` +
    `profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1">` +
    `<BaseURL>${outside}</BaseURL></Representation></AdaptationSet></Period></MPD>\n`)]));
  const opened = path.join(dir, "opened");
  const probe = path.join(tmp(), "ffprobe");
  fs.writeFileSync(probe, `#!/bin/sh\ncase " $* " in *" ${film} "*) : > '${opened}';; esac\nexec ${JSON.stringify(FFPROBE)} "$@"\n`, { mode: 0o755 });
  for (const command of ["check", "frames"]) {
    const r = cliWith({ LAUNCH_FILM_CONFINE: "1", LAUNCH_FILM_FFPROBE: probe }, command, film, "--out", path.join(dir, command));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${film} is a DASH manifest, whose files ffmpeg would open wherever they are, which LAUNCH_FILM_CONFINE does not allow: give the film itself\n`, command);
    assert.ok(!fs.existsSync(path.join(dir, command)), `${command}: its folder was made`);
    assert.ok(!fs.existsSync(opened), `${command}: ffprobe opened the film`);
  }
});

// A Chrome that notes it was started and fails, in place of the real one.
function noteChrome() {
  const started = path.join(tmp(), "chrome-started");
  const chrome = path.join(tmp(), "chrome");
  fs.writeFileSync(chrome, `#!/bin/sh\n: > "${started}"\nexit 1\n`, { mode: 0o755 });
  return { chrome, started: () => fs.existsSync(started) };
}

// An earlier file the user made read-only is not replaced: the commit
// refused it, after a render's clips or a plan's read of the site.
test("an earlier film or plan the user made read-only refuses a render or a plan before any work", { skip: (process.platform === "win32" || process.getuid() === 0 || !available()) && "a file its user may not write, and ffmpeg" }, () => {
  const dir = filmFolder();
  fs.chmodSync(path.join(dir, "film.mp4"), 0o444);
  const before = snap(dir);
  const chrome = noteChrome();
  const render = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"));
  assert.equal(render.status, 1, render.stderr);
  assert.equal(render.stderr, `launch-film: ${path.join(dir, "film.mp4")} may not be written (EACCES), so the run would not replace it: make it writable or remove it, and run again\n`);
  fs.chmodSync(path.join(dir, "words.json"), 0o444);
  const plan = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "plan", "https://acme-notes.example", "--out", dir, "--brand", fixture, "--words", path.join(fixture, "words.json"));
  assert.equal(plan.status, 1, plan.stderr);
  assert.equal(plan.stderr, `launch-film: ${path.join(dir, "words.json")} may not be written (EACCES), so the run would not replace it: make it writable or remove it, and run again\n`);
  const film = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "https://acme-notes.example", "--out", dir, "--brand", fixture, "--words", path.join(fixture, "words.json"));
  assert.equal(film.status, 1, film.stderr);
  assert.equal(film.stderr, plan.stderr);
  assert.deepEqual(snap(dir), before);
  assert.ok(!chrome.started(), "a Chrome was started");
});

test("a render refuses an --output it could not write the film to before any Chrome is started", { skip: (process.platform === "win32" && "the stand-in Chrome is a shell script") || (!available() && "ffmpeg not found") }, () => {
  const dir = filmFolder();
  fs.rmSync(path.join(dir, "film.mp4"));
  fs.mkdirSync(path.join(dir, "adir"));
  fs.writeFileSync(path.join(dir, "adir", "notes.txt"), "the user's");
  const chrome = noteChrome();
  const before = snap(dir);
  const render = (...args) => cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"), ...args);
  const out = (name) => path.join(dir, name);
  for (const [name, said] of [
    [".launch-film-x.mp4", `--output ${out(".launch-film-x.mp4")}: a name that starts with .launch-film- is one of launch-film's own: give another`],
    ["adir", `--output ${out("adir")} is a folder: give the film's file in it, such as ${path.join(out("adir"), "film.mp4")}`],
    ["noext", `--output ${out("noext")} has no extension, so ffmpeg cannot tell what kind of file to write: give a name that ends in .mp4`],
    ["film.webm", `--output ${out("film.webm")}: ffmpeg cannot write the film as a .webm file (H.264 video and AAC sound): give a name that ends in .mp4, .mov or .mkv`],
  ]) {
    const r = render("--output", out(name));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${said}\n`, name);
  }
  // The film's own place, when a folder holds it.
  fs.mkdirSync(out("film.mp4"));
  const taken = render();
  assert.equal(taken.stderr, `launch-film: ${out("film.mp4")} is a folder, where the film goes: move it, or give --output another file\n`);
  fs.rmdirSync(out("film.mp4"));
  assert.ok(!chrome.started(), "no Chrome was started");
  assert.deepEqual(snap(dir), before);
  // A kind of file ffmpeg writes the film in goes on to the render.
  const avi = render("--output", out("film.avi"));
  assert.match(avi.stderr, /^launch-film: rendering clip 1: Chrome stopped \(exit 1\)/);
  assert.ok(chrome.started());
});

test("an --output of another kind is refused for its kind only when ffmpeg refuses it and writes the same frame as an .mp4", { skip: (process.platform === "win32" && "the stand-in ffmpeg and Chrome are shell scripts") || (!available() && "ffmpeg not found") }, () => {
  const dir = filmFolder();
  fs.rmSync(path.join(dir, "film.mp4"));
  const before = snap(dir);
  // A line of sh that may answer for ffmpeg first, then the real one.
  const ffmpeg = (line) => {
    const file = path.join(tmp(), "ffmpeg");
    fs.writeFileSync(file, `#!/bin/sh\n${line}\nexec '${FFMPEG.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
    return file;
  };
  const render = (stand, name) => {
    const chrome = noteChrome();
    const r = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome, LAUNCH_FILM_FFMPEG: stand }, "render", path.join(dir, "film.json"), "--output", path.join(dir, name));
    return { status: r.status, stderr: r.stderr, started: chrome.started() };
  };
  // An ffmpeg that cannot be started fails the render in the words it has
  // for a film.mp4, where it was refused as one that cannot write a .avi.
  const none = path.join(tmp(), "no-such-ffmpeg");
  const avi = render(none, "film.avi");
  assert.equal(avi.status, 1, avi.stderr);
  assert.ok(!avi.stderr.includes("cannot write the film as"), avi.stderr);
  assert.equal(avi.stderr, render(none, "film.mp4").stderr);
  // One that cannot write H.264 at all, and one a signal ends during the
  // try, say nothing about the kind either: the render goes on to Chrome.
  for (const line of [`case "$*" in *libx264*) echo "Unknown encoder 'libx264'" >&2; exit 1;; esac`, `case "$*" in *film.avi*) kill -KILL $$;; esac`]) {
    const r = render(ffmpeg(line), "film.avi");
    assert.match(r.stderr, /^launch-film: rendering clip 1: Chrome stopped \(exit 1\)/, line);
    assert.ok(r.started, line);
  }
  assert.deepEqual(snap(dir), before);
});

test("a clip's picture that is no picture is refused before the clip renders, and the folder is left as it was", { skip: (process.platform === "win32" && "the stand-in Chrome is a shell script") || (!available() && "ffmpeg not found") }, () => {
  // A screen clip once rendered an empty page here, and the render ended
  // well. The phone clip already refused such a file.
  const dir = filmFolder();
  fs.writeFileSync(path.join(dir, "notes.png"), "not a picture");
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  const chrome = noteChrome();
  for (const clip of [{ kind: "screen", seconds: 2.5, image: "notes.png" }, { kind: "shots", seconds: 2.5, images: ["notes.png"] }, { kind: "phone", seconds: 2.5, image: "notes.png" }]) {
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, clips: [clip] }));
    const before = snap(dir);
    const r = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "render", path.join(dir, "film.json"));
    assert.equal(r.stderr, `launch-film: ${path.join(dir, "notes.png")} could not be read as a picture\nlaunch-film: ${dir} is as it was.\n`, clip.kind);
    assert.deepEqual(snap(dir), before);
  }
  // The stills draw the film's screen too.
  fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ ...film, clips: [{ kind: "screen", seconds: 2.5, image: "notes.png" }, ...film.clips] }));
  const stills = cliWith({ LAUNCH_FILM_CHROME: chrome.chrome }, "stills", path.join(dir, "film.json"), "--for", "og");
  assert.equal(stills.stderr, `launch-film: ${path.join(dir, "notes.png")} could not be read as a picture\nlaunch-film: ${path.join(dir, "stills")} was not made.\n`);
  assert.ok(!fs.existsSync(path.join(dir, "stills")));
  assert.ok(!chrome.started(), "no Chrome was started");
});

test("a folder asked for inside a file is refused as the file it is, and nothing is made", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "afile"), "the user's");
  for (const out of [path.join(dir, "afile", "sub"), path.join(dir, "afile", "sub", "deeper")]) {
    const r = cli("plan", "https://acme-notes.example", "--out", out, "--brand", fixture, "--words", path.join(fixture, "words.json"));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `launch-film: ${path.join(dir, "afile")} is a file, not a folder\n`);
  }
  assert.deepEqual(fs.readdirSync(dir), ["afile"]);
});

test("a plan into a folder already there writes the path of a file outside the kit so the film finds it", () => {
  // A kit whose brand.json names its screen by an absolute path outside it.
  const kit = otherKit();
  const shared = path.join(path.dirname(kit), "shared");
  fs.mkdirSync(shared);
  fs.renameSync(path.join(kit, "screenshot-1.png"), path.join(shared, "screen.png"));
  const brand = JSON.parse(fs.readFileSync(path.join(kit, "brand.json"), "utf8"));
  brand.screenshots[0].file = path.join(shared, "screen.png");
  fs.writeFileSync(path.join(kit, "brand.json"), JSON.stringify(brand));
  const dir = filmFolder();
  const r = cli("plan", "https://acme-notes.example", "--out", dir, "--brand", kit, "--words", path.join(kit, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  const film = JSON.parse(fs.readFileSync(path.join(dir, "film.json"), "utf8"));
  assert.ok(film.clips.some((c) => c.image && path.resolve(dir, c.image) === path.join(shared, "screen.png")), JSON.stringify(film.clips.map((c) => c.image || c.logo || c.icon).filter(Boolean)));
  const { loadFilm } = require("../src/film");
  assert.deepEqual(loadFilm(path.join(dir, "film.json")).problems, []);
});

test("an option's value is all that follows its first =", () => {
  // The folder's name holds an =: cut there, the plan would land on the
  // film in a folder named "my".
  const base = tmp();
  fs.mkdirSync(path.join(base, "my"));
  fs.writeFileSync(path.join(base, "my", "film.json"), "another film's plan");
  const r = cli("plan", "https://acme-notes.example", `--out=${base}/my=film`, `--brand=${fixture}`, "--words", path.join(fixture, "words.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(base, "my=film", "film.json")));
  assert.equal(fs.readFileSync(path.join(base, "my", "film.json"), "utf8"), "another film's plan");
});

// What each command takes, as its refusal lists it.
const TAKES = {
  check: "--out, --expect, --seconds, --lufs, --cues, --cuts and --allow",
  plan: "--out, --brand, --words, --easybrandkit, --look, --seconds, --aspect, --no-music, --no-sfx and --verbose",
  url: "--out, --brand, --words, --easybrandkit, --look, --seconds, --aspect, --no-music, --no-sfx, --verbose, --jobs and --keep",
};

test("an option a command does not take, or a value it cannot use, is refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const url = "https://acme-notes.example";
  const out = path.join(dir, "out");
  const plan = ["plan", url, "--out", out, "--brand", fixture, "--words", path.join(fixture, "words.json")];
  for (const [args, said] of [
    // Values that were put right or dropped without a word.
    [[...plan, "--aspect", "4:3"], '--aspect "4:3": choose 16:9 or 9:16'],
    [[...plan, "--aspect", "9:16 "], '--aspect "9:16 ": choose 16:9 or 9:16'],
    [[...plan, "--seconds", "abc"], '--seconds "abc": give a length from 20 to 40 seconds, such as 30'],
    [[...plan, "--seconds", "1e9"], '--seconds "1e9": give a length from 20 to 40 seconds, such as 30'],
    [[...plan, "--seconds", "15"], '--seconds "15": give a length from 20 to 40 seconds, such as 30'],
    [[url, "--out", out, "--seconds", "41"], '--seconds "41": give a length from 20 to 40 seconds, such as 30'],
    [["stills", url, "--out", out, "--aspect", "1:1"], '--aspect "1:1": choose 16:9 or 9:16'],
    [["render", film, "--jobs", "0"], '--jobs "0": give a whole number from 1 to 4'],
    [["render", film, "--jobs", "abc"], '--jobs "abc": give a whole number from 1 to 4'],
    [["render", film, "--jobs", "8"], '--jobs "8": give a whole number from 1 to 4'],
    [[url, "--out", out, "--jobs", "1.5"], '--jobs "1.5": give a whole number from 1 to 4'],
    [["render", film, "--keep=false"], "--keep takes no value: give it alone, or leave it out"],
    [[...plan, "--verbose=yes"], "--verbose takes no value: give it alone, or leave it out"],
    [["check", "film.mp4", "--expect", "0x0@0"], '--expect "0x0@0": the size and the frame rate must be above 0, as in 1920x1080@30'],
    [["check", "film.mp4", "--expect", "1920x1080@0"], '--expect "1920x1080@0": the size and the frame rate must be above 0, as in 1920x1080@30'],
    [["check", "film.mp4", "--expect", "0x1080"], '--expect "0x1080": the size and the frame rate must be above 0, as in 1920x1080@30'],
    // Options a command does not take.
    [["check", "film.mp4", "--outt", out], `--outt is not an option of launch-film check, which takes ${TAKES.check}.`],
    [["render", film, "--music", "track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["plan", url, "--out", out, "--music=track.wav"], '--music is not an option: a film plays what "music" in film.json says. Give the path of the track there, from film.json\'s folder or absolute'],
    [["render", film, "--no-music"], '--no-music is for a plan: a render plays what "music" in film.json says. Set it to false there and render again'],
    [["render", film, "--no-sfx"], '--no-sfx is for a plan: a render plays what "sfx" in film.json says. Set it to false there and render again'],
    [["render", film, "--out", out], "--out is not an option of launch-film render, which takes --jobs, --keep and --output."],
    [["plan", url, "--out", out, "--jobs", "1"], `--jobs is not an option of launch-film plan, which takes ${TAKES.plan}.`],
    [["frames", "film.mp4", "--for", "og"], "--for is not an option of launch-film frames, which takes --out."],
    [["stills", film, "--look", "pop"], "--look is not an option of launch-film stills <film.json>, which takes --for and --easybrandkit."],
    [[url, "--out", out, "--output", path.join(dir, "movie.mp4")], `--output is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [["looks", "--everything"], "--everything is not an option of launch-film looks, which takes no options."],
    [["plan", url, "--out", out, "--__proto__", "x"], `--__proto__ is not an option of launch-film plan, which takes ${TAKES.plan}.`],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    // A message that names launch-film first says it once.
    assert.equal(r.stderr, `${said.startsWith("launch-film ") ? "" : "launch-film: "}${said}\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an option given without its value is refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const url = "https://acme-notes.example";
  const out = path.join(dir, "out");
  const words = path.join(fixture, "words.json");
  for (const [args, option] of [
    [["check", "a.mp4", "--out", "--lufs", "-14"], "--out"],
    [["check", "a.mp4", "--seconds"], "--seconds"],
    [["check", "a.mp4", "--out="], "--out"],
    [["check", "a.mp4", "--out", ""], "--out"],
    [["plan", url, "--out", out, "--brand", "--words", words], "--brand"],
    [["plan", url, "--out", out, "--brand=", "--words="], "--brand"],
    [["plan", url, "--look"], "--look"],
    [["render", film, "--jobs"], "--jobs"],
    [["render", film, "--output="], "--output"],
    [["frames", "a.mp4", "--out"], "--out"],
    [["stills", film, "--for"], "--for"],
    [[url, "--aspect", "--no-sfx"], "--aspect"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, `launch-film: ${option} needs a value\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  // What a command does not take is told of as that first.
  assert.equal(cli("render", film, "--out").stderr, "launch-film: --out is not an option of launch-film render, which takes --jobs, --keep and --output.\n");
  // A value given with = can start with two dashes.
  assert.match(cli("check", path.join(dir, "no-such.mp4"), "--out=--a-folder").stderr, /no-such\.mp4/);
});

test("a word that starts with a dash and an argument past the ones a command reads are refused by name, and nothing is made", () => {
  const dir = tmp();
  const film = path.join(dir, "film.json");
  const other = path.join(dir, "other");
  const url = "https://acme-notes.example";
  for (const [args, said] of [
    [["check", "a.mp4", "-o", "x"], `-o is not an option of launch-film check, which takes ${TAKES.check}.`],
    [["plan", url, "-x"], `-x is not an option of launch-film plan, which takes ${TAKES.plan}.`],
    [["-x"], `-x is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [[url, "-"], `- is not an option of launch-film <url>, which takes ${TAKES.url}.`],
    [["check", "a.mp4", other, "--out", path.join(dir, "out")], `launch-film check takes one film, so "${other}" would not be read.`],
    [["render", film, other], `launch-film render takes one film.json, so "${other}" would not be read.`],
    [["frames", "a.mp4", other], `launch-film frames takes one film, so "${other}" would not be read.`],
    [["stills", film, other], `launch-film stills <film.json> takes one address or film.json, so "${other}" would not be read.`],
    [["stills", url, other], `launch-film stills takes one address or film.json, so "${other}" would not be read.`],
    [["plan", url, other], `launch-film plan takes one address, so "${other}" would not be read.`],
    [[url, other], `launch-film <url> takes one address, so "${other}" would not be read.`],
    [["looks", other], `launch-film looks takes no arguments, so "${other}" would not be read.`],
    [["types", other], `launch-film types takes no arguments, so "${other}" would not be read.`],
    [["doctor", other], `launch-film doctor takes no arguments, so "${other}" would not be read.`],
    [["icons", "rocket", "launch"], 'launch-film icons takes one word, so "launch" would not be read.'],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    // A message that names launch-film first says it once.
    assert.equal(r.stderr, `${said.startsWith("launch-film ") ? "" : "launch-film: "}${said}\n`, args.join(" "));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  // A first word that is neither a command nor an address is told of as that.
  assert.equal(cli("rendr", film).stderr, 'launch-film: "rendr" is not a command or an address. Run launch-film --help.\n');
  // -h and -v are options of every command, and a value can start with a dash.
  assert.match(cli("-h").stdout, /^launch-film: a 20-40 second/);
  assert.equal(cli("-v").stdout, `${require("../package.json").version}\n`);
  assert.doesNotMatch(cli("check", path.join(dir, "no-such.mp4"), "--lufs", "-14").stderr, /needs a value|is not an option/);
});

test("the texts name easybrandkit's script as its package has it, and --help lists --verbose", () => {
  const help = cli("--help").stdout;
  assert.match(help, /--verbose/);
  for (const text of [help, fs.readFileSync(path.join(root, "src", "brand.js"), "utf8"), fs.readFileSync(path.join(root, "skills", "launch-film", "SKILL.md"), "utf8")]) {
    assert.match(text, /skills\/easybrandkit\/scripts\/easybrandkit\.js/);
    assert.doesNotMatch(text, /(?<!skills\/easybrandkit\/)scripts\/easybrandkit\.js/);
  }
});

test("every option a command takes gets past the refusal, also as makersmcp gives them", () => {
  const dir = tmp();
  const none = path.join(dir, "none.json");
  // An option the command does not take, or a value it cannot use.
  const notAnOption = /is not an option|is for a plan|needs a value|would not be read|takes no value|choose 16:9 or 9:16|from 20 to 40|from 1 to 4|above 0/;
  const url = "https://acme-notes.example";
  const kit = path.join(dir, "no-such-kit");
  const plans = ["--out", path.join(dir, "out"), "--brand", kit, "--words", path.join(fixture, "words.json"), "--easybrandkit", "ebk", "--look", "pop", "--seconds", "20", "--aspect", "9:16", "--no-music", "--no-sfx", "--verbose"];
  for (const args of [
    [url, ...plans, "--jobs", "2", "--keep"],
    [url, "--out", path.join(dir, "out"), "--brand", kit, "--seconds", "40", "--aspect", "16:9", "--jobs", "4"],
    ["plan", url, "--out", path.join(dir, "out"), "--brand", kit, "--seconds", "30.5"],
    ["plan", url, ...plans],
    ["stills", url, ...plans, "--for", "og"],
    ["stills", none, "--for", "og", "--easybrandkit", "ebk"],
    ["render", none, "--jobs", "1", "--keep", "--output", path.join(dir, "m.mp4")],
    ["frames", none, "--out", path.join(dir, "f")],
    ["check", none, "--out", path.join(dir, "c"), "--expect", "1920x1080@25", "--seconds", "20-40", "--lufs", "-14", "--cues", none, "--cuts", "1,2", "--allow", "1-2"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(!notAnOption.test(r.stderr), r.stderr);
  }
  // --keep and --verbose take no value: what follows them is read as usual.
  assert.match(cli("plan", url, "--verbose", "--brand", kit, "--out", path.join(dir, "out")).stderr, /no brand\.json at/);
});

test("a look or a place named as one of JavaScript's own properties is refused", () => {
  const dir = tmp();
  const r = cli("plan", "https://acme-notes.example", "--out", path.join(dir, "out"), "--brand", fixture, "--words", path.join(fixture, "words.json"), "--look", "constructor");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, 'launch-film: --look "constructor": choose from launch, aurora, gridline, pop, journal\n');
  // A first word named so is no command, with an option of a command's.
  for (const [word, ...rest] of [["toString", "--out", path.join(dir, "x")], ["constructor", "--look", "launch"], ["hasOwnProperty", "--jobs", "2"]]) {
    const named = cli(word, ...rest);
    assert.equal(named.status, 1, named.stderr);
    assert.equal(named.stderr, `launch-film: "${word}" is not a command or an address. Run launch-film --help.\n`);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  const { parseTargets } = require("../src/stills");
  assert.throws(() => parseTargets("constructor"), /--for "constructor": choose from ph, og, x, play, chrome/);
  const { loadFilm } = require("../src/film");
  const { parseScene } = require("../src/scene");
  const file = path.join(dir, "film.json");
  fs.writeFileSync(file, JSON.stringify({ look: "toString", clips: [{ kind: "scene", seconds: 3, scene: { type: "headline", title: "A title" } }] }));
  assert.deepEqual(loadFilm(file).problems.filter((p) => !p.includes("clips[0].scene")), ['"look" must be one of launch, aurora, gridline, pop, journal']);
  assert.match(parseScene({ type: "constructor" }).problems[0], /^"type" must be one of/);
  assert.match(parseScene({ type: "headline", title: "A title", look: "valueOf" }).problems[0], /^"look" must be one of/);
  assert.match(parseScene({ type: "features", items: [{ icon: "constructor", title: "A" }, { icon: "constructor", title: "B" }] }).problems[0], /"constructor" is not an icon/);
});

// A Chrome that answers every call on the DevTools pipe and ends when it is
// asked to close.
function answeringChrome() {
  const file = path.join(tmp(), "chrome");
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require("fs");
let buf = "";
fs.createReadStream("", { fd: 3 }).on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\0")) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i));
    fs.writeSync(4, JSON.stringify({ id: msg.id, result: {} }) + "\\0");
    if (msg.method === "Browser.close") process.exit(0);
  }
});
${WAITS}
`, { mode: 0o755 });
  return file;
}
// An ffmpeg that says it is this version.
function ffmpegOf(version) {
  const file = path.join(tmp(), "ffmpeg");
  fs.writeFileSync(file, `#!/bin/sh\necho 'ffmpeg version ${version} Copyright (c) 2000-2022 the FFmpeg developers'\n`, { mode: 0o755 });
  return file;
}
const doctor = (env) => spawnSync(process.execPath, [path.join(root, "bin", "launch-film.js"), "doctor"], { encoding: "utf8", timeout: 90_000, env: { ...process.env, ...env } });

test("doctor says when ffmpeg is older than 4.4, and passes a version it cannot read", { skip: process.platform === "win32" && "the stand-in ffmpeg is a shell script" }, () => {
  const chrome = answeringChrome();
  const old = doctor({ LAUNCH_FILM_FFMPEG: ffmpegOf("4.2.7-0ubuntu0.1"), LAUNCH_FILM_CHROME: chrome });
  assert.match(old.stdout, /^ffmpeg {2}4\.2\.7-0ubuntu0\.1 \(4\.4 or newer is needed\)$/m);
  assert.equal(old.status, 1);
  for (const version of ["4.4.2-0ubuntu0.22.04.1", "n7.1", "N-112233-gabcdef0"]) {
    const r = doctor({ LAUNCH_FILM_FFMPEG: ffmpegOf(version), LAUNCH_FILM_CHROME: chrome });
    assert.match(r.stdout, new RegExp(`^ffmpeg {2}${escape(version)}$`, "m"));
    assert.equal(r.status, 0, r.stdout);
  }
});

// Since Chrome keeps its sandbox, a Chrome that cannot start one fails every
// render and stills, and doctor, which only looked for the file, passed.
test("doctor starts Chrome, and fails with what to do when Chrome cannot start its sandbox", { skip: process.platform === "win32" && "the stand-ins are scripts" }, () => {
  const ffmpeg = ffmpegOf("4.4.2-0ubuntu0.22.04.1");
  const sandbox = path.join(tmp(), "chrome");
  fs.writeFileSync(sandbox, "#!/bin/sh\necho '[14:14:1110/174151.699093:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:242] Zygote process exited prematurely with exit code 82 (setuid sandbox: failed to move to new namespaces)' >&2\nkill -ABRT $$\n", { mode: 0o755 });
  const temp = tmp();
  const failed = doctor({ LAUNCH_FILM_FFMPEG: ffmpeg, LAUNCH_FILM_CHROME: sandbox, TMPDIR: temp });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stdout, new RegExp(`^chrome {2}${escape(sandbox)}: Chrome could not start its sandbox \\(Zygote process exited prematurely with exit code 82 \\(setuid sandbox: failed to move to new namespaces\\)\\)\\. ` +
    "Run launch-film where Chrome's sandbox can start: Google Chrome's own package sets it up, and a container needs --security-opt seccomp=unconfined$", "m"));
  // One that starts passes, and leaves no profile behind.
  const started = doctor({ LAUNCH_FILM_FFMPEG: ffmpeg, LAUNCH_FILM_CHROME: answeringChrome(), TMPDIR: temp });
  assert.equal(started.status, 0, started.stdout);
  assert.deepEqual(fs.readdirSync(temp), []);
  // And so does this machine's own Chrome, where it keeps its sandbox.
  const { findChrome } = require("../src/chrome");
  if (findChrome() && process.platform === "linux" && process.getuid() !== 0) {
    const real = doctor({ LAUNCH_FILM_FFMPEG: ffmpeg, TMPDIR: temp });
    assert.equal(real.status, 0, real.stdout);
    assert.match(real.stdout, new RegExp(`^chrome {2}${escape(findChrome())}$`, "m"));
    assert.deepEqual(fs.readdirSync(temp), []);
  }
});
