#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Cloudflare Pages publishes dist/. Only the files a browser needs go there, so
// scripts/, test/ and package.json stay out of the deployed site.
const PUBLISHED = ["index.html", "app.js", "lib", "vendor", "data"];
const ROOT = path.join(__dirname, "..");

function build(outDir = path.join(ROOT, "dist")) {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const entry of PUBLISHED) {
    fs.cpSync(path.join(ROOT, entry), path.join(outDir, entry), {
      recursive: true,
      filter: source => !source.endsWith(".next.json")
    });
  }
  return outDir;
}

if (require.main === module) {
  try {
    process.stdout.write(`Built ${build()}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PUBLISHED, build };
