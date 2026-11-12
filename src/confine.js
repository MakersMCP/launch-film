"use strict";
// ─── files a film.json or brand.json names ─────────────────────────────────
// Run by its own user, launch-film reads any file a film.json or brand.json
// names: a track kept elsewhere, a kit's logo by an absolute path. Where it
// runs for others, who give it these files (makersmcp's hosted service),
// LAUNCH_FILM_CONFINE is set, to anything but 0, and such a file may name
// only files in its own folder. A name that is absolute or climbs with ..
// and lands outside the folder is refused, however long it is and whether
// or not anything is there, and so is one in the folder that a link leads
// out of it. A file in the folder may not be a list of other files that
// ffmpeg opens wherever they are, such as an HLS playlist (listOf): a name
// says nothing of what such a list names.

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

// The lists of other files that ffmpeg opens on its own, by the marks its
// probes look for in a file's first bytes, read as latin1 so that a byte is
// a character: ffmpeg reads at most PROBE bytes to tell a file's kind, and
// its probes stop at the first NUL byte. A playlist named track.wav or
// logo.png is read as one all the same.
const LISTS = [
  ["an HLS playlist", /^(?:\xEF\xBB\xBF)?\s*#EXTM3U/],
  ["a DASH manifest", /<MPD/i],
  ["an ffconcat list", /^(?:\xEF\xBB\xBF)?\s*ffconcat\s+version/i],
  ["an IMF composition playlist", /<CompositionPlaylist/i],
];
const PROBE = 5_000_000;

// The length of the ID3v2 tag whose first bytes are `head`, as ffmpeg tells
// one (ff_id3v2_match and ff_id3v2_tag_len): the bytes "ID3", a version and
// a revision that are not 0xFF, and a size in four bytes of seven bits each,
// after the tag's 10-byte header, with a footer of 10 bytes more when its
// flags say so. 0 when it is no such tag.
const TAG = 10;
function tagLength(head) {
  if (head.length < TAG || head.toString("latin1", 0, 3) !== "ID3" || head[3] === 0xff || head[4] === 0xff || head.subarray(6, TAG).some((b) => b & 0x80)) return 0;
  return TAG + head[6] * 2 ** 21 + head[7] * 2 ** 14 + head[8] * 2 ** 7 + head[9] + (head[5] & 0x10 ? TAG : 0);
}
// The most tags in a row looked past: no sound or picture has more.
const TAGS = 1000;

// The text of `fd` from `start`, as a probe reads it: up to its first NUL
// byte, at most PROBE bytes.
function textAt(fd, start) {
  const chunk = Buffer.alloc(1 << 16);
  const parts = [];
  for (let at = start; at < start + PROBE;) {
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, start + PROBE - at), at);
    if (n <= 0) break;
    const end = chunk.subarray(0, n).indexOf(0);
    parts.push(Buffer.from(chunk.subarray(0, end < 0 ? n : end)));
    if (end >= 0) break;
    at += n;
  }
  return Buffer.concat(parts).toString("latin1");
}

// With LAUNCH_FILM_CONFINE set, which of those lists the file `file` is
// ("an HLS playlist"), or null: always null without it, and for what is
// not a regular file, which is told of as what it is.
//
// ffmpeg skips an ID3v2 tag at a file's start before its probes look at
// it, and reads past every tag in a row there before a list is read: a
// playlist behind a tag of 10 bytes, whose header has a NUL byte, was read
// as one, its files outside the folder too. So the marks are looked for
// from the file's start, from the end of the first tag, where the probes
// look, and from the end of the last, where the list is read, each text up
// to its first NUL. The tags are passed over, not read.
function listOf(file) {
  if (!confined()) return null;
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(TAG);
    let first = null;
    let last = null;
    for (let at = 0, tags = 0; tags < TAGS; tags++) {
      if (fs.readSync(fd, head, 0, TAG, at) < TAG) break;
      const length = tagLength(head);
      if (!length) break;
      at += length;
      if (at >= stat.size) break;
      if (first === null) first = at;
      last = at;
    }
    for (const start of new Set([0, first, last].filter((at) => at !== null))) {
      const text = textAt(fd, start);
      const found = LISTS.find(([, mark]) => mark.test(text));
      if (found) return found[0];
    }
    return null;
  } catch {
    // One that cannot be read is told of when it is read.
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// Why the film given to check or frames, `file`, said as `named`, may not be
// read, with LAUNCH_FILM_CONFINE set: it is one of those lists, which ffmpeg
// would follow as it reads the film. null when it may be read.
function filmListed(file, named) {
  const list = listOf(file);
  return list ? `${named} is ${list}, whose files ffmpeg would open wherever they are, which LAUNCH_FILM_CONFINE does not allow: give the film itself` : null;
}

// A name as a message shows it, on one line: a line break or another
// control character in it is written escaped, as a line of its own could
// pass for one of launch-film's. A film.json, a brand.json or a cues.json can
// name anything.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const oneLine = (name) => String(name).replace(new RegExp(CONTROL.source, "gu"), (c) => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// A name as it is said in a message: on one line (oneLine), and cut in the
// middle when it is longer than `room`, as one made to slip past a check,
// which runs to thousands of characters, is.
const said = (name, room = 100) => {
  const text = oneLine(name);
  const head = Math.round(room / 2);
  return text.length > room ? `${text.slice(0, head)}...${text.slice(-(room - head - 10))}` : text;
};

// A path made from such a name, as a message says it: cut only past 300
// characters, so that a folder's own long path is said whole.
const saidPath = (file) => said(file, 300);

module.exports = { confined, outside, listOf, filmListed, said, saidPath, oneLine, CONTROL };
