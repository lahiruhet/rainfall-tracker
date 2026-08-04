"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Dashboard = require("../lib/dashboard.js");
const River = require("../lib/river-levels.js");

const STATIONS = [
  { id: "alpha", name: "Alpha", basin: "River A", latitude: 7.1, longitude: 80.1 },
  { id: "beta", name: "Beta", basin: "River B", latitude: null, longitude: null }
];
const FIXED_NOW = Date.parse("2026-08-03T19:00:00Z"); // 2026-08-04 in Asia/Colombo

test("7, 30, and 90-day presets are inclusive Asia/Colombo ranges", () => {
  assert.deepEqual(Dashboard.inclusiveRange(7, FIXED_NOW), { start: "2026-07-29", end: "2026-08-04" });
  assert.deepEqual(Dashboard.inclusiveRange(30, FIXED_NOW), { start: "2026-07-06", end: "2026-08-04" });
  assert.deepEqual(Dashboard.inclusiveRange(90, FIXED_NOW), { start: "2026-05-07", end: "2026-08-04" });
  assert.equal(Dashboard.dateSequence("2026-07-29", "2026-08-04").length, 7);
});

test("query parsing validates gauge, river, and dates without implying a gauge", () => {
  const valid = Dashboard.parseQuery("?gauge=alpha&river=River%20B&start=2026-07-01&end=2026-07-03",
    STATIONS, ["River A", "River B"], FIXED_NOW);
  assert.deepEqual(valid, { gaugeId: "alpha", riverId: "River A", start: "2026-07-01", end: "2026-07-03", usedDefaultRange: false });
  const invalid = Dashboard.parseQuery("?gauge=missing&river=missing&start=2026-02-30&end=nope",
    STATIONS, ["River A", "River B"], FIXED_NOW);
  assert.deepEqual(invalid, { gaugeId: null, riverId: null, start: "2026-07-06", end: "2026-08-04", usedDefaultRange: true });
  const future = Dashboard.parseQuery("?start=2026-08-01&end=2026-08-05", STATIONS,
    ["River A", "River B"], FIXED_NOW);
  assert.equal(future.usedDefaultRange, true);
});

test("river selection filters without auto-selecting and only clears a gauge from another basin", () => {
  assert.deepEqual(Dashboard.filterStations(STATIONS, "River B").map(item => item.id), ["beta"]);
  const empty = Dashboard.selectRiver({ gaugeId: null, riverId: null }, "River A", STATIONS);
  assert.equal(empty.gaugeId, null);
  const retained = Dashboard.selectRiver({ gaugeId: "alpha", riverId: "River A" }, "River A", STATIONS);
  assert.equal(retained.gaugeId, "alpha");
  const cleared = Dashboard.selectRiver(retained, "River B", STATIONS);
  assert.equal(cleared.gaugeId, null);
});

test("gauge selection synchronizes river and rainfall coordinates while allowing unmapped gauges", () => {
  const mapped = Dashboard.selectGauge({ mode: null }, "alpha", STATIONS);
  assert.deepEqual(mapped.rainfallCoordinates, { latitude: 7.1, longitude: 80.1 });
  assert.equal(mapped.riverId, "River A");
  assert.equal(mapped.mode, "gauge");
  const unmapped = Dashboard.selectGauge(mapped, "beta", STATIONS);
  assert.equal(unmapped.riverId, "River B");
  assert.equal(unmapped.rainfallCoordinates, null);
});

test("request coordination aborts stale rainfall requests and rejects old tokens", () => {
  class Controller {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }
  const coordinator = new Dashboard.RequestCoordinator(Controller);
  const first = coordinator.begin();
  const second = coordinator.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  coordinator.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test("status visuals use both shape and stale outline state", () => {
  assert.deepEqual(Dashboard.statusVisual("Alert", false), {
    className: "alert", shape: "triangle", label: "Alert", stale: false
  });
  assert.equal(Dashboard.statusVisual("Major", true).shape, "diamond");
  assert.equal(Dashboard.statusVisual("Major", true).className, "major stale");
  assert.equal(Dashboard.statusVisual("not-a-status").shape, "ring");
});

test("aligned series constructs every date and preserves independent rainfall and river gaps", () => {
  const rows = Dashboard.alignSeries("2026-08-01", "2026-08-04",
    [{ date: "2026-08-01", rain: 5 }, { date: "2026-08-03", rain: 0 }],
    [{ date: "2026-08-02", peakM: -0.2 }, { date: "2026-08-03", peakM: 1.1 }]);
  assert.deepEqual(rows.map(row => row.date), ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
  assert.equal(rows[0].river, null);
  assert.equal(rows[1].rainfall, null);
  assert.equal(rows[2].rainfall.rain, 0);
  assert.equal(rows[3].river, null);
});

test("checked archive keeps trusted coordinates and the official Thambuththegama override", () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "river-levels.json"), "utf8"));
  const station = archive.stations.find(item => item.id === "thambuththegama");
  assert.ok(Math.abs(station.latitude - River.THAMBUTHTHEGAMA_COORDINATE.latitude) < 1e-12);
  assert.ok(Math.abs(station.longitude - River.THAMBUTHTHEGAMA_COORDINATE.longitude) < 1e-12);
  assert.equal(station.coordinate_source, River.THAMBUTHTHEGAMA_COORDINATE.source);
  assert.match(station.coordinate_note, /8°07′16″N, 80°19′32″E/);
  assert.ok(archive.stations.every(item => item.latitude === null || item.coordinate_source));
});

test("archive generation never replaces trusted station coordinates with ArcGIS geometry", () => {
  const mirror = { station_name: "Dunamale", time_ut: 1764322417, water_level_m: 5.96 };
  const archive = River.buildArchive({
    mirrorRecords: [mirror],
    stationMetadata: [{ name: "Dunamale", river_name: "Aththanagalu Oya", lat_lng: [7.1156, 80.0806], coordinate_source: "trusted-test" }],
    rivers: [{ name: "Aththanagalu Oya", basin_name: "Aththanagalu Oya" }],
    liveFeatures: [{ attributes: { gauge: "Dunamale", basin: "Aththanagalu Oya", CreationDate: 1764322417000,
      water_level: 5.96, alertpull: 3, minorpull: 4, majorpull: 5 }, geometry: { x: 0, y: 0 } }]
  });
  const station = archive.stations[0];
  assert.deepEqual([station.latitude, station.longitude], [7.1156, 80.0806]);
  assert.equal(station.coordinate_source, "trusted-test");
});

test("client markup pins local Leaflet and contains one coordinated chart", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.match(html, /vendor\/leaflet\/leaflet\.js/);
  assert.match(html, /vendor\/leaflet\/leaflet\.css/);
  assert.match(html, /id="combinedChart"/);
  assert.doesNotMatch(html, /id="riverChartScroll"|id="chartScroll"/);
  assert.doesNotMatch(app, /tileLayer\s*\(/);
  assert.match(app, /new Dashboard\.RequestCoordinator/);
});
