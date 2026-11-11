"use strict";
// Programs that cannot be started, each where a test can give it to
// launch-film in place of ffmpeg, ffprobe or Chrome (programs.test.js). Each
// case has its `file`, or the environment it is given in, and what launch-film
// says of it after "which" or after the place it found it.
const fs = require("fs");
const path = require("path");

// The real program a name gives on PATH, or null.
function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const file = path.resolve(dir || ".", name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch {
      // Not here.
    }
  }
  return null;
}

// A copy of an ELF program with `from` in it changed to `to`, of the same
// length, or null when it holds no `from`.
function swapped(bytes, from, to) {
  const at = bytes.indexOf(from);
  if (at < 0 || from.length !== to.length) return null;
  const out = Buffer.from(bytes);
  out.write(to, at, "latin1");
  return out;
}

function makeCases(dir) {
  const at = (...names) => path.join(dir, ...names);
  const put = (folder, data, mode = 0o755) => {
    fs.mkdirSync(at(folder), { recursive: true });
    fs.writeFileSync(at(folder, "program"), data);
    fs.chmodSync(at(folder, "program"), mode);
    return at(folder, "program");
  };
  const ffmpeg = onPath(process.env.LAUNCH_FILM_FFMPEG || "ffmpeg");
  const ffprobe = onPath(process.env.LAUNCH_FILM_FFPROBE || "ffprobe");
  const elf = ffmpeg && fs.readFileSync(ffmpeg).readUInt32BE(0) === 0x7f454c46 ? fs.readFileSync(ffmpeg) : null;
  const cases = [];
  const add = (name, file, said, extra = {}) => cases.push({ name, file, said, ...extra });

  add("nothing there", at("none", "program"), "which is not there");
  fs.mkdirSync(at("folder", "program"), { recursive: true });
  add("a folder", at("folder", "program"), "which is a folder, not a program");
  fs.mkdirSync(at("linkdir"), { recursive: true });
  fs.symlinkSync(at("folder", "program"), at("linkdir", "program"));
  add("a link to a folder", at("linkdir", "program"), `which is a link to the folder ${at("folder", "program")}, not a program`);
  fs.mkdirSync(at("dangling"), { recursive: true });
  fs.symlinkSync(at("nothing-here", "program"), at("dangling", "program"));
  add("a link to nothing", at("dangling", "program"), `which is a link to ${at("nothing-here", "program")}, where there is nothing`);
  fs.mkdirSync(at("loop"), { recursive: true });
  fs.symlinkSync(at("loop", "b"), at("loop", "a"));
  fs.symlinkSync(at("loop", "a"), at("loop", "b"));
  add("a loop of links", at("loop", "a"), "which is a link in a loop of links, which leads to no file");
  fs.writeFileSync(at("afile"), "x");
  add("a path through a file", at("afile", "program"), `which is not there, as ${at("afile")} is a file, not a folder`);
  add("a file without the execute bit", put("plain", "#!/bin/sh\nexit 0\n", 0o644), "which is a file without the permission to run it, which chmod +x gives");
  add("execute bits for other users only", put("others", "#!/bin/sh\nexit 0\n", 0o055), "which is a file only other users may run", { user: true });
  // Shut while its case runs (before), and opened again after, so the
  // folder can be removed.
  const locked = put("locked", "#!/bin/sh\nexit 0\n");
  add("in a folder this user may not enter", locked, `which is in ${at("locked")}, a folder this user may not enter`,
    { user: true, before: () => fs.chmodSync(at("locked"), 0o600), after: () => fs.chmodSync(at("locked"), 0o700) });
  add("an empty file", put("empty", ""), "which is an empty file, not a program");
  add("a text file with no #! line", put("text", "<!doctype html><title>ffmpeg</title>\n"), "which is a text file with no #! line, not a program");
  add("a script whose #! program is not there", put("badinterp", "#!/nonexistent/sh\nexit 0\n"), "which is a script whose #! line names /nonexistent/sh, which is not there");
  add("a script whose #! program is a folder", put("dirinterp", "#!/usr\nexit 0\n"), "which is a script whose #! line names /usr, a folder");
  add("a script whose #! program may not be run", put("nointerp", "#!/etc/passwd\nexit 0\n"), "which is a script whose #! line names /etc/passwd, which may not be run");
  add("a script whose env program is not on PATH", put("envmiss", "#!/usr/bin/env launch-film-no-such-program\n"), "which is a script whose #! line has env start launch-film-no-such-program, which is not on your PATH");
  add("a Windows program", put("pe", Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b800000000000000400000000000000000", "hex"), Buffer.alloc(4096)])),
    `which is a Windows program, which does not run on ${{ linux: "Linux", darwin: "macOS" }[process.platform] || process.platform}`);
  add("a macOS program", put("macho", Buffer.concat([Buffer.from("cffaedfe07000001030000000200000010000000", "hex"), Buffer.alloc(4096)])), "which is a macOS program, which does not run on Linux");
  if (elf) {
    const arm = Buffer.from(elf);
    const other = process.arch === "arm64" ? [62, "x86-64", "64-bit ARM"] : [183, "64-bit ARM", "x86-64"];
    arm.writeUInt16LE(other[0], 0x12);
    add("a program for another processor", put("arm", arm), `which is a program for ${other[1]}, which this ${other[2]} machine cannot run`);
    const loader = ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1"].find((l) => elf.includes(l));
    if (loader) add("a program whose loader is missing", put("noloader", swapped(elf, loader, `${loader.slice(0, -1)}9`)), `which is a program whose loader, ${loader.slice(0, -1)}9, is not there`);
    const library = /libav(?:util|codec|format|filter|device)\.so\.\d+/.exec(elf.toString("latin1"));
    if (library) {
      const missing = `${library[0].slice(0, 7)}X${library[0].slice(8)}`;
      add("a program that needs a library that is missing", put("nolib", swapped(elf, library[0], missing)), `which needs the shared library ${missing}, which is not on this machine`);
    }
  }
  // As ffmpeg the ffprobe, and as ffprobe the ffmpeg: neither says it is
  // the other when asked its version.
  if (ffmpeg && ffprobe) {
    add("ffprobe in ffmpeg's place", ffprobe, /^which is not ffmpeg: asked its version, it said "ffprobe version \S+"/, { only: "ffmpeg" });
    add("ffmpeg in ffprobe's place", ffmpeg, /^which is not ffprobe: asked its version, it said "ffmpeg version \S+"/, { only: "ffprobe" });
  }
  return cases;
}

module.exports = { makeCases, onPath };
