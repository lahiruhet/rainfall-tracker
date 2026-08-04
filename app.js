"use strict";

const River = window.RiverLevels;
const Dashboard = window.RainRiverDashboard;
const ARCGIS_LAYER = "https://services3.arcgis.com/J7ZFXmR8rSmQ3FGf/arcgis/rest/services/gauges_2_view/FeatureServer/0";
const WEATHER_VARS = "precipitation_sum,rain_sum,precipitation_hours,temperature_2m_max,temperature_2m_min,windspeed_10m_max";
const STATUS_RANK = { Unknown: 0, Normal: 1, Alert: 2, Minor: 3, Major: 4 };
const STATUS_COLORS = { Normal: "#198754", Alert: "#d28b00", Minor: "#d65a31", Major: "#9e2146", Unknown: "#6f7775" };
const RAIN_BANDS = [[1, "#9ccfe0"], [10, "#68b7d2"], [25, "#2e8fbb"], [50, "#17678e"], [100, "#76508f"], [150, "#9e2146"], [Infinity, "#68152e"]];
const EVENTS = [
  ["2025-11-28", "2025-12-05", "Ditwah landfall + first flood peak"],
  ["2025-12-19", "2025-12-23", "Second heavy-rain episode"]
];
const PLACES = [
  ["Negombo", 7.2083, 79.8358], ["Colombo", 6.9271, 79.8612], ["Kelaniya", 6.9553, 79.9219],
  ["Gampaha", 7.0917, 79.9997], ["Kalutara", 6.5854, 79.9607], ["Puttalam", 8.0362, 79.8283],
  ["Kurunegala", 7.4863, 80.3647], ["Kandy", 7.2906, 80.6337], ["Nuwara Eliya", 6.9497, 80.7891],
  ["Badulla", 6.9895, 81.0557], ["Ratnapura", 6.6828, 80.3992], ["Galle", 6.0535, 80.2210],
  ["Matara", 5.9485, 80.5353], ["Hambantota", 6.1241, 81.1185], ["Ampara", 7.2917, 81.6725],
  ["Batticaloa", 7.7102, 81.6924], ["Trincomalee", 8.5874, 81.2152], ["Polonnaruwa", 7.9403, 81.0188],
  ["Anuradhapura", 8.3114, 80.4037], ["Vavuniya", 8.7514, 80.4971], ["Mannar", 8.9810, 79.9044],
  ["Jaffna", 9.6615, 80.0255]
];

const $ = selector => document.querySelector(selector);
const el = {
  map: $("#riverMap"), mapFallback: $("#mapFallback"), riverFilterHeading: $("#riverFilterHeading"),
  riverFilterNote: $("#riverFilterNote"), showAllRivers: $("#showAllRivers"), riverSystem: $("#riverSystem"), gauge: $("#gauge"),
  gaugeList: $("#gaugeList"), start: $("#start"), end: $("#end"), csv: $("#csv"),
  place: $("#place"), lat: $("#lat"), lon: $("#lon"), latField: $("#latField"), lonField: $("#lonField"),
  loadRainOnly: $("#loadRainOnly"), riverStatus: $("#riverStatus"), rainStatus: $("#rainStatus"),
  selectionHeading: $("#selectionHeading"), selectionSub: $("#selectionSub"), coverageNote: $("#coverageNote"),
  overview: $("#overview"), chartSub: $("#chartSub"), combinedReadout: $("#combinedReadout"),
  combinedChart: $("#combinedChart"), monthPanel: $("#monthPanel"), months: $("#months"),
  tablePanel: $("#tablePanel"), rowCount: $("#rowCount"), fMonth: $("#fMonth"), fMin: $("#fMin"),
  fReset: $("#fReset"), tableBody: $("#tableBody")
};

const initialRange = Dashboard.inclusiveRange(30);
let state = {
  riverId: null, gaugeId: null, mode: null, rainfallCoordinates: null,
  rainfallTarget: null, start: initialRange.start, end: initialRange.end
};
let RIVER_ARCHIVE = null;
let LIVE_FEATURES = null;
let LIVE_BY_STATION = new Map();
let MAP_DATA = null;
let STATIONS = new Map();
let ACTIVE_RIVER_DAILY = new Map();
let RAIN_ROWS = [];
let ALIGNED_ROWS = [];
let SORT = { key: "date", dir: 1 };
let map = null;
let outlineLayer = null;
let riverLayer = null;
let markerLayer = null;
const rainfallRequests = new Dashboard.RequestCoordinator();

const finite = River.finite;
const num = (value, digits = 1) => finite(value) ? Number(value).toFixed(digits) : "—";
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const slug = value => River.slugify(value) || "location";

function setStatus(target, html, mode = "") {
  target.className = `status${mode ? ` ${mode}` : ""}`;
  target.innerHTML = html;
}

