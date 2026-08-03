"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const River = require("../lib/river-levels.js");
const Generator = require("../scripts/generate-river-levels.js");
const { MAX_ARCHIVE_BYTES, validateArchiveSize, validateArchive } = require("../scripts/validate-river-levels.js");

function seconds(iso) { return Math.floor(Date.parse(iso) / 1000); }
function mirror(station, iso, level) {
  return { station_name: station, time_ut: seconds(iso), water_level_m: level };
}
function official(station, iso, level, extra = {}) {
  return { attributes: { objectid: extra.objectid || 1, gauge: station,
    CreationDate: Date.parse(iso), water_level: level, basin: extra.basin || "Test Basin",
    alertpull: extra.alert ?? 2, minorpull: extra.minor ?? 3, majorpull: extra.major ?? 4 } };
}

const META = [{ name: "Dunamale", river_name: "Aththanagalu Oya", lat_lng: [7.1, 80.1],
  alert_level_m: 3.3, minor_flood_level_m: 4.4, major_flood_level_m: 5.5 }];
const RIVERS = [{ name: "Aththanagalu Oya", basin_name: "Aththanagalu Oya" }];
const DUNAMALE_CHECK = { station_name: "Dunamale", time_ut: 1764322417, water_level_m: 5.96 };

test("Asia/Colombo date conversion crosses midnight at 18:30 UTC", () => {
  assert.equal(River.lktDate(seconds("2025-11-27T18:29:59Z")), "2025-11-27");
  assert.equal(River.lktDate(seconds("2025-11-27T18:30:00Z")), "2025-11-28");
  assert.equal(River.lktDateTime(seconds("2025-11-27T18:30:00Z")), "2025-11-28T00:00:00+05:30");
});

test("daily aggregation keeps first peak, final reading, count, and no interpolated gaps", () => {
  const records = [
    mirror("Gauge A", "2025-11-28T00:00:00Z", 1),
    mirror("Gauge A", "2025-11-28T01:00:00Z", 3),
    mirror("Gauge A", "2025-11-28T02:00:00Z", 3),
    mirror("Gauge A", "2025-11-28T03:00:00Z", -0.4),
    mirror("Gauge A", "2025-11-30T01:00:00Z", 2)
  ].map(River.normalizeMirrorRecord);
  const rows = River.aggregateDaily(records)["gauge-a"];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.date), ["2025-11-28", "2025-11-30"]);
  assert.equal(rows[0].peakM, 3);
  assert.equal(rows[0].peakTimeLkt, "2025-11-28T06:30:00+05:30");
  assert.equal(rows[0].finalM, -0.4);
  assert.equal(rows[0].observations, 4);
});

test("official ArcGIS wins duplicate station/timestamp records", () => {
  const archived = River.normalizeMirrorRecord(mirror("Gauge A", "2025-12-01T00:00:00Z", 1.2));
  const live = River.normalizeArcGISFeature(official("Gauge A", "2025-12-01T00:00:00.999Z", 1.8));
  const merged = River.dedupeMeasurements([archived], [live]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].levelM, 1.8);
  assert.equal(merged[0].source, "official_arcgis");
});

test("status thresholds are inclusive at Alert, Minor, and Major boundaries", () => {
  const thresholds = { alert: 2, minor: 3, major: 4 };
  assert.equal(River.statusFor(1, { alert: 0, minor: 0, major: 0 }), "Unknown");
  assert.equal(River.statusFor(1, {}), "Unknown");
  assert.equal(River.statusFor(2.5, { alert: 2, minor: null, major: 4 }), "Unknown");
  assert.equal(River.statusFor(1.5, { alert: 2, minor: null, major: 4 }), "Normal");
  assert.equal(River.statusFor(1.999, thresholds), "Normal");
  assert.equal(River.statusFor(2, thresholds), "Alert");
  assert.equal(River.statusFor(3, thresholds), "Minor");
  assert.equal(River.statusFor(4, thresholds), "Major");
});

