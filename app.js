"use strict";

const River = window.RiverLevels;
const LANDFALL = "2025-11-28";
const ARCGIS_LAYER = "https://services3.arcgis.com/J7ZFXmR8rSmQ3FGf/arcgis/rest/services/gauges_2_view/FeatureServer/0";

const PLACES = [
  ["Negombo",7.2083,79.8358],["Colombo",6.9271,79.8612],["Kelaniya",6.9553,79.9219],
  ["Katunayake",7.1697,79.8842],["Gampaha",7.0917,79.9997],["Kalutara",6.5854,79.9607],
  ["Puttalam",8.0362,79.8283],["Kurunegala",7.4863,80.3647],["Kegalle",7.2513,80.3464],
  ["Kandy",7.2906,80.6337],["Matale",7.4675,80.6234],["Nuwara Eliya",6.9497,80.7891],
  ["Badulla",6.9895,81.0557],["Monaragala",6.8728,81.3509],["Ratnapura",6.6828,80.3992],
  ["Galle",6.0535,80.2210],["Matara",5.9485,80.5353],["Hambantota",6.1241,81.1185],
  ["Ampara",7.2917,81.6725],["Batticaloa",7.7102,81.6924],["Trincomalee",8.5874,81.2152],
  ["Polonnaruwa",7.9403,81.0188],["Anuradhapura",8.3114,80.4037],["Vavuniya",8.7514,80.4971],
  ["Mannar",8.9810,79.9044],["Mullaitivu",9.2670,80.8142],["Kilinochchi",9.3803,80.3770],
  ["Jaffna",9.6615,80.0255]
];

const BANDS = [
  [0.1,"var(--b0)","Dry / trace"],[1,"var(--b1)","Trace"],[10,"var(--b1)","Light"],
  [25,"var(--b2)","Moderate"],[50,"var(--b3)","Heavy"],[100,"var(--b4)","Very heavy"],
  [150,"var(--b5)","Extreme"],[1e9,"var(--b6)","Exceptional"]
];
const LEGEND = [
  ["var(--b1)","0.1–10 mm light"],["var(--b2)","10–25 moderate"],
  ["var(--b3)","25–50 heavy"],["var(--b4)","50–100 very heavy"],
  ["var(--b5)","100–150 extreme"],["var(--b6)","150+ exceptional"]
];
const EVENTS = [
  ["2025-11-28","2025-12-05","Ditwah landfall + first flood peak"],
  ["2025-12-19","2025-12-23","Second heavy-rain episode"]
];
const STATUS_RANK = { Unknown:0, Normal:1, Alert:2, Minor:3, Major:4 };

const $ = selector => document.querySelector(selector);
const el = {
  place:$("#place"), gauge:$("#gauge"), lat:$("#lat"), lon:$("#lon"), start:$("#start"), end:$("#end"),
  load:$("#load"), csv:$("#csv"), status:$("#status"), riverStatus:$("#riverStatus"), stats:$("#stats"),
  chartPanel:$("#chartPanel"), chartScroll:$("#chartScroll"), legend:$("#legend"), readout:$("#readout"),
  monthPanel:$("#monthPanel"), months:$("#months"), tablePanel:$("#tablePanel"), tbody:$("#tbl tbody"),
  rowCount:$("#rowCount"), fMonth:$("#fMonth"), fMin:$("#fMin"), fReset:$("#fReset"),
  custom:$("#customCoords"), dayCount:$("#dayCount"), siteLabel:$("#siteLabel"),
  riverSummaryPanel:$("#riverSummaryPanel"), riverSummarySub:$("#riverSummarySub"), riverCurrent:$("#riverCurrent"),
  gaugeCoverage:$("#gaugeCoverage"), riverChartPanel:$("#riverChartPanel"), riverChartSub:$("#riverChartSub"),
  riverReadout:$("#riverReadout"), riverChartScroll:$("#riverChartScroll")
};

let ROWS = [];
let SORT = { key:"date", dir:1 };
let RIVER_ARCHIVE = null;
let LIVE_FEATURES = null;
let RIVER_STATIONS = new Map();
let ACTIVE_RIVER_DAILY = new Map();

const iso = date => date.toISOString().slice(0,10);
const parseDate = value => new Date(`${value}T00:00:00Z`);
const daysBetween = (a,b) => Math.round((parseDate(b)-parseDate(a))/86400000);
const num = (value,digits=1) => River.finite(value) ? Number(value).toFixed(digits) : "—";
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const bandOf = mm => BANDS.find(band => mm < band[0]) || BANDS.at(-1);
const valueOf = (object,names) => {
  for (const name of names) if (object && object[name] !== undefined && object[name] !== null) return object[name];
  return null;
};

function setStatus(target, html, mode="") {
  target.className = `status${mode ? ` ${mode}` : ""}`;
  target.innerHTML = html;
  target.classList.remove("hidden");
}

