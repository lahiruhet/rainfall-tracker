#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const River = require("../lib/river-levels.js");

const URLS = Object.freeze({
  measurements: "https://raw.githubusercontent.com/nuuuwan/lk_irrigation/main/data/all.json",
  stations: "https://raw.githubusercontent.com/nuuuwan/lk_irrigation/main/data/static/stations.json",
  rivers: "https://raw.githubusercontent.com/nuuuwan/lk_irrigation/main/data/static/rivers.json",
  arcgis: "https://services3.arcgis.com/J7ZFXmR8rSmQ3FGf/arcgis/rest/services/gauges_2_view/FeatureServer/0"
});

async function fetchJSON(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { "user-agent": "rainfall-river-tracker/1.0" } });
  if (!response?.ok) throw new Error(`Download failed for ${url}: HTTP ${response?.status ?? "unknown"}`);
  let body;
  try { body = await response.json(); }
  catch (error) { throw new Error(`Malformed JSON from ${url}: ${error.message}`); }
  if (!Array.isArray(body)) throw new Error(`Expected an array from ${url}`);
  return body;
}

async function loadSources(fetchImpl = fetch) {
  const [mirrorRecords, stationMetadata, rivers, liveFeatures] = await Promise.all([
    fetchJSON(URLS.measurements, fetchImpl),
    fetchJSON(URLS.stations, fetchImpl),
    fetchJSON(URLS.rivers, fetchImpl),
    River.fetchArcGISPages(URLS.arcgis, fetchImpl)
  ]);
  return { mirrorRecords, stationMetadata, rivers, liveFeatures };
}

async function generate({ output = path.join("data", "river-levels.json"), fetchImpl = fetch } = {}) {
  const sources = await loadSources(fetchImpl);
  const archive = River.buildArchive(sources);
  if (!archive.verification.dunamale_2025_11_28.matched) {
    throw new Error("Dunamale 2025-11-28 15:03:37 LKT / 5.96 m mirror provenance check failed");
  }
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(archive) + "\n", "utf8");
  return { archive, target };
}

function outputArg(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : path.join("data", "river-levels.json");
}

if (require.main === module) {
  generate({ output: outputArg(process.argv.slice(2)) })
    .then(({ archive, target }) => {
      process.stdout.write(`Generated ${target}\n`);
      process.stdout.write(`${archive.stations.length} stations; ${archive.coverage.merged_records} merged observations; ${archive.coverage.start} to ${archive.coverage.end}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = { URLS, fetchJSON, loadSources, generate, outputArg };
