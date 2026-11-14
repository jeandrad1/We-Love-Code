/* Fuego en Europa — núcleo: carga de datos, zona elegida, cifras, calendario y gráficos.
   Los datos ya vienen agregados por el pipeline (series por país, rejilla de ~50 km, incendios). */
"use strict";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_L = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const SATS = ["Terra", "Aqua", "S-NPP", "NOAA-20", "NOAA-21"];
const INSTR = ["MODIS", "MODIS", "VIIRS", "VIIRS", "VIIRS"];
const DAY0 = Date.UTC(2000, 0, 1);
const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });

// Rampas: térmica (cantidad, oscuro -> brillante) y divergente (menos / más que lo habitual)
const THERMAL = ["#2A1B4A", "#4A1F66", "#74246E", "#9C2F68", "#C2445A", "#DE6345", "#F08A34", "#F6B53E", "#F9DD7A", "#FFF6CF"];
const DIVERG = ["#4FA0E6", "#3F7FBA", "#3B5F86", "#4A5568", "#5F5A5E", "#8A4A3B", "#B9502F", "#E0583A", "#FF7A4A"];
const COL = { corr: "#C77A22", modis: "#3A86CC", viirs: "#C9476C", raw: "#8A9AB0", ink: "#E6EDF6", grid: "#22354F", muted: "#9CB0C9", band: "rgba(156,176,201,.16)", normal: "#C8D4E3" };

const S = { zone: "EU", geom: null, circle: null, mode: "count", mapView: "calor", mapMonth: null, yA: null, yB: null };
const D = {};          // datos cargados
let NK, K0, LAST, CY, CM, DD, PARTIAL, EU, Z, BASE, KPI = [], REC = null, COUNTRY_NAME = {}, GRID_BY_CELL;

// ---------- utilidades ----------
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
// Geometría
function inRing(x, y, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
function inPoly(x, y, p) { if (!inRing(x, y, p[0])) return false; for (let h = 1; h < p.length; h++) if (inRing(x, y, p[h])) return false; return true; }
function inGeom(x, y, g) { return g.type === "Polygon" ? inPoly(x, y, g.coordinates) : g.coordinates.some((p) => inPoly(x, y, p)); }
function haversineKm(a, b, c, d) { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); }
function inZonePoint(lon, lat) {
  if (S.zone === "circle") return S.circle && haversineKm(S.circle.lat, S.circle.lon, lat, lon) <= S.circle.km;
  if (S.zone === "draw") return S.geom && inGeom(lon, lat, S.geom);
  return true;
}

// ---------- lenguaje llano ----------
function level(p) { return p >= 80 ? "alto" : p <= 20 ? "bajo" : "normal"; }
function levelTxt(p) { return p >= 90 ? "muy por encima de lo habitual" : p >= 80 ? "por encima de lo habitual" : p <= 10 ? "muy por debajo de lo habitual" : p <= 20 ? "por debajo de lo habitual" : "dentro de lo habitual"; }
function levelWord(p) { return p >= 90 ? "Mucho más de lo habitual" : p >= 80 ? "Más de lo habitual" : p <= 10 ? "Mucho menos de lo habitual" : p <= 20 ? "Menos de lo habitual" : "Normal"; }
function arrow(p) { return p >= 90 ? "▲▲" : p >= 80 ? "▲" : p <= 10 ? "▼▼" : p <= 20 ? "▼" : "●"; }
function yearsTxt(hist, v) {
  const n = hist.length; if (!n) return "";
  const lt = hist.filter((h) => h < v).length, gt = hist.filter((h) => h > v).length;
  if (lt === n) return `el valor más alto de los ${n} años anteriores`;
  if (gt === n) return `el valor más bajo de los ${n} años anteriores`;
  if (lt === 0) return gt === 0 ? `igual que los ${n} años anteriores` : `menos que en ${gt} de ${n} años`;
  return `más que en ${lt} de ${n} años`;
}
function diffTxt(v, med) {
  if (!(med > 0)) return v > 0 ? "cuando normalmente apenas hay" : "como es habitual";
  const r = (v - med) / med;
  if (Math.abs(r) < 0.1) return "parecido a un año normal";
  return r > 0 ? (r >= 1 ? `${nf1.format(1 + r)} veces lo normal` : `un ${Math.round(r * 100)} % más que un año normal`) : `un ${Math.round(-r * 100)} % menos que un año normal`;
}