async function getJSON(url,options={}) {
  const response = await fetch(url,options);
  if (!response.ok) {
    let message = "";
    try { message = (await response.json()).reason || ""; } catch (_) {}
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json();
}

/* ---------- initialization ---------- */
PLACES.forEach(([name],index) => {
  const option = document.createElement("option");
  option.value = index;
  option.textContent = name;
  el.place.appendChild(option);
});
const custom = document.createElement("option");
custom.value = "custom";
custom.textContent = "Custom coordinates…";
el.place.appendChild(custom);
el.end.value = iso(new Date());
el.end.max = iso(new Date());
el.place.addEventListener("change", () => {
  const isCustom = el.place.value === "custom";
  el.custom.classList.toggle("on", isCustom);
  if (!isCustom) {
    const [name,lat,lon] = PLACES[Number(el.place.value)];
    el.lat.value = lat;
    el.lon.value = lon;
    el.siteLabel.textContent = name;
  }
});
el.dayCount.textContent = `day ${daysBetween(LANDFALL, iso(new Date())) + 1}`;

/* ---------- rainfall ---------- */
const WEATHER_VARS = "precipitation_sum,rain_sum,precipitation_hours,temperature_2m_max,temperature_2m_min,windspeed_10m_max";

function weatherRows(data) {
  if (!data?.daily) return [];
  const daily = data.daily;
  const time = daily.time || [];
  const precipitation = valueOf(daily,["precipitation_sum"]) || [];
  const rain = valueOf(daily,["rain_sum"]) || [];
  const hours = valueOf(daily,["precipitation_hours"]) || [];
  const tmax = valueOf(daily,["temperature_2m_max"]) || [];
  const tmin = valueOf(daily,["temperature_2m_min"]) || [];
  const wind = valueOf(daily,["windspeed_10m_max","wind_speed_10m_max"]) || [];
  return time.map((date,index) => ({
    date, rain:precipitation[index] ?? rain[index] ?? null, hours:hours[index] ?? null,
    tmax:tmax[index] ?? null, tmin:tmin[index] ?? null, wind:wind[index] ?? null
  })).filter(row => row.rain !== null || row.tmax !== null);
}

async function loadRainfall() {
  const latitude = Number.parseFloat(el.lat.value);
  const longitude = Number.parseFloat(el.lon.value);
  const start = el.start.value;
  const end = el.end.value;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    setStatus(el.status,"Enter a valid latitude and longitude.","error"); return;
  }
  if (!start || !end || start > end) {
    setStatus(el.status,"The end date must fall on or after the start date.","error"); return;
  }
  el.load.disabled = true;
  setStatus(el.status,"Fetching modelled daily rainfall from Open-Meteo…");
  const query = `latitude=${latitude}&longitude=${longitude}&timezone=Asia%2FColombo&daily=${WEATHER_VARS}`;
  const archiveURL = `https://archive-api.open-meteo.com/v1/archive?${query}&start_date=${start}&end_date=${end}`;
  const forecastURL = `https://api.open-meteo.com/v1/forecast?${query}&past_days=92&forecast_days=1`;
  try {
    const [archive,forecast] = await Promise.allSettled([getJSON(archiveURL),getJSON(forecastURL)]);
    if (archive.status === "rejected" && forecast.status === "rejected") throw archive.reason;
    const byDate = new Map();
    if (forecast.status === "fulfilled") weatherRows(forecast.value).forEach(row => byDate.set(row.date,{...row,prelim:true}));
    if (archive.status === "fulfilled") weatherRows(archive.value).forEach(row => byDate.set(row.date,row));
    ROWS = [...byDate.values()].filter(row => row.date >= start && row.date <= end)
      .sort((a,b) => a.date.localeCompare(b.date))
      .map(row => ({...row,day:daysBetween(LANDFALL,row.date)}));
    if (!ROWS.length) throw new Error("The API returned no days for that range.");
    const gap = daysBetween(ROWS.at(-1).date,end);
    setStatus(el.status,`Loaded <strong>${ROWS.length}</strong> rainfall days · ${ROWS[0].date} to ${ROWS.at(-1).date}` +
      (gap > 0 ? ` · the final ${gap} day${gap === 1 ? " is" : "s are"} not available yet.` : "."));
    renderRainfall();
  } catch (error) {
    ROWS = [];
    setStatus(el.status,`<strong>Couldn’t reach Open-Meteo.</strong> ${escapeHTML(error.message || error)} ` +
      `River-gauge data remains available independently.`,"error");
    [el.stats,el.chartPanel,el.monthPanel,el.tablePanel].forEach(node => node.classList.add("hidden"));
    el.csv.disabled = true;
  } finally {
    el.load.disabled = false;
  }
}

function renderRainfall() {
  el.csv.disabled = false;
  [el.stats,el.chartPanel,el.monthPanel,el.tablePanel].forEach(node => node.classList.remove("hidden"));
  renderStats();
  renderRainChart();
  renderMonths();
  renderMonthFilter();
  renderTable();
}

