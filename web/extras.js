/* Countries, fires and daily stripes. */
"use strict";

let COUNTRY_STATS = {}, EVF = null;
const dayNum = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - DAY0) / 864e5);
const dayStr = (d) => { const t = new Date(DAY0 + d * 864e5); return `${t.getUTCDate()} ${MESES[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };

function initExtras() {
  computeCountryStats();
  $("stripesPng").addEventListener("click", () => { const a = document.createElement("a"); a.href = $("stripes").toDataURL("image/png"); a.download = `fire_stripes_${slug()}.png`; a.click(); });
  $("repMetric").addEventListener("change", renderReported);
  $("dlCal").addEventListener("click", csvCalendar);
  $("dlPoints").addEventListener("click", csvPoints);
  $("dlCountries").addEventListener("click", csvCountries);
  $("dlSvg").addEventListener("click", () => download(`calendar_${slug()}.svg`, new XMLSerializer().serializeToString($("cal").querySelector("svg")), "image/svg+xml"));
}

// ---------- Countries ----------
function computeCountryStats() {
  const yrs = D.parcial.anios, hy = yrs.filter((y) => y >= 2001 && y < CY);
  const iF = PARTIAL ? NK - 2 : NK - 1, mF = mOf(iF);
  for (const { iso } of D.meta.paises) {
    const s = D.series[iso], part = {}; yrs.forEach((y, yi) => (part[y] = D.parcial.paises[iso][yi]));
    const ytd = (y) => { let t = 0; for (let m = 1; m < CM; m++) { const i = iOf(y, m); if (i >= 0) t += s.h[i]; } return t + (part[y] || 0); };
    const hYtd = hy.filter((y) => iOf(y, 1) >= 0).map(ytd), hCur = hy.map((y) => part[y] || 0);
    const hLast = []; for (let y = 2001; y < yOf(iF); y++) { const i = iOf(y, mF); if (validMonth(i)) hLast.push(s.h[i]); }
    COUNTRY_STATS[iso] = { iso, name: COUNTRY_NAME[iso], ytd: ytd(CY), ytdMed: median(hYtd), ytdP: pctRank(hYtd, ytd(CY)), hYtd,
      cur: part[CY] || 0, curMed: median(hCur), curP: pctRank(hCur, part[CY] || 0), last: s.h[iF], lastMed: median(hLast), lastP: pctRank(hLast, s.h[iF]) };
  }
}
function ratioOf(c) { return (c.ytd + 1) / (c.ytdMed + 1); }
function renderCountryTable() {
  // First those above usual, then normal and below; within each group, by number of hotspots
  const lv = (c) => (c.ytdP >= 80 ? 0 : c.ytdP > 20 ? 1 : 2);
  const rows = Object.values(COUNTRY_STATS).filter((c) => c.ytd > 0 || c.ytdMed > 0).sort((a, b) => lv(a) - lv(b) || b.ytd - a.ytd);
  const maxL = Math.max(1, ...rows.map((c) => Math.abs(Math.log2(ratioOf(c)))));
  const tr = (c) => {
    const lr = Math.log2(ratioOf(c)), wbar = Math.round(60 * Math.min(1, Math.abs(lr) / maxL));
    const pct = c.ytdMed > 0 ? Math.round(100 * (c.ytd - c.ytdMed) / c.ytdMed) : null;
    return `<tr data-k="${c.iso}" tabindex="0" class="${c.iso === S.zone ? "sel" : ""}"><td>${c.name}</td><td>${fmt(c.ytd)}</td>` +
      `<td><div class="bar-cell"><span>${pct === null ? "–" : (pct > 0 ? "+" : "") + pct + "%"}</span><span class="b" style="width:${wbar}px;background:${lr >= 0 ? "#E0583A" : "#4FA0E6"}"></span></div></td>` +
      `<td><span class="arrow ${level(c.ytdP)}" title="${levelWord(c.ytdP)}">${arrow(c.ytdP)}</span><span class="sr">${levelWord(c.ytdP)}</span></td></tr>`;
  };
  $("countryTable").innerHTML = `<table class="t"><caption class="sr">Heat spots by country in ${CY} versus usual</caption>` +
    `<tr><th scope="col">Country</th><th scope="col">Hotspots in ${CY}</th><th scope="col">Versus usual</th><th scope="col"><span class="sr">Level</span></th></tr>${rows.map(tr).join("")}</table>`;
  $("countryTable").querySelectorAll("tr[data-k]").forEach((t) => {
    const go = () => selectZone(t.dataset.k);
    t.addEventListener("click", go); t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
function csvCountries() {
  const out = [`country,iso,hotspots_${CY}_so_far,usual_same_dates,difference_pct,hotspots_current_month,usual_current_month,hotspots_last_month,usual_last_month,modis_viirs_factor,factor_source`];
  for (const c of Object.values(COUNTRY_STATS)) {
    const f = D.fac.r[c.iso];
    out.push([`"${c.name}"`, c.iso, c.ytd.toFixed(0), (c.ytdMed || 0).toFixed(0), c.ytdMed > 0 ? (100 * (c.ytd - c.ytdMed) / c.ytdMed).toFixed(0) : "", c.cur.toFixed(0), (c.curMed || 0).toFixed(0), c.last.toFixed(0), (c.lastMed || 0).toFixed(0), f.est, f.fuente].join(","));
  }
  download(`countries_${CY}.csv`, out.join("\n"));
}

// ---------- Fires ----------
function eventList() {
  const E = D.incendios, out = [];
  for (let j = 0; j < E.w.length; j++) {
    if (S.zone !== "EU" && !zoneIsCustom() && E.iso[j] !== S.zone) continue;
    if (zoneIsCustom() && !inZonePoint(E.lon[j], E.lat[j])) continue;
    out.push({ j, w: E.w[j], d0: E.d0[j], d1: E.d1[j], lon: E.lon[j], lat: E.lat[j], iso: E.iso[j], peak: E.peak[j], gid: E.gid[j], pts: E.pts[j], frp: E.frp[j] });
  }
  return out;   // already sorted from largest to smallest
}
function recentEvent(all) {
  const lastD = dayNum(CY, CM, DD), rec = all.filter((e) => e.d1 >= lastD - 30);
  return rec.length ? rec[0] : null;
}
function renderEvents() {
  const all = eventList(), dA = dayNum(S.yA, 1, 1), dB = dayNum(S.yB, 12, 31);
  const inRange = all.filter((e) => e.d0 >= dA && e.d0 <= dB), rank = new Map(all.map((e, i) => [e, i + 1]));
  const rec = recentEvent(all), z = zoneLabel();
  let head;
  if (rec) {
    const r = rank.get(rec), pct = 100 * (1 - (r - 1) / all.length), pTxt = pct >= 99 && pct < 100 ? nf1.format(Math.floor(pct * 10) / 10) : fmt(pct);
    head = `<div class="ev-now ${pct >= 95 ? "alto" : ""}">The largest fire of the last month started on <b>${dayStr(rec.d0)}</b> in ${COUNTRY_NAME[rec.iso]}, lasted ${rec.d1 - rec.d0 + 1} days and had <b>${fmt(rec.w)} hotspots</b>. ` +
      `It is larger than <b>${pTxt}%</b> of the ${fmt(all.length)} fires recorded in ${z} since 2000. <a href="#" data-ev="rec">See it on the map</a></div>`;
  } else head = `<div class="ev-now">No fire has been detected in ${z} in the last 30 days.</div>`;
  const rows = inRange.slice(0, 15).map((e, i) => `<tr data-k="${i}" tabindex="0"><td>#${fmt(rank.get(e))}</td><td>${dayStr(e.d0)}</td><td>${e.d1 - e.d0 + 1}</td><td>${COUNTRY_NAME[e.iso]}</td><td><b>${fmt(e.w)}</b></td></tr>`).join("");
  $("events").innerHTML = head + `<h3>The largest between ${S.yA} and ${S.yB}</h3>` +
    `<div class="table-wrap"><table class="t ev"><caption class="sr">Largest fires of the period</caption><tr><th scope="col">Rank</th><th scope="col">Started</th><th scope="col">Days</th><th scope="col">Country</th><th scope="col">Hotspots</th></tr>${rows || `<tr><td colspan="5">There are no fires in these years.</td></tr>`}</table></div>` +
    `<p class="note">The rank compares with all fires in ${z} since 2000. Only fires with at least 15 hotspots are counted.</p>`;
  $("events").querySelectorAll("tr[data-k]").forEach((t) => {
    const go = () => focusEvent(inRange[+t.dataset.k]);
    t.addEventListener("click", go); t.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
  });
  const a = $("events").querySelector("a[data-ev=rec]"); if (a) a.onclick = (ev) => { ev.preventDefault(); focusEvent(rec); };
  renderEventStrip(all, rec);
}
function renderEventStrip(all, rec) {
  const svg = $("evStrip"); svg.innerHTML = "";
  const w = svg.clientWidth || 900, h = 90, pad = { l: 12, r: 12 };
  if (!all.length) return;
  const mn = Math.log10(Math.min(...all.map((e) => e.w))), mx = Math.log10(Math.max(...all.map((e) => e.w)) * 1.15);
  const xs = (v) => pad.l + (Math.log10(v) - mn) / Math.max(0.01, mx - mn) * (w - pad.l - pad.r);
  [10, 100, 1000, 10000, 100000].filter((v) => Math.log10(v) >= mn && Math.log10(v) <= mx).forEach((v) => {
    svgEl("line", { x1: xs(v), x2: xs(v), y1: 6, y2: h - 18, stroke: COL.grid }, svg);
    svgEl("text", { x: xs(v), y: h - 4, "text-anchor": "middle", "font-size": 11, fill: COL.muted }, svg).textContent = fmt(v) + " hotspots";
  });
  let seed = 7; const jit = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const sample = all.length > 4000 ? all.filter((_, i) => i < 400 || i % Math.ceil(all.length / 3600) === 0) : all;
  sample.slice().reverse().forEach((e) => {
    const top = all.indexOf(e) < 10, isRec = e === rec, cy = 10 + jit() * (h - 34);
    const c = svgEl("circle", { cx: xs(e.w), cy, r: top ? 5 : 2.4, fill: top ? "#F6B53E" : "#5C6F8A", opacity: top ? 1 : 0.55 }, svg);
    if (isRec) svgEl("circle", { cx: xs(e.w), cy, r: 8, fill: "none", stroke: "#E6EDF6", "stroke-width": 2 }, svg);
    if (top || isRec) {
      c.style.cursor = "pointer";
      c.addEventListener("mousemove", (ev) => showTip(ev, `<b>${dayStr(e.d0)}</b>, ${COUNTRY_NAME[e.iso]}<br>${fmt(e.w)} hotspots in ${e.d1 - e.d0 + 1} days`));
      c.addEventListener("mouseleave", hideTip); c.addEventListener("click", () => focusEvent(e));
    }
  });
}
async function focusEvent(e) {
  if (!e) return;
  S.event = e; S.mapMonth = null; styleCountries();
  const items = [], ll = [];
  if (e.pts) {
    if (!EVF) EVF = await fetch("data/incendios_focos.json").then((r) => r.json());
    const p = EVF[String(e.gid)], span = Math.max(1, e.d1 - e.d0);
    if (p) for (let t = 0; t < p.x.length; t++) {
      const lat = p.y[t] / 1000, lon = p.x[t] / 1000; ll.push([lat, lon]);
      items.push({ lat, lon, r: 5, rgb: rgbOf(ramp(THERMAL, 0.3 + 0.7 * (p.d[t] - e.d0) / span)), a: 0.9 });
    }
  }
  if (!items.length) { items.push({ lat: e.lat, lon: e.lon, r: 22, rgb: rgbOf(ramp(THERMAL, 0.85)), a: 0.9 }); ll.push([e.lat, e.lon]); }
  glow.set(items);
  const b = L.latLngBounds(ll).pad(0.8);
  map.fitBounds(b, { maxZoom: 11, paddingTopLeft: [20, innerWidth > 560 ? 60 : 70], paddingBottomRight: [50, innerWidth > 560 ? 110 : 150] });
  $("gibsDate").value = new Date(DAY0 + e.peak * 864e5).toISOString().slice(0, 10);
  $("gibsOn").checked = true; updateGibs();
  $("mapLegend").innerHTML = `<span>first day</span><div class="ramp" style="background:linear-gradient(90deg,${THERMAL.slice(3).join(",")})"></div><span>last day</span>`;
  $("mapnote").innerHTML = `Fire of ${dayStr(e.d0)} in ${COUNTRY_NAME[e.iso]}: ${fmt(e.w)} hotspots in ${e.d1 - e.d0 + 1} days. The photo is from ${dayStr(e.peak)}, its day with the most fire. <a href="#" id="mapBack">Back</a>`;
  $("mapBack").onclick = (ev) => { ev.preventDefault(); S.event = null; $("gibsOn").checked = false; updateGibs(); renderMapLayer(true); };
  scrollToMap();
}
function eventsSpeech(t) {
  const all = eventList(); if (!all.length) return `There are no recorded fires in ${zoneLabel()}.`;
  const rec = recentEvent(all), top = all[0];
  if (/latest|last|recent|current|now|compar/.test(t)) {
    const e = rec || all.slice().sort((a, b) => b.d1 - a.d1)[0], r = all.indexOf(e) + 1; focusEvent(e);
    return `${rec ? "The largest fire of the last month" : `In the last month there are no fires in ${zoneLabel()}. The most recent one`} started on ${dayStr(e.d0)}${S.zone === e.iso ? "" : " in " + COUNTRY_NAME[e.iso]}, lasted ${e.d1 - e.d0 + 1} days and had ${fmt(e.w)} hotspots: it is number ${fmt(r)} of ${fmt(all.length)} since 2000. The largest was the one of ${dayStr(top.d0)}, with ${fmt(top.w)}.`;
  }
  focusEvent(top);
  return `The largest fire recorded in ${zoneLabel()} since 2000 started on ${dayStr(top.d0)}${S.zone === top.iso ? "" : " in " + COUNTRY_NAME[top.iso]}, lasted ${top.d1 - top.d0 + 1} days and had ${fmt(top.w)} hotspots.`;
}

// ---------- Daily stripes ----------
function renderStripes() {
  const cv = $("stripes"), y0 = Math.max(2001, S.yA), ny = S.yB - y0 + 1;
  if (!Z.daily) { cv.width = 1; cv.height = 1; cv.style.height = "0px"; $("stripesNote").textContent = "Daily stripes are available for Europe and for each country, not for drawn areas."; return; }
  const W0 = Math.max(600, cv.parentElement.clientWidth - 48), lab = 42, top = 18, rowH = Math.max(7, Math.min(12, Math.floor(420 / ny)));
  const H0 = top + ny * rowH + 4, dpr = devicePixelRatio || 1;
  cv.width = W0 * dpr; cv.height = H0 * dpr; cv.style.width = W0 + "px"; cv.style.height = H0 + "px";
  const g = cv.getContext("2d"); g.scale(dpr, dpr); g.fillStyle = "#0B1524"; g.fillRect(0, 0, W0, H0);
  const daily = Array.from({ length: ny }, () => new Float32Array(367));
  const add = (arr) => { for (const [d, v] of arr) { const t = new Date(DAY0 + d * 864e5), y = t.getUTCFullYear(); if (y < y0 || y > S.yB) continue; daily[y - y0][d - dayNum(y, 1, 1)] += v; } };
  if (S.zone === "EU") for (const iso in D.diario) add(D.diario[iso]); else add(D.diario[S.zone] || []);
  const all = []; daily.forEach((r) => r.forEach((v) => v > 0 && all.push(v)));
  const vmax = Math.max(1, quantile(all, 0.995)), cw = (W0 - lab - 4) / 366;
  daily.forEach((r, yi) => {
    for (let d = 0; d < 366; d++) {
      const v = (r[Math.max(0, d - 1)] + 2 * r[d] + r[d + 1]) / 4;
      if (v <= 0.05) continue;
      g.fillStyle = ramp(THERMAL, 0.12 + 0.88 * Math.log1p(v) / Math.log1p(vmax));
      g.fillRect(lab + d * cw, top + yi * rowH, Math.ceil(cw), rowH - 1);
    }
  });
  g.fillStyle = "#9CB0C9"; g.font = "11px Archivo, system-ui, sans-serif"; g.textAlign = "right";
  for (let y = y0; y <= S.yB; y++) if ((y - y0) % 5 === 0 || y === S.yB) g.fillText(y, lab - 6, top + (y - y0) * rowH + rowH - 1);
  g.textAlign = "left";
  [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334].forEach((d, i) => g.fillText(MESES[i], lab + d * cw + 2, 12));
  $("stripesNote").textContent = `${zoneLabel()}, ${y0}–${S.yB}. Notice when the fire season starts and ends each year.`;
}

function renderExtras() { renderCountryTable(); renderEvents(); renderStripes(); }