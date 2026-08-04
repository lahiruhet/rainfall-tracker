#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const SOURCE_REVISION = "1b6efd84b049dbd9b7d4ca137ec616b0773d4262";
const GEOBOUNDARIES_REVISION = "9469f09";
const URLS = Object.freeze({
  outline: `https://github.com/wmgeolab/geoBoundaries/raw/${GEOBOUNDARIES_REVISION}/releaseData/gbOpen/LKA/ADM0/geoBoundaries-LKA-ADM0_simplified.geojson`,
  rivers: `https://raw.githubusercontent.com/nuuuwan/lk_rivers/${SOURCE_REVISION}/data/sri_lanka_rivers.geojson`,
  aliases: `https://raw.githubusercontent.com/nuuuwan/lk_rivers/${SOURCE_REVISION}/data/static/riv_id_to_name.json`
});

const RIVER_SYSTEMS = Object.freeze([
  ["Aththanagalu Oya", 41404739, ["Attanagalu Oya", "Aththanagalu Oya"]],
  ["Deduru Oya", 41403190, []], ["Gal Oya", 41404379, []],
  ["Gin Ganga", 41409948, ["Gin River"]], ["Heda Oya", 41406267, []],
  ["Kala Oya", 41400542, []], ["Kalu Ganga", 41407423, ["Kalu River"]],
  ["Kelani Ganga", 41405515, ["Kelani River"]], ["Kirindi Oya", 41409262, []],
  ["Kumbukkan Oya", 41407753, []], ["Ma Oya", 41397058, []],
  ["Maduru Oya", 41402045, []], ["Maha Oya", 41404427, []],
  ["Mahaweli Ganga", 41399660, ["Mahaweli River"]],
  ["Malwathu Oya", 41397865, ["Malvathu Oya"]],
  ["Mee Oya", 41401373, ["Mi Oya"]], ["Menik Ganga", 41408473, []],
  ["Nilwala Ganga", 41410526, ["Nilvala Ganga"]],
  ["Walawe Ganga", 41409740, ["Walawe River"]], ["Yan Oya", 41397237, []]
].map(([id, mainRiv, aliases]) => ({ id, name: id, main_riv: mainRiv, aliases })));

const BOUNDS = Object.freeze([79.35, 5.70, 82.10, 10.15]);

function round(value, digits = 5) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function pointDistanceSquared(point, start, end) {
  const [x, y] = point, [x1, y1] = start, [x2, y2] = end;
  const dx = x2 - x1, dy = y2 - y1;
  if (!dx && !dy) return (x - x1) ** 2 + (y - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2;
}

function simplifyLine(points, tolerance = 0.0015) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  let maxDistance = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = pointDistanceSquared(points[i], points[0], points.at(-1));
    if (distance > maxDistance) { index = i; maxDistance = distance; }
  }
  if (maxDistance <= tolerance * tolerance) return [points[0], points.at(-1)];
  return simplifyLine(points.slice(0, index + 1), tolerance).slice(0, -1)
    .concat(simplifyLine(points.slice(index), tolerance));
}