function renderStats() {
  const rain = ROWS.map(row => row.rain).filter(River.finite);
  const total = rain.reduce((sum,value) => sum + value,0);
  const wet = ROWS.filter(row => (row.rain || 0) >= 1).length;
  const heavy = ROWS.filter(row => (row.rain || 0) >= 50).length;
  const wettest = ROWS.reduce((a,b) => (b.rain || 0) > (a.rain || 0) ? b : a,ROWS[0]);
  const tmaxes = ROWS.map(row => row.tmax).filter(River.finite);
  const tmins = ROWS.map(row => row.tmin).filter(River.finite);
  const hot = ROWS.reduce((a,b) => (b.tmax ?? -99) > (a.tmax ?? -99) ? b : a,ROWS[0]);
  const cold = ROWS.reduce((a,b) => (b.tmin ?? 99) < (a.tmin ?? 99) ? b : a,ROWS[0]);
  const cards = [
    ["Total rainfall",Math.round(total).toLocaleString(),"mm",`over ${ROWS.length} days`],
    ["Wet days",wet,`/ ${ROWS.length}`,`${heavy} day${heavy === 1 ? "" : "s"} over 50 mm`],
    ["Wettest day",num(wettest.rain),"mm",`${wettest.date} · day ${wettest.day}`],
    ["Daily mean",num(total/ROWS.length),"mm","across the whole range"],
    ["Hottest",num(hot.tmax),"°C",`${hot.date} · mean max ${num(tmaxes.reduce((a,b)=>a+b,0)/(tmaxes.length||1))}`],
    ["Coolest",num(cold.tmin),"°C",`${cold.date} · mean min ${num(tmins.reduce((a,b)=>a+b,0)/(tmins.length||1))}`]
  ];
  el.stats.innerHTML = cards.map(([key,value,unit,note]) =>
    `<div class="stat"><div class="k">${key}</div><div class="v">${value}<em>${unit}</em></div><div class="n">${note}</div></div>`).join("");
}

function renderRainChart() {
  const W=1240,H=470,ML=56,MR=14,MT=34,RAIN_H=250,GAP=26,TEMP_H=96;
  const plotW=W-ML-MR,n=ROWS.length,step=plotW/n,bw=Math.max(1.4,step-(n>140?.6:1.6));
  const x=index => ML+index*step+(step-bw)/2;
  const maxRain=Math.max(10,...ROWS.map(row=>row.rain||0)),rTop=Math.ceil(maxRain/25)*25;
  const rainY=mm => MT+(mm/rTop)*RAIN_H;
  const temperatures=ROWS.flatMap(row=>[row.tmax,row.tmin]).filter(River.finite);
  const tempHigh=Math.ceil(Math.max(...temperatures)/2)*2,tempLow=Math.floor(Math.min(...temperatures)/2)*2;
  const tempBase=MT+RAIN_H+GAP,tempY=value=>tempBase+TEMP_H-((value-tempLow)/((tempHigh-tempLow)||1))*TEMP_H;
  let svg="";
  EVENTS.forEach(([start,end,label]) => {
    const first=ROWS.findIndex(row=>row.date>=start),after=ROWS.findIndex(row=>row.date>end);
    if(first<0)return;
    const x0=ML+first*step,x1=ML+(after<0?n:after)*step;
    svg+=`<rect x="${x0}" y="${MT}" width="${Math.max(2,x1-x0)}" height="${RAIN_H}" fill="var(--b6)" opacity=".07"/>`;
    svg+=`<text x="${x0+4}" y="${MT-9}" font-family="var(--mono)" font-size="9.5" fill="var(--b6)">${label.toUpperCase()}</text>`;
  });
  const gridStep=rTop>300?100:rTop>150?50:25;
  for(let mm=0;mm<=rTop;mm+=gridStep){
    const y=rainY(mm); svg+=`<line x1="${ML}" y1="${y}" x2="${W-MR}" y2="${y}" stroke="var(--grid)"/>`;
    svg+=`<text x="${ML-8}" y="${y+3.5}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">${mm}</text>`;
  }
  svg+=`<line x1="${ML}" y1="${MT}" x2="${W-MR}" y2="${MT}" stroke="var(--ink)" stroke-width="2"/>`;
  ROWS.forEach((row,index) => {
    const mm=row.rain||0;if(mm<=0)return;
    const height=Math.max(1,rainY(mm)-MT),color=bandOf(mm)[1];
    svg+=`<rect class="bar" data-i="${index}" x="${x(index).toFixed(2)}" y="${MT}" width="${bw.toFixed(2)}" height="${height.toFixed(2)}" fill="${color}"><title>${row.date} — ${num(mm)} mm</title></rect>`;
  });
  svg+=`<rect x="${ML}" y="${tempBase}" width="${plotW}" height="${TEMP_H}" fill="#fff" opacity=".55"/>`;
  [tempLow,Math.round((tempLow+tempHigh)/2),tempHigh].forEach(value => {
    svg+=`<line x1="${ML}" y1="${tempY(value)}" x2="${W-MR}" y2="${tempY(value)}" stroke="var(--grid)"/>`;
    svg+=`<text x="${ML-8}" y="${tempY(value)+3.5}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">${value}°</text>`;
  });
  const polyline=key=>ROWS.map((row,index)=>row[key]===null?null:`${(x(index)+bw/2).toFixed(2)},${tempY(row[key]).toFixed(2)}`).filter(Boolean).join(" ");
  svg+=`<polyline points="${polyline("tmax")}" fill="none" stroke="var(--b5)" stroke-width="1.5"/>`;
  svg+=`<polyline points="${polyline("tmin")}" fill="none" stroke="var(--b3)" stroke-width="1.5"/>`;
  svg+=`<text x="${ML+6}" y="${tempBase+13}" font-family="var(--mono)" font-size="9.5" fill="var(--ink-2)">DAILY MAX / MIN °C</text>`;
  addMonthTicks(ROWS.map(row=>row.date),ML,step,tempBase+TEMP_H,W,MR,value=>svg+=value);
  el.chartScroll.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily modelled rainfall and temperature">${svg}</svg>`;
  el.chartScroll.querySelectorAll(".bar").forEach(bar=>bar.addEventListener("mouseenter",()=>{
    const row=ROWS[Number(bar.dataset.i)];
    el.readout.innerHTML=`<b>${row.date}</b> · day ${row.day} · <b>${num(row.rain)} mm</b> · ${num(row.hours,0)} rain hrs · ${num(row.tmax)}° / ${num(row.tmin)}° · wind ${num(row.wind,0)} km/h · ${bandOf(row.rain||0)[2]}`;
  }));
  el.legend.innerHTML=LEGEND.map(([color,label])=>`<span class="li"><span class="sw" style="background:${color}"></span><span class="lb">${label}</span></span>`).join("");
}

