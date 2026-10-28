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

// The last-good archive is carried forward so stations and days that have left
// the live sources are kept. A missing file means a first run; a broken one is
// an error rather than a silent loss of history.
async function readPreviousArchive(file) {
  let text;
  try { text = await fs.readFile(path.resolve(file), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const archive = JSON.parse(text);
  if (!River.validArchiveShape(archive)) throw new Error(`${file} is not a valid river archive`);
  return archive;
}

async function generate({ output = path.join("data", "river-levels.json"),
  previous = path.join("data", "river-levels.json"), fetchImpl = fetch } = {}) {
  const [sources, previousArchive] = await Promise.all([loadSources(fetchImpl), readPreviousArchive(previous)]);
  const archive = River.buildArchive({ ...sources, previousArchive });
  if (!archive.verification.dunamale_2025_11_28.matched) {
    throw new Error("Dunamale 2025-11-28 15:03:37 LKT / 5.96 m mirror provenance check failed");
  }
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(archive) + "\n", "utf8");
  return { archive, target };
}

function flagArg(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : path.join("data", "river-levels.json");
}

function outputArg(argv) { return flagArg(argv, "--output"); }
function previousArg(argv) { return flagArg(argv, "--previous"); }

if (require.main === module) {
  const argv = process.argv.slice(2);
  generate({ output: outputArg(argv), previous: previousArg(argv) })
    .then(({ archive, target }) => {
      process.stdout.write(`Generated ${target}\n`);
      process.stdout.write(`${archive.stations.length} stations; ${archive.coverage.merged_records} merged observations; ${archive.coverage.start} to ${archive.coverage.end}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    });
}

module.exports = { URLS, fetchJSON, loadSources, readPreviousArchive, generate, outputArg, previousArg };
