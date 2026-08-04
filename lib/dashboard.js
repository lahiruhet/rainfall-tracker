(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RainRiverDashboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIME_ZONE = "Asia/Colombo";
  const DITWAH_DATE = "2025-11-28";
  const DAY_MS = 86_400_000;
  const STATUS_VISUALS = Object.freeze({
    Normal: { className: "normal", shape: "circle", label: "Normal" },
    Alert: { className: "alert", shape: "triangle", label: "Alert" },
    Minor: { className: "minor", shape: "square", label: "Minor flood" },
    Major: { className: "major", shape: "diamond", label: "Major flood" },
    Unknown: { className: "unknown", shape: "ring", label: "Unknown" }
  });

  const lktDateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });

  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function parseDate(value) { return new Date(`${value}T00:00:00Z`); }
  function addDays(value, days) { return isoDate(new Date(parseDate(value).getTime() + days * DAY_MS)); }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
    const date = parseDate(value);
    return Number.isFinite(date.getTime()) && isoDate(date) === value;
  }

  function lktToday(now = Date.now()) {
    const parts = Object.fromEntries(lktDateFormatter.formatToParts(new Date(now))
      .map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function inclusiveRange(days, now = Date.now()) {
    const count = Number(days);
    if (!Number.isInteger(count) || count < 1) throw new Error("Range days must be a positive integer");
    const end = lktToday(now);
    return { start: addDays(end, -(count - 1)), end };
  }

  function dateSequence(start, end) {
    if (!validDate(start) || !validDate(end) || start > end) return [];
    const output = [];
    for (let current = start; current <= end; current = addDays(current, 1)) output.push(current);
    return output;
  }

  function stationMap(stations) {
    if (stations instanceof Map) return stations;
    return new Map((stations || []).map(station => [station.id, station]));
  }

  function parseQuery(search, stations = [], riverIds = [], now = Date.now()) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const byId = stationMap(stations);
    const validRivers = new Set(riverIds || []);
    const fallback = inclusiveRange(30, now);
    const today = fallback.end;
    const requestedStart = params.get("start");
    const requestedEnd = params.get("end");
    const validRange = validDate(requestedStart) && validDate(requestedEnd) &&
      requestedStart <= requestedEnd && requestedEnd <= today;
    const gaugeId = byId.has(params.get("gauge")) ? params.get("gauge") : null;
    const station = gaugeId ? byId.get(gaugeId) : null;
    let riverId = validRivers.has(params.get("river")) ? params.get("river") : null;
    if (station && validRivers.has(station.basin)) riverId = station.basin;
    return {
      gaugeId, riverId,
      start: validRange ? requestedStart : fallback.start,
      end: validRange ? requestedEnd : fallback.end,
      usedDefaultRange: !validRange
    };
  }

  function filterStations(stations, riverId) {
    return [...(stations || [])].filter(station => !riverId || station.basin === riverId)
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  function selectRiver(state, riverId, stations = []) {
    const byId = stationMap(stations);
    const selected = state.gaugeId ? byId.get(state.gaugeId) : null;
    return {
      ...state, riverId: riverId || null,
      gaugeId: riverId && selected && selected.basin !== riverId ? null : state.gaugeId
    };
  }

  function selectGauge(state, gaugeId, stations = []) {
    const station = stationMap(stations).get(gaugeId);
    if (!station) return { ...state, gaugeId: null };
    return {
      ...state, gaugeId: station.id, riverId: station.basin, mode: "gauge",
      rainfallCoordinates: Number.isFinite(station.latitude) && Number.isFinite(station.longitude) ?
        { latitude: station.latitude, longitude: station.longitude } : null
    };
  }

  function statusVisual(status, stale = false) {
    const base = STATUS_VISUALS[status] || STATUS_VISUALS.Unknown;
    return { ...base, stale: Boolean(stale), className: `${base.className}${stale ? " stale" : ""}` };
  }

  function alignSeries(start, end, rainfallRows = [], riverRows = []) {
    const rainfall = new Map(rainfallRows.map(row => [row.date, row]));
    const river = riverRows instanceof Map ? riverRows : new Map(riverRows.map(row => [row.date, row]));
    return dateSequence(start, end).map(date => ({
      date, rainfall: rainfall.get(date) || null, river: river.get(date) || null
    }));
  }

  class RequestCoordinator {
    constructor(AbortControllerImpl = globalThis.AbortController) {
      this.AbortControllerImpl = AbortControllerImpl;
      this.sequence = 0;
      this.controller = null;
    }
    begin() {
      if (this.controller) this.controller.abort();
      this.controller = new this.AbortControllerImpl();
      const token = ++this.sequence;
      return { token, signal: this.controller.signal, isCurrent: () => token === this.sequence };
    }
    cancel() {
      if (this.controller) this.controller.abort();
      this.controller = null;
      this.sequence += 1;
    }
  }

  return {
    TIME_ZONE, DITWAH_DATE, STATUS_VISUALS, validDate, lktToday, inclusiveRange,
    addDays, dateSequence, parseQuery, filterStations, selectRiver, selectGauge,
    statusVisual, alignSeries, RequestCoordinator
  };
});
