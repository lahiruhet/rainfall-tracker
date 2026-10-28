"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("../scripts/build-site.js");

test("site build publishes only the browser files", () => {
  const out = build(fs.mkdtempSync(path.join(os.tmpdir(), "rainfall-dist-")));
  try {
    for (const file of ["index.html", "app.js", "lib/river-levels.js", "lib/dashboard.js",
      "vendor/leaflet/leaflet.js", "data/river-levels.json", "data/river-map.json"]) {
      assert.ok(fs.existsSync(path.join(out, file)), `${file} is missing from the build`);
    }
    for (const entry of ["scripts", "test", "package.json", "node_modules"]) {
      assert.ok(!fs.existsSync(path.join(out, entry)), `${entry} should not be published`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