function cleanLine(line, tolerance) {
  const simplified = simplifyLine(line, tolerance).map(([longitude, latitude]) =>
    [round(longitude), round(latitude)]);
  return simplified.filter((point, index) => !index ||
    point[0] !== simplified[index - 1][0] || point[1] !== simplified[index - 1][1]);
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function mapCoordinates(value, transform) {
  if (Array.isArray(value) && typeof value[0] === "number") return transform(value);
  return (value || []).map(item => mapCoordinates(item, transform));
}

function cleanOutline(source) {
  const feature = source?.type === "FeatureCollection" ? source.features?.[0] : source;
  if (!feature?.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
    throw new Error("geoBoundaries source did not contain a polygon outline");
  }
  const cleanRing = ring => cleanLine(ring, 0.0035);
  const cleanPolygon = polygon => polygon.map(cleanRing).filter(ring => ring.length >= 3);
  const coordinates = feature.geometry.type === "Polygon" ? cleanPolygon(feature.geometry.coordinates) :
    feature.geometry.coordinates.map(cleanPolygon).filter(polygon => polygon.length);
  return {
    type: "Feature", properties: { name: "Sri Lanka" },
    geometry: { type: feature.geometry.type, coordinates }
  };
}

function buildMap({ outlineGeoJSON, riverGeoJSON, sourceAliases = {} }) {
  if (!Array.isArray(riverGeoJSON?.features)) throw new Error("HydroRIVERS source has no features array");
  const systemByMain = new Map(RIVER_SYSTEMS.map(system => [system.main_riv, system]));
  const grouped = new Map();
  for (const feature of riverGeoJSON.features) {
    const properties = feature.properties || {};
    const system = systemByMain.get(Number(properties.MAIN_RIV));
    if (!system) continue;
    const flowOrder = Math.max(1, Math.round(Number(properties.ORD_STRA) || 1));
    const key = `${system.id}\u0000${String(flowOrder).padStart(2, "0")}`;
    if (!grouped.has(key)) grouped.set(key, { system, flowOrder, lines: [] });
    for (const rawLine of geometryLines(feature.geometry)) {
      const line = cleanLine(rawLine, 0.0015);
      if (line.length >= 2) grouped.get(key).lines.push(line);
    }
  }

  const features = [...grouped.values()].sort((a, b) =>
    a.system.id.localeCompare(b.system.id, "en") || a.flowOrder - b.flowOrder).map(group => ({
      type: "Feature",
      properties: { river_id: group.system.id, river_name: group.system.name, flow_order: group.flowOrder },
      geometry: { type: "MultiLineString", coordinates: group.lines.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
    }));
  const found = new Set(features.map(feature => feature.properties.river_id));
  const missing = RIVER_SYSTEMS.filter(system => !found.has(system.id));
  if (missing.length) throw new Error(`HydroRIVERS source is missing: ${missing.map(item => item.id).join(", ")}`);

  const aliases = {};
  for (const system of RIVER_SYSTEMS) {
    const sourceName = sourceAliases[String(system.main_riv)];
    aliases[system.id] = [...new Set([...(system.aliases || []), sourceName].filter(name => name && name !== system.id))].sort();
  }
  return {
    version: 1,
    metadata: {
      bounds: [...BOUNDS], coordinate_order: "longitude,latitude", simplification_degrees: 0.0015,
      attribution: "Sri Lanka outline: geoBoundaries gbOpen (source OpenStreetMap/Wambacher, ODbL 1.0). Rivers: HydroRIVERS/HydroSHEDS via nuuuwan/lk_rivers (MIT repository; HydroRIVERS attribution required).",
      sources: {
        outline: { name: "geoBoundaries gbOpen", url: URLS.outline, revision: GEOBOUNDARIES_REVISION, license: "ODbL 1.0" },
        rivers: { name: "HydroRIVERS via nuuuwan/lk_rivers", url: URLS.rivers, revision: SOURCE_REVISION }
      },
      aliases
    },
    river_systems: RIVER_SYSTEMS.map(system => ({ id: system.id, name: system.name, aliases: aliases[system.id] })),
    outline: cleanOutline(outlineGeoJSON),
    rivers: { type: "FeatureCollection", features }
  };
}

async function fetchJSON(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { "user-agent": "rainfall-river-tracker/1.0" } });
  if (!response?.ok) throw new Error(`Download failed for ${url}: HTTP ${response?.status ?? "unknown"}`);
  try { return await response.json(); }
  catch (error) { throw new Error(`Malformed JSON from ${url}: ${error.message}`); }
}

async function loadSources(fetchImpl = fetch) {
  const [outlineGeoJSON, riverGeoJSON, sourceAliases] = await Promise.all([
    fetchJSON(URLS.outline, fetchImpl), fetchJSON(URLS.rivers, fetchImpl), fetchJSON(URLS.aliases, fetchImpl)
  ]);
  return { outlineGeoJSON, riverGeoJSON, sourceAliases };
}

async function generate({ output = path.join("data", "river-map.json"), fetchImpl = fetch } = {}) {
  const data = buildMap(await loadSources(fetchImpl));
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(data) + "\n", "utf8");
  return { data, target };
}

function outputArg(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : path.join("data", "river-map.json");
}

if (require.main === module) {
  generate({ output: outputArg(process.argv.slice(2)) })
    .then(({ data, target }) => process.stdout.write(
      `Generated ${target}: ${data.river_systems.length} systems, ${data.rivers.features.length} styled feature groups\n`))
    .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}

module.exports = {
  SOURCE_REVISION, GEOBOUNDARIES_REVISION, URLS, RIVER_SYSTEMS, BOUNDS,
  simplifyLine, cleanLine, buildMap, fetchJSON, loadSources, generate, outputArg
};
