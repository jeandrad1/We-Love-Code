/* PyrOrbit Code — core: data loading, selected area, key figures, calendar and charts.
   The data arrives already aggregated by the pipeline (country series, ~50 km grid, fires). */
"use strict";

const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MESES_L = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// English country names (the data files carry the Spanish ones)
const COUNTRY_EN = { ALB: "Albania", AUT: "Austria", BEL: "Belgium", BIH: "Bosnia and Herzegovina", BGR: "Bulgaria", BLR: "Belarus", CHE: "Switzerland", CYP: "Cyprus", CZE: "Czechia", DEU: "Germany",
  DNK: "Denmark", ESP: "Spain", EST: "Estonia", FIN: "Finland", FRA: "France", GBR: "United Kingdom", GRC: "Greece", HRV: "Croatia", HUN: "Hungary", IRL: "Ireland",
  ISL: "Iceland", ITA: "Italy", KOS: "Kosovo", LTU: "Lithuania", LUX: "Luxembourg", LVA: "Latvia", MDA: "Moldova", MKD: "North Macedonia", MLT: "Malta", MNE: "Montenegro",
  NLD: "Netherlands", NOR: "Norway", POL: "Poland", PRT: "Portugal", ROU: "Romania", SRB: "Serbia", SVK: "Slovakia", SVN: "Slovenia", SWE: "Sweden", UKR: "Ukraine" };
const SATS = ["Terra", "Aqua", "S-NPP", "NOAA-20", "NOAA-21"];
const INSTR = ["MODIS", "MODIS", "VIIRS", "VIIRS", "VIIRS"];
const DAY0 = Date.UTC(2000, 0, 1);
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

// Ramps: thermal (amount, dark -> bright) and diverging (less / more than usual)
const THERMAL = ["#2A1B4A", "#4A1F66", "#74246E", "#9C2F68", "#C2445A", "#DE6345", "#F08A34", "#F6B53E", "#F9DD7A", "#FFF6CF"];
const DIVERG = ["#4FA0E6", "#3F7FBA", "#3B5F86", "#4A5568", "#5F5A5E", "#8A4A3B", "#B9502F", "#E0583A", "#FF7A4A"];
const COL = { corr: "#C77A22", modis: "#3A86CC", viirs: "#C9476C", raw: "#8A9AB0", ink: "#E6EDF6", grid: "#22354F", muted: "#9CB0C9", band: "rgba(156,176,201,.16)", normal: "#C8D4E3" };

const S = { zone: "EU", geom: null, circle: null, mode: "count", mapView: "calor", mapMonth: null, yA: null, yB: null };
const D = {};          // loaded data
let NK, K0, LAST, CY, CM, DD, PARTIAL, EU, Z, BASE, KPI = [], REC = null, COUNTRY_NAME = {}, GRID_BY_CELL;