function addMonthTicks(dates,marginLeft,step,bottom,width,marginRight,append) {
  let last="";
  dates.forEach((date,index)=>{
    const month=date.slice(0,7);if(month===last)return;last=month;
    const x=marginLeft+index*step;
    const label=parseDate(date).toLocaleDateString("en-GB",{month:"short",year:"2-digit",timeZone:"UTC"}).toUpperCase();
    append(`<line x1="${x}" y1="34" x2="${x}" y2="${bottom}" stroke="var(--rule)" stroke-dasharray="2 3"/>`+
      `<text x="${x+4}" y="${bottom+20}" font-family="var(--display)" font-size="16" font-weight="600" fill="var(--ink-2)">${label}</text>`);
  });
}

function renderMonths() {
  const months=new Map();
  ROWS.forEach(row=>{
    const key=row.date.slice(0,7);if(!months.has(key))months.set(key,{total:0,wet:0,days:0,max:0});
    const month=months.get(key);month.total+=row.rain||0;month.days++;
    if((row.rain||0)>=1)month.wet++;if((row.rain||0)>month.max)month.max=row.rain;
  });
  const peak=Math.max(...[...months.values()].map(month=>month.total));
  el.months.innerHTML=[...months.entries()].map(([key,month])=>{
    const label=parseDate(`${key}-01`).toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"});
    return `<div class="mo"><div class="mn">${label}</div><div class="mv">${Math.round(month.total).toLocaleString()}<em> mm</em></div>`+
      `<div class="track"><i style="width:${(month.total/peak*100).toFixed(1)}%"></i></div>`+
      `<div class="md">${month.wet} wet of ${month.days} days · peak ${num(month.max,0)} mm</div></div>`;
  }).join("");
}

function renderMonthFilter() {
  const months=[...new Set(ROWS.map(row=>row.date.slice(0,7)))];
  el.fMonth.innerHTML=`<option value="">All</option>`+months.map(key=>{
    const label=parseDate(`${key}-01`).toLocaleDateString("en-GB",{month:"short",year:"numeric",timeZone:"UTC"});
    return `<option value="${key}">${label}</option>`;
  }).join("");
}

/* ---------- river sources ---------- */
function archiveStationMap() {
  return new Map((RIVER_ARCHIVE?.stations || []).map(station=>[station.id,station]));
}

function liveStationDescriptors() {
  const descriptors=new Map();
  for(const feature of LIVE_FEATURES || []){
    const a=feature.attributes||feature;
    const name=String(a.gauge||"").trim();if(!name)continue;
    const id=River.slugify(name),unit=name===River.NAGALAGAM?"ft":"m";
    const normalized=River.normalizeArcGISFeature(feature);
    const previous=descriptors.get(id);
    if(!previous || (normalized?.timestamp||0)>(previous.timestamp||0)){
      descriptors.set(id,{id,name,basin:a.basin||"Unassigned",display_unit:unit,
        thresholds_m:River.thresholdsFrom(a,unit),timestamp:normalized?.timestamp||0,
        live_only:!archiveStationMap().has(id),coverage_note:null});
    }
  }
  return descriptors;
}

