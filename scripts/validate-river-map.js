#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { RIVER_SYSTEMS, BOUNDS } = require("./generate-river-map.js");

const MAX_MAP_BYTES = 750_000;

function assert(condition, message) { if (!condition) throw new Error(message); }

function visitCoordinates(value, callback) {
  if (Array.isArray(value) && typeof value[0] === "number") callback(value);
  else for (const child of value || []) visitCoordinates(child, callback);
}

function validateCoordinates(geometry, label) {
  assert(geometry && typeof geometry === "object", `${label} has no geometry`);
  let count = 0;
  visitCoordinates(geometry.coordinates, coordinate => {
    count += 1;
    const [longitude, latitude] = coordinate;
    assert(Number.isFinite(longitude) && Number.isFinite(latitude), `${label} has non-finite coordinates`);
    assert(longitude >= BOUNDS[0] && longitude <= BOUNDS[2] && latitude >= BOUNDS[1] && latitude <= BOUNDS[3],
      `${label} coordinate ${longitude},${latitude} is outside Sri Lanka bounds`);
  });
  assert(count > 0, `${label} has no coordinates`);
}

function validateMapSize(bytes, label = "river map") {
  assert(Number.isInteger(bytes) && bytes >= 0, `${label} size is invalid`);
  assert(bytes <= MAX_MAP_BYTES, `${label} is ${bytes} bytes; maximum allowed size is ${MAX_MAP_BYTES} bytes`);
}

function validateMap(data, archive = null) {
  assert(data && typeof data === "object", "map must be an object");
  assert(data.version === 1, "map version must be 1");
  assert(data.metadata?.coordinate_order === "longitude,latitude", "coordinate order is missing");
  assert(/geoBoundaries/.test(data.metadata?.attribution || "") && /HydroRIVERS/.test(data.metadata?.attribution || ""),
    "required map attribution is missing");
  assert(data.metadata?.sources?.outline?.revision && data.metadata?.sources?.rivers?.revision,
    "pinned map source revisions are missing");
  assert(data.metadata?.aliases && typeof data.metadata.aliases === "object", "source aliases are missing");
  assert(data.outline?.type === "Feature", "outline must be a GeoJSON Feature");
  assert(["Polygon", "MultiPolygon"].includes(data.outline?.geometry?.type), "outline must be polygon geometry");
  validateCoordinates(data.outline.geometry, "outline");
  assert(data.rivers?.type === "FeatureCollection" && Array.isArray(data.rivers.features),
    "rivers must be a GeoJSON FeatureCollection");
  assert(Array.isArray(data.river_systems), "river system metadata is missing");

  const expected = new Set(RIVER_SYSTEMS.map(system => system.id));
  const declared = new Set(data.river_systems.map(system => system.id));
  assert(expected.size === declared.size && [...expected].every(id => declared.has(id)),
    "river-system declarations do not match the canonical crosswalk");
  const covered = new Set();
  let previousKey = "";
  for (const feature of data.rivers.features) {
    const p = feature.properties || {};
    assert(expected.has(p.river_id), `unknown river_id ${p.river_id}`);
    assert(p.river_name === p.river_id, `${p.river_id} river_name is not canonical`);
    assert(Number.isInteger(p.flow_order) && p.flow_order > 0, `${p.river_id} has invalid flow order`);
    const key = `${p.river_id}\u0000${String(p.flow_order).padStart(2, "0")}`;
    assert(key.localeCompare(previousKey, "en") >= 0, "river features are not deterministically sorted");
    previousKey = key;
    covered.add(p.river_id);
    validateCoordinates(feature.geometry, `river ${p.river_id}`);
  }
  assert([...expected].every(id => covered.has(id)), "one or more monitored river systems have no geometry");
  if (archive) {
    const basins = new Set((archive.stations || []).map(station => station.basin));
    assert([...basins].every(id => covered.has(id)), "checked-in stations include a river system without map geometry");
  }
  return data;
}

function readAndValidate(file, archiveFile = path.join("data", "river-levels.json")) {
  const resolved = path.resolve(file);
  validateMapSize(fs.statSync(resolved).size, resolved);
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const archive = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, "utf8")) : null;
  return validateMap(data, archive);
}

if (require.main === module) {
  try {
    const file = process.argv[2] || path.join("data", "river-map.json");
    const data = readAndValidate(file);
    process.stdout.write(`Valid river map: ${data.river_systems.length} systems, ${data.rivers.features.length} feature groups\n`);
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
}

module.exports = { MAX_MAP_BYTES, visitCoordinates, validateMapSize, validateMap, readAndValidate };
