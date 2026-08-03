#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const River = require("../lib/river-levels.js");
const MAX_ARCHIVE_BYTES = 2_000_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nullableFinite(value, label) {
  assert(value === null || River.finite(value), `${label} must be finite or null`);
}

function validateArchiveSize(bytes, label = "river archive") {
  assert(Number.isInteger(bytes) && bytes >= 0, `${label} size is invalid`);
  assert(bytes <= MAX_ARCHIVE_BYTES,
    `${label} is ${bytes} bytes; maximum allowed size is ${MAX_ARCHIVE_BYTES} bytes`);
}

function validateArchive(data) {
  assert(data && typeof data === "object", "archive must be an object");
  assert(data.version === 1, "archive version must be 1");
  assert(data.coverage?.timezone === River.TIME_ZONE, "coverage timezone must be Asia/Colombo");
  assert(data.coverage?.requested_start === River.ARCHIVE_START, "coverage must begin at the requested historical scope");
  assert(Array.isArray(data.stations) && data.stations.length, "stations must be a non-empty array");
  assert(Array.isArray(data.daily_fields) && data.daily_fields.join("|") === River.DAILY_FIELDS.join("|"), "daily field map is invalid");
  assert(data.daily && typeof data.daily === "object", "daily series must be an object");
  assert(Array.isArray(data.recent_fields) && data.recent_fields.join("|") === River.RECENT_FIELDS.join("|"), "recent field map is invalid");
  assert(data.recent && typeof data.recent === "object", "recent observation window must be an object");

  const ids = new Set();
  let previousSortKey = "";
  for (const station of data.stations) {
    assert(station.id === River.slugify(station.name), `invalid station id for ${station.name}`);
    assert(!ids.has(station.id), `duplicate station ${station.id}`);
    ids.add(station.id);
    assert(typeof station.basin === "string" && station.basin, `${station.id} has no basin`);
    assert(station.display_unit === "m" || station.display_unit === "ft", `${station.id} has invalid display unit`);
    nullableFinite(station.thresholds_m?.alert, `${station.id} alert threshold`);
    nullableFinite(station.thresholds_m?.minor, `${station.id} minor threshold`);
    nullableFinite(station.thresholds_m?.major, `${station.id} major threshold`);
    const sortKey = `${station.basin}\u0000${station.name}`;
    assert(sortKey.localeCompare(previousSortKey, "en") >= 0, "stations are not deterministically sorted");
    previousSortKey = sortKey;
    if (station.live_only) {
      assert(!station.history_start && Boolean(station.coverage_note), `${station.id} live-only coverage must be explicit`);
    } else {
      assert(Boolean(station.history_start), `${station.id} historical station has no history start`);
    }
    if (station.latest) {
      assert(Array.isArray(station.latest) && station.latest.length === 5, `${station.id} latest tuple is invalid`);
      nullableFinite(station.latest[1], `${station.id} current reading`);
      nullableFinite(station.latest[3], `${station.id} previous reading`);
    }
  }

  for (const [stationId, compactRows] of Object.entries(data.daily)) {
    assert(ids.has(stationId), `daily series references unknown station ${stationId}`);
    assert(Array.isArray(compactRows) && compactRows.length, `${stationId} daily series is empty`);
    let previousDate = "";
    const seenDates = new Set();
    for (const compact of compactRows) {
      assert(Array.isArray(compact) && compact.length === River.DAILY_FIELDS.length, `${stationId} daily tuple has wrong length`);
      const row = River.expandDailyRow(compact);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(row.date), `${stationId} has invalid daily date`);
      assert(row.date >= River.ARCHIVE_START, `${stationId} includes an out-of-scope date`);
      assert(row.date > previousDate && !seenDates.has(row.date), `${stationId} dates are duplicated or unsorted`);
      previousDate = row.date;
      seenDates.add(row.date);
      assert(River.finite(row.peakM) && River.finite(row.finalM), `${stationId}/${row.date} has invalid levels`);
      assert(Number.isInteger(row.observations) && row.observations > 0, `${stationId}/${row.date} has invalid observation count`);
      assert(row.peakTimeLkt.startsWith(`${row.date}T`) && row.finalTimeLkt.startsWith(`${row.date}T`), `${stationId}/${row.date} timestamp is outside its LKT date`);
      nullableFinite(row.alertM, `${stationId}/${row.date} alert threshold`);
      nullableFinite(row.minorM, `${stationId}/${row.date} minor threshold`);
      nullableFinite(row.majorM, `${stationId}/${row.date} major threshold`);
      assert(["community_mirror", "official_arcgis", "community_mirror+official_arcgis"].includes(row.provenance), `${stationId}/${row.date} has invalid provenance`);
    }
  }

  const stationsById = Object.fromEntries(data.stations.map(station => [station.id, station]));
  for (const [stationId, compactRows] of Object.entries(data.recent)) {
    assert(ids.has(stationId), `recent observations reference unknown station ${stationId}`);
    assert(Array.isArray(compactRows) && compactRows.length, `${stationId} recent observation series is empty`);
    let previousTimestamp = -Infinity;
    const expanded = [];
    for (const compact of compactRows) {
      assert(Array.isArray(compact) && compact.length === River.RECENT_FIELDS.length, `${stationId} recent tuple has wrong length`);
      const item = River.expandRecentMeasurement(compact, stationsById[stationId]);
      assert(item, `${stationId} has an invalid recent observation`);
      assert(item.timestamp > previousTimestamp, `${stationId} recent observations are duplicated or unsorted`);
      assert(River.lktDate(item.timestamp) >= data.coverage.official_start, `${stationId} recent observation predates the overlap window`);
      previousTimestamp = item.timestamp;
      expanded.push(item);
    }
    const station = stationsById[stationId];
    const stationConfig = { thresholds: station.thresholds_m };
    const rebuilt = River.aggregateDaily(expanded, { [stationId]: stationConfig })[stationId] || [];
    const archivedByDate = new Map((data.daily[stationId] || []).map(compact => {
      const row = River.expandDailyRow(compact);
      return [row.date, row];
    }));
    for (const row of rebuilt) {
      const archived = archivedByDate.get(row.date);
      assert(archived, `${stationId}/${row.date} recent observations have no daily aggregate`);
      for (const field of ["peakM", "peakTimeLkt", "finalM", "finalTimeLkt", "observations", "provenance"]) {
        assert(row[field] === archived[field], `${stationId}/${row.date} recent ${field} does not reproduce the daily aggregate`);
      }
    }
  }

  const check = data.verification?.dunamale_2025_11_28;
  assert(check?.matched === true, "Dunamale provenance check was not matched in the mirror");
  assert(check.level_m === 5.96 && check.observed_at_lkt === "2025-11-28T15:03:37+05:30", "Dunamale provenance values changed");
  assert(check.official_bulletin === River.DMC_SPOT_CHECK.official_bulletin, "DMC bulletin URL changed");
  return data;
}

function readAndValidate(file) {
  const resolved = path.resolve(file);
  validateArchiveSize(fs.statSync(resolved).size, resolved);
  let data;
  try { data = JSON.parse(fs.readFileSync(resolved, "utf8")); }
  catch (error) { throw new Error(`Could not parse ${resolved}: ${error.message}`); }
  validateArchive(data);
  return data;
}

if (require.main === module) {
  try {
    const file = process.argv[2] || path.join("data", "river-levels.json");
    const data = readAndValidate(file);
    process.stdout.write(`Valid river archive: ${data.stations.length} stations, through ${data.coverage.end}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { MAX_ARCHIVE_BYTES, validateArchiveSize, validateArchive, readAndValidate };