function populateGaugeSelector() {
  const selected=el.gauge.value;
  const requested=new URLSearchParams(window.location.search).get("gauge");
  RIVER_STATIONS=archiveStationMap();
  for(const [id,live] of liveStationDescriptors()){
    const archived=RIVER_STATIONS.get(id);
    RIVER_STATIONS.set(id,archived?{...archived,basin:live.basin||archived.basin,
      thresholds_m:live.thresholds_m,display_unit:live.display_unit}:live);
  }
  const grouped=new Map();
  [...RIVER_STATIONS.values()].sort((a,b)=>a.basin.localeCompare(b.basin)||a.name.localeCompare(b.name)).forEach(station=>{
    if(!grouped.has(station.basin))grouped.set(station.basin,[]);grouped.get(station.basin).push(station);
  });
  el.gauge.replaceChildren(new Option("Select river gauge.",""));
  for(const [basin,stations] of grouped){
    const group=document.createElement("optgroup");group.label=basin;
    stations.forEach(station=>{
      const option=new Option(`${station.name}${station.live_only?" — live coverage only":""}`,station.id);
      group.appendChild(option);
    });
    el.gauge.appendChild(group);
  }
  if(RIVER_STATIONS.has(selected))el.gauge.value=selected;
  else if(requested&&RIVER_STATIONS.has(requested))el.gauge.value=requested;
  if(el.gauge.value)renderRiver();
}

async function loadRiverSources() {
  setStatus(el.riverStatus,"Loading the cached community archive and current official ArcGIS readings…");
  const [archive,live]=await Promise.allSettled([
    getJSON("data/river-levels.json",{cache:"no-cache"}),
    River.fetchArcGISPages(ARCGIS_LAYER)
  ]);
  const archiveError=archive.status==="rejected"?archive.reason:
    River.validArchiveShape(archive.value)?null:new Error("Historical river JSON has an invalid schema");
  RIVER_ARCHIVE=archiveError?null:archive.value;
  LIVE_FEATURES=live.status==="fulfilled"?live.value:null;
  populateGaugeSelector();
  const mode=River.sourceAvailability(RIVER_ARCHIVE,LIVE_FEATURES);
  if(mode==="archive+live"){
    setStatus(el.riverStatus,`Official ArcGIS live readings loaded · community-mirror daily archive through <strong>${escapeHTML(RIVER_ARCHIVE.coverage.end)}</strong>.`);
  }else if(mode==="cached-archive"){
    setStatus(el.riverStatus,`<strong>Official ArcGIS is unavailable.</strong> Showing the newest cached community-mirror/archive reading through ${escapeHTML(RIVER_ARCHIVE.coverage.end)}.`,"cached");
  }else if(mode==="live-only"){
    setStatus(el.riverStatus,`<strong>Historical JSON is unavailable.</strong> The official live seven-day ArcGIS view is still available.`,"warning");
  }else{
    const reason=[archiveError,live.reason].filter(Boolean).map(error=>escapeHTML(error.message||error)).join(" · ");
    setStatus(el.riverStatus,`<strong>River sources are unavailable.</strong> ${reason} Rainfall remains usable.`,"error");
  }
}

function selectedStation() { return RIVER_STATIONS.get(el.gauge.value)||null; }

function liveMeasurements(stationId) {
  const normalized=(LIVE_FEATURES||[]).map(River.normalizeArcGISFeature).filter(Boolean)
    .filter(item=>item.stationId===stationId);
  return River.dedupeMeasurements([],normalized);
}

function archivedRecentMeasurements(station) {
  return (RIVER_ARCHIVE?.recent?.[station.id]||[])
    .map(row=>River.expandRecentMeasurement(row,station)).filter(Boolean);
}

function selectedDaily(station) {
  const rows=new Map();
  for(const compact of RIVER_ARCHIVE?.daily?.[station.id]||[]){
    const row=River.expandDailyRow(compact);rows.set(row.date,row);
  }
  const live=liveMeasurements(station.id);
  const stationConfig={thresholds:{alert:station.thresholds_m?.alert,minor:station.thresholds_m?.minor,major:station.thresholds_m?.major}};
  const archivedRecent=archivedRecentMeasurements(station);
  if(archivedRecent.length){
    const combined=River.mergeRecentMeasurements(archivedRecent,live);
    const combinedDaily=River.aggregateDaily(combined,{[station.id]:stationConfig})[station.id]||[];
    combinedDaily.forEach(row=>rows.set(row.date,row));
  }else{
    // Compatibility with archives generated before the compact recent-observation
    // window existed: retain their aggregate and add only readings newer than it.
    const unseen=live.filter(item=>{
      const archived=rows.get(River.lktDate(item.timestamp));
      return !archived||item.timestamp>Math.floor(Date.parse(archived.finalTimeLkt)/1000);
    });
    const unseenDaily=River.aggregateDaily(unseen,{[station.id]:stationConfig})[station.id]||[];
    unseenDaily.forEach(row=>rows.set(row.date,River.mergeDailyRows(rows.get(row.date),row)));
  }
  return new Map([...rows.entries()].sort(([a],[b])=>a.localeCompare(b)));
}

