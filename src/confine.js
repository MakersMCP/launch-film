"use strict";
// ─── files a film.json or brand.json names ─────────────────────────────────
// Run by its own user, launch-film reads any file a film.json or brand.json
// names: a track kept elsewhere, a kit's logo by an absolute path. Where it
// runs for others, who give it these files (makersmcp's hosted service),
// LAUNCH_FILM_CONFINE is set, to anything but 0, and such a file may name
// only files in its own folder. A name that is absolute or climbs with ..
// and lands outside the folder is refused, however long it is and whether
// or not anything is there, and so is one in the folder that a link leads
// out of it.

const fs = require("fs");
const path = require("path");

function confined() {
  const value = process.env.LAUNCH_FILM_CONFINE;
  return value !== undefined && value !== "" && value !== "0";
}

const inside = (folder, at) => {
  const rel = path.relative(folder, at);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// Why `name`, which `of` names from its folder `folder`, may not be read:
// "is outside <of>'s folder", "leads out of <of>'s folder through a link",
// or null when it may be read, as always without LAUNCH_FILM_CONFINE. A
// name that is not there passes, to be told of as missing.
function outside(folder, name, of) {
  if (!confined()) return null;
  const at = path.resolve(folder, String(name));
  if (!inside(folder, at)) return `is outside ${of}'s folder`;
  let real;
  try {
    real = fs.realpathSync(at);
  } catch {
    return null;
  }
  let base = folder;
  try {
    base = fs.realpathSync(folder);
  } catch {
    // The folder as it is named.
  }
  return inside(base, real) ? null : `leads out of ${of}'s folder through a link`;
}

// A name as it is said in a message: one that runs to thousands of
// characters, as one made to slip past a check, is cut in the middle.
const said = (name) => {
  const text = String(name);
  return text.length > 100 ? `${text.slice(0, 50)}...${text.slice(-40)}` : text;
};

module.exports = { confined, outside, said };