test("recent overlap preserves mirror peaks while live records win exact timestamps", () => {
  const station={id:"gauge-a",name:"Gauge A",basin:"Test Basin",thresholds_m:{alert:4,minor:6,major:8}};
  const archived=[
    River.normalizeMirrorRecord(mirror("Gauge A","2025-12-01T00:00:00Z",5)),
    River.normalizeArcGISFeature(official("Gauge A","2025-12-01T01:00:00Z",2,{alert:4,minor:6,major:8}))
  ];
  const live=[
    River.normalizeArcGISFeature(official("Gauge A","2025-12-01T01:00:00Z",2.5,{alert:4,minor:6,major:8})),
    River.normalizeArcGISFeature(official("Gauge A","2025-12-01T02:00:00Z",3,{alert:4,minor:6,major:8}))
  ];
  const compact=archived.map(River.compactRecentMeasurement);
  const expanded=compact.map(row=>River.expandRecentMeasurement(row,station));
  const merged=River.mergeRecentMeasurements(expanded,live);
  const daily=River.aggregateDaily(merged,{"gauge-a":{thresholds:station.thresholds_m}})["gauge-a"][0];
  assert.equal(merged.length,3);
  assert.equal(merged.find(item=>item.timestamp===seconds("2025-12-01T01:00:00Z")).levelM,2.5);
  assert.equal(daily.peakM,5);
  assert.equal(daily.finalM,3);
  assert.equal(daily.observations,3);
  assert.equal(daily.provenance,"community_mirror+official_arcgis");
});

test("Nagalagam Street official feet values convert to canonical metres", () => {
  const normalized = River.normalizeArcGISFeature(official("Nagalagam Street", "2025-12-01T00:00:00Z", 5,
    { alert: 4, minor: 5, major: 7, basin: "Kelani Ganga" }));
  assert.equal(normalized.levelM, 1.524);
  assert.deepEqual(normalized.thresholds, { alert: 1.2192, minor: 1.524, major: 2.1336 });
  assert.equal(River.convertToMetres(5, "ft"), 1.524);
});

test("zero and negative readings are retained while invalid readings are rejected", () => {
  assert.equal(River.normalizeMirrorRecord(mirror("Gauge A", "2025-12-01T00:00:00Z", -3.29)).levelM, -3.29);
  assert.equal(River.normalizeMirrorRecord(mirror("Gauge A", "2025-12-01T00:00:00Z", 0)).levelM, 0);
  assert.equal(River.normalizeMirrorRecord({ station_name: "Gauge A", time_ut: 1, water_level_m: null }), null);
  assert.equal(River.normalizeArcGISFeature({ attributes: { gauge: "Gauge A", CreationDate: 1, water_level: "bad" } }), null);
});

test("Dunamale mirror record is fixed at 5.96 m around 15:00 LKT and matches DMC check", () => {
  const record = River.normalizeMirrorRecord(DUNAMALE_CHECK);
  assert.equal(River.lktDateTime(record.timestamp), "2025-11-28T15:03:37+05:30");
  assert.equal(record.levelM, River.DMC_SPOT_CHECK.level_m);
  assert.match(River.DMC_SPOT_CHECK.official_bulletin, /dmc\.gov\.lk/);
  const archive = River.buildArchive({ mirrorRecords: [DUNAMALE_CHECK], stationMetadata: META, rivers: RIVERS });
  assert.equal(archive.verification.dunamale_2025_11_28.matched, true);
});

test("archive output is deterministic, compact, and records provenance", () => {
  const input = {
    mirrorRecords: [DUNAMALE_CHECK, mirror("Dunamale", "2025-11-29T00:00:00Z", 2)],
    stationMetadata: META, rivers: RIVERS,
    liveFeatures: [official("Dunamale", "2025-11-29T00:00:00.123Z", 2.2,
      { basin: "Aththanagalu Oya", alert: 3.3, minor: 4.4, major: 5.5 })]
  };
  const one = River.buildArchive(input);
  const two = River.buildArchive(input);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  const row = River.expandDailyRow(one.daily.dunamale[1]);
  assert.equal(row.provenance, "official_arcgis");
  assert.equal(row.peakM, 2.2);
  assert.doesNotThrow(() => validateArchive(one));
});

test("new official stations remain selectable with an explicit live-only note", () => {
  const archive = River.buildArchive({
    mirrorRecords: [DUNAMALE_CHECK], stationMetadata: META, rivers: RIVERS,
    liveFeatures: [official("New Gauge", "2025-12-01T00:00:00Z", 1, { basin: "New Basin" })]
  });
  const station = archive.stations.find(item => item.name === "New Gauge");
  assert.equal(station.live_only, true);
  assert.equal(station.history_start, null);
  assert.match(station.coverage_note, /live coverage only/i);
  assert.ok(archive.daily[station.id]);
});