function currentTuple(station) {
  const live=liveMeasurements(station.id);
  if(live.length)return {tuple:River.latestPair(live),cached:false};
  const archived=RIVER_ARCHIVE?.stations?.find(item=>item.id===station.id);
  return {tuple:archived?.latest||null,cached:true};
}

function displayLevel(levelM,station,digits=2) {
  if(!River.finite(levelM))return "—";
  if(station.name===River.NAGALAGAM){
    return `${num(levelM/River.FEET_TO_METRES,digits)} ft <span class="river-unit-secondary">(${num(levelM,digits)} m)</span>`;
  }
  return `${num(levelM,digits)} m`;
}

function displayDelta(deltaM,station) {
  if(!River.finite(deltaM))return "No preceding reading";
  const sign=deltaM>0?"+":"";
  if(station.name===River.NAGALAGAM){
    return `${sign}${num(deltaM/River.FEET_TO_METRES,2)} ft (${sign}${num(deltaM,2)} m)`;
  }
  return `${sign}${num(deltaM,2)} m`;
}

function readableLkt(value) {
  return value?`${value.slice(0,10)} ${value.slice(11,19)} LKT`:"—";
}

function renderRiver() {
  const station=selectedStation();
  if(!station){
    ACTIVE_RIVER_DAILY=new Map();
    el.riverSummaryPanel.classList.add("hidden");el.riverChartPanel.classList.add("hidden");
    if(ROWS.length)renderTable();return;
  }
  ACTIVE_RIVER_DAILY=selectedDaily(station);
  renderRiverSummary(station);
  renderRiverChart(station);
  if(ROWS.length)renderTable();
}

function renderRiverSummary(station) {
  el.riverSummaryPanel.classList.remove("hidden");
  const {tuple,cached}=currentTuple(station);
  const threshold=station.thresholds_m||{};
  if(!tuple){
    el.riverSummarySub.textContent=`${station.name} · ${station.basin}`;
    el.riverCurrent.innerHTML=`<div class="river-cell"><div class="k">Current reading</div><div class="v">—</div><div class="n">No valid observation is available.</div></div>`;
    el.gaugeCoverage.textContent=station.coverage_note||"Station metadata is available, but no valid observations were returned.";
    return;
  }
  const [observedAt,current,previousAt,previous]=tuple;
  const trend=River.trendFor(current,previous);
  const status=River.statusFor(current,threshold);
  const stale=River.isStale(observedAt);
  const trendSymbol={rising:"↑",falling:"↓",steady:"→",unknown:"—"}[trend.direction];
  el.riverSummarySub.textContent=`${station.name} · ${station.basin}${cached?" · cached":" · official live"}`;
  el.riverCurrent.innerHTML=`
    <div class="river-cell"><div class="k">Level</div><div class="v river-value">${displayLevel(current,station)}</div><div class="n">Gauge datum · stored as ${num(current,3)} m</div></div>
    <div class="river-cell"><div class="k">Observed</div><div class="v" style="font-size:23px">${readableLkt(observedAt)}</div><div class="n">${cached?"Cached archive reading":"Official ArcGIS reading"}${stale?' · <span class="stale-flag">stale, over 24 h old</span>':""}</div></div>
    <div class="river-cell"><div class="k">Trend from preceding reading</div><div class="v">${trendSymbol} ${escapeHTML(trend.direction)}</div><div class="n">${displayDelta(trend.deltaM,station)}${previousAt?` · previous ${readableLkt(previousAt)}`:""}</div></div>
    <div class="river-cell"><div class="k">Flood status</div><div class="v"><span class="river-badge ${status.toLowerCase()}">${status}</span></div><div class="n">Alert ${displayLevel(threshold.alert,station)} · Minor ${displayLevel(threshold.minor,station)} · Major ${displayLevel(threshold.major,station)}</div></div>`;
  const archiveStation=RIVER_ARCHIVE?.stations?.find(item=>item.id===station.id);
  const coverage=station.coverage_note||archiveStation?.coverage_note||
    `Community-mirror history: ${archiveStation?.history_start||"—"} to ${archiveStation?.history_end||"—"}. `+
    `Official ArcGIS readings replace matching archived station/timestamp records.`;
  el.gaugeCoverage.textContent=coverage;
}

function dateSequence(start,end) {
  const dates=[];
  for(let current=parseDate(start);current<=parseDate(end);current=new Date(current.getTime()+86400000))dates.push(iso(current));
  return dates;
}