// ---------- utilities ----------
const $ = (id) => document.getElementById(id);
const yOf = (i) => 2000 + Math.floor((K0 + i) / 12);
const mOf = (i) => ((K0 + i) % 12) + 1;
const iOf = (y, m) => (y - 2000) * 12 + (m - 1) - K0;
const fmt = (v) => Number.isFinite(v) ? nf.format(Math.round(v)) : "–";
const fmt1 = (v) => Number.isFinite(v) ? nf1.format(v) : "–";
function hex2rgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(",")})`;
}
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function quantile(a, q) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), p = (s.length - 1) * q, i = Math.floor(p); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (p - i); }
function pctRank(arr, v) { if (!arr.length) return NaN; let lt = 0, eq = 0; for (const a of arr) { if (a < v) lt++; else if (a === v) eq++; } return 100 * (lt + 0.5 * eq) / arr.length; }
function download(name, text, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const tip = $("tip");
function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = Math.min(ev.clientX + 14, innerWidth - 300) + "px"; tip.style.top = (ev.clientY + 14) + "px"; }
function hideTip() { tip.hidden = true; }
function parseCSV(t) {
  const [h, ...rows] = t.trim().split(/\r?\n/), cols = h.split(",").map((c) => c.trim());
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v.trim()])));
}
// Geometry
function inRing(x, y, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
function inPoly(x, y, p) { if (!inRing(x, y, p[0])) return false; for (let h = 1; h < p.length; h++) if (inRing(x, y, p[h])) return false; return true; }
function inGeom(x, y, g) { return g.type === "Polygon" ? inPoly(x, y, g.coordinates) : g.coordinates.some((p) => inPoly(x, y, p)); }
function haversineKm(a, b, c, d) { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); }
function inZonePoint(lon, lat) {
  if (S.zone === "circle") return S.circle && haversineKm(S.circle.lat, S.circle.lon, lat, lon) <= S.circle.km;
  if (S.zone === "draw") return S.geom && inGeom(lon, lat, S.geom);
  return true;
}

// ---------- plain language ----------
function level(p) { return p >= 80 ? "alto" : p <= 20 ? "bajo" : "normal"; }   // CSS class names, keep
function levelTxt(p) { return p >= 90 ? "much higher than usual" : p >= 80 ? "higher than usual" : p <= 10 ? "much lower than usual" : p <= 20 ? "lower than usual" : "within the usual range"; }
function levelWord(p) { return p >= 90 ? "Much more than usual" : p >= 80 ? "More than usual" : p <= 10 ? "Much less than usual" : p <= 20 ? "Less than usual" : "Normal"; }
function arrow(p) { return p >= 90 ? "▲▲" : p >= 80 ? "▲" : p <= 10 ? "▼▼" : p <= 20 ? "▼" : "●"; }
function yearsTxt(hist, v) {
  const n = hist.length; if (!n) return "";
  const lt = hist.filter((h) => h < v).length, gt = hist.filter((h) => h > v).length;
  if (lt === n) return `the highest value of the previous ${n} years`;
  if (gt === n) return `the lowest value of the previous ${n} years`;
  if (lt === 0) return gt === 0 ? `same as the previous ${n} years` : `lower than in ${gt} of ${n} years`;
  return `higher than in ${lt} of ${n} years`;
}
function diffTxt(v, med) {
  if (!(med > 0)) return v > 0 ? "when there are normally almost none" : "as usual";
  const r = (v - med) / med;
  if (Math.abs(r) < 0.1) return "similar to a normal year";
  return r > 0 ? (r >= 1 ? `${nf1.format(1 + r)} times normal` : `${Math.round(r * 100)}% more than a normal year`) : `${Math.round(-r * 100)}% less than a normal year`;
}

// ---------- loading ----------
async function load() {
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const [meta, paises, series, parcial, diario, rejilla, incendios, fac, val, fijas] = await Promise.all([
    j("data/meta.json"), j("data/paises.geojson"), j("data/series.json"), j("data/parcial.json"), j("data/diario.json"),
    j("data/rejilla.json"), j("data/incendios.json"), j("data/factores.json"), j("data/validacion.json"),
    j("data/fuentes_fijas.geojson").catch(() => ({ features: [] }))]);
  Object.assign(D, { meta, paises, series, parcial, diario, rejilla, incendios, fac, val, fijas });
  try { const r = await fetch("data/reportado.csv"); if (r.ok) D.reportado = parseCSV(await r.text()); } catch (e) { /* optional */ }
  K0 = meta.k0; NK = meta.nk;
  LAST = new Date(meta.ultimo_dato + "T00:00:00Z");
  CY = LAST.getUTCFullYear(); CM = LAST.getUTCMonth() + 1; DD = LAST.getUTCDate();
  const nx = new Date(LAST); nx.setUTCDate(nx.getUTCDate() + 1); PARTIAL = nx.getUTCDate() !== 1;
  meta.paises.forEach((p) => { p.nombre = COUNTRY_EN[p.iso] || p.nombre; COUNTRY_NAME[p.iso] = p.nombre; });
  // Europe totals
  EU = {}; for (const key of ["h", "lo", "hi", "naive", "modis", "viirs"]) { EU[key] = new Float64Array(NK); for (const iso in series) series[iso][key].forEach((v, i) => (EU[key][i] += v)); }
  // Grid grouped by cell
  const R = rejilla; GRID_BY_CELL = R.celdas.map(() => []);
  for (let t = 0; t < R.c.length; t++) GRID_BY_CELL[R.c[t]].push(t);
  S.yA = yOf(0); S.yB = CY;
}
const validMonth = (i) => i >= 0 && i < NK && !!D.fac.choice[`${yOf(i)}-${String(mOf(i)).padStart(2, "0")}`];
const monthSource = (i) => D.fac.choice[`${yOf(i)}-${String(mOf(i)).padStart(2, "0")}`];

// ---------- selected area ----------
function zoneLabel() { return S.zone === "EU" ? "Europe" : S.zone === "draw" ? "the drawn area" : S.zone === "circle" ? `a ${S.circle ? S.circle.km : "?"} km radius` : COUNTRY_NAME[S.zone]; }
function zoneIsCustom() { return S.zone === "draw" || S.zone === "circle"; }
function cellsInZone() {
  const g = D.rejilla.deg, out = [];
  D.rejilla.celdas.forEach(([cx, cy], ci) => { if (inZonePoint((cx + 0.5) * g, (cy + 0.5) * g)) out.push(ci); });
  return out;
}
function computeZone() {
  const years = D.parcial.anios, z = { partial: {}, raw: true, daily: true };
  if (S.zone === "EU") {
    Object.assign(z, EU);
    years.forEach((y, yi) => { let s = 0; for (const iso in D.parcial.paises) s += D.parcial.paises[iso][yi]; z.partial[y] = s; });
  } else if (!zoneIsCustom()) {
    const s = D.series[S.zone]; for (const k of ["h", "lo", "hi", "naive", "modis", "viirs"]) z[k] = Float64Array.from(s[k]);
    years.forEach((y, yi) => (z.partial[y] = D.parcial.paises[S.zone][yi]));
  } else {
    const cells = new Set(cellsInZone()), R = D.rejilla;
    z.h = new Float64Array(NK);
    for (const ci of cells) for (const t of GRID_BY_CELL[ci]) z.h[R.k[t]] += R.v[t] / 10;
    z.lo = z.h; z.hi = z.h; z.raw = false; z.daily = false;
    years.forEach((y) => (z.partial[y] = 0));
    const P = D.parcial; for (let t = 0; t < P.c.length; t++) if (cells.has(P.c[t])) z.partial[P.y[t]] = (z.partial[P.y[t]] || 0) + P.v[t] / 10;
    z.ncells = cells.size;
  }
  Z = z;
  // Baseline per calendar month: complete months only (no half-finished current month, no year 2000)
  const lastFull = PARTIAL ? NK - 2 : NK - 1;
  BASE = [];
  for (let m = 1; m <= 12; m++) {
    const vals = [], nv = [];
    for (let y = 2001; y <= CY; y++) { const i = iOf(y, m); if (validMonth(i) && i <= lastFull) { vals.push(Z.h[i]); if (Z.raw) nv.push(Z.naive[i]); } }
    BASE.push({ vals, med: median(vals), p10: quantile(vals, 0.1), p90: quantile(vals, 0.9), naiveVals: nv, naiveMed: median(nv) });
  }
}

// ---------- key figures ----------
function computeKPIs() {
  const years = D.parcial.anios, box = [];
  const histYears = years.filter((y) => y >= 2001 && y < CY);
  // This month (days 1..DD) against the same days in other years
  const hist = histYears.map((y) => Z.partial[y] || 0), cur = Z.partial[CY] || 0;
  box.push({ id: "mes", n: cur, med: median(hist), p: pctRank(hist, cur), hist, lab: PARTIAL ? `This month, 1–${DD} ${MESES_L[CM - 1]}` : `${MESES_L[CM - 1]} ${CY}` });
  // Year to date
  const ytd = (y) => { let s = 0; for (let m = 1; m < CM; m++) { const i = iOf(y, m); if (i >= 0) s += Z.h[i]; } return s + (Z.partial[y] || 0); };
  const yh = histYears.filter((y) => y >= 2001 && iOf(y, 1) >= 0).map(ytd), yc = ytd(CY);
  box.push({ id: "anio", n: yc, med: median(yh), p: pctRank(yh, yc), hist: yh, lab: `So far in ${CY}` });
  // Last complete month
  const iF = PARTIAL ? NK - 2 : NK - 1, mF = mOf(iF), bF = BASE[mF - 1];
  box.push({ id: "ultimo", n: Z.h[iF], med: bF.med, p: pctRank(bF.vals, Z.h[iF]), hist: bF.vals, mes: `${MESES_L[mF - 1]} ${yOf(iF)}`, lab: `Last month, ${MESES_L[mF - 1]}` });
  const order = BASE.map((b, i) => [b.med, i]).sort((a, b) => b[0] - a[0]);
  const annual = {}; for (let y = 2001; y < CY; y++) { let s = 0; for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i >= 0) s += Z.h[i]; } annual[y] = s; }
  const rec = Object.entries(annual).sort((a, b) => b[1] - a[1])[0];
  REC = { order: order.map((o) => o[1]), rec };
  KPI = box;
}
function renderKPIs() {
  const figs = KPI.map((b) => `<div class="fig"><div class="lab">${b.lab}</div><div class="val">${fmt(b.n)} <small>hotspots</small></div>` +
    `<div class="lvl ${level(b.p)}">${arrow(b.p)} ${levelWord(b.p)}</div><div class="det">Usual: ${fmt(b.med)}. ${yearsTxt(b.hist, b.n)[0].toUpperCase() + yearsTxt(b.hist, b.n).slice(1)}.</div></div>`);
  figs.push(`<div class="fig"><div class="lab">When it burns most here</div><div class="val" style="font-size:28px">${MESES_L[REC.order[0]]} and ${MESES_L[REC.order[1]]}</div>` +
    `<div class="det">The year with the most fire was ${REC.rec ? REC.rec[0] : "–"}, with ${REC.rec ? fmt(REC.rec[1]) : "–"} hotspots.</div></div>`);
  $("kpis").innerHTML = figs.join("");
}

// ---------- calendar ----------
const years = () => { const out = []; for (let y = S.yB; y >= S.yA; y--) out.push(y); return out; };
function cellValue(i) { return S.mode === "raw" ? Z.naive[i] : Z.h[i]; }
function renderCalendar() {
  if (S.mode === "raw" && !Z.raw) S.mode = "count", document.querySelector("input[name=mode][value=count]").checked = true;
  document.querySelector("input[name=mode][value=raw]").disabled = !Z.raw;
  const host = $("cal"); host.innerHTML = "";
  const width = Math.max(760, host.clientWidth || 1000), lab = 48, totW = 78, cw = (width - lab - totW - 12) / 12, ch = 21, top = 22;
  const ys = years();
  const svg = svgEl("svg", { width, height: top + ys.length * ch + 4, xmlns: "http://www.w3.org/2000/svg", "font-family": "Archivo, system-ui, sans-serif" }, host);
  svgEl("rect", { x: 0, y: 0, width, height: top + ys.length * ch + 4, fill: "#15253B" }, svg);
  MESES.forEach((m, i) => (svgEl("text", { x: lab + i * cw + cw / 2, y: 14, "text-anchor": "middle", fill: COL.muted, "font-size": 12 }, svg).textContent = m));
  svgEl("text", { x: lab + 12 * cw + 6 + totW / 2, y: 14, "text-anchor": "middle", fill: COL.muted, "font-size": 12 }, svg).textContent = "year";
  const inView = []; ys.forEach((y) => { for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (validMonth(i)) inView.push(cellValue(i)); } });
  const vmax = Math.max(1, quantile(inView, 0.98));
  const annual = ys.map((y) => { let s = 0, n = 0; for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (validMonth(i)) { s += cellValue(i); n++; } } return { y, s, n }; });
  const annMed = median(annual.filter((a) => a.n === 12 && a.y < CY).map((a) => a.s)), annMax = Math.max(1, ...annual.map((a) => a.s));
  const showNums = $("nums").checked;
  ys.forEach((y, r) => {
    const yy = top + r * ch;
    svgEl("text", { x: lab - 8, y: yy + ch * 0.68, "text-anchor": "end", fill: y === 2012 && S.mode === "raw" ? "#FFB04A" : COL.muted, "font-size": 12, "font-weight": y === 2012 && S.mode === "raw" ? 700 : 400 }, svg).textContent = y;
    for (let m = 1; m <= 12; m++) {
      const i = iOf(y, m), x = lab + (m - 1) * cw;
      if (!validMonth(i)) { svgEl("rect", { x: x + 1, y: yy + 1, width: cw - 2, height: ch - 2, fill: "#1B2E48", rx: 3 }, svg); continue; }
      const v = cellValue(i), b = BASE[m - 1], med = S.mode === "raw" ? b.naiveMed : b.med;
      let fill, txt, dark;
      if (S.mode === "anom") {
        const t = Math.log2((v + 1) / (med + 1)) / 2;
        fill = ramp(DIVERG, (t + 1) / 2); dark = false;
        if (med >= 5) { const pc = Math.round(100 * (v - med) / med); txt = (pc > 0 ? "+" : "") + pc + "%"; } else { const df = Math.round(v - med); txt = (df > 0 ? "+" : "") + df; }
      } else {
        const t = Math.log1p(v) / Math.log1p(vmax);
        fill = v < 0.5 ? "#1B2E48" : ramp(THERMAL, 0.08 + 0.92 * t); dark = t > 0.72; txt = fmt(v);
      }
      const isPartial = PARTIAL && i === NK - 1;
      const rect = svgEl("rect", { x: x + 1, y: yy + 1, width: cw - 2, height: ch - 2, fill, rx: 3, stroke: isPartial ? COL.ink : "none", "stroke-dasharray": isPartial ? "3,2" : "" }, svg);
      if (showNums && cw > 38) svgEl("text", { x: x + cw / 2, y: yy + ch * 0.68, "text-anchor": "middle", fill: dark ? "#1A1206" : COL.ink, "font-size": 11, "font-variant-numeric": "tabular-nums" }, svg).textContent = txt;
      const histM = S.mode === "raw" ? b.naiveVals : b.vals, pr = pctRank(histM, v), src = monthSource(i);
      rect.addEventListener("mousemove", (ev) => showTip(ev,
        `<b>${MESES_L[m - 1]} ${y}</b>${isPartial ? " (current month)" : ""}<br><b>${fmt(v)}</b> hotspots${S.mode === "raw" ? " uncorrected" : ""}` +
        (S.mode !== "raw" && src !== "SNPP" && Z.lo !== Z.h ? ` (between ${fmt(Z.lo[i])} and ${fmt(Z.hi[i])})` : "") +
        `<br>Usual in ${MESES_L[m - 1]}: ${fmt(med)}<br>${arrow(pr)} ${levelWord(pr)}: ${yearsTxt(histM, v)}` +
        `<br><span style="opacity:.7">Satellite: ${src === "MODIS" || src === "Terra" ? "MODIS, corrected" : "VIIRS " + src}. Click to see it on the map.</span>`));
      rect.addEventListener("mouseleave", hideTip);
      rect.addEventListener("click", () => focusMonth(y, m));
    }
    const a = annual[r], x = lab + 12 * cw + 6;
    if (a.n) {
      const t = S.mode === "anom" ? (Math.log2((a.s + 1) / (annMed + 1)) / 2 + 1) / 2 : 0.08 + 0.85 * Math.log1p(a.s) / Math.log1p(annMax);
      svgEl("rect", { x, y: yy + 1, width: totW, height: ch - 2, fill: S.mode === "anom" ? ramp(DIVERG, t) : ramp(THERMAL, t), rx: 3 }, svg);
      svgEl("text", { x: x + totW / 2, y: yy + ch * 0.68, "text-anchor": "middle", "font-size": 11, fill: S.mode !== "anom" && t > 0.72 ? "#1A1206" : COL.ink }, svg).textContent = fmt(a.s) + (a.n < 12 ? "*" : "");
    }
  });
  if (S.mode === "raw" && 2012 >= S.yA && 2012 <= S.yB) {
    const yy = top + (S.yB - 2012) * ch;
    svgEl("rect", { x: lab - 3, y: yy, width: 12 * cw + 6, height: ch, fill: "none", stroke: "#FFB04A", "stroke-width": 2, rx: 4 }, svg);
  }
  const T = { count: "How many hotspots were there each month?", anom: "Was each month above or below usual?", raw: "Uncorrected: mixing the satellites as they are" };
  const H = { count: `Each row is a year and each cell a month in ${zoneLabel()}. The brighter, the more fire. Hover over a cell for details or click it to see it on the map.`,
    anom: "Red: that month had more fire than usual for that time of year. Blue: less. The number says how much.",
    raw: "Look at 2012: it seems that suddenly there is much more fire, but a satellite that sees more simply started working. That is why we correct the data." };
  $("calTitle").textContent = T[S.mode]; $("calHow").textContent = H[S.mode] + (zoneIsCustom() ? ` Calculated from the ${Z.ncells} cells of ~50 km in the area.` : "");
  $("calLegend").innerHTML = S.mode === "anom"
    ? `<span>Less than usual</span><div class="ramp" style="background:linear-gradient(90deg,${DIVERG.join(",")})"></div><span>More</span>`
    : `<span>Little fire</span><div class="ramp" style="background:linear-gradient(90deg,${THERMAL.slice(1).join(",")})"></div><span>A lot</span>`;
}

// ---------- charts ----------
function axes(svg, w, h, pad, xs, ys, xTicks, yMax) {
  for (let i = 0; i <= 4; i++) {
    const v = yMax * i / 4, y = ys(v);
    svgEl("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: COL.grid }, svg);
    svgEl("text", { x: pad.l - 6, y: y + 4, "text-anchor": "end", "font-size": 11, fill: COL.muted }, svg).textContent = fmt(v);
  }
  xTicks.forEach(([v, l]) => (svgEl("text", { x: xs(v), y: h - 6, "text-anchor": "middle", "font-size": 11, fill: COL.muted }, svg).textContent = l));
}
function path(pts) { return pts.filter((p) => Number.isFinite(p[1])).map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(""); }
function legend(svg, items, x, y) {
  items.forEach(([c, l, dash], i) => {
    svgEl("line", { x1: x, x2: x + 20, y1: y + i * 17, y2: y + i * 17, stroke: c, "stroke-width": 2.5, "stroke-dasharray": dash || "" }, svg);
    svgEl("text", { x: x + 26, y: y + i * 17 + 4, "font-size": 12, fill: COL.ink }, svg).textContent = l;
  });
}
function renderClim() {
  const svg = $("clim"); svg.innerHTML = "";
  const w = svg.clientWidth || 560, h = 280, pad = { l: 52, r: 12, t: 12, b: 24 };
  const cur = []; for (let m = 1; m <= 12; m++) { const i = iOf(CY, m); cur.push(i < NK ? Z.h[i] : NaN); }
  const yMax = Math.max(1, ...BASE.map((b) => b.p90 || 0), ...cur.filter(Number.isFinite)) * 1.1;
  const xs = (m) => pad.l + (m - 0.5) * (w - pad.l - pad.r) / 12, ys = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  axes(svg, w, h, pad, xs, ys, MESES.map((l, i) => [i + 1, l]), yMax);
  const band = BASE.map((b, i) => [xs(i + 1), ys(b.p90)]).concat(BASE.map((b, i) => [xs(i + 1), ys(b.p10)]).reverse());
  svgEl("path", { d: path(band) + "Z", fill: COL.band }, svg);
  svgEl("path", { d: path(BASE.map((b, i) => [xs(i + 1), ys(b.med)])), fill: "none", stroke: COL.normal, "stroke-width": 2 }, svg);
  svgEl("path", { d: path(cur.map((v, i) => [xs(i + 1), ys(v)])), fill: "none", stroke: COL.corr, "stroke-width": 2.5 }, svg);
  cur.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const c = svgEl("circle", { cx: xs(i + 1), cy: ys(v), r: 4.5, fill: COL.corr, stroke: "#15253B", "stroke-width": 2 }, svg);
    const b = BASE[i];
    const hit = svgEl("rect", { x: xs(i + 1) - 14, y: pad.t, width: 28, height: h - pad.t - pad.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${MESES_L[i]}</b><br>${CY}: ${fmt(v)} hotspots${i === CM - 1 && PARTIAL ? " (month in progress)" : ""}<br>Normal year: ${fmt(b.med)}<br>8 out of 10 years: between ${fmt(b.p10)} and ${fmt(b.p90)}`));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, [[COL.corr, String(CY)], [COL.normal, "a normal year"]], w - 150, 22);
}
function renderAnnual() {
  const svg = $("annual"); svg.innerHTML = "";
  const w = svg.clientWidth || 560, h = 280, pad = { l: 58, r: 14, t: 12, b: 24 };
  const yA = Math.max(S.yA, 2001), yB = S.yB, ser = [];
  for (let y = yA; y <= yB; y++) {
    let H = 0, lo = 0, hi = 0, nv = 0, mo = 0, vi = 0;
    for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i < 0 || i >= NK) continue; H += Z.h[i]; lo += Z.lo[i]; hi += Z.hi[i]; if (Z.raw) { nv += Z.naive[i]; mo += Z.modis[i]; vi += Z.viirs[i]; } }
    ser.push({ y, H, lo, hi, nv: Z.raw ? nv : NaN, mo: Z.raw ? mo : NaN, vi: Z.raw && y >= 2012 ? vi : NaN });
  }
  if (ser.length < 2) return;
  const yMax = Math.max(1, ...ser.map((s) => Math.max(s.hi, s.nv || 0, s.vi || 0))) * 1.1;
  const xs = (y) => pad.l + (y - yA) / Math.max(1, yB - yA) * (w - pad.l - pad.r), ys = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  const step = Math.ceil((yB - yA) / 8);
  axes(svg, w, h, pad, xs, ys, ser.filter((s) => (s.y - yA) % step === 0).map((s) => [s.y, s.y]), yMax);
  if (yA <= 2012 && yB >= 2012) svgEl("line", { x1: xs(2012), x2: xs(2012), y1: pad.t, y2: h - pad.b, stroke: "#FFB04A", "stroke-dasharray": "3,4", opacity: 0.6 }, svg);
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.hi)]).concat(ser.map((s) => [xs(s.y), ys(s.lo)]).reverse())) + "Z", fill: "rgba(199,122,34,.22)" }, svg);
  if (Z.raw) {
    svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.mo)])), fill: "none", stroke: COL.modis, "stroke-width": 2 }, svg);
    svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.vi)])), fill: "none", stroke: COL.viirs, "stroke-width": 2 }, svg);
    svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.nv)])), fill: "none", stroke: COL.raw, "stroke-width": 2, "stroke-dasharray": "6,4" }, svg);
  }
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.H)])), fill: "none", stroke: COL.corr, "stroke-width": 2.5 }, svg);
  ser.forEach((s) => {
    const hit = svgEl("rect", { x: xs(s.y) - 10, y: pad.t, width: 20, height: h - pad.t - pad.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${s.y}</b><br>Corrected: ${fmt(s.H)} hotspots${s.hi > s.lo ? ` (between ${fmt(s.lo)} and ${fmt(s.hi)})` : ""}` + (Z.raw ? `<br>Uncorrected: ${fmt(s.nv)}<br>MODIS only: ${fmt(s.mo)} · VIIRS only: ${fmt(s.vi)}` : "")));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, Z.raw ? [[COL.corr, "corrected"], [COL.raw, "uncorrected", "6,4"], [COL.modis, "MODIS only"], [COL.viirs, "VIIRS only"]] : [[COL.corr, "corrected"]], pad.l + 10, 22);
}
function renderValidation() {
  const v = D.val.resumen, o = D.fac.overlap, eu = D.val.europa;
  const iso = !zoneIsCustom() && S.zone !== "EU" ? S.zone : null;
  const rows = (iso ? D.val.paises[iso] || [] : eu).map((r) => `<tr><td>${r.year}</td><td>${fmt(r.observado)}</td><td>${fmt(iso ? r.pred_pais : r.pred_europeo)}</td><td>${fmt(r.modis)}</td></tr>`).join("");
  const f = iso ? D.fac.r[iso] : D.fac.eu;
  $("validation").innerHTML =
    `<p>Test: between ${o[0]} and ${o[1]} both satellites work. We hide one year, use only MODIS to estimate what VIIRS saw and compare it with reality.</p>` +
    `<p>Across countries, uncorrected we are off by <b>${fmt(v.paises.sin_corregir)}%</b>; with one common factor for Europe, <b>${fmt1(v.paises.factor_europeo)}%</b>; with each country's own factor, only <b>${fmt1(v.paises.factor_por_pais)}%</b> (median error of the annual total).</p>` +
    `<p class="note">${iso ? `${COUNTRY_NAME[iso]}: VIIRS sees ${fmt1(f.est)} hotspots for each one from MODIS (between ${fmt1(f.lo)} and ${fmt1(f.hi)})${f.fuente === "europeo" ? ", European factor because of a lack of its own data" : ""}.` : `Europe: VIIRS sees ${fmt1(f.est)} hotspots for each one from MODIS (between ${fmt1(f.lo)} and ${fmt1(f.hi)}).`}</p>` +
    `<div class="table-wrap" style="max-height:260px"><table class="t"><caption class="sr">Validation by year</caption><tr><th scope="col">Year</th><th scope="col">Seen by VIIRS</th><th scope="col">Estimated from MODIS</th><th scope="col">MODIS uncorrected</th></tr>${rows}</table></div>`;
}
function spearman(a, b) { const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length); o.forEach(([, i], j) => (r[i] = j + 1)); return r; }; return pearson(rk(a), rk(b)); }
function pearson(a, b) { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); }
const REP_LABEL = { hectareas_gwis: "burned area (GWIS, Copernicus)", hectareas_oficiales: "official burned area", incendios: "official number of fires" };
function renderReported() {
  const card = $("reportedCard");
  if (!D.reportado || zoneIsCustom()) { card.hidden = true; return; }
  const metrics = Object.keys(REP_LABEL).filter((k) => D.reportado.some((r) => r[k] !== undefined && r[k] !== ""));
  const sel = $("repMetric");
  if (!sel.options.length) metrics.forEach((k) => sel.add(new Option(REP_LABEL[k], k)));
  const metric = sel.value || metrics[0];
  const by = {};
  for (const r of D.reportado) { if (S.zone !== "EU" && r.iso !== S.zone) continue; const v = parseFloat(r[metric]); if (!Number.isFinite(v)) continue; by[r.year] = (by[r.year] || 0) + v; }
  const ys = Object.keys(by).map(Number).filter((y) => y >= 2001 && y < CY && iOf(y, 12) < NK).sort();
  if (ys.length < 4) { card.hidden = true; return; }
  card.hidden = false;
  const det = ys.map((y) => { let s = 0; for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i >= 0) s += Z.h[i]; } return s; }), rep = ys.map((y) => by[y]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, md = mean(det), mr = mean(rep);
  const svg = $("reported"); svg.innerHTML = "";
  const w = svg.clientWidth || 900, h = 280, pad = { l: 48, r: 24, t: 12, b: 24 };
  const di = det.map((d) => 100 * d / md), ri = rep.map((d) => 100 * d / mr), yMax = Math.max(...di, ...ri) * 1.1;
  const xs = (y) => pad.l + (y - ys[0]) / Math.max(1, ys[ys.length - 1] - ys[0]) * (w - pad.l - pad.r), yv = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  const step = Math.ceil(ys.length / 12);
  axes(svg, w, h, pad, xs, yv, ys.filter((_, i) => i % step === 0).map((y) => [y, y]), yMax);
  svgEl("path", { d: path(ys.map((y, i) => [xs(y), yv(di[i])])), fill: "none", stroke: COL.corr, "stroke-width": 2.5 }, svg);
  svgEl("path", { d: path(ys.map((y, i) => [xs(y), yv(ri[i])])), fill: "none", stroke: COL.modis, "stroke-width": 2.5, "stroke-dasharray": "6,4" }, svg);
  ys.forEach((y, i) => {
    const hit = svgEl("rect", { x: xs(y) - 10, y: pad.t, width: 20, height: h - pad.t - pad.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${y}</b><br>Hotspots: ${fmt(det[i])}<br>${REP_LABEL[metric]}: ${fmt(rep[i])}`));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, [[COL.corr, "hotspots (corrected)"], [COL.modis, REP_LABEL[metric], "6,4"]], pad.l + 10, 22);
  const sp = spearman(det, rep), word = sp >= 0.7 ? "very similar" : sp >= 0.5 ? "fairly similar" : sp >= 0.3 ? "somewhat similar" : "weakly similar";
  $("reportedNote").innerHTML = `${zoneLabel()}, ${ys[0]}–${ys[ys.length - 1]}: the two series are <b>${word}</b> (Spearman coefficient ${nf1.format(Math.round(sp * 100) / 100)}; 1 means they rise and fall exactly together). ` +
    `They need not match completely: a large fire burns a lot with relatively few hotspots, while many small agricultural fires give many hotspots and little area.`;
}

// ---------- downloads ----------
const slug = () => (zoneIsCustom() ? "area" : S.zone === "EU" ? "europe" : COUNTRY_NAME[S.zone]).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
function csvCalendar() {
  const out = ["year,month,corrected_hotspots,min_90,max_90,usual_for_month,difference_pct,uncorrected,modis,viirs_snpp,month_satellite,incomplete_month"];
  for (let i = 0; i < NK; i++) {
    const y = yOf(i), m = mOf(i); if (y < S.yA || y > S.yB || !validMonth(i)) continue;
    const b = BASE[m - 1], v = Z.h[i];
    out.push([y, m, v.toFixed(1), Z.lo[i].toFixed(1), Z.hi[i].toFixed(1), (b.med || 0).toFixed(1), b.med > 0 ? (100 * (v - b.med) / b.med).toFixed(0) : "",
      Z.raw ? Z.naive[i] : "", Z.raw ? Z.modis[i] : "", Z.raw ? Z.viirs[i] : "", monthSource(i), i === NK - 1 && PARTIAL ? 1 : 0].join(","));
  }
  download(`calendar_${slug()}.csv`, out.join("\n"));
}
async function csvPoints() {
  const months = D.meta.recientes.filter((n) => +n.slice(0, 4) >= S.yA && +n.slice(0, 4) <= S.yB);
  const out = ["date,latitude,longitude,country,satellite,instrument,frp_mw,correction_weight"];
  for (const n of months) {
    const p = await loadMonth(n);
    for (let t = 0; t < p.x.length; t++) {
      const lon = p.x[t] / 1000, lat = p.y[t] / 1000;
      if (!zoneIsCustom() && S.zone !== "EU" && p.p[t] !== S.zone) continue;
      if (zoneIsCustom() && !inZonePoint(lon, lat)) continue;
      out.push([new Date(DAY0 + p.d[t] * 864e5).toISOString().slice(0, 10), lat.toFixed(3), lon.toFixed(3), p.p[t], SATS[p.s[t]], INSTR[p.s[t]], (p.f[t] / 10).toFixed(1), p.w[t]].join(","));
    }
  }
  download(`hotspots_${slug()}.csv`, out.join("\n"));
}
const MONTH_CACHE = {};
function loadMonth(name) { if (!MONTH_CACHE[name]) MONTH_CACHE[name] = fetch(`data/focos/${name}.json`).then((r) => r.json()); return MONTH_CACHE[name]; }

// ---------- update ----------
function update(fit = false) {
  computeZone(); computeKPIs();
  renderKPIs(); renderCalendar(); renderClim(); renderAnnual(); renderValidation(); renderReported();
  if (typeof renderMapLayer === "function") renderMapLayer(fit);
  if (typeof renderExtras === "function") renderExtras();
  if (typeof renderHero === "function") renderHero();
}
async function main() {
  try { await load(); }
  catch (e) { $("mapnote").textContent = "The data could not be loaded (" + e.message + "). Open the site through a server (python -m http.server) and check that the web/data folder exists."; return; }
  if (D.meta.sinteticos) $("synthetic").hidden = false;
  $("ovl").textContent = `${D.fac.overlap[0]}–${D.fac.overlap[1]}`;
  $("nstatic").textContent = fmt(D.fijas.features.length);
  initMap(); initExtras(); initUI();
  update(true);
}
main();