// ---------- carga ----------
async function load() {
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const [meta, paises, series, parcial, diario, rejilla, incendios, fac, val, fijas] = await Promise.all([
    j("data/meta.json"), j("data/paises.geojson"), j("data/series.json"), j("data/parcial.json"), j("data/diario.json"),
    j("data/rejilla.json"), j("data/incendios.json"), j("data/factores.json"), j("data/validacion.json"),
    j("data/fuentes_fijas.geojson").catch(() => ({ features: [] }))]);
  Object.assign(D, { meta, paises, series, parcial, diario, rejilla, incendios, fac, val, fijas });
  try { const r = await fetch("data/reportado.csv"); if (r.ok) D.reportado = parseCSV(await r.text()); } catch (e) { /* opcional */ }
  K0 = meta.k0; NK = meta.nk;
  LAST = new Date(meta.ultimo_dato + "T00:00:00Z");
  CY = LAST.getUTCFullYear(); CM = LAST.getUTCMonth() + 1; DD = LAST.getUTCDate();
  const nx = new Date(LAST); nx.setUTCDate(nx.getUTCDate() + 1); PARTIAL = nx.getUTCDate() !== 1;
  meta.paises.forEach((p) => (COUNTRY_NAME[p.iso] = p.nombre));
  // Totales de Europa
  EU = {}; for (const key of ["h", "lo", "hi", "naive", "modis", "viirs"]) { EU[key] = new Float64Array(NK); for (const iso in series) series[iso][key].forEach((v, i) => (EU[key][i] += v)); }
  // Rejilla agrupada por celda
  const R = rejilla; GRID_BY_CELL = R.celdas.map(() => []);
  for (let t = 0; t < R.c.length; t++) GRID_BY_CELL[R.c[t]].push(t);
  S.yA = yOf(0); S.yB = CY;
}
const validMonth = (i) => i >= 0 && i < NK && !!D.fac.choice[`${yOf(i)}-${String(mOf(i)).padStart(2, "0")}`];
const monthSource = (i) => D.fac.choice[`${yOf(i)}-${String(mOf(i)).padStart(2, "0")}`];

// ---------- zona elegida ----------
function zoneLabel() { return S.zone === "EU" ? "Europa" : S.zone === "draw" ? "la zona dibujada" : S.zone === "circle" ? `un radio de ${S.circle ? S.circle.km : "?"} km` : COUNTRY_NAME[S.zone]; }
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
  // Línea base por mes del año: meses completos (sin el mes en curso a medias ni el año 2000)
  const lastFull = PARTIAL ? NK - 2 : NK - 1;
  BASE = [];
  for (let m = 1; m <= 12; m++) {
    const vals = [], nv = [];
    for (let y = 2001; y <= CY; y++) { const i = iOf(y, m); if (validMonth(i) && i <= lastFull) { vals.push(Z.h[i]); if (Z.raw) nv.push(Z.naive[i]); } }
    BASE.push({ vals, med: median(vals), p10: quantile(vals, 0.1), p90: quantile(vals, 0.9), naiveVals: nv, naiveMed: median(nv) });
  }
}