function renderRiverChart(station) {
  el.riverChartPanel.classList.remove("hidden");
  el.riverChartSub.textContent=`${station.name} · daily peak metres · thresholds at gauge datum`;
  const start=el.start.value||LANDFALL,end=el.end.value||iso(new Date());
  const dates=dateSequence(start,end),rows=dates.map(date=>ACTIVE_RIVER_DAILY.get(date)||null);
  const available=rows.filter(Boolean);
  if(!available.length){
    el.riverChartScroll.innerHTML=`<div class="panel-body mono-note">No river observations in the selected date range. Missing dates have not been filled.</div>`;
    return;
  }
  const W=1240,H=390,ML=62,MR=82,MT=34,PB=62,plotW=W-ML-MR,plotH=H-MT-PB;
  const step=dates.length>1?plotW/(dates.length-1):plotW;
  const x=index=>ML+(dates.length>1?index*step:plotW/2);
  const thresholds=station.thresholds_m||{};
  const values=available.map(row=>row.peakM).concat([thresholds.alert,thresholds.minor,thresholds.major].filter(River.finite));
  let low=Math.min(...values),high=Math.max(...values);
  const padding=Math.max((high-low)*.12,.25);low=Math.floor((low-padding)*2)/2;high=Math.ceil((high+padding)*2)/2;
  if(low===high){low-=1;high+=1;}
  const y=value=>MT+((high-value)/(high-low))*plotH;
  let svg="";
  EVENTS.forEach(([a,b])=>{
    const first=dates.findIndex(date=>date>=a),last=dates.findLastIndex(date=>date<=b);
    if(first<0||last<0)return;
    const x0=Math.max(ML,x(first)-step/2),x1=Math.min(W-MR,x(last)+step/2);
    svg+=`<rect x="${x0}" y="${MT}" width="${Math.max(2,x1-x0)}" height="${plotH}" fill="var(--b6)" opacity=".06"/>`;
  });
  for(let i=0;i<=4;i++){
    const value=low+(high-low)*i/4,yp=y(value);
    svg+=`<line x1="${ML}" y1="${yp}" x2="${W-MR}" y2="${yp}" stroke="var(--grid)"/>`+
      `<text x="${ML-9}" y="${yp+4}" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">${num(value,1)}</text>`;
  }
  [["Alert",thresholds.alert,"var(--b4)"],["Minor",thresholds.minor,"var(--b5)"],["Major",thresholds.major,"var(--b6)"]].forEach(([label,value,color])=>{
    if(!River.finite(value)||value<=0)return;
    const yp=y(value);svg+=`<line x1="${ML}" y1="${yp}" x2="${W-MR}" y2="${yp}" stroke="${color}" stroke-width="1.5" stroke-dasharray="7 4"/>`+
      `<text x="${W-MR+6}" y="${yp+4}" font-family="var(--mono)" font-size="10" fill="${color}">${label} ${num(value,2)} m</text>`;
  });
  let segment=[];
  const flush=()=>{if(segment.length>1)svg+=`<polyline class="hydro-line" points="${segment.join(" ")}"/>`;segment=[];};
  rows.forEach((row,index)=>{
    if(!row){flush();return;}segment.push(`${x(index).toFixed(2)},${y(row.peakM).toFixed(2)}`);
    const status=River.statusFor(row.peakM,{alert:row.alertM,minor:row.minorM,major:row.majorM});
    const color={Normal:"var(--b3)",Alert:"var(--b4)",Minor:"var(--b5)",Major:"var(--b6)"}[status]||"var(--ink-3)";
    svg+=`<circle class="hydro-dot" cx="${x(index)}" cy="${y(row.peakM)}" r="3.5" style="stroke:${color}"/>`+
      `<circle class="hydro-hit" tabindex="0" role="button" aria-label="${row.date}, peak ${num(row.peakM,2)} metres, ${status}" data-date="${row.date}" cx="${x(index)}" cy="${y(row.peakM)}" r="11"/>`;
  });flush();
  addMonthTicks(dates,ML,step,MT+plotH,W,MR,value=>svg+=value);
  svg+=`<text x="${ML-9}" y="${MT-12}" text-anchor="end" font-family="var(--mono)" font-size="9.5" fill="var(--ink-2)">M</text>`;
  el.riverChartScroll.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily peak hydrograph for ${escapeHTML(station.name)} with visible missing-date gaps">${svg}</svg>`;
  const showReadout=node=>{
    const row=ACTIVE_RIVER_DAILY.get(node.dataset.date);if(!row)return;
    const status=River.statusFor(row.peakM,{alert:row.alertM,minor:row.minorM,major:row.majorM});
    el.riverReadout.innerHTML=`<b>${row.date}</b> · peak <b>${displayLevel(row.peakM,station)}</b> at ${readableLkt(row.peakTimeLkt)} · final ${displayLevel(row.finalM,station)} at ${readableLkt(row.finalTimeLkt)} · ${row.observations} observation${row.observations===1?"":"s"} · ${status} · ${escapeHTML(row.provenance.replaceAll("_"," ").replace("+"," + "))}`;
  };
  el.riverChartScroll.querySelectorAll(".hydro-hit").forEach(node=>{
    node.addEventListener("mouseenter",()=>showReadout(node));node.addEventListener("focus",()=>showReadout(node));
  });
}