async function getJSON(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function weatherRows(data) {
  const daily = data?.daily;
  if (!daily) return [];
  const precipitation = daily.precipitation_sum || daily.rain_sum || [];
  const wind = daily.windspeed_10m_max || daily.wind_speed_10m_max || [];
  return (daily.time || []).map((date, index) => ({
    date, rain: precipitation[index] ?? null, hours: daily.precipitation_hours?.[index] ?? null,
    tmax: daily.temperature_2m_max?.[index] ?? null, tmin: daily.temperature_2m_min?.[index] ?? null,
    wind: wind[index] ?? null
  })).filter(row => finite(row.rain) || finite(row.tmax));
}

function archiveStationMap() {
  return new Map((RIVER_ARCHIVE?.stations || []).map(station => [station.id, station]));
}

function liveStationDescriptors() {
  const descriptors = new Map();
  for (const feature of LIVE_FEATURES || []) {
    const attributes = feature.attributes || feature;
    const name = String(attributes.gauge || "").trim();
    if (!name) continue;
    const id = River.slugify(name);
    const unit = name === River.NAGALAGAM ? "ft" : "m";
    const normalized = River.normalizeArcGISFeature(feature);
    const existing = descriptors.get(id);
    if (!existing || (normalized?.timestamp || 0) > existing.timestamp) {
      descriptors.set(id, {
        id, name, basin: attributes.basin || "Unassigned", display_unit: unit,
        thresholds_m: River.thresholdsFrom(attributes, unit), timestamp: normalized?.timestamp || 0,
        latitude: null, longitude: null, coordinate_source: null, live_only: true,
        coverage_note: "Official live coverage only; map location unavailable until trusted station metadata is added."
      });
    }
  }
  return descriptors;
}

function preferredThreshold(live, archived) {
  return finite(live) && Number(live) > 0 ? live : archived ?? null;
}

function buildStations() {
  STATIONS = archiveStationMap();
  for (const [id, live] of liveStationDescriptors()) {
    const archived = STATIONS.get(id);
    if (!archived) { STATIONS.set(id, live); continue; }
    STATIONS.set(id, {
      ...archived, name: live.name || archived.name, basin: live.basin || archived.basin,
      display_unit: live.display_unit || archived.display_unit,
      thresholds_m: {
        alert: preferredThreshold(live.thresholds_m.alert, archived.thresholds_m?.alert),
        minor: preferredThreshold(live.thresholds_m.minor, archived.thresholds_m?.minor),
        major: preferredThreshold(live.thresholds_m.major, archived.thresholds_m?.major)
      },
      // ArcGIS geometry is intentionally never consulted: trusted archive metadata wins.
      latitude: archived.latitude, longitude: archived.longitude,
      coordinate_source: archived.coordinate_source || null,
      coordinate_note: archived.coordinate_note || null
    });
  }
  STATIONS = new Map([...STATIONS.entries()].sort(([, a], [, b]) =>
    a.basin.localeCompare(b.basin, "en") || a.name.localeCompare(b.name, "en")));
}

function liveMeasurements(stationId) {
  return LIVE_BY_STATION.get(stationId) || [];
}

function indexLiveMeasurements() {
  const grouped = new Map();
  for (const item of (LIVE_FEATURES || []).map(River.normalizeArcGISFeature).filter(Boolean)) {
    if (!grouped.has(item.stationId)) grouped.set(item.stationId, []);
    grouped.get(item.stationId).push(item);
  }
  LIVE_BY_STATION = new Map([...grouped].map(([stationId, items]) =>
    [stationId, River.dedupeMeasurements([], items)]));
}

function archivedRecentMeasurements(station) {
  return (RIVER_ARCHIVE?.recent?.[station.id] || [])
    .map(row => River.expandRecentMeasurement(row, station)).filter(Boolean);
}

function selectedDaily(station) {
  const rows = new Map();
  for (const compact of RIVER_ARCHIVE?.daily?.[station.id] || []) {
    const row = River.expandDailyRow(compact);
    rows.set(row.date, row);
  }
  const live = liveMeasurements(station.id);
  const stationConfig = { thresholds: station.thresholds_m || {} };
  const archivedRecent = archivedRecentMeasurements(station);
  if (archivedRecent.length) {
    const combined = River.mergeRecentMeasurements(archivedRecent, live);
    const combinedDaily = River.aggregateDaily(combined, { [station.id]: stationConfig })[station.id] || [];
    combinedDaily.forEach(row => rows.set(row.date, row));
  } else {
    const unseen = live.filter(item => {
      const archived = rows.get(River.lktDate(item.timestamp));
      return !archived || item.timestamp > Math.floor(Date.parse(archived.finalTimeLkt) / 1000);
    });
    const unseenDaily = River.aggregateDaily(unseen, { [station.id]: stationConfig })[station.id] || [];
    unseenDaily.forEach(row => rows.set(row.date, River.mergeDailyRows(rows.get(row.date), row)));
  }
  return new Map([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function currentTuple(station) {
  const live = liveMeasurements(station.id);
  if (live.length) {
    const combined = River.mergeRecentMeasurements(archivedRecentMeasurements(station), live);
    return { tuple: River.latestPair(combined.length ? combined : live), cached: false };
  }
  return { tuple: RIVER_ARCHIVE?.stations?.find(item => item.id === station.id)?.latest || station.latest || null, cached: true };
}

function stationSnapshot(station) {
  const { tuple, cached } = currentTuple(station);
  if (!tuple) return { tuple: null, status: "Unknown", stale: true, trend: River.trendFor(null, null), cached };
  const [, current, , previous] = tuple;
  return {
    tuple, cached, status: River.statusFor(current, station.thresholds_m),
    stale: River.isStale(tuple[0]), trend: River.trendFor(current, previous)
  };
}

function displayLevel(levelM, station, digits = 2) {
  if (!finite(levelM)) return "—";
  if (station?.display_unit === "ft" || station?.name === River.NAGALAGAM) {
    return `${num(Number(levelM) / River.FEET_TO_METRES, digits)} ft <span class="river-unit-secondary">(${num(levelM, digits)} m)</span>`;
  }
  return `${num(levelM, digits)} m`;
}

function plainLevel(levelM, station, digits = 2) {
  if (!finite(levelM)) return "unavailable";
  return station?.display_unit === "ft" ?
    `${num(Number(levelM) / River.FEET_TO_METRES, digits)} feet (${num(levelM, digits)} metres)` :
    `${num(levelM, digits)} metres`;
}

function displayDelta(deltaM, station) {
  if (!finite(deltaM)) return "No preceding reading";
  const sign = Number(deltaM) > 0 ? "+" : "";
  return station?.display_unit === "ft" ?
    `${sign}${num(Number(deltaM) / River.FEET_TO_METRES, 2)} ft (${sign}${num(deltaM, 2)} m)` :
    `${sign}${num(deltaM, 2)} m`;
}

function readableLkt(value) {
  return value ? `${value.slice(0, 10)} ${value.slice(11, 19)} LKT` : "—";
}

function selectedStation() { return state.gaugeId ? STATIONS.get(state.gaugeId) || null : null; }

function renderGaugeSelectors() {
  const stations = Dashboard.filterStations([...STATIONS.values()], state.riverId);
  const riverIds = [...new Set([
    ...(MAP_DATA?.river_systems || []).map(system => system.id),
    ...[...STATIONS.values()].map(station => station.basin)
  ])].sort((a, b) => a.localeCompare(b, "en"));
  el.riverSystem.replaceChildren(new Option("All monitored rivers (clear selection)", ""));
  riverIds.forEach(riverId => el.riverSystem.appendChild(new Option(riverId, riverId)));
  el.riverSystem.value = state.riverId || "";
  el.riverFilterHeading.textContent = state.riverId || "All monitored rivers";
  el.riverFilterNote.textContent = `${stations.length} gauge${stations.length === 1 ? "" : "s"} shown · choosing a river never chooses a gauge.`;
  el.gauge.replaceChildren(new Option("Select a gauge…", ""));
  for (const station of stations) {
    const locationNote = finite(station.latitude) && finite(station.longitude) ? "" : " — map location unavailable";
    el.gauge.appendChild(new Option(`${station.name}${station.live_only ? " — live only" : ""}${locationNote}`, station.id));
  }
  el.gauge.value = stations.some(station => station.id === state.gaugeId) ? state.gaugeId : "";
  el.gaugeList.innerHTML = stations.map(station => {
    const snapshot = stationSnapshot(station);
    const current = snapshot.tuple?.[1];
    const observed = snapshot.tuple?.[0];
    const trendSymbol = { rising: "↑", falling: "↓", steady: "→", unknown: "—" }[snapshot.trend.direction];
    const location = finite(station.latitude) && finite(station.longitude) ? "" :
      `<span class="unmapped">Map location unavailable · list selection still works</span>`;
    return `<button type="button" role="listitem" data-gauge="${escapeHTML(station.id)}" aria-current="${station.id === state.gaugeId}">
      <span class="gauge-name"><span>${escapeHTML(station.name)}</span><span class="mini-status ${snapshot.status.toLowerCase()}">${snapshot.status}${snapshot.stale ? " · stale" : ""}</span></span>
      <span class="gauge-meta">${escapeHTML(station.basin)} · ${displayLevel(current, station)} · ${trendSymbol} ${snapshot.trend.direction} · ${readableLkt(observed)} ${location}</span>
    </button>`;
  }).join("");
  el.gaugeList.querySelectorAll("[data-gauge]").forEach(button =>
    button.addEventListener("click", () => selectGaugeById(button.dataset.gauge)));
}

function popupHTML(station) {
  const snapshot = stationSnapshot(station);
  const [observed, current] = snapshot.tuple || [];
  const trendSymbol = { rising: "↑", falling: "↓", steady: "→", unknown: "—" }[snapshot.trend.direction];
  return `<div class="popup-title">${escapeHTML(station.name)}</div>
    <div>${escapeHTML(station.basin)}</div>
    <div><strong>${displayLevel(current, station)}</strong> · <span class="river-badge ${snapshot.status.toLowerCase()}">${snapshot.status}</span></div>
    <div>${trendSymbol} ${snapshot.trend.direction}${snapshot.stale ? " · stale" : ""}</div>
    <div class="popup-meta">Observed ${readableLkt(observed)}</div>`;
}

function markerIcon(station) {
  const snapshot = stationSnapshot(station);
  const visual = Dashboard.statusVisual(snapshot.status, snapshot.stale);
  const selected = station.id === state.gaugeId ? " selected" : "";
  return L.divIcon({
    className: "gauge-div-icon", iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -11],
    html: `<span class="gauge-marker ${visual.shape} ${visual.stale ? "stale" : ""}${selected}" style="--marker-color:${STATUS_COLORS[snapshot.status]}"></span>`
  });
}

function riverStyle(feature) {
  const selected = feature.properties.river_id === state.riverId;
  return {
    color: selected ? "#087e8b" : "#82938f", opacity: selected ? 1 : .62,
    weight: selected ? Math.min(5, 2.5 + feature.properties.flow_order * .32) :
      Math.min(2.5, .55 + feature.properties.flow_order * .25), lineCap: "round", lineJoin: "round"
  };
}

function initializeMap() {
  if (!MAP_DATA || !window.L) {
    el.map.classList.add("hidden");
    el.mapFallback.classList.remove("hidden");
    return;
  }
  try {
    map = L.map(el.map, { zoomControl: true, attributionControl: false, minZoom: 6, maxZoom: 11, preferCanvas: true });
    outlineLayer = L.geoJSON(MAP_DATA.outline, {
      interactive: false, style: { color: "#61716e", weight: 1.2, fillColor: "#f8fbf6", fillOpacity: .93 }
    }).addTo(map);
    riverLayer = L.geoJSON(MAP_DATA.rivers, {
      style: riverStyle,
      onEachFeature(feature, layer) {
        layer.bindTooltip(feature.properties.river_name, { sticky: true });
        layer.on("click", event => { L.DomEvent.stopPropagation(event); selectRiverById(feature.properties.river_id, true); });
      }
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    map.fitBounds(outlineLayer.getBounds(), { padding: [14, 14] });
    map.on("click", () => {});
    refreshMapSelection(false);
  } catch (error) {
    map = null;
    el.map.classList.add("hidden");
    el.mapFallback.classList.remove("hidden");
  }
}

function refreshMapSelection(fitRiver = false) {
  if (!map) return;
  riverLayer.setStyle(riverStyle);
  markerLayer.clearLayers();
  for (const station of STATIONS.values()) {
    if (!finite(station.latitude) || !finite(station.longitude)) continue;
    const marker = L.marker([station.latitude, station.longitude], {
      icon: markerIcon(station), keyboard: true, title: `${station.name}, ${station.basin}`,
      opacity: state.riverId && station.basin !== state.riverId ? .27 : 1
    }).bindPopup(popupHTML(station)).on("click", () => selectGaugeById(station.id));
    marker.addTo(markerLayer);
    marker.getElement()?.setAttribute("aria-label",
      `${station.name}, ${station.basin}, ${stationSnapshot(station).status} status`);
    if (station.id === state.gaugeId) marker.openPopup();
  }
  if (fitRiver && state.riverId) {
    const bounds = L.latLngBounds([]);
    riverLayer.eachLayer(layer => { if (layer.feature.properties.river_id === state.riverId) bounds.extend(layer.getBounds()); });
    if (bounds.isValid()) map.fitBounds(bounds.pad(.08), { maxZoom: 9, padding: [20, 20] });
  } else if (fitRiver && outlineLayer) map.fitBounds(outlineLayer.getBounds(), { padding: [14, 14] });
}

function updateURL() {
  const params = new URLSearchParams();
  if (state.gaugeId) params.set("gauge", state.gaugeId);
  if (state.riverId) params.set("river", state.riverId);
  params.set("start", state.start);
  params.set("end", state.end);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}${location.hash}`);
}

function updatePresetButtons() {
  document.querySelectorAll(".preset").forEach(button => {
    const range = button.dataset.days ? Dashboard.inclusiveRange(Number(button.dataset.days)) :
      { start: Dashboard.DITWAH_DATE, end: Dashboard.lktToday() };
    button.classList.toggle("active", state.start === range.start && state.end === range.end);
  });
}

function updateActiveRiver() {
  const station = selectedStation();
  ACTIVE_RIVER_DAILY = station && state.mode === "gauge" ? selectedDaily(station) : new Map();
}

function renderSelectionHeading() {
  const station = selectedStation();
  if (station && state.mode === "gauge") {
    el.selectionHeading.textContent = station.name;
    el.selectionSub.textContent = `${station.basin} · ${finite(station.latitude) ? `${num(station.latitude, 5)}° N, ${num(station.longitude, 5)}° E` : "map location unavailable"}`;
    const archiveStation = RIVER_ARCHIVE?.stations?.find(item => item.id === station.id);
    el.coverageNote.textContent = station.coordinate_note || station.coverage_note || archiveStation?.coverage_note ||
      `River history ${archiveStation?.history_start || "unavailable"} to ${archiveStation?.history_end || "unavailable"} · coordinate source recorded in station metadata.`;
  } else if (state.mode === "rainfall" && state.rainfallTarget) {
    el.selectionHeading.textContent = state.rainfallTarget.label;
    el.selectionSub.textContent = `Rainfall only · ${num(state.rainfallTarget.latitude, 5)}° N, ${num(state.rainfallTarget.longitude, 5)}° E`;
    el.coverageNote.textContent = "No river series is combined with city/custom rainfall. Choose a gauge to reset rainfall to trusted gauge coordinates.";
  } else if (state.riverId) {
    el.selectionHeading.textContent = state.riverId;
    el.selectionSub.textContent = "River-system context · no measuring point selected";
    el.coverageNote.textContent = "Choose one gauge in this river system to load its measured levels and coordinate-matched rainfall.";
  } else {
    el.selectionHeading.textContent = "Choose a gauge";
    el.selectionSub.textContent = "No default gauge is implied.";
    el.coverageNote.textContent = "Click a river to filter, then choose its exact measuring point.";
  }
}

function renderAll(fitRiver = false) {
  renderGaugeSelectors();
  refreshMapSelection(fitRiver);
  updateActiveRiver();
  updatePresetButtons();
  renderDashboard();
}

function selectRiverById(riverId, fitRiver = false) {
  const previousGauge = state.gaugeId;
  state = Dashboard.selectRiver(state, riverId, STATIONS);
  if (previousGauge && !state.gaugeId) {
    rainfallRequests.cancel();
    state = { ...state, mode: null, rainfallCoordinates: null, rainfallTarget: null };
    RAIN_ROWS = [];
  }
  updateURL();
  renderAll(fitRiver);
}

function selectGaugeById(gaugeId) {
  const station = STATIONS.get(gaugeId);
  if (!station) return;
  state = Dashboard.selectGauge(state, gaugeId, STATIONS);
  state.rainfallTarget = state.rainfallCoordinates ? {
    ...state.rainfallCoordinates, label: station.name, gaugeId: station.id
  } : null;
  if (finite(station.latitude) && finite(station.longitude)) {
    el.lat.value = station.latitude;
    el.lon.value = station.longitude;
  }
  RAIN_ROWS = [];
  updateURL();
  renderAll(true);
  if (state.rainfallTarget) loadRainfall(state.rainfallTarget);
  else {
    rainfallRequests.cancel();
    setStatus(el.rainStatus, "<strong>Map location unavailable.</strong> River observations remain usable, but rainfall cannot be fetched until trusted coordinates are added.", "warning");
    el.rainStatus.classList.remove("hidden");
  }
}

function clearSelection() {
  rainfallRequests.cancel();
  state = { ...state, riverId: null, gaugeId: null, mode: null, rainfallCoordinates: null, rainfallTarget: null };
  RAIN_ROWS = [];
  el.rainStatus.classList.add("hidden");
  updateURL();
  renderAll(true);
}

async function loadRainfall(target) {
  if (!target || !finite(target.latitude) || !finite(target.longitude)) return;
  const request = rainfallRequests.begin();
  const start = state.start, end = state.end;
  RAIN_ROWS = [];
  renderDashboard();
  el.loadRainOnly.disabled = true;
  el.rainStatus.classList.remove("hidden");
  setStatus(el.rainStatus, `Fetching modelled rainfall for <strong>${escapeHTML(target.label)}</strong>…`);
  const query = `latitude=${encodeURIComponent(target.latitude)}&longitude=${encodeURIComponent(target.longitude)}&timezone=Asia%2FColombo&daily=${WEATHER_VARS}`;
  const archiveURL = `https://archive-api.open-meteo.com/v1/archive?${query}&start_date=${start}&end_date=${end}`;
  const forecastURL = `https://api.open-meteo.com/v1/forecast?${query}&past_days=92&forecast_days=1`;
  try {
    const options = { signal: request.signal };
    const [archive, forecast] = await Promise.allSettled([getJSON(archiveURL, options), getJSON(forecastURL, options)]);
    if (!request.isCurrent()) return;
    if (archive.status === "rejected" && forecast.status === "rejected") throw archive.reason;
    const byDate = new Map();
    if (forecast.status === "fulfilled") weatherRows(forecast.value).forEach(row => byDate.set(row.date, { ...row, prelim: true }));
    if (archive.status === "fulfilled") weatherRows(archive.value).forEach(row => byDate.set(row.date, row));
    RAIN_ROWS = [...byDate.values()].filter(row => row.date >= start && row.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!RAIN_ROWS.length) throw new Error("The rainfall service returned no days for this range.");
    const partial = archive.status === "rejected" || forecast.status === "rejected";
    setStatus(el.rainStatus, `Loaded <strong>${RAIN_ROWS.length}</strong> rainfall day${RAIN_ROWS.length === 1 ? "" : "s"} for ${escapeHTML(target.label)}${partial ? " · one Open-Meteo endpoint was unavailable." : "."}`, partial ? "warning" : "");
    renderDashboard();
  } catch (error) {
    if (!request.isCurrent() || error?.name === "AbortError") return;
    RAIN_ROWS = [];
    setStatus(el.rainStatus, `<strong>Rainfall is unavailable.</strong> ${escapeHTML(error.message || error)} River map, status, and hydrograph remain usable.`, "error");
    renderDashboard();
  } finally {
    if (request.isCurrent()) el.loadRainOnly.disabled = false;
  }
}

function card(label, value, unit, note) {
  return `<div class="stat"><div class="k">${label}</div><div class="v">${value}${unit ? `<em>${unit}</em>` : ""}</div><div class="n">${note}</div></div>`;
}

function renderOverview() {
  const station = selectedStation();
  const snapshot = station && state.mode === "gauge" ? stationSnapshot(station) : null;
  const [observed, current] = snapshot?.tuple || [];
  const rainfall = RAIN_ROWS.filter(row => finite(row.rain));
  const latestRain = rainfall.at(-1) || null;
  const total = rainfall.reduce((sum, row) => sum + Number(row.rain), 0);
  const wettest = rainfall.reduce((best, row) => !best || row.rain > best.rain ? row : best, null);
  const riverRows = [...ACTIVE_RIVER_DAILY.values()].filter(row => row.date >= state.start && row.date <= state.end);
  const rangePeak = riverRows.reduce((best, row) => !best || row.peakM > best.peakM ? row : best, null);
  const trendSymbol = { rising: "↑", falling: "↓", steady: "→", unknown: "—" }[snapshot?.trend.direction || "unknown"];
  el.overview.innerHTML = [
    card("Current river level", station ? displayLevel(current, station) : "—", "", observed ? readableLkt(observed) : "No gauge selected"),
    card("Flood status", snapshot ? `<span class="river-badge ${snapshot.status.toLowerCase()}">${snapshot.status}</span>` : "—", "", station ? "Against documented gauge thresholds" : "River data not combined"),
    card("Trend & freshness", snapshot ? `${trendSymbol} ${snapshot.trend.direction}` : "—", "", snapshot ? `${displayDelta(snapshot.trend.deltaM, station)} · ${snapshot.stale ? "stale (>24 h)" : "fresh"}` : "No current observation"),
    card("Latest rainfall", latestRain ? num(latestRain.rain) : "—", latestRain ? "mm" : "", latestRain ? `${latestRain.date}${latestRain.prelim ? " · preliminary" : ""}` : "Rainfall not loaded"),
    card("Range rainfall", rainfall.length ? Math.round(total).toLocaleString() : "—", rainfall.length ? "mm" : "", rainfall.length ? `${rainfall.length} available day${rainfall.length === 1 ? "" : "s"}` : "Independent rainfall source unavailable"),
    card("Wettest day", wettest ? num(wettest.rain) : "—", wettest ? "mm" : "", wettest?.date || "No rainfall values"),
    card("Range river peak", rangePeak && station ? displayLevel(rangePeak.peakM, station) : "—", "", rangePeak ? `${rangePeak.date} · ${readableLkt(rangePeak.peakTimeLkt)}` : "No measured peak in range")
  ].join("");
}

function rainfallColor(mm) {
  return (RAIN_BANDS.find(([limit]) => Number(mm) < limit) || RAIN_BANDS.at(-1))[1];
}

function tooltipHTML(item, station) {
  const rain = item.rainfall, river = item.river;
  const rainText = rain ? `<b>${num(rain.rain)} mm rain</b> · ${num(rain.hours, 0)} rain hrs · ${num(rain.tmax)}°C max / ${num(rain.tmin)}°C min · wind ${num(rain.wind, 0)} km/h${rain.prelim ? " · preliminary" : ""}` : "Rainfall unavailable";
  if (!river || !station) return `<b>${item.date}</b> · ${rainText} · River observation unavailable`;
  const status = River.statusFor(river.peakM, { alert: river.alertM, minor: river.minorM, major: river.majorM });
  return `<b>${item.date}</b> · ${rainText}<br>River peak <b>${displayLevel(river.peakM, station)}</b> at ${readableLkt(river.peakTimeLkt)} · final ${displayLevel(river.finalM, station)} at ${readableLkt(river.finalTimeLkt)} · ${river.observations} observation${river.observations === 1 ? "" : "s"} · ${status} · ${escapeHTML(river.provenance.replaceAll("_", " ").replace("+", " + "))}`;
}

function tooltipLabel(item, station) {
  const rain = item.rainfall ? `${num(item.rainfall.rain)} millimetres rainfall` : "rainfall unavailable";
  const river = item.river && station ? `river peak ${plainLevel(item.river.peakM, station)}` : "river observation unavailable";
  return `${item.date}, ${rain}, ${river}`;
}

function renderCombinedChart() {
  const station = selectedStation();
  ALIGNED_ROWS = Dashboard.alignSeries(state.start, state.end, RAIN_ROWS, ACTIVE_RIVER_DAILY);
  const hasRain = ALIGNED_ROWS.some(item => item.rainfall);
  const hasRiver = ALIGNED_ROWS.some(item => item.river);
  const unit = station?.display_unit === "ft" ? "ft" : "m";
  el.chartSub.textContent = `Rainfall mm above · river level ${unit} below · shared complete LKT date sequence`;
  if (!hasRain && !hasRiver) {
    el.combinedChart.innerHTML = `<div class="chart-empty">No rainfall or river observations are available in this range. The selector and source statuses remain usable.</div>`;
    return;
  }
  el.combinedReadout.textContent = "Hover, touch, or focus a date to read rainfall, weather, exact river observations, and provenance together.";

  const n = ALIGNED_ROWS.length;
  const W = Math.max(900, 150 + n * 11), H = 570, ML = 70, MR = 78;
  const plotW = W - ML - MR, step = plotW / Math.max(1, n), x = index => ML + (index + .5) * step;
  const rainTop = 45, rainH = 150, rainBottom = rainTop + rainH;
  const riverTop = 286, riverH = 205, riverBottom = riverTop + riverH;
  const rainValues = ALIGNED_ROWS.map(item => item.rainfall?.rain).filter(finite);
  const maxRain = Math.max(10, ...rainValues), rainCeiling = Math.max(10, Math.ceil(maxRain / 25) * 25);
  const rainY = value => rainTop + (Number(value) / rainCeiling) * rainH;
  const toDisplay = value => station?.display_unit === "ft" ? Number(value) / River.FEET_TO_METRES : Number(value);
  const riverValues = ALIGNED_ROWS.map(item => item.river?.peakM).filter(finite).map(toDisplay);
  const thresholds = station?.thresholds_m || {};
  const displayThresholds = [thresholds.alert, thresholds.minor, thresholds.major].filter(value => finite(value) && Number(value) > 0).map(toDisplay);
  let riverLow = riverValues.length ? Math.min(...riverValues, ...displayThresholds) : 0;
  let riverHigh = riverValues.length ? Math.max(...riverValues, ...displayThresholds) : 1;
  const padding = Math.max((riverHigh - riverLow) * .14, unit === "ft" ? .5 : .2);
  riverLow = Math.floor((riverLow - padding) * 2) / 2;
  riverHigh = Math.ceil((riverHigh + padding) * 2) / 2;
  if (riverLow === riverHigh) { riverLow -= 1; riverHigh += 1; }
  const riverY = valueM => riverBottom - ((toDisplay(valueM) - riverLow) / (riverHigh - riverLow)) * riverH;
  const clampY = value => Math.max(riverTop, Math.min(riverBottom, value));
  let svg = "";

  for (const [start, end, label] of EVENTS) {
    const first = ALIGNED_ROWS.findIndex(item => item.date >= start);
    const last = ALIGNED_ROWS.findLastIndex(item => item.date <= end);
    if (first < 0 || last < 0) continue;
    const left = ML + first * step, right = ML + (last + 1) * step;
    svg += `<rect x="${left}" y="${rainTop}" width="${Math.max(2, right - left)}" height="${riverBottom - rainTop}" fill="#b4365b" opacity=".055"/>`;
    if (right - left > 130) svg += `<text x="${left + 4}" y="${rainTop - 10}" class="axis-text" fill="#9e2146">${escapeHTML(label.toUpperCase())}</text>`;
  }

  for (let index = 0; index <= 4; index++) {
    const rainfall = rainCeiling * index / 4, y = rainY(rainfall);
    svg += `<line x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" class="chart-grid"/><text x="${ML - 9}" y="${y + 3}" text-anchor="end" class="axis-text">${num(rainfall, 0)}</text>`;
  }
  svg += `<text x="${ML}" y="18" class="axis-title">RAINFALL (MM) · BARS FALL DOWNWARD</text>`;
  ALIGNED_ROWS.forEach((item, index) => {
    if (!finite(item.rainfall?.rain) || Number(item.rainfall.rain) <= 0) return;
    const height = Math.max(1, rainY(item.rainfall.rain) - rainTop);
    svg += `<rect x="${(x(index) - Math.max(1.5, step * .34)).toFixed(2)}" y="${rainTop}" width="${Math.max(2, step * .68).toFixed(2)}" height="${height.toFixed(2)}" fill="${rainfallColor(item.rainfall.rain)}"/>`;
  });

  if (station && riverValues.length) {
    const bands = [
      [riverLow, finite(thresholds.alert) && thresholds.alert > 0 ? toDisplay(thresholds.alert) : riverLow, "#198754", .05],
      [finite(thresholds.alert) && thresholds.alert > 0 ? toDisplay(thresholds.alert) : null, finite(thresholds.minor) && thresholds.minor > 0 ? toDisplay(thresholds.minor) : null, "#d28b00", .07],
      [finite(thresholds.minor) && thresholds.minor > 0 ? toDisplay(thresholds.minor) : null, finite(thresholds.major) && thresholds.major > 0 ? toDisplay(thresholds.major) : null, "#d65a31", .07],
      [finite(thresholds.major) && thresholds.major > 0 ? toDisplay(thresholds.major) : null, riverHigh, "#9e2146", .07]
    ];
    for (const [lower, upper, color, opacity] of bands) {
      if (!finite(lower) || !finite(upper) || upper <= lower) continue;
      const top = riverBottom - ((Math.min(upper, riverHigh) - riverLow) / (riverHigh - riverLow)) * riverH;
      const bottom = riverBottom - ((Math.max(lower, riverLow) - riverLow) / (riverHigh - riverLow)) * riverH;
      svg += `<rect x="${ML}" y="${clampY(top)}" width="${plotW}" height="${Math.max(0, clampY(bottom) - clampY(top))}" fill="${color}" opacity="${opacity}"/>`;
    }
  }
  for (let index = 0; index <= 4; index++) {
    const level = riverLow + (riverHigh - riverLow) * index / 4;
    const y = riverBottom - riverH * index / 4;
    svg += `<line x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" class="chart-grid"/><text x="${ML - 9}" y="${y + 3}" text-anchor="end" class="axis-text">${num(level, unit === "ft" ? 1 : 2)}</text>`;
  }
  svg += `<text x="${ML}" y="${riverTop - 20}" class="axis-title">DAILY PEAK RIVER LEVEL (${unit.toUpperCase()}) · GAUGE DATUM</text>`;
  [["Alert", thresholds.alert, "#b27600"], ["Minor", thresholds.minor, "#d65a31"], ["Major", thresholds.major, "#9e2146"]].forEach(([label, value, color]) => {
    if (!finite(value) || Number(value) <= 0 || !riverValues.length) return;
    const y = riverY(value);
    svg += `<line x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" stroke="${color}" stroke-dasharray="7 4"/><text x="${W - MR + 6}" y="${y + 3}" class="axis-text" fill="${color}">${label} ${num(toDisplay(value), unit === "ft" ? 1 : 2)}</text>`;
  });

  let segment = [];
  const flush = () => { if (segment.length > 1) svg += `<polyline points="${segment.join(" ")}" class="hydro-line"/>`; segment = []; };
  ALIGNED_ROWS.forEach((item, index) => {
    if (!item.river || !station) { flush(); return; }
    const point = `${x(index).toFixed(2)},${riverY(item.river.peakM).toFixed(2)}`;
    segment.push(point);
    const status = River.statusFor(item.river.peakM, { alert: item.river.alertM, minor: item.river.minorM, major: item.river.majorM });
    svg += `<circle cx="${x(index)}" cy="${riverY(item.river.peakM)}" r="3.4" class="hydro-dot" style="stroke:${STATUS_COLORS[status]}"/>`;
  });
  flush();

  let lastMonth = "";
  ALIGNED_ROWS.forEach((item, index) => {
    const month = item.date.slice(0, 7);
    if (month === lastMonth) return;
    lastMonth = month;
    const xPos = ML + index * step;
    const label = new Date(`${item.date}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).toUpperCase();
    svg += `<line x1="${xPos}" y1="${rainTop}" x2="${xPos}" y2="${riverBottom}" class="chart-month"/><text x="${xPos + 4}" y="${riverBottom + 24}" class="month-text">${label}</text>`;
  });
  svg += `<line id="chartCrosshair" x1="${ML}" y1="${rainTop}" x2="${ML}" y2="${riverBottom}" class="crosshair" visibility="hidden"/>`;
  ALIGNED_ROWS.forEach((item, index) => {
    svg += `<rect class="day-hit" data-index="${index}" tabindex="0" role="button" aria-label="${escapeHTML(tooltipLabel(item, station))}" x="${ML + index * step}" y="${rainTop}" width="${Math.max(2, step)}" height="${riverBottom - rainTop}"/>`;
  });
  el.combinedChart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Aligned daily rainfall and river-level chart with a shared date axis">${svg}</svg>`;
  const hits = [...el.combinedChart.querySelectorAll(".day-hit")];
  const show = index => {
    const item = ALIGNED_ROWS[index];
    if (!item) return;
    el.combinedReadout.innerHTML = tooltipHTML(item, station);
    const crosshair = el.combinedChart.querySelector("#chartCrosshair");
    crosshair.setAttribute("x1", x(index)); crosshair.setAttribute("x2", x(index)); crosshair.setAttribute("visibility", "visible");
  };
  hits.forEach((hit, index) => {
    hit.addEventListener("pointerenter", () => show(index));
    hit.addEventListener("pointerdown", () => show(index));
    hit.addEventListener("focus", () => show(index));
    hit.addEventListener("keydown", event => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        hits[Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))]?.focus();
      }
    });
  });
}

function renderMonths() {
  if (!RAIN_ROWS.length) { el.monthPanel.classList.add("hidden"); return; }
  el.monthPanel.classList.remove("hidden");
  const months = new Map();
  for (const row of RAIN_ROWS) {
    const key = row.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { total: 0, wet: 0, days: 0, max: 0 });
    const month = months.get(key);
    month.total += finite(row.rain) ? Number(row.rain) : 0; month.days += 1;
    if (Number(row.rain || 0) >= 1) month.wet += 1;
    month.max = Math.max(month.max, Number(row.rain || 0));
  }
  const peak = Math.max(1, ...[...months.values()].map(month => month.total));
  el.months.innerHTML = [...months.entries()].map(([key, month]) => {
    const label = new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    return `<div class="month"><div class="mn">${label}</div><div class="mv">${Math.round(month.total).toLocaleString()} <small>mm</small></div><div class="track"><i style="width:${month.total / peak * 100}%"></i></div><div class="md">${month.wet} wet of ${month.days} available days · peak ${num(month.max, 0)} mm</div></div>`;
  }).join("");
}

function rebuildMonthFilter() {
  const selected = el.fMonth.value;
  const months = [...new Set(ALIGNED_ROWS.map(item => item.date.slice(0, 7)))];
  el.fMonth.innerHTML = `<option value="">All</option>${months.map(key => {
    const label = new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    return `<option value="${key}">${label}</option>`;
  }).join("")}`;
  if (months.includes(selected)) el.fMonth.value = selected;
}

function tableRows() {
  const month = el.fMonth.value, minimum = Number.parseFloat(el.fMin.value) || 0;
  const rows = ALIGNED_ROWS.map(item => {
    const rain = item.rainfall, river = item.river;
    const riverStatus = river ? River.statusFor(river.peakM, { alert: river.alertM, minor: river.minorM, major: river.majorM }) : null;
    return {
      ...item, rain: rain?.rain ?? null, hours: rain?.hours ?? null, tmax: rain?.tmax ?? null,
      tmin: rain?.tmin ?? null, wind: rain?.wind ?? null, riverPeak: river?.peakM ?? null,
      riverStatus, riverStatusRank: STATUS_RANK[riverStatus] ?? -1
    };
  }).filter(row => (!month || row.date.startsWith(month)) && Number(row.rain || 0) >= minimum);
  rows.sort((a, b) => {
    const left = SORT.key === "date" ? a.date : a[SORT.key] ?? -Infinity;
    const right = SORT.key === "date" ? b.date : b[SORT.key] ?? -Infinity;
    return (left < right ? -1 : left > right ? 1 : 0) * SORT.dir;
  });
  return rows;
}

function renderTable() {
  const hasData = ALIGNED_ROWS.some(item => item.rainfall || item.river);
  if (!hasData) { el.tablePanel.classList.add("hidden"); el.csv.disabled = true; return; }
  el.tablePanel.classList.remove("hidden");
  el.csv.disabled = false;
  const station = selectedStation();
  const rows = tableRows();
  el.rowCount.textContent = `${rows.length} of ${ALIGNED_ROWS.length} LKT days · gaps shown explicitly`;
  el.tableBody.innerHTML = rows.map(row => {
    const rain = row.rainfall, river = row.river;
    const exact = [
      rain ? `${rain.prelim ? "Preliminary " : ""}modelled rainfall · Open-Meteo` : "Rainfall unavailable",
      river ? `peak ${readableLkt(river.peakTimeLkt)} · final ${displayLevel(river.finalM, station)} at ${readableLkt(river.finalTimeLkt)} · ${river.observations} obs · ${escapeHTML(river.provenance.replaceAll("_", " ").replace("+", " + "))}` : "River observation unavailable"
    ].join("<br>");
    return `<tr class="${EVENTS.some(([start, end]) => row.date >= start && row.date <= end) ? "event" : ""}">
      <td>${row.date}</td><td>${num(row.rain)}</td><td>${river && station ? displayLevel(row.riverPeak, station) : "—"}</td>
      <td>${row.riverStatus ? `<span class="river-badge ${row.riverStatus.toLowerCase()}">${row.riverStatus}</span>` : "—"}</td>
      <td>${num(row.hours, 0)}</td><td>${num(row.tmax)}</td><td>${num(row.tmin)}</td><td>${num(row.wind, 0)}</td><td class="details-cell">${exact}</td></tr>`;
  }).join("");
}

function renderDashboard() {
  renderSelectionHeading();
  renderOverview();
  renderCombinedChart();
  renderMonths();
  rebuildMonthFilter();
  renderTable();
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCSV() {
  const station = selectedStation();
  const header = ["date", "rainfall_mm", "rain_hours", "temp_max_c", "temp_min_c", "wind_max_kmh", "rainfall_preliminary",
    "river_station", "river_basin", "river_peak_m", "river_peak_time_lkt", "river_status", "river_observations",
    "river_alert_m", "river_minor_m", "river_major_m", "river_provenance"];
  const lines = [header.join(",")];
  for (const row of tableRows()) {
    const riverFields = River.riverCsvRecord(station, row.river);
    lines.push([row.date, row.rain ?? "", row.hours ?? "", row.tmax ?? "", row.tmin ?? "", row.wind ?? "", row.rainfall?.prelim ? "true" : "false",
      ...Object.values(riverFields)].map(csvCell).join(","));
  }
  const label = station?.name || state.rainfallTarget?.label || "selection";
  const prefix = station ? "rainfall-river" : "rainfall";
  const url = URL.createObjectURL(new Blob([`${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `${prefix}_${slug(label)}_${state.start}_to_${state.end}.csv`; anchor.click();
  URL.revokeObjectURL(url);
}

function handleRangeChange() {
  if (!Dashboard.validDate(el.start.value) || !Dashboard.validDate(el.end.value) ||
      el.start.value > el.end.value || el.end.value > Dashboard.lktToday()) {
    setStatus(el.rainStatus, "Choose a valid range ending today or earlier, with the end on or after the start.", "error");
    el.rainStatus.classList.remove("hidden");
    return;
  }
  state = { ...state, start: el.start.value, end: el.end.value };
  updateURL(); updatePresetButtons(); renderDashboard();
  if (state.rainfallTarget) loadRainfall(state.rainfallTarget);
}

function loadRainOnly() {
  const custom = el.place.value === "custom";
  const place = custom ? ["Custom coordinates", Number(el.lat.value), Number(el.lon.value)] : PLACES[Number(el.place.value)];
  const [label, latitude, longitude] = place || [];
  if (!finite(latitude) || !finite(longitude) || latitude < 5 || latitude > 10.5 || longitude < 79 || longitude > 82.5) {
    setStatus(el.rainStatus, "Enter coordinates within Sri Lanka’s vicinity.", "error"); el.rainStatus.classList.remove("hidden"); return;
  }
  state = {
    ...state, gaugeId: null, mode: "rainfall", rainfallCoordinates: { latitude, longitude },
    rainfallTarget: { label, latitude, longitude }
  };
  RAIN_ROWS = [];
  updateURL(); renderAll(false); loadRainfall(state.rainfallTarget);
}

async function loadSources() {
  const [archive, live, mapData] = await Promise.allSettled([
    getJSON("data/river-levels.json", { cache: "no-cache" }),
    River.fetchArcGISPages(ARCGIS_LAYER),
    getJSON("data/river-map.json", { cache: "no-cache" })
  ]);
  const archiveError = archive.status === "rejected" ? archive.reason :
    River.validArchiveShape(archive.value) ? null : new Error("Historical river JSON has an invalid schema");
  RIVER_ARCHIVE = archiveError ? null : archive.value;
  LIVE_FEATURES = live.status === "fulfilled" ? live.value : null;
  indexLiveMeasurements();
  MAP_DATA = mapData.status === "fulfilled" && mapData.value?.version === 1 ? mapData.value : null;
  buildStations();
  const availability = River.sourceAvailability(RIVER_ARCHIVE, LIVE_FEATURES);
  const mapNote = MAP_DATA ? "" : " Map geometry is unavailable; the gauge list remains active.";
  if (availability === "archive+live") {
    setStatus(el.riverStatus, `Official live readings loaded · community archive through <strong>${escapeHTML(RIVER_ARCHIVE.coverage.end)}</strong>.${mapNote}`);
  } else if (availability === "cached-archive") {
    setStatus(el.riverStatus, `<strong>Official live readings are unavailable.</strong> Showing the cached archive through ${escapeHTML(RIVER_ARCHIVE.coverage.end)}.${mapNote}`, "cached");
  } else if (availability === "live-only") {
    setStatus(el.riverStatus, `<strong>Historical archive is unavailable.</strong> Official live readings and rainfall remain usable.${mapNote}`, "warning");
  } else {
    setStatus(el.riverStatus, `<strong>River observations are unavailable.</strong> Rainfall-only mode and the gauge/map metadata remain independent.${mapNote}`, "error");
  }
}

function initializePlaces() {
  PLACES.forEach(([name], index) => el.place.appendChild(new Option(name, String(index))));
  el.place.appendChild(new Option("Custom coordinates…", "custom"));
  el.place.value = "0"; el.lat.value = PLACES[0][1]; el.lon.value = PLACES[0][2];
  el.place.addEventListener("change", () => {
    const custom = el.place.value === "custom";
    el.latField.classList.toggle("on", custom); el.lonField.classList.toggle("on", custom);
    if (!custom) { const place = PLACES[Number(el.place.value)]; el.lat.value = place[1]; el.lon.value = place[2]; }
  });
}

function wireEvents() {
  el.showAllRivers.addEventListener("click", clearSelection);
  el.riverSystem.addEventListener("change", () => {
    if (el.riverSystem.value) selectRiverById(el.riverSystem.value, true);
    else clearSelection();
  });
  el.gauge.addEventListener("change", () => {
    if (el.gauge.value) selectGaugeById(el.gauge.value);
    else {
      rainfallRequests.cancel(); RAIN_ROWS = [];
      state = { ...state, gaugeId: null, mode: null, rainfallCoordinates: null, rainfallTarget: null };
      updateURL(); renderAll(false);
    }
  });
  el.start.addEventListener("change", handleRangeChange); el.end.addEventListener("change", handleRangeChange);
  document.querySelectorAll(".preset").forEach(button => button.addEventListener("click", () => {
    const range = button.dataset.days ? Dashboard.inclusiveRange(Number(button.dataset.days)) :
      { start: Dashboard.DITWAH_DATE, end: Dashboard.lktToday() };
    el.start.value = range.start; el.end.value = range.end; handleRangeChange();
  }));
  el.loadRainOnly.addEventListener("click", loadRainOnly); el.csv.addEventListener("click", exportCSV);
  el.fMonth.addEventListener("change", renderTable); el.fMin.addEventListener("input", renderTable);
  el.fReset.addEventListener("click", () => { el.fMonth.value = ""; el.fMin.value = "0"; renderTable(); });
  document.querySelectorAll(".sortable").forEach(header => {
    const sort = () => { const key = header.dataset.sort; SORT = { key, dir: SORT.key === key ? -SORT.dir : key === "date" ? 1 : -1 }; renderTable(); };
    header.addEventListener("click", sort);
    header.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); sort(); } });
  });
}

async function init() {
  initializePlaces(); wireEvents();
  el.end.max = Dashboard.lktToday();
  await loadSources();
  const riverIds = [...new Set([
    ...(MAP_DATA?.river_systems || []).map(system => system.id),
    ...[...STATIONS.values()].map(station => station.basin)
  ])];
  const query = Dashboard.parseQuery(location.search, STATIONS, riverIds);
  state = { ...state, riverId: query.riverId, gaugeId: query.gaugeId, start: query.start, end: query.end };
  if (query.gaugeId) {
    state = Dashboard.selectGauge(state, query.gaugeId, STATIONS);
    const station = STATIONS.get(query.gaugeId);
    state.rainfallTarget = state.rainfallCoordinates ? { ...state.rainfallCoordinates, label: station.name, gaugeId: station.id } : null;
  }
  el.start.value = state.start; el.end.value = state.end;
  initializeMap(); renderAll(Boolean(state.riverId)); updateURL();
  if (state.rainfallTarget) loadRainfall(state.rainfallTarget);
}

init().catch(error => {
  setStatus(el.riverStatus, `<strong>Dashboard initialization failed.</strong> ${escapeHTML(error.message || error)}`, "error");
});