// ---------- cifras clave ----------
function computeKPIs() {
  const years = D.parcial.anios, box = [];
  const histYears = years.filter((y) => y >= 2001 && y < CY);
  // Este mes (días 1..DD) frente a los mismos días de otros años
  const hist = histYears.map((y) => Z.partial[y] || 0), cur = Z.partial[CY] || 0;
  box.push({ id: "mes", n: cur, med: median(hist), p: pctRank(hist, cur), hist, lab: PARTIAL ? `Este mes, del 1 al ${DD} de ${MESES_L[CM - 1]}` : `${MESES_L[CM - 1]} de ${CY}` });
  // Año hasta la fecha
  const ytd = (y) => { let s = 0; for (let m = 1; m < CM; m++) { const i = iOf(y, m); if (i >= 0) s += Z.h[i]; } return s + (Z.partial[y] || 0); };
  const yh = histYears.filter((y) => y >= 2001 && iOf(y, 1) >= 0).map(ytd), yc = ytd(CY);
  box.push({ id: "anio", n: yc, med: median(yh), p: pctRank(yh, yc), hist: yh, lab: `En lo que va de ${CY}` });
  // Último mes completo
  const iF = PARTIAL ? NK - 2 : NK - 1, mF = mOf(iF), bF = BASE[mF - 1];
  box.push({ id: "ultimo", n: Z.h[iF], med: bF.med, p: pctRank(bF.vals, Z.h[iF]), hist: bF.vals, mes: `${MESES_L[mF - 1]} de ${yOf(iF)}`, lab: `El mes pasado, ${MESES_L[mF - 1]}` });
  const order = BASE.map((b, i) => [b.med, i]).sort((a, b) => b[0] - a[0]);
  const annual = {}; for (let y = 2001; y < CY; y++) { let s = 0; for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i >= 0) s += Z.h[i]; } annual[y] = s; }
  const rec = Object.entries(annual).sort((a, b) => b[1] - a[1])[0];
  REC = { order: order.map((o) => o[1]), rec };
  KPI = box;
}
function renderKPIs() {
  const figs = KPI.map((b) => `<div class="fig"><div class="lab">${b.lab}</div><div class="val">${fmt(b.n)} <small>focos</small></div>` +
    `<div class="lvl ${level(b.p)}">${arrow(b.p)} ${levelWord(b.p)}</div><div class="det">Lo habitual: ${fmt(b.med)}. ${yearsTxt(b.hist, b.n)[0].toUpperCase() + yearsTxt(b.hist, b.n).slice(1)}.</div></div>`);
  figs.push(`<div class="fig"><div class="lab">Cuándo se quema más aquí</div><div class="val" style="font-size:28px">${MESES_L[REC.order[0]]} y ${MESES_L[REC.order[1]]}</div>` +
    `<div class="det">El año con más fuego fue ${REC.rec ? REC.rec[0] : "–"}, con ${REC.rec ? fmt(REC.rec[1]) : "–"} focos.</div></div>`);
  $("kpis").innerHTML = figs.join("");
}

// ---------- calendario ----------
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
  svgEl("text", { x: lab + 12 * cw + 6 + totW / 2, y: 14, "text-anchor": "middle", fill: COL.muted, "font-size": 12 }, svg).textContent = "año";
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
        `<b>${MESES_L[m - 1]} de ${y}</b>${isPartial ? " (mes en curso)" : ""}<br><b>${fmt(v)}</b> focos de calor${S.mode === "raw" ? " sin corregir" : ""}` +
        (S.mode !== "raw" && src !== "SNPP" && Z.lo !== Z.h ? ` (entre ${fmt(Z.lo[i])} y ${fmt(Z.hi[i])})` : "") +
        `<br>Lo habitual en ${MESES_L[m - 1]}: ${fmt(med)}<br>${arrow(pr)} ${levelWord(pr)}: ${yearsTxt(histM, v)}` +
        `<br><span style="opacity:.7">Satélite: ${src === "MODIS" || src === "Terra" ? "MODIS, corregido" : "VIIRS " + src}. Pulsa para verlo en el mapa.</span>`));
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
  const T = { count: "¿Cuántos focos hubo cada mes?", anom: "¿Fue cada mes más o menos de lo habitual?", raw: "Sin corregir: mezclando los satélites tal cual" };
  const H = { count: `Cada fila es un año y cada casilla un mes de ${zoneLabel()}. Cuanto más brillante, más fuego. Pasa por una casilla para ver el detalle o púlsala para verla en el mapa.`,
    anom: "Rojo: ese mes hubo más fuego de lo habitual para esa época del año. Azul: menos. El número dice cuánto.",
    raw: "Fíjate en 2012: parece que de golpe hay mucho más fuego, pero solo empezó a funcionar un satélite que ve más. Por eso corregimos los datos." };
  $("calTitle").textContent = T[S.mode]; $("calHow").textContent = H[S.mode] + (zoneIsCustom() ? ` Calculado con las ${Z.ncells} celdas de ~50 km de la zona.` : "");
  $("calLegend").innerHTML = S.mode === "anom"
    ? `<span>Menos de lo habitual</span><div class="ramp" style="background:linear-gradient(90deg,${DIVERG.join(",")})"></div><span>Más</span>`
    : `<span>Poco fuego</span><div class="ramp" style="background:linear-gradient(90deg,${THERMAL.slice(1).join(",")})"></div><span>Mucho</span>`;
}

