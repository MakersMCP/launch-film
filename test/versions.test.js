"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const { version } = JSON.parse(read("package.json"));

// The skill runs the CLI release it was written for, so the commands it
// describes are the ones that run. A release bumps it with package.json.
test("the skill runs the release in package.json", () => {
  const pinned = [...read("skills/launch-film/SKILL.md").matchAll(/launch-film@([\w.-]*\w)/g)].map((m) => m[1]);
  assert.ok(pinned.length > 0);
  assert.deepEqual([...new Set(pinned)], [version]);
});

test("the plugin manifests and the lockfile carry the same version", () => {
  for (const file of [".claude-plugin/marketplace.json", ".codex-plugin/plugin.json", "plugin.json"]) {
    const manifest = JSON.parse(read(file));
    assert.equal((manifest.plugins ? manifest.plugins[0] : manifest).version, version, file);
  }
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, version, "package-lock.json");
  assert.equal(lock.packages[""].version, version, "package-lock.json, its root package");
});

// The repository moved to github.com/MakersMCP with the kits it links to,
// and npm checks the repository package.json names against the one a
// release is published from. The addresses of the person stay.
test("every address of the repository and of the kits it links to names github.com/MakersMCP", () => {
  assert.equal(JSON.parse(read("package.json")).repository.url, "git+https://github.com/MakersMCP/launch-film.git");
  for (const file of ["package.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json", "plugin.json", "README.md", "THIRD_PARTY.md", "skills/launch-film/SKILL.md", "src/brand.js"]) {
    assert.deepEqual(read(file).match(/\bEminBudak\/[\w.-]+/g) || [], [], file);
  }
});
