"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Generator = require("../scripts/generate-river-map.js");
const { MAX_MAP_BYTES, validateMapSize, validateMap } = require("../scripts/validate-river-map.js");

function fixture() {
  const features = Generator.RIVER_SYSTEMS.map((system, index) => ({
    type: "Feature",
    properties: { MAIN_RIV: system.main_riv, ORD_STRA: index % 5 + 1 },
    geometry: { type: "LineString", coordinates: [[80 + index / 100, 7], [80.01 + index / 100, 7.01]] }
  }));
  return {
    outlineGeoJSON: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[
      [79.5, 5.8], [81.9, 5.8], [81.9, 9.9], [79.5, 5.8]
    ]] } },
    riverGeoJSON: { type: "FeatureCollection", features },
    sourceAliases: Object.fromEntries(Generator.RIVER_SYSTEMS.map(system => [String(system.main_riv), system.id]))
  };
}

test("map generation is deterministic, sorted, versioned, and covers current systems", () => {
  const first = Generator.buildMap(fixture());
  const second = Generator.buildMap(fixture());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.version, 1);
  assert.equal(first.river_systems.length, 20);
  assert.equal(new Set(first.rivers.features.map(feature => feature.properties.river_id)).size, 20);
  assert.doesNotThrow(() => validateMap(first));
});

test("source aliases include Mee/Mi and Aththanagalu naming provenance", () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "river-map.json"), "utf8"));
  assert.ok(data.metadata.aliases["Mee Oya"].includes("Mi Oya"));
  assert.ok(data.metadata.aliases["Aththanagalu Oya"].includes("Attanagalu Oya"));
  assert.match(data.metadata.attribution, /geoBoundaries/);
  assert.match(data.metadata.attribution, /HydroRIVERS/);
});

test("checked-in map has valid Sri Lanka bounds and covers every archive basin", () => {
  const mapPath = path.join(__dirname, "..", "data", "river-map.json");
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "river-levels.json"), "utf8"));
  const data = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  assert.doesNotThrow(() => validateMap(data, archive));
  assert.doesNotThrow(() => validateMapSize(fs.statSync(mapPath).size, "checked map"));
  assert.ok(fs.statSync(mapPath).size < MAX_MAP_BYTES);
});

test("map validator enforces the uncompressed 750 KB ceiling", () => {
  assert.doesNotThrow(() => validateMapSize(MAX_MAP_BYTES));
  assert.throws(() => validateMapSize(MAX_MAP_BYTES + 1), /maximum allowed size/);
});