// ---------- gráficos ----------
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
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${MESES_L[i]}</b><br>${CY}: ${fmt(v)} focos${i === CM - 1 && PARTIAL ? " (mes a medias)" : ""}<br>Año normal: ${fmt(b.med)}<br>8 de cada 10 años: entre ${fmt(b.p10)} y ${fmt(b.p90)}`));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, [[COL.corr, String(CY)], [COL.normal, "un año normal"]], w - 150, 22);
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
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${s.y}</b><br>Corregido: ${fmt(s.H)} focos${s.hi > s.lo ? ` (entre ${fmt(s.lo)} y ${fmt(s.hi)})` : ""}` + (Z.raw ? `<br>Sin corregir: ${fmt(s.nv)}<br>Solo MODIS: ${fmt(s.mo)} · solo VIIRS: ${fmt(s.vi)}` : "")));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, Z.raw ? [[COL.corr, "corregido"], [COL.raw, "sin corregir", "6,4"], [COL.modis, "solo MODIS"], [COL.viirs, "solo VIIRS"]] : [[COL.corr, "corregido"]], pad.l + 10, 22);
}
function renderValidation() {
  const v = D.val.resumen, o = D.fac.overlap, eu = D.val.europa;
  const iso = !zoneIsCustom() && S.zone !== "EU" ? S.zone : null;
  const rows = (iso ? D.val.paises[iso] || [] : eu).map((r) => `<tr><td>${r.year}</td><td>${fmt(r.observado)}</td><td>${fmt(iso ? r.pred_pais : r.pred_europeo)}</td><td>${fmt(r.modis)}</td></tr>`).join("");
  const f = iso ? D.fac.r[iso] : D.fac.eu;
  $("validation").innerHTML =
    `<p>Prueba: entre ${o[0]} y ${o[1]} funcionan los dos satélites. Escondemos un año, usamos solo MODIS para estimar lo que vio VIIRS y lo comparamos con la realidad.</p>` +
    `<p>En los países, sin corregir nos equivocamos un <b>${fmt(v.paises.sin_corregir)} %</b>; con un factor común para Europa, un <b>${fmt1(v.paises.factor_europeo)} %</b>; con un factor propio de cada país, solo un <b>${fmt1(v.paises.factor_por_pais)} %</b> (error mediano del total anual).</p>` +
    `<p class="note">${iso ? `${COUNTRY_NAME[iso]}: VIIRS ve ${fmt1(f.est)} focos por cada uno de MODIS (entre ${fmt1(f.lo)} y ${fmt1(f.hi)})${f.fuente === "europeo" ? ", factor europeo por falta de datos propios" : ""}.` : `Europa: VIIRS ve ${fmt1(f.est)} focos por cada uno de MODIS (entre ${fmt1(f.lo)} y ${fmt1(f.hi)}).`}</p>` +
    `<div class="table-wrap" style="max-height:260px"><table class="t"><caption class="sr">Validación por años</caption><tr><th scope="col">Año</th><th scope="col">Visto por VIIRS</th><th scope="col">Estimado con MODIS</th><th scope="col">MODIS sin corregir</th></tr>${rows}</table></div>`;
}
function spearman(a, b) { const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = new Array(v.length); o.forEach(([, i], j) => (r[i] = j + 1)); return r; }; return pearson(rk(a), rk(b)); }
function pearson(a, b) { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); }
const REP_LABEL = { hectareas_gwis: "área quemada (GWIS, Copernicus)", hectareas_oficiales: "área quemada oficial", incendios: "número de incendios oficial" };
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
    hit.addEventListener("mousemove", (ev) => showTip(ev, `<b>${y}</b><br>Focos de calor: ${fmt(det[i])}<br>${REP_LABEL[metric]}: ${fmt(rep[i])}`));
    hit.addEventListener("mouseleave", hideTip);
  });
  legend(svg, [[COL.corr, "focos de calor (corregidos)"], [COL.modis, REP_LABEL[metric], "6,4"]], pad.l + 10, 22);
  const sp = spearman(det, rep), word = sp >= 0.7 ? "muy parecidas" : sp >= 0.5 ? "bastante parecidas" : sp >= 0.3 ? "algo parecidas" : "poco parecidas";
  $("reportedNote").innerHTML = `${zoneLabel()}, ${ys[0]}–${ys[ys.length - 1]}: las dos series son <b>${word}</b> (coeficiente de Spearman ${nf1.format(Math.round(sp * 100) / 100)}; 1 significa que suben y bajan exactamente a la vez). ` +
    `No tienen por qué coincidir del todo: un incendio grande quema mucho con relativamente pocos focos, y muchas quemas agrícolas pequeñas dan muchos focos y poca superficie.`;
}