/* ---------- combined table and CSV ---------- */
function inEvent(date){return EVENTS.some(([start,end])=>date>=start&&date<=end);}

function rowsForTable() {
  const month=el.fMonth.value,min=Number.parseFloat(el.fMin.value)||0;
  const station=selectedStation();
  const rows=ROWS.filter(row=>(!month||row.date.startsWith(month))&&(row.rain||0)>=min).map(row=>{
    const river=ACTIVE_RIVER_DAILY.get(row.date)||null;
    const thresholds=river?{alert:river.alertM,minor:river.minorM,major:river.majorM}:station?.thresholds_m;
    const riverStatus=river?River.statusFor(river.peakM,thresholds):null;
    return {...row,river,riverPeak:river?.peakM??null,riverStatus,riverStatusRank:STATUS_RANK[riverStatus]??-1};
  });
  rows.sort((a,b)=>{
    const left=SORT.key==="date"?a.date:(a[SORT.key]??-1e99),right=SORT.key==="date"?b.date:(b[SORT.key]??-1e99);
    return (left<right?-1:left>right?1:0)*SORT.dir;
  });
  return rows;
}

function renderTable() {
  const rows=rowsForTable(),station=selectedStation();
  el.rowCount.textContent=`${rows.length} of ${ROWS.length} days${station?` · ${station.name}`:" · no river gauge selected"}`;
  el.tbody.innerHTML=rows.map(row=>{
    const [,color,label]=bandOf(row.rain||0);
    const riverPeak=row.river?displayLevel(row.riverPeak,station,2):"—";
    const status=row.riverStatus||"—";
    return `<tr class="${(row.rain||0)>=50?"wet":""} ${inEvent(row.date)?"event":""}">
      <td><span class="chip" style="background:${color}" title="${label}"></span>${row.date}</td>
      <td>${row.day}</td><td>${num(row.rain)}</td><td>${num(row.hours,0)}</td><td>${num(row.tmax)}</td><td>${num(row.tmin)}</td><td>${num(row.wind,0)}</td>
      <td>${riverPeak}</td><td>${row.river?`<span class="river-badge ${status.toLowerCase()}">${status}</span>`:"—"}</td></tr>`;
  }).join("");
}

function csvCell(value) {
  if(value===null||value===undefined)return "";
  const text=String(value);return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

function exportCSV() {
  const station=selectedStation();
  const header=["date","day_since_landfall","rainfall_mm","rain_hours","temp_max_c","temp_min_c","wind_max_kmh","intensity_band",
    "river_station","river_basin","river_peak_m","river_peak_time_lkt","river_status","river_observations",
    "river_alert_m","river_minor_m","river_major_m","river_provenance"];
  const lines=[header.join(",")];
  rowsForTable().forEach(row=>{
    const river=row.river;
    const riverFields=River.riverCsvRecord(station,river);
    lines.push([row.date,row.day,row.rain??"",row.hours??"",row.tmax??"",row.tmin??"",row.wind??"",bandOf(row.rain||0)[2],
      ...Object.values(riverFields)].map(csvCell).join(","));
  });
  const place=el.place.value==="custom"?`${el.lat.value}_${el.lon.value}`:PLACES[Number(el.place.value)][0].replace(/\s+/g,"-");
  const url=URL.createObjectURL(new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=`rainfall_river_${place}_${el.start.value}_to_${el.end.value}.csv`;anchor.click();
  URL.revokeObjectURL(url);
}

/* ---------- wiring ---------- */
el.load.addEventListener("click",()=>{loadRainfall();renderRiver();});
el.csv.addEventListener("click",exportCSV);
el.gauge.addEventListener("change",renderRiver);
el.start.addEventListener("change",()=>{if(el.gauge.value)renderRiver();});
el.end.addEventListener("change",()=>{if(el.gauge.value)renderRiver();});
el.fMonth.addEventListener("change",renderTable);
el.fMin.addEventListener("input",renderTable);
el.fReset.addEventListener("click",()=>{el.fMonth.value="";el.fMin.value=0;renderTable();});
document.querySelectorAll("th.s").forEach(th=>{
  th.tabIndex=0;th.setAttribute("role","button");
  const sort=()=>{const key=th.dataset.sort;SORT={key,dir:SORT.key===key?-SORT.dir:(key==="date"?1:-1)};renderTable();};
  th.addEventListener("click",sort);
  th.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();sort();}});
});

loadRainfall();
loadRiverSources();