test("stale and trend helpers handle the 24-hour boundary", () => {
  const now = Date.parse("2025-12-02T00:00:00Z");
  assert.equal(River.isStale("2025-12-01T00:00:00Z", now), false);
  assert.equal(River.isStale("2025-11-30T23:59:59Z", now), true);
  assert.deepEqual(River.trendFor(1.25, 1), { direction: "rising", deltaM: 0.25 });
  assert.equal(River.trendFor(-2, -1).direction, "falling");
});

test("source availability supports both partial-source fallbacks", () => {
  assert.equal(River.sourceAvailability({}, null), "cached-archive");
  assert.equal(River.sourceAvailability(null, []), "live-only");
  assert.equal(River.sourceAvailability({}, []), "archive+live");
  assert.equal(River.sourceAvailability(null, null), "unavailable");
  assert.equal(River.validArchiveShape({version:1,stations:[],daily:{},daily_fields:[]}), true);
  assert.equal(River.validArchiveShape({version:1,stations:{},daily:{},daily_fields:[]}), false);
});

test("CSV river fields use canonical metres and exact requested provenance columns", () => {
  const station={name:"Nagalagam Street",basin:"Kelani Ganga",thresholds_m:{alert:1.2192,minor:1.524,major:2.1336}};
  const daily={peakM:1.524,peakTimeLkt:"2025-11-28T15:00:00+05:30",observations:4,
    alertM:1.2192,minorM:1.524,majorM:2.1336,provenance:"community_mirror+official_arcgis"};
  assert.deepEqual(River.riverCsvRecord(station,daily),{
    river_station:"Nagalagam Street",river_basin:"Kelani Ganga",river_peak_m:1.524,
    river_peak_time_lkt:"2025-11-28T15:00:00+05:30",river_status:"Minor",river_observations:4,
    river_alert_m:1.2192,river_minor_m:1.524,river_major_m:2.1336,
    river_provenance:"community_mirror+official_arcgis"
  });
});

test("ArcGIS pagination requests every page without duplicating records", async () => {
  const offsets = [];
  const mockFetch = async url => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("resultOffset"));
    offsets.push(offset);
    const page = offset === 0 ? [{ attributes: { objectid: 1 } }, { attributes: { objectid: 2 } }] :
      [{ attributes: { objectid: 3 } }];
    return { ok: true, json: async () => ({ features: page, exceededTransferLimit: offset === 0 }) };
  };
  const result = await River.fetchArcGISPages("https://example.test/layer/0", mockFetch, 2);
  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(result.map(item => item.attributes.objectid), [1, 2, 3]);
});

test("ArcGIS pagination rejects HTTP errors and malformed responses", async () => {
  await assert.rejects(() => River.fetchArcGISPages("https://example.test/layer/0",
    async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(() => River.fetchArcGISPages("https://example.test/layer/0",
    async () => ({ ok: true, json: async () => ({ nope: [] }) })), /features array/);
});

test("generator rejects a partial critical-source failure", async () => {
  const mockFetch = async url => {
    if (url.includes("stations.json")) return { ok: false, status: 502 };
    return { ok: true, json: async () => [] };
  };
  await assert.rejects(() => Generator.loadSources(mockFetch), /stations\.json.*HTTP 502/);
});

test("workflow preserves last-good data until candidate validation succeeds", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "update-river-levels.yml"), "utf8");
  const generated = workflow.indexOf("--output data/river-levels.next.json");
  const validated = workflow.indexOf("validate-river-levels.js data/river-levels.next.json");
  const replaced = workflow.indexOf("mv data/river-levels.next.json data/river-levels.json");
  assert.ok(generated >= 0 && validated > generated && replaced > validated);
  assert.match(workflow, /git diff --cached --quiet/);
  assert.match(workflow, /cron: "15 19 \* \* \*"/);
});

test("candidate validation enforces the archive-size ceiling before publication", () => {
  assert.doesNotThrow(()=>validateArchiveSize(MAX_ARCHIVE_BYTES,"candidate"));
  assert.throws(()=>validateArchiveSize(MAX_ARCHIVE_BYTES+1,"candidate"),/maximum allowed size/);
});

test("checked-in archive stays compact enough for a static Cloudflare Pages load", () => {
  const archivePath=path.join(__dirname,"..","data","river-levels.json");
  const stat=fs.statSync(archivePath);
  assert.ok(stat.size <= MAX_ARCHIVE_BYTES, `archive is unexpectedly large: ${stat.size} bytes`);
});
