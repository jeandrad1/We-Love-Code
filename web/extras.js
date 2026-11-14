/* Países, incendios y franjas diarias. */
"use strict";

let COUNTRY_STATS = {}, EVF = null;
const dayNum = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - DAY0) / 864e5);
const dayStr = (d) => { const t = new Date(DAY0 + d * 864e5); return `${t.getUTCDate()} ${MESES[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };

function initExtras() {
  computeCountryStats();
  $("stripesPng").addEventListener("click", () => { const a = document.createElement("a"); a.href = $("stripes").toDataURL("image/png"); a.download = `franjas_fuego_${slug()}.png`; a.click(); });
  $("repMetric").addEventListener("change", renderReported);
  $("dlCal").addEventListener("click", csvCalendar);
  $("dlPoints").addEventListener("click", csvPoints);
  $("dlCountries").addEventListener("click", csvCountries);
  $("dlSvg").addEventListener("click", () => download(`calendario_${slug()}.svg`, new XMLSerializer().serializeToString($("cal").querySelector("svg")), "image/svg+xml"));
}

// ---------- Países ----------
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
  // Primero los que van por encima de lo habitual, después normales y por debajo; dentro de cada grupo, por número de focos
  const lv = (c) => (c.ytdP >= 80 ? 0 : c.ytdP > 20 ? 1 : 2);
  const rows = Object.values(COUNTRY_STATS).filter((c) => c.ytd > 0 || c.ytdMed > 0).sort((a, b) => lv(a) - lv(b) || b.ytd - a.ytd);
  const maxL = Math.max(1, ...rows.map((c) => Math.abs(Math.log2(ratioOf(c)))));
  const tr = (c) => {
    const lr = Math.log2(ratioOf(c)), wbar = Math.round(60 * Math.min(1, Math.abs(lr) / maxL));
    const pct = c.ytdMed > 0 ? Math.round(100 * (c.ytd - c.ytdMed) / c.ytdMed) : null;
    return `<tr data-k="${c.iso}" tabindex="0" class="${c.iso === S.zone ? "sel" : ""}"><td>${c.name}</td><td>${fmt(c.ytd)}</td>` +
      `<td><div class="bar-cell"><span>${pct === null ? "–" : (pct > 0 ? "+" : "") + pct + " %"}</span><span class="b" style="width:${wbar}px;background:${lr >= 0 ? "#E0583A" : "#4FA0E6"}"></span></div></td>` +
      `<td><span class="arrow ${level(c.ytdP)}" title="${levelWord(c.ytdP)}">${arrow(c.ytdP)}</span><span class="sr">${levelWord(c.ytdP)}</span></td></tr>`;
  };
  $("countryTable").innerHTML = `<table class="t"><caption class="sr">Focos de calor por país en ${CY} frente a lo habitual</caption>` +
    `<tr><th scope="col">País</th><th scope="col">Focos en ${CY}</th><th scope="col">Frente a lo habitual</th><th scope="col"><span class="sr">Nivel</span></th></tr>${rows.map(tr).join("")}</table>`;
  $("countryTable").querySelectorAll("tr[data-k]").forEach((t) => {
    const go = () => selectZone(t.dataset.k);
    t.addEventListener("click", go); t.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
function csvCountries() {
  const out = [`pais,iso,focos_${CY}_hasta_hoy,habitual_mismas_fechas,diferencia_pct,focos_mes_en_curso,habitual_mes_en_curso,focos_mes_pasado,habitual_mes_pasado,factor_modis_viirs,factor_origen`];
  for (const c of Object.values(COUNTRY_STATS)) {
    const f = D.fac.r[c.iso];
    out.push([`"${c.name}"`, c.iso, c.ytd.toFixed(0), (c.ytdMed || 0).toFixed(0), c.ytdMed > 0 ? (100 * (c.ytd - c.ytdMed) / c.ytdMed).toFixed(0) : "", c.cur.toFixed(0), (c.curMed || 0).toFixed(0), c.last.toFixed(0), (c.lastMed || 0).toFixed(0), f.est, f.fuente].join(","));
  }
  download(`paises_${CY}.csv`, out.join("\n"));
}

// ---------- Incendios ----------
function eventList() {
  const E = D.incendios, out = [];
  for (let j = 0; j < E.w.length; j++) {
    if (S.zone !== "EU" && !zoneIsCustom() && E.iso[j] !== S.zone) continue;
    if (zoneIsCustom() && !inZonePoint(E.lon[j], E.lat[j])) continue;
    out.push({ j, w: E.w[j], d0: E.d0[j], d1: E.d1[j], lon: E.lon[j], lat: E.lat[j], iso: E.iso[j], peak: E.peak[j], gid: E.gid[j], pts: E.pts[j], frp: E.frp[j] });
  }
  return out;   // ya vienen ordenados de mayor a menor
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
    head = `<div class="ev-now ${pct >= 95 ? "alto" : ""}">El incendio más grande del último mes empezó el <b>${dayStr(rec.d0)}</b> en ${COUNTRY_NAME[rec.iso]}, duró ${rec.d1 - rec.d0 + 1} días y tuvo <b>${fmt(rec.w)} focos de calor</b>. ` +
      `Es más grande que el <b>${pTxt} %</b> de los ${fmt(all.length)} incendios registrados en ${z} desde 2000. <a href="#" data-ev="rec">Verlo en el mapa</a></div>`;
  } else head = `<div class="ev-now">No se ha detectado ningún incendio en ${z} en los últimos 30 días.</div>`;
  const rows = inRange.slice(0, 15).map((e, i) => `<tr data-k="${i}" tabindex="0"><td>${fmt(rank.get(e))}º</td><td>${dayStr(e.d0)}</td><td>${e.d1 - e.d0 + 1}</td><td>${COUNTRY_NAME[e.iso]}</td><td><b>${fmt(e.w)}</b></td></tr>`).join("");
  $("events").innerHTML = head + `<h3>Los mayores entre ${S.yA} y ${S.yB}</h3>` +
    `<div class="table-wrap"><table class="t ev"><caption class="sr">Mayores incendios del periodo</caption><tr><th scope="col">Puesto</th><th scope="col">Empezó</th><th scope="col">Días</th><th scope="col">País</th><th scope="col">Focos</th></tr>${rows || `<tr><td colspan="5">No hay incendios en estos años.</td></tr>`}</table></div>` +
    `<p class="note">El puesto compara con todos los incendios de ${z} desde 2000. Solo se cuentan los que tuvieron al menos 15 focos.</p>`;
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
    svgEl("text", { x: xs(v), y: h - 4, "text-anchor": "middle", "font-size": 11, fill: COL.muted }, svg).textContent = fmt(v) + " focos";
  });
  let seed = 7; const jit = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const sample = all.length > 4000 ? all.filter((_, i) => i < 400 || i % Math.ceil(all.length / 3600) === 0) : all;
  sample.slice().reverse().forEach((e) => {
    const top = all.indexOf(e) < 10, isRec = e === rec, cy = 10 + jit() * (h - 34);
    const c = svgEl("circle", { cx: xs(e.w), cy, r: top ? 5 : 2.4, fill: top ? "#F6B53E" : "#5C6F8A", opacity: top ? 1 : 0.55 }, svg);
    if (isRec) svgEl("circle", { cx: xs(e.w), cy, r: 8, fill: "none", stroke: "#E6EDF6", "stroke-width": 2 }, svg);
    if (top || isRec) {
      c.style.cursor = "pointer";
      c.addEventListener("mousemove", (ev) => showTip(ev, `<b>${dayStr(e.d0)}</b>, ${COUNTRY_NAME[e.iso]}<br>${fmt(e.w)} focos en ${e.d1 - e.d0 + 1} días`));
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
  map.fitBounds(b, { maxZoom: 11, paddingTopLeft: [innerWidth > 1000 ? Math.min(520, innerWidth * 0.46) : 20, 20] });
  $("gibsDate").value = new Date(DAY0 + e.peak * 864e5).toISOString().slice(0, 10);
  $("gibsOn").checked = true; updateGibs();
  $("mapLegend").innerHTML = `<span>primer día</span><div class="ramp" style="background:linear-gradient(90deg,${THERMAL.slice(3).join(",")})"></div><span>último día</span>`;
  $("mapnote").innerHTML = `Incendio del ${dayStr(e.d0)} en ${COUNTRY_NAME[e.iso]}: ${fmt(e.w)} focos en ${e.d1 - e.d0 + 1} días. La foto es del ${dayStr(e.peak)}, su día con más fuego. <a href="#" id="mapBack">Volver</a>`;
  $("mapBack").onclick = (ev) => { ev.preventDefault(); S.event = null; $("gibsOn").checked = false; updateGibs(); renderMapLayer(true); };
  scrollToMap();
}
function eventsSpeech(t) {
  const all = eventList(); if (!all.length) return `No hay incendios registrados en ${zoneLabel()}.`;
  const rec = recentEvent(all), top = all[0];
  if (/ultimo|reciente|actual|ahora|compara/.test(t)) {
    const e = rec || all.slice().sort((a, b) => b.d1 - a.d1)[0], r = all.indexOf(e) + 1; focusEvent(e);
    return `${rec ? "El incendio más grande del último mes" : `En el último mes no hay incendios en ${zoneLabel()}. El más reciente`} empezó el ${dayStr(e.d0)}${S.zone === e.iso ? "" : " en " + COUNTRY_NAME[e.iso]}, duró ${e.d1 - e.d0 + 1} días y tuvo ${fmt(e.w)} focos de calor: es el número ${fmt(r)} de ${fmt(all.length)} desde 2000. El mayor fue el del ${dayStr(top.d0)}, con ${fmt(top.w)}.`;
  }
  focusEvent(top);
  return `El mayor incendio registrado en ${zoneLabel()} desde 2000 empezó el ${dayStr(top.d0)}${S.zone === top.iso ? "" : " en " + COUNTRY_NAME[top.iso]}, duró ${top.d1 - top.d0 + 1} días y tuvo ${fmt(top.w)} focos de calor.`;
}

// ---------- Franjas diarias ----------
function renderStripes() {
  const cv = $("stripes"), y0 = Math.max(2001, S.yA), ny = S.yB - y0 + 1;
  if (!Z.daily) { cv.width = 1; cv.height = 1; cv.style.height = "0px"; $("stripesNote").textContent = "Las franjas diarias están disponibles para Europa y para cada país, no para zonas dibujadas."; return; }
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
  $("stripesNote").textContent = `${zoneLabel()}, ${y0}–${S.yB}. Fíjate en cuándo empieza y acaba la temporada de fuego cada año.`;
}

function renderExtras() { renderCountryTable(); renderEvents(); renderStripes(); }