// ---------- descargas ----------
const slug = () => (zoneIsCustom() ? "zona" : S.zone === "EU" ? "europa" : COUNTRY_NAME[S.zone]).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
function csvCalendar() {
  const out = ["anio,mes,focos_corregidos,minimo_90,maximo_90,habitual_mes,diferencia_pct,sin_corregir,modis,viirs_snpp,satelite_del_mes,mes_incompleto"];
  for (let i = 0; i < NK; i++) {
    const y = yOf(i), m = mOf(i); if (y < S.yA || y > S.yB || !validMonth(i)) continue;
    const b = BASE[m - 1], v = Z.h[i];
    out.push([y, m, v.toFixed(1), Z.lo[i].toFixed(1), Z.hi[i].toFixed(1), (b.med || 0).toFixed(1), b.med > 0 ? (100 * (v - b.med) / b.med).toFixed(0) : "",
      Z.raw ? Z.naive[i] : "", Z.raw ? Z.modis[i] : "", Z.raw ? Z.viirs[i] : "", monthSource(i), i === NK - 1 && PARTIAL ? 1 : 0].join(","));
  }
  download(`calendario_${slug()}.csv`, out.join("\n"));
}
async function csvPoints() {
  const months = D.meta.recientes.filter((n) => +n.slice(0, 4) >= S.yA && +n.slice(0, 4) <= S.yB);
  const out = ["fecha,latitud,longitud,pais,satelite,instrumento,frp_mw,peso_correccion"];
  for (const n of months) {
    const p = await loadMonth(n);
    for (let t = 0; t < p.x.length; t++) {
      const lon = p.x[t] / 1000, lat = p.y[t] / 1000;
      if (!zoneIsCustom() && S.zone !== "EU" && p.p[t] !== S.zone) continue;
      if (zoneIsCustom() && !inZonePoint(lon, lat)) continue;
      out.push([new Date(DAY0 + p.d[t] * 864e5).toISOString().slice(0, 10), lat.toFixed(3), lon.toFixed(3), p.p[t], SATS[p.s[t]], INSTR[p.s[t]], (p.f[t] / 10).toFixed(1), p.w[t]].join(","));
    }
  }
  download(`focos_${slug()}.csv`, out.join("\n"));
}
const MONTH_CACHE = {};
function loadMonth(name) { if (!MONTH_CACHE[name]) MONTH_CACHE[name] = fetch(`data/focos/${name}.json`).then((r) => r.json()); return MONTH_CACHE[name]; }

// ---------- actualización ----------
function update(fit = false) {
  computeZone(); computeKPIs();
  renderKPIs(); renderCalendar(); renderClim(); renderAnnual(); renderValidation(); renderReported();
  if (typeof renderMapLayer === "function") renderMapLayer(fit);
  if (typeof renderExtras === "function") renderExtras();
  if (typeof renderHero === "function") renderHero();
}
async function main() {
  try { await load(); }
  catch (e) { $("kicker").textContent = "No se pudieron cargar los datos (" + e.message + "). Abre la web con un servidor (python -m http.server) y comprueba que existe la carpeta web/data."; return; }
  if (D.meta.sinteticos) $("synthetic").hidden = false;
  $("ovl").textContent = `${D.fac.overlap[0]}–${D.fac.overlap[1]}`;
  $("nstatic").textContent = fmt(D.fijas.features.length);
  initMap(); initExtras(); initUI();
  update(true);
}
main();
