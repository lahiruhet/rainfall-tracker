(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RiverLevels = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIME_ZONE = "Asia/Colombo";
  const LKT_OFFSET = "+05:30";
  const FEET_TO_METRES = 0.3048;
  const NAGALAGAM = "Nagalagam Street";
  const ARCHIVE_START = "2025-11-28";
  const DAILY_FIELDS = [
    "date", "peak_m", "peak_time_lkt", "final_m", "final_time_lkt",
    "observations", "alert_m", "minor_m", "major_m", "provenance"
  ];
  const RECENT_FIELDS = ["time_ut", "level_m", "source"];
  const DMC_SPOT_CHECK = Object.freeze({
    station: "Dunamale",
    observed_at_lkt: "2025-11-28T15:03:37+05:30",
    level_m: 5.96,
    mirror_record: "https://github.com/nuuuwan/lk_irrigation/blob/main/data/rwlds/aththanagalu-oya-basin/aththanagalu-oya-river/dunamale-station/2025/2025-11/2025-11-28/2025-11-28-15-03-37.json",
    official_bulletin: "https://www.dmc.gov.lk/images/dmcreports/Water_level_%26_Rainfall_2025__1764326082.pdf",
    note: "Community-mirror observation matches the official DMC bulletin at approximately 15:00 LKT."
  });

  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  });

  function finite(value) {
    return typeof value === "number" ? Number.isFinite(value) :
      value !== null && value !== "" && Number.isFinite(Number(value));
  }

  function round(value, digits = 5) {
    if (!finite(value)) return null;
    const factor = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function epochSeconds(value, unit) {
    if (!finite(value)) return null;
    const n = Number(value);
    if (unit === "seconds") return Math.floor(n);
    if (unit === "milliseconds") return Math.floor(n / 1000);
    return Math.floor(Math.abs(n) >= 1e11 ? n / 1000 : n);
  }

  function dateParts(epoch) {
    const parts = dateFormatter.formatToParts(new Date(epoch * 1000));
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  }

  function lktDate(epoch) {
    if (!finite(epoch)) return null;
    const p = dateParts(Number(epoch));
    return `${p.year}-${p.month}-${p.day}`;
  }

  function lktTime(epoch) {
    if (!finite(epoch)) return null;
    return timeFormatter.format(new Date(Number(epoch) * 1000));
  }

  function lktDateTime(epoch) {
    const date = lktDate(epoch);
    return date ? `${date}T${lktTime(epoch)}${LKT_OFFSET}` : null;
  }

  function utcDateTime(epoch) {
    return finite(epoch) ? new Date(Number(epoch) * 1000).toISOString().replace(".000Z", "Z") : null;
  }

  function convertToMetres(value, unit) {
    if (!finite(value)) return null;
    return round(Number(value) * (unit === "ft" ? FEET_TO_METRES : 1));
  }

  function cleanThreshold(value, unit) {
    if (!finite(value)) return null;
    return convertToMetres(value, unit);
  }

  function thresholdsFrom(source, unit = "m") {
    source = source || {};
    return {
      alert: cleanThreshold(source.alert ?? source.alertpull ?? source.alert_level_m, unit),
      minor: cleanThreshold(source.minor ?? source.minorpull ?? source.minor_flood_level_m, unit),
      major: cleanThreshold(source.major ?? source.majorpull ?? source.major_flood_level_m, unit)
    };
  }

  function usableThreshold(value) {
    return finite(value) && Number(value) > 0;
  }

  function statusFor(levelM, thresholds) {
    if (!finite(levelM)) return "Unknown";
    const t = thresholds || {};
    if (![t.alert, t.minor, t.major].some(usableThreshold)) return "Unknown";
    if (usableThreshold(t.major) && Number(levelM) >= Number(t.major)) return "Major";
    if (usableThreshold(t.minor) && Number(levelM) >= Number(t.minor)) {
      return usableThreshold(t.major) ? "Minor" : "Unknown";
    }
    if (usableThreshold(t.alert) && Number(levelM) >= Number(t.alert)) {
      return usableThreshold(t.minor) ? "Alert" : "Unknown";
    }
    return usableThreshold(t.alert) ? "Normal" : "Unknown";
  }

  function normalizeMirrorRecord(record) {
    const station = String(record?.station_name || "").trim();
    const timestamp = epochSeconds(record?.time_ut, "seconds");
    if (!station || timestamp === null || !finite(record?.water_level_m)) return null;
    return {
      station, stationId: slugify(station), timestamp,
      levelM: round(Number(record.water_level_m)), source: "community_mirror",
      basin: record.basin || null, thresholds: thresholdsFrom(record)
    };
  }

  function normalizeArcGISFeature(feature) {
    const a = feature?.attributes || feature || {};
    const station = String(a.gauge || "").trim();
    const timestamp = epochSeconds(a.CreationDate, "milliseconds");
    if (!station || timestamp === null || !finite(a.water_level)) return null;
    const sourceUnit = station === NAGALAGAM ? "ft" : "m";
    return {
      station, stationId: slugify(station), timestamp,
      levelM: convertToMetres(Number(a.water_level), sourceUnit),
      source: "official_arcgis", basin: a.basin || null,
      thresholds: thresholdsFrom(a, sourceUnit)
    };
  }

  function measurementKey(item) {
    return `${item.stationId}\u0000${item.timestamp}`;
  }

  function compareMeasurements(a, b) {
    return a.station.localeCompare(b.station, "en") || a.timestamp - b.timestamp ||
      a.source.localeCompare(b.source, "en");
  }

  function dedupeMeasurements(mirror, official) {
    const map = new Map();
    for (const item of mirror || []) if (item) map.set(measurementKey(item), item);
    for (const item of official || []) if (item) map.set(measurementKey(item), item);
    return [...map.values()].sort(compareMeasurements);
  }

  function provenanceOf(items) {
    const sources = new Set(items.map(item => item.source));
    return ["community_mirror", "official_arcgis"].filter(source => sources.has(source)).join("+");
  }

  function thresholdForDay(items, fallback) {
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i].thresholds || {};
      if (usableThreshold(t.alert) || usableThreshold(t.minor) || usableThreshold(t.major)) return t;
    }
    return fallback || { alert: null, minor: null, major: null };
  }

  function aggregateDaily(measurements, stationsById = {}) {
    const groups = new Map();
    for (const item of measurements || []) {
      if (!item || !finite(item.levelM) || !finite(item.timestamp)) continue;
      const date = lktDate(item.timestamp);
      const key = `${item.stationId}\u0000${date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const output = {};
    for (const items of groups.values()) {
      items.sort((a, b) => a.timestamp - b.timestamp ||
        (a.source === "official_arcgis" ? 1 : -1));
      const first = items[0];
      let peak = first;
      for (const item of items) if (item.levelM > peak.levelM) peak = item;
      const final = items[items.length - 1];
      const fallback = stationsById[first.stationId]?.thresholds;
      const thresholds = thresholdForDay(items, fallback);
      const row = {
        date: lktDate(first.timestamp), peakM: round(peak.levelM),
        peakTimeLkt: lktDateTime(peak.timestamp), finalM: round(final.levelM),
        finalTimeLkt: lktDateTime(final.timestamp), observations: items.length,
        alertM: round(thresholds.alert), minorM: round(thresholds.minor),
        majorM: round(thresholds.major), provenance: provenanceOf(items)
      };
      if (!output[first.stationId]) output[first.stationId] = [];
      output[first.stationId].push(row);
    }
    for (const rows of Object.values(output)) rows.sort((a, b) => a.date.localeCompare(b.date));
    return output;
  }

  function compactDailyRow(row) {
    return [row.date, row.peakM, row.peakTimeLkt, row.finalM, row.finalTimeLkt,
      row.observations, row.alertM, row.minorM, row.majorM, row.provenance];
  }

  function expandDailyRow(row) {
    if (!Array.isArray(row)) return row;
    const values = Object.fromEntries(DAILY_FIELDS.map((field, index) => [field, row[index]]));
    return {
      date: values.date, peakM: values.peak_m, peakTimeLkt: values.peak_time_lkt,
      finalM: values.final_m, finalTimeLkt: values.final_time_lkt,
      observations: values.observations, alertM: values.alert_m,
      minorM: values.minor_m, majorM: values.major_m, provenance: values.provenance
    };
  }

  function compactRecentMeasurement(item) {
    return [item.timestamp, round(item.levelM), item.source === "official_arcgis" ? "a" : "m"];
  }

  function expandRecentMeasurement(row, station) {
    if (!Array.isArray(row) || row.length !== RECENT_FIELDS.length || !station) return null;
    const timestamp = epochSeconds(row[0], "seconds");
    if (timestamp === null || !finite(row[1]) || (row[2] !== "m" && row[2] !== "a")) return null;
    const thresholds = station.thresholds_m || station.thresholds || {};
    return {
      station: station.name, stationId: station.id || slugify(station.name), timestamp,
      levelM: round(row[1]), source: row[2] === "a" ? "official_arcgis" : "community_mirror",
      basin: station.basin || null,
      thresholds: { alert: thresholds.alert ?? null, minor: thresholds.minor ?? null, major: thresholds.major ?? null }
    };
  }

  function mergeDailyRows(base, extra) {
    if (!base) return extra || null;
    if (!extra) return base;
    const extraWinsPeak = extra.peakM > base.peakM ||
      (extra.peakM === base.peakM && extra.peakTimeLkt < base.peakTimeLkt);
    const extraWinsFinal = extra.finalTimeLkt > base.finalTimeLkt;
    const sources = new Set(`${base.provenance}+${extra.provenance}`.split("+").filter(Boolean));
    const provenance = ["community_mirror", "official_arcgis"].filter(source => sources.has(source)).join("+");
    return {
      date: base.date,
      peakM: extraWinsPeak ? extra.peakM : base.peakM,
      peakTimeLkt: extraWinsPeak ? extra.peakTimeLkt : base.peakTimeLkt,
      finalM: extraWinsFinal ? extra.finalM : base.finalM,
      finalTimeLkt: extraWinsFinal ? extra.finalTimeLkt : base.finalTimeLkt,
      observations: base.observations + extra.observations,
      alertM: extraWinsFinal ? extra.alertM : base.alertM,
      minorM: extraWinsFinal ? extra.minorM : base.minorM,
      majorM: extraWinsFinal ? extra.majorM : base.majorM,
      provenance
    };
  }

  function mergeRecentMeasurements(archived, live) {
    const mirror = (archived || []).filter(item => item?.source === "community_mirror");
    const official = (archived || []).filter(item => item?.source === "official_arcgis").concat(live || []);
    return dedupeMeasurements(mirror, official);
  }

  function latestPair(measurements) {
    const sorted = [...(measurements || [])].sort((a, b) => a.timestamp - b.timestamp);
    const current = sorted.at(-1);
    if (!current) return null;
    const previous = sorted.at(-2) || null;
    return [lktDateTime(current.timestamp), round(current.levelM),
      previous ? lktDateTime(previous.timestamp) : null,
      previous ? round(previous.levelM) : null, current.source];
  }

  function isStale(observedAt, now = Date.now(), hours = 24) {
    const observed = typeof observedAt === "number" ?
      (observedAt < 1e11 ? observedAt * 1000 : observedAt) : Date.parse(observedAt);
    return !Number.isFinite(observed) || Number(now) - observed > hours * 3600000;
  }

  function trendFor(current, previous, epsilon = 0.00001) {
    if (!finite(current) || !finite(previous)) return { direction: "unknown", deltaM: null };
    const deltaM = round(Number(current) - Number(previous));
    return { direction: Math.abs(deltaM) <= epsilon ? "steady" : deltaM > 0 ? "rising" : "falling", deltaM };
  }

  function buildRiverMap(rivers) {
    const map = new Map();
    for (const river of rivers || []) map.set(river.name, river.basin_name || river.name);
    return map;
  }

  function featureAttributes(feature) {
    return feature?.attributes || feature || {};
  }

  function buildArchive({ mirrorRecords = [], stationMetadata = [], rivers = [], liveFeatures = [], start = ARCHIVE_START }) {
    const riverBasins = buildRiverMap(rivers);
    const mirror = mirrorRecords.map(normalizeMirrorRecord).filter(Boolean)
      .filter(item => lktDate(item.timestamp) >= start);
    const official = liveFeatures.map(normalizeArcGISFeature).filter(Boolean)
      .filter(item => lktDate(item.timestamp) >= start);
    const measurements = dedupeMeasurements(mirror, official);

    const metaById = {};
    for (const meta of stationMetadata) {
      const name = String(meta?.name || "").trim();
      if (!name) continue;
      const id = slugify(name);
      metaById[id] = {
        id, name, basin: riverBasins.get(meta.river_name) || meta.river_name || "Unassigned",
        river: meta.river_name || null, thresholds: thresholdsFrom(meta),
        latitude: finite(meta.lat_lng?.[0]) ? Number(meta.lat_lng[0]) : null,
        longitude: finite(meta.lat_lng?.[1]) ? Number(meta.lat_lng[1]) : null
      };
    }

    const liveDescriptors = new Map();
    for (const feature of liveFeatures) {
      const a = featureAttributes(feature);
      const name = String(a.gauge || "").trim();
      if (!name) continue;
      const id = slugify(name);
      const unit = name === NAGALAGAM ? "ft" : "m";
      liveDescriptors.set(id, {
        id, name, basin: a.basin || metaById[id]?.basin || "Unassigned",
        thresholds: thresholdsFrom(a, unit)
      });
    }

    const mirrorIds = new Set(mirror.map(item => item.stationId));
    const observedIds = new Set(measurements.map(item => item.stationId));
    const includedIds = new Set([...observedIds, ...liveDescriptors.keys()]);
    const stationsById = {};
    for (const id of includedIds) {
      const observation = measurements.find(item => item.stationId === id);
      const base = metaById[id] || {};
      const live = liveDescriptors.get(id) || {};
      const liveThresholds = live.thresholds || {};
      stationsById[id] = {
        id, name: live.name || base.name || observation?.station || id,
        basin: live.basin || base.basin || observation?.basin || "Unassigned",
        river: base.river || null,
        thresholds: {
          alert: usableThreshold(liveThresholds.alert) ? liveThresholds.alert : base.thresholds?.alert ?? null,
          minor: usableThreshold(liveThresholds.minor) ? liveThresholds.minor : base.thresholds?.minor ?? null,
          major: usableThreshold(liveThresholds.major) ? liveThresholds.major : base.thresholds?.major ?? null
        },
        displayUnit: (live.name || base.name) === NAGALAGAM ? "ft" : "m",
        latitude: base.latitude ?? null, longitude: base.longitude ?? null,
        liveOnly: !mirrorIds.has(id)
      };
    }

    const dailyExpanded = aggregateDaily(measurements, stationsById);
    const stations = [];
    for (const station of Object.values(stationsById)) {
      const stationMeasurements = measurements.filter(item => item.stationId === station.id);
      const mirrorStation = mirror.filter(item => item.stationId === station.id)
        .sort((a, b) => a.timestamp - b.timestamp);
      const daily = dailyExpanded[station.id] || [];
      stations.push({
        id: station.id, name: station.name, basin: station.basin, river: station.river,
        display_unit: station.displayUnit, thresholds_m: station.thresholds,
        latitude: station.latitude, longitude: station.longitude,
        history_start: mirrorStation.length ? lktDate(mirrorStation[0].timestamp) : null,
        history_end: mirrorStation.length ? lktDate(mirrorStation.at(-1).timestamp) : null,
        data_start: daily[0]?.date || null, data_end: daily.at(-1)?.date || null,
        live_only: station.liveOnly,
        coverage_note: station.liveOnly ?
          `Official ArcGIS live coverage only; no community-mirror observations from ${start}.` : null,
        latest: latestPair(stationMeasurements)
      });
    }
    stations.sort((a, b) => a.basin.localeCompare(b.basin, "en") || a.name.localeCompare(b.name, "en"));

    const daily = {};
    for (const station of stations) {
      const rows = dailyExpanded[station.id];
      if (rows?.length) daily[station.id] = rows.map(compactDailyRow);
    }

    const mirrorDates = mirror.map(item => lktDate(item.timestamp)).sort();
    const officialDates = official.map(item => lktDate(item.timestamp)).sort();
    const allDates = measurements.map(item => lktDate(item.timestamp)).sort();
    const recentStart = officialDates[0] || null;
    const recent = {};
    if (recentStart) {
      for (const station of stations) {
        const rows = measurements.filter(item => item.stationId === station.id && lktDate(item.timestamp) >= recentStart);
        if (rows.length) recent[station.id] = rows.map(compactRecentMeasurement);
      }
    }
    const maxEpoch = measurements.reduce((max, item) => Math.max(max, item.timestamp), 0);
    const spotRecord = mirror.find(item => item.station === DMC_SPOT_CHECK.station &&
      lktDateTime(item.timestamp) === DMC_SPOT_CHECK.observed_at_lkt &&
      Math.abs(item.levelM - DMC_SPOT_CHECK.level_m) < 0.00001);

    return {
      version: 1,
      generated_at: maxEpoch ? utcDateTime(maxEpoch) : null,
      coverage: {
        timezone: TIME_ZONE, requested_start: start,
        start: allDates[0] || null, end: allDates.at(-1) || null,
        mirror_start: mirrorDates[0] || null, mirror_end: mirrorDates.at(-1) || null,
        official_start: officialDates[0] || null, official_end: officialDates.at(-1) || null,
        mirror_records: mirror.length, official_records: official.length,
        merged_records: measurements.length
      },
      sources: {
        official: "https://www.arcgis.com/apps/dashboards/2cffe83c9ff5497d97375498bdf3ff38",
        official_layer: "https://services3.arcgis.com/J7ZFXmR8rSmQ3FGf/arcgis/rest/services/gauges_2_view/FeatureServer/0",
        community_mirror: "https://github.com/nuuuwan/lk_irrigation",
        dmc_verification: DMC_SPOT_CHECK.official_bulletin
      },
      daily_fields: DAILY_FIELDS,
      recent_fields: RECENT_FIELDS,
      recent,
      verification: { dunamale_2025_11_28: { ...DMC_SPOT_CHECK, matched: Boolean(spotRecord) } },
      stations,
      daily
    };
  }

  async function fetchArcGISPages(baseUrl, fetchImpl = fetch, pageSize = 1000) {
    const features = [];
    let offset = 0;
    for (let page = 0; page < 1000; page++) {
      const url = new URL(baseUrl.replace(/\/$/, "") + "/query");
      url.search = new URLSearchParams({
        where: "1=1", outFields: "objectid,basin,gauge,water_level,CreationDate,alertpull,minorpull,majorpull",
        orderByFields: "objectid ASC", resultOffset: String(offset),
        resultRecordCount: String(pageSize), returnGeometry: "false", f: "json"
      }).toString();
      const response = await fetchImpl(url.toString());
      if (!response?.ok) throw new Error(`ArcGIS request failed: HTTP ${response?.status ?? "unknown"}`);
      const body = await response.json();
      if (body?.error) throw new Error(`ArcGIS error: ${body.error.message || "unknown response"}`);
      if (!Array.isArray(body?.features)) throw new Error("ArcGIS response did not contain a features array");
      features.push(...body.features);
      if (!body.exceededTransferLimit && body.features.length < pageSize) break;
      if (!body.features.length) throw new Error("ArcGIS pagination stalled on an empty page");
      offset += body.features.length;
    }
    return features;
  }

  function sourceAvailability(archive, live) {
    if (archive && live) return "archive+live";
    if (live) return "live-only";
    if (archive) return "cached-archive";
    return "unavailable";
  }

  function validArchiveShape(value) {
    return Boolean(value && value.version === 1 && Array.isArray(value.stations) &&
      value.daily && typeof value.daily === "object" && Array.isArray(value.daily_fields));
  }

  function riverCsvRecord(station, dailyRow) {
    const row = dailyRow || null;
    const thresholds = row ? {
      alert: row.alertM, minor: row.minorM, major: row.majorM
    } : (station?.thresholds_m || station?.thresholds || {});
    return {
      river_station: station?.name || "",
      river_basin: station?.basin || "",
      river_peak_m: row?.peakM ?? "",
      river_peak_time_lkt: row?.peakTimeLkt || "",
      river_status: row ? statusFor(row.peakM, thresholds) : "",
      river_observations: row?.observations ?? "",
      river_alert_m: thresholds.alert ?? "",
      river_minor_m: thresholds.minor ?? "",
      river_major_m: thresholds.major ?? "",
      river_provenance: row?.provenance || ""
    };
  }

  return {
    TIME_ZONE, LKT_OFFSET, FEET_TO_METRES, NAGALAGAM, ARCHIVE_START,
    DAILY_FIELDS, RECENT_FIELDS, DMC_SPOT_CHECK, finite, round, slugify, epochSeconds,
    lktDate, lktTime, lktDateTime, utcDateTime, convertToMetres,
    thresholdsFrom, statusFor, normalizeMirrorRecord, normalizeArcGISFeature,
    dedupeMeasurements, aggregateDaily, compactDailyRow, expandDailyRow,
    compactRecentMeasurement, expandRecentMeasurement, mergeDailyRows, mergeRecentMeasurements,
    latestPair, isStale, trendFor, buildArchive, fetchArcGISPages, sourceAvailability,
    validArchiveShape,
    riverCsvRecord
  };
});
