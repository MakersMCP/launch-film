"use strict";
// The tests' own folders: each test file makes them inside one folder of its
// own in the system's temp folder, which goes once its tests have run, so a
// run of the tests leaves the temp folder as it found it.
const { after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-film-tests-"));
after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// A new folder for a test.
const tmp = (prefix = "t-") => fs.mkdtempSync(path.join(root, prefix));

module.exports = { tmp };
