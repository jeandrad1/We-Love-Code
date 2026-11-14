/* Calendario de quemas de Andalucía — todo se calcula en el navegador a partir de web/data/. */
"use strict";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_L = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const SATS = ["Terra", "Aqua", "S-NPP", "NOAA-20", "NOAA-21"];
const INSTR = ["MODIS", "MODIS", "VIIRS", "VIIRS", "VIIRS"];
const CAT_NAMES = ["no cuenta (otro sensor manda ese mes)", "referencia VIIRS S-NPP", "MODIS×r", "Terra×a×r", "NOAA-20×k", "NOAA-21×k"];
const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const DAY0 = Date.UTC(2000, 0, 1);

// Rampas accesibles (perceptualmente uniformes y aptas para daltonismo)
const INFERNO_R = ["#fcffa4", "#f7d13d", "#fb9b06", "#ed6925", "#cf4446", "#a52c60", "#781c6d", "#4a0c6b", "#1b0c41"];
const RDBU = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"];

const S = { aoi: "all", aoiGeom: null, circle: null, mode: "count" };
let P, N, Y, M, DD, K, W, F, META, VAL, PROV, STATIC, REPORTED = null;
let K0, KL, LAST, NK, SEL, AGG, BASE, map, aoiLayer, ptsLayer, drawn, osm, gibs, KPI = [], REC = null;

// ---------- utilidades ----------
const $ = (id) => document.getElementById(id);
const kOf = (y, m) => (y - 2000) * 12 + (m - 1);
const yOf = (k) => 2000 + Math.floor(k / 12);
const mOf = (k) => (k % 12) + 1;
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
function fmt(v) { return Number.isFinite(v) ? nf.format(v) : "–"; }
function download(name, text, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const tip = $("tip");
function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; const x = Math.min(ev.clientX + 14, innerWidth - 280); tip.style.left = x + "px"; tip.style.top = (ev.clientY + 14) + "px"; }
function hideTip() { tip.hidden = true; }

// ---------- geometría ----------
function inRing(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function inPoly(x, y, poly) { if (!inRing(x, y, poly[0])) return false; for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false; return true; }
function inGeom(x, y, g) { return g.type === "Polygon" ? inPoly(x, y, g.coordinates) : g.coordinates.some((p) => inPoly(x, y, p)); }
function bbox(g) {
  let a = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)]; }
  return a;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// ---------- carga ----------
async function load() {
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const [pts, fac, meta, val, prov, stat] = await Promise.all([
    j("data/points.json"), j("data/factors.json"), j("data/meta.json"), j("data/validation.json"),
    j("data/provincias.geojson"), j("data/static_sources.geojson").catch(() => ({ features: [] }))]);
  try { const r = await fetch("data/reported.csv"); if (r.ok) REPORTED = parseCSV(await r.text()); } catch (e) { /* opcional */ }
  F = fac; META = meta; VAL = val; PROV = prov; STATIC = stat;
  N = pts.x.length;
  P = { x: Int32Array.from(pts.x), y: Int32Array.from(pts.y), d: Int32Array.from(pts.d), t: Int16Array.from(pts.t),
        s: Int8Array.from(pts.s), c: Int8Array.from(pts.c), f: Int32Array.from(pts.f) };
  Y = new Int16Array(N); M = new Int8Array(N); DD = new Int8Array(N); K = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const dt = new Date(DAY0 + P.d[i] * 864e5);
    Y[i] = dt.getUTCFullYear(); M[i] = dt.getUTCMonth() + 1; DD[i] = dt.getUTCDate(); K[i] = kOf(Y[i], M[i]);
  }
  // Tabla de pesos por categoría y mes: est / lo / hi
  const f = F.factors, w = (key) => {
    const t = new Float64Array(6 * 12);
    for (let m = 0; m < 12; m++) {
      t[12 + m] = 1;
      t[24 + m] = f.r[key][m];
      t[36 + m] = (f.a ? f.a.est[m] : 1) * f.r[key][m];
      t[48 + m] = f.k20 ? f.k20[key][m] : 0;
      t[60 + m] = f.k21 ? f.k21[key][m] : 0;
    }
    return t;
  };
  W = { est: w("est"), lo: w("lo"), hi: w("hi") };
  const keys = Object.keys(F.choice).filter((k) => F.choice[k]).sort();
  const [y0, m0] = keys[0].split("-").map(Number);
  K0 = kOf(y0, m0);
  LAST = new Date(META.ultimo_dato + "T00:00:00Z");
  KL = kOf(LAST.getUTCFullYear(), LAST.getUTCMonth() + 1);
  NK = KL + 1;
}
function parseCSV(t) {
  const [h, ...rows] = t.trim().split(/\r?\n/);
  const cols = h.split(",").map((c) => c.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v.trim()])));
}

// ---------- selección y agregación ----------
const lastMonthPartial = () => { const d = new Date(LAST); d.setUTCDate(d.getUTCDate() + 1); return d.getUTCDate() !== 1; };
const validMonth = (k) => k >= K0 && k <= KL && !!F.choice[`${yOf(k)}-${String(mOf(k)).padStart(2, "0")}`];
function range() {
  const parse = (v, dflt) => { if (!v) return dflt; const [y, m] = v.split("-").map(Number); return kOf(y, m); };
  return [Math.max(K0, parse($("from").value, K0)), Math.min(KL, parse($("to").value, KL))];
}
function computeSelection() {
  SEL = new Uint8Array(N);
  if (S.aoi === "all") { SEL.fill(1); return; }
  if (S.aoi === "circle" && S.circle) {
    const { lat, lon, km } = S.circle;
    const dLat = km / 111, dLon = km / (111 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i < N; i++) {
      const x = P.x[i] / 1e4, y = P.y[i] / 1e4;
      if (Math.abs(y - lat) > dLat || Math.abs(x - lon) > dLon) continue;
      if (haversineKm(lat, lon, y, x) <= km) SEL[i] = 1;
    }
    return;
  }
  const g = S.aoiGeom;
  if (!g) return;
  const [a, b, c, d] = bbox(g);
  for (let i = 0; i < N; i++) {
    const x = P.x[i] / 1e4, y = P.y[i] / 1e4;
    if (x < a || x > c || y < b || y > d) continue;
    if (inGeom(x, y, g)) SEL[i] = 1;
  }
}
function aggregate() {
  const H = new Float64Array(NK), Lo = new Float64Array(NK), Hi = new Float64Array(NK);
  const raw = SATS.map(() => new Float64Array(NK));
  for (let i = 0; i < N; i++) {
    if (!SEL[i]) continue;
    const k = K[i], j = P.c[i] * 12 + M[i] - 1;
    H[k] += W.est[j]; Lo[k] += W.lo[j]; Hi[k] += W.hi[j];
    raw[P.s[i]][k]++;
  }
  // "Sin armonizar": el sensor disponible tal cual (MODIS Terra+Aqua hasta 2011, luego VIIRS)
  const naive = new Float64Array(NK);
  for (let k = K0; k <= KL; k++) {
    const src = F.choice[`${yOf(k)}-${String(mOf(k)).padStart(2, "0")}`];
    naive[k] = src === "SNPP" ? raw[2][k] : src === "NOAA20" ? raw[3][k] : src === "NOAA21" ? raw[4][k] : raw[0][k] + raw[1][k];
  }
  AGG = { H, Lo, Hi, raw, naive };
  // Línea base por mes del año: todos los meses completos y válidos (sin el mes en curso si está a medias)
  const lastFull = lastMonthPartial() ? KL - 1 : KL;
  BASE = [];
  for (let m = 1; m <= 12; m++) {
    const vals = [], naiveVals = [];
    for (let y = 2000; y <= yOf(KL); y++) { const k = kOf(y, m); if (validMonth(k) && k <= lastFull && !(y === 2000)) { vals.push(H[k]); naiveVals.push(naive[k]); } }
    BASE.push({ vals, med: median(vals), p10: quantile(vals, 0.1), p90: quantile(vals, 0.9), naiveMed: median(naiveVals), naiveVals });
  }
}
// Recuento armonizado de los días 1..dd de un mes, por año (para comparar el mes en curso de forma justa)
function partialByYear(m, dd) {
  const out = {};
  for (let i = 0; i < N; i++) {
    if (!SEL[i] || M[i] !== m || DD[i] > dd) continue;
    out[Y[i]] = (out[Y[i]] || 0) + W.est[P.c[i] * 12 + m - 1];
  }
  return out;
}

// ---------- KPI ----------
function level(p) { return p >= 80 ? "alto" : p <= 20 ? "bajo" : "normal"; }
function levelTxt(p) { return p >= 90 ? "muy por encima de lo normal" : p >= 80 ? "por encima de lo normal" : p <= 10 ? "muy por debajo de lo normal" : p <= 20 ? "por debajo de lo normal" : "dentro de lo normal"; }
function renderKPIs() {
  const cy = yOf(KL), cm = mOf(KL), dd = LAST.getUTCDate(), partial = lastMonthPartial();
  const box = [];
  // 1. Mes en curso (días 1..dd frente a los mismos días de otros años)
  const pb = partialByYear(cm, dd);
  const hist = []; for (let y = 2001; y < cy; y++) if (validMonth(kOf(y, cm))) hist.push(pb[y] || 0);
  const cur = pb[cy] || 0, med = median(hist), p = pctRank(hist, cur);
  box.push({ id: "mes", n: cur, med, lab: `${MESES_L[cm - 1]} ${cy}${partial ? ` (1–${dd})` : ""}`, val: fmt(cur), p,
    det: `mediana ${fmt(med)} · percentil ${fmt(p)}: ${levelTxt(p)}` });
  // 2. Último mes completo
  const kf = partial ? KL - 1 : KL - 0, mf = mOf(kf), vf = AGG.H[kf], bf = BASE[mf - 1];
  const pf = pctRank(bf.vals, vf);
  box.push({ id: "ultimo", n: vf, med: bf.med, mes: `${MESES_L[mf - 1]} de ${yOf(kf)}`, lab: `Último mes completo: ${MESES_L[mf - 1]} ${yOf(kf)}`, val: fmt(vf), p: pf,
    det: `mediana ${fmt(bf.med)} · percentil ${fmt(pf)}: ${levelTxt(pf)}` });
  // 3. Año hasta la fecha
  const ytd = {};
  for (let y = 2001; y <= cy; y++) { let s = 0; for (let m = 1; m < cm; m++) s += AGG.H[kOf(y, m)]; ytd[y] = s + (pb[y] || 0); }
  const yh = Object.entries(ytd).filter(([y]) => +y < cy && validMonth(kOf(+y, 1))).map(([, v]) => v);
  const py = pctRank(yh, ytd[cy]);
  box.push({ id: "anio", n: ytd[cy], med: median(yh), lab: `${cy} hasta el ${dd} de ${MESES_L[cm - 1]}`, val: fmt(ytd[cy]), p: py,
    det: `mediana ${fmt(median(yh))} · percentil ${fmt(py)}: ${levelTxt(py)}` });
  // 4. Patrón
  const order = BASE.map((b, i) => [b.med, i]).sort((a, b) => b[0] - a[0]);
  const annual = {}; for (let y = 2001; y < cy; y++) { let s = 0; for (let m = 1; m <= 12; m++) s += AGG.H[kOf(y, m)]; annual[y] = s; }
  const rec = Object.entries(annual).sort((a, b) => b[1] - a[1])[0];
  REC = { order: order.map((o) => o[1]), rec };
  box.push({ id: "patron", lab: "Patrón de la zona", val: `${MESES[order[0][1]]} · ${MESES[order[1][1]]}`, p: 50,
    det: `meses con más actividad típica · año récord: ${rec ? rec[0] : "–"} (${rec ? fmt(rec[1]) : "–"})`, neutral: true });
  KPI = box;
  $("kpis").innerHTML = box.map((b) => `<div class="kpi ${b.neutral ? "" : level(b.p)}"><div class="lab">${b.lab}</div><div class="val">${b.val}</div><div class="det">${b.det}</div></div>`).join("");
}

// ---------- calendario ----------
function cellValue(k) { return S.mode === "raw" ? AGG.naive[k] : AGG.H[k]; }
function renderCalendar() {
  const [kA, kB] = range(), yA = yOf(kA), yB = yOf(kB);
  const host = $("cal"); host.innerHTML = "";
  const width = Math.max(720, host.clientWidth), lab = 44, totW = 70, cw = (width - lab - totW - 10) / 12, ch = 19, top = 18;
  const years = []; for (let y = yB; y >= yA; y--) years.push(y);
  const svg = svgEl("svg", { width, height: top + years.length * ch + 4, xmlns: "http://www.w3.org/2000/svg", "font-family": "system-ui, sans-serif" }, host);
  MESES.forEach((m, i) => svgEl("text", { x: lab + i * cw + cw / 2, y: 12, "text-anchor": "middle", fill: "#6b665e" }, svg).textContent = m);
  svgEl("text", { x: lab + 12 * cw + 6 + totW / 2, y: 12, "text-anchor": "middle", fill: "#6b665e" }, svg).textContent = "año";
  const inView = []; for (let k = kA; k <= kB; k++) if (validMonth(k)) inView.push(cellValue(k));
  const vmax = Math.max(1, quantile(inView, 0.98));
  const annual = years.map((y) => { let s = 0, n = 0; for (let m = 1; m <= 12; m++) { const k = kOf(y, m); if (validMonth(k)) { s += cellValue(k); n++; } } return { y, s, n }; });
  const fullAnn = annual.filter((a) => a.n === 12).map((a) => a.s), annMed = median(fullAnn), annMax = Math.max(1, ...annual.map((a) => a.s));
  const showNums = $("nums").checked, partial = lastMonthPartial();
  years.forEach((y, r) => {
    const yy = top + r * ch;
    svgEl("text", { x: lab - 6, y: yy + ch * 0.7, "text-anchor": "end", fill: "#3d3a35", "font-weight": y === 2012 ? 700 : 400 }, svg).textContent = y;
    for (let m = 1; m <= 12; m++) {
      const k = kOf(y, m), x = lab + (m - 1) * cw;
      if (!validMonth(k) || k < kA || k > kB) { svgEl("rect", { x: x + 1, y: yy + 1, width: cw - 2, height: ch - 2, fill: "#f1eee9", rx: 2 }, svg); continue; }
      const v = cellValue(k), b = BASE[m - 1], med = S.mode === "raw" ? b.naiveMed : b.med;
      let fill, txt, dark;
      if (S.mode === "anom") {
        const t = Math.log2((v + 1) / (med + 1)) / 2;
        fill = ramp(RDBU, (t + 1) / 2); dark = Math.abs(t) > 0.6;
        if (med >= 5) { const pc = Math.round(100 * (v - med) / med); txt = (pc > 0 ? "+" : "") + pc + "%"; }
        else { const df = Math.round(v - med); txt = (df > 0 ? "+" : "") + df; }  // mediana casi 0: diferencia absoluta
      } else {
        const t = Math.log1p(v) / Math.log1p(vmax);
        fill = v === 0 ? "#fbfaf7" : ramp(INFERNO_R, t); dark = t > 0.55; txt = fmt(v);
      }
      const isPartial = partial && k === KL;
      const rect = svgEl("rect", { x: x + 1, y: yy + 1, width: cw - 2, height: ch - 2, fill, rx: 2,
        stroke: isPartial ? "#1f1d1a" : "none", "stroke-dasharray": isPartial ? "3,2" : "" }, svg);
      if (showNums && cw > 34) svgEl("text", { x: x + cw / 2, y: yy + ch * 0.68, "text-anchor": "middle", fill: dark ? "#fff" : "#1f1d1a", "font-size": 10 }, svg).textContent = txt;
      const src = F.choice[`${y}-${String(m).padStart(2, "0")}`];
      const pr = pctRank(S.mode === "raw" ? b.naiveVals : b.vals, v);
      rect.addEventListener("mousemove", (ev) => showTip(ev,
        `<b>${MESES_L[m - 1]} ${y}</b>${isPartial ? " (mes en curso)" : ""}<br>` +
        `${S.mode === "raw" ? "Sin armonizar" : "Armonizado"}: <b>${fmt(v)}</b> puntos` +
        (S.mode !== "raw" && src !== "SNPP" ? ` (IC90 ${fmt(AGG.Lo[k])}–${fmt(AGG.Hi[k])})` : "") +
        `<br>Mediana de ${MESES_L[m - 1]}: ${fmt(med)} · percentil ${fmt(pr)}<br>` +
        `Fuente del mes: ${src === "MODIS" ? "MODIS Terra+Aqua" : src}<br>` +
        `Bruto → MODIS ${fmt(AGG.raw[0][k] + AGG.raw[1][k])} · S-NPP ${fmt(AGG.raw[2][k])} · NOAA-20 ${fmt(AGG.raw[3][k])}`));
      rect.addEventListener("mouseleave", hideTip);
      rect.addEventListener("click", () => focusMonth(y, m));
    }
    const a = annual[r], x = lab + 12 * cw + 6;
    if (a.n) {
      const fill = S.mode === "anom" ? ramp(RDBU, (Math.log2((a.s + 1) / (annMed + 1)) / 2 + 1) / 2) : ramp(INFERNO_R, Math.log1p(a.s) / Math.log1p(annMax) * 0.85);
      svgEl("rect", { x, y: yy + 1, width: totW, height: ch - 2, fill, rx: 2 }, svg);
      const dark = S.mode !== "anom" && Math.log1p(a.s) / Math.log1p(annMax) * 0.85 > 0.55;
      svgEl("text", { x: x + totW / 2, y: yy + ch * 0.68, "text-anchor": "middle", "font-size": 10, fill: dark ? "#fff" : "#1f1d1a" }, svg).textContent = fmt(a.s) + (a.n < 12 ? "*" : "");
    }
  });
  if (S.mode === "raw" && 2012 >= yA && 2012 <= yB) {
    const r = yB - 2012, yy = top + r * ch;
    svgEl("rect", { x: lab - 2, y: yy, width: 12 * cw + 4, height: ch, fill: "none", stroke: "#1f1d1a", "stroke-width": 1.5 }, svg);
  }
  const titles = { count: "Calendario de actividad: puntos calientes armonizados por mes",
    anom: "Anomalía: diferencia frente a la mediana de ese mes", raw: "Sin armonizar: cada mes con el sensor disponible tal cual (fíjate en 2012)" };
  $("calTitle").textContent = titles[S.mode];
  const stops = S.mode === "anom" ? RDBU : INFERNO_R;
  $("calLegend").innerHTML = S.mode === "anom"
    ? `<span>¼ de lo normal</span><div class="ramp" style="background:linear-gradient(90deg,${stops.join(",")})"></div><span>4× lo normal</span>`
    : `<span>0</span><div class="ramp" style="background:linear-gradient(90deg,${stops.join(",")})"></div><span>${fmt(vmax)}+ (escala log)</span>`;
  $("calLegend").innerHTML += `<span style="margin-left:12px">borde discontinuo = mes en curso · * = año incompleto</span>`;
}

// ---------- gráficos ----------
function axes(svg, w, h, pad, xs, ys, xTicks, yMax) {
  for (let i = 0; i <= 4; i++) {
    const v = yMax * i / 4, y = ys(v);
    svgEl("line", { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: "#eee9e1" }, svg);
    svgEl("text", { x: pad.l - 5, y: y + 4, "text-anchor": "end", "font-size": 10, fill: "#6b665e" }, svg).textContent = fmt(v);
  }
  xTicks.forEach(([v, l]) => svgEl("text", { x: xs(v), y: h - 6, "text-anchor": "middle", "font-size": 10, fill: "#6b665e" }, svg).textContent = l);
}
function path(pts) { return pts.filter((p) => Number.isFinite(p[1])).map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(""); }
function legend(svg, items, x, y) {
  items.forEach(([c, l, dash], i) => {
    svgEl("line", { x1: x, x2: x + 18, y1: y + i * 15, y2: y + i * 15, stroke: c, "stroke-width": 2.5, "stroke-dasharray": dash || "" }, svg);
    svgEl("text", { x: x + 23, y: y + i * 15 + 4, "font-size": 11, fill: "#3d3a35" }, svg).textContent = l;
  });
}
function renderClim() {
  const svg = $("clim"); svg.innerHTML = "";
  const w = svg.clientWidth || 500, h = 250, pad = { l: 44, r: 10, t: 10, b: 22 };
  const cy = yOf(KL), cur = []; for (let m = 1; m <= 12; m++) { const k = kOf(cy, m); cur.push(k <= KL ? AGG.H[k] : NaN); }
  const yMax = Math.max(1, ...BASE.map((b) => b.p90), ...cur.filter(Number.isFinite)) * 1.08;
  const xs = (m) => pad.l + (m - 0.5) * (w - pad.l - pad.r) / 12, ys = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  axes(svg, w, h, pad, xs, ys, MESES.map((l, i) => [i + 1, l]), yMax);
  const band = BASE.map((b, i) => [xs(i + 1), ys(b.p90)]).concat(BASE.map((b, i) => [xs(i + 1), ys(b.p10)]).reverse());
  svgEl("path", { d: path(band) + "Z", fill: "#fbd5b5", opacity: 0.7 }, svg);
  svgEl("path", { d: path(BASE.map((b, i) => [xs(i + 1), ys(b.med)])), fill: "none", stroke: "#9a3412", "stroke-width": 2 }, svg);
  svgEl("path", { d: path(cur.map((v, i) => [xs(i + 1), ys(v)])), fill: "none", stroke: "#1f1d1a", "stroke-width": 2.5 }, svg);
  cur.forEach((v, i) => Number.isFinite(v) && svgEl("circle", { cx: xs(i + 1), cy: ys(v), r: 3, fill: "#1f1d1a" }, svg));
  legend(svg, [["#9a3412", "mediana histórica"], ["#fbd5b5", "p10–p90"], ["#1f1d1a", `${cy}${lastMonthPartial() ? " (último mes parcial)" : ""}`]], w - 190, 18);
}
function renderAnnual() {
  const svg = $("annual"); svg.innerHTML = "";
  const w = svg.clientWidth || 500, h = 250, pad = { l: 50, r: 10, t: 10, b: 22 };
  const [kA, kB] = range(), yA = Math.max(yOf(kA), 2001), yB = yOf(kB);
  const ser = []; for (let y = yA; y <= yB; y++) {
    let H = 0, lo = 0, hi = 0, nv = 0, mo = 0, vi = 0;
    for (let m = 1; m <= 12; m++) { const k = kOf(y, m); if (k > KL) continue; H += AGG.H[k]; lo += AGG.Lo[k]; hi += AGG.Hi[k]; nv += AGG.naive[k]; mo += AGG.raw[0][k] + AGG.raw[1][k]; vi += AGG.raw[2][k]; }
    ser.push({ y, H, lo, hi, nv, mo, vi: y >= 2012 ? vi : NaN });
  }
  if (ser.length < 2) return;
  const yMax = Math.max(1, ...ser.map((s) => Math.max(s.hi, s.nv, s.vi || 0))) * 1.08;
  const xs = (y) => pad.l + (y - yA) / Math.max(1, yB - yA) * (w - pad.l - pad.r), ys = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  const step = Math.ceil((yB - yA) / 8);
  axes(svg, w, h, pad, xs, ys, ser.filter((s) => (s.y - yA) % step === 0).map((s) => [s.y, s.y]), yMax);
  if (yA <= 2012 && yB >= 2012) svgEl("line", { x1: xs(2012), x2: xs(2012), y1: pad.t, y2: h - pad.b, stroke: "#a8a29e", "stroke-dasharray": "3,3" }, svg);
  const band = ser.map((s) => [xs(s.y), ys(s.hi)]).concat(ser.map((s) => [xs(s.y), ys(s.lo)]).reverse());
  svgEl("path", { d: path(band) + "Z", fill: "#fed7aa", opacity: 0.8 }, svg);
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.mo)])), fill: "none", stroke: "#0072B2", "stroke-width": 1.5 }, svg);
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.vi)])), fill: "none", stroke: "#D55E00", "stroke-width": 1.5 }, svg);
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.nv)])), fill: "none", stroke: "#78716c", "stroke-width": 2, "stroke-dasharray": "5,3" }, svg);
  svgEl("path", { d: path(ser.map((s) => [xs(s.y), ys(s.H)])), fill: "none", stroke: "#1f1d1a", "stroke-width": 2.5 }, svg);
  ser.forEach((s) => {
    const c = svgEl("circle", { cx: xs(s.y), cy: ys(s.H), r: 4, fill: "transparent" }, svg);
    c.addEventListener("mousemove", (ev) => showTip(ev, `<b>${s.y}</b><br>Armonizado: ${fmt(s.H)} (IC90 ${fmt(s.lo)}–${fmt(s.hi)})<br>Sin armonizar: ${fmt(s.nv)}<br>MODIS bruto: ${fmt(s.mo)} · S-NPP bruto: ${fmt(s.vi)}`));
    c.addEventListener("mouseleave", hideTip);
  });
  legend(svg, [["#1f1d1a", "armonizado (equiv. VIIRS)"], ["#78716c", "sin armonizar", "5,3"], ["#0072B2", "MODIS bruto"], ["#D55E00", "VIIRS S-NPP bruto"]], pad.l + 8, 18);
}
function renderValidation() {
  const v = VAL.resumen_loyo, o = F.overlap;
  if (!v || v.err_anual_mediano_pct_mensual === undefined) { $("validation").innerHTML = "<p>Sin datos de validación.</p>"; return; }
  const rows = VAL.loyo.map((r) => `<tr><td>${r.year}</td><td>${fmt(r.observado)}</td><td>${fmt(r.pred_mensual)}</td><td>${fmt(r.modis_bruto)}</td></tr>`).join("");
  const fo = VAL.resumen_fuera_ventana;
  $("validation").innerHTML =
    `<p class="big">Escondemos un año del solape ${o[0]}–${o[1]}, calibramos con el resto y predecimos cuántos puntos VIIRS habría habido a partir de MODIS. ` +
    `Error mediano del total anual: <b>${v.err_anual_mediano_pct_mensual.toFixed(1)} %</b> armonizado frente a <b>${v.err_anual_mediano_pct_sin_armonizar.toFixed(0)} %</b> sin armonizar` +
    ` (factor único sin estacionalidad: ${v.err_anual_mediano_pct_factor_unico.toFixed(1)} %).` +
    (fo && fo.err_anual_mediano_pct_mensual !== undefined ? ` Fuera de la ventana de calibración (${o[1] + 1}+): ${fo.err_anual_mediano_pct_mensual.toFixed(1)} %.` : "") +
    ` <small>Validación para toda Andalucía.</small></p>` +
    `<table class="val"><tr><th>Año</th><th>VIIRS observado</th><th>Predicho desde MODIS</th><th>MODIS sin armonizar</th></tr>${rows}</table>` +
    `<p class="note">Factor MODIS→VIIRS por mes: ${F.factors.r.est.map((x, i) => `${MESES[i]} ${x.toFixed(2)}`).join(" · ")}</p>`;
}
function renderReported() {
  const card = $("reportedCard");
  if (!REPORTED || S.aoi === "draw" || S.aoi === "circle") { card.hidden = true; return; }
  const provName = S.aoi === "prov" ? $("prov").value.toLowerCase() : null;
  const byYear = {};
  for (const r of REPORTED) {
    const p = (r.provincia || "").toLowerCase();
    if (provName && p !== provName) continue;
    if (!provName && p && p !== "andalucía" && p !== "andalucia" && REPORTED.some((x) => (x.provincia || "").toLowerCase().startsWith("andaluc"))) continue;
    byYear[r.year] = (byYear[r.year] || 0) + Number(r.incendios || 0);
  }
  const ys = Object.keys(byYear).map(Number).filter((y) => y >= 2001 && kOf(y, 12) <= KL).sort();
  if (ys.length < 3) { card.hidden = true; return; }
  card.hidden = false;
  const det = ys.map((y) => { let s = 0; for (let m = 1; m <= 12; m++) s += AGG.H[kOf(y, m)]; return s; }), rep = ys.map((y) => byYear[y]);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length, md = mean(det), mr = mean(rep);
  const cov = det.reduce((s, d, i) => s + (d - md) * (rep[i] - mr), 0), r = cov / Math.sqrt(det.reduce((s, d) => s + (d - md) ** 2, 0) * rep.reduce((s, d) => s + (d - mr) ** 2, 0));
  const svg = $("reported"); svg.innerHTML = "";
  const w = svg.clientWidth || 800, h = 250, pad = { l: 44, r: 10, t: 10, b: 22 };
  const di = det.map((d) => 100 * d / md), ri = rep.map((d) => 100 * d / mr), yMax = Math.max(...di, ...ri) * 1.1;
  const xs = (y) => pad.l + (y - ys[0]) / Math.max(1, ys[ys.length - 1] - ys[0]) * (w - pad.l - pad.r), yv = (v) => h - pad.b - v / yMax * (h - pad.t - pad.b);
  axes(svg, w, h, pad, xs, yv, ys.filter((_, i) => i % 2 === 0).map((y) => [y, y]), yMax);
  svgEl("path", { d: path(ys.map((y, i) => [xs(y), yv(di[i])])), fill: "none", stroke: "#1f1d1a", "stroke-width": 2.5 }, svg);
  svgEl("path", { d: path(ys.map((y, i) => [xs(y), yv(ri[i])])), fill: "none", stroke: "#0072B2", "stroke-width": 2.5, "stroke-dasharray": "5,3" }, svg);
  legend(svg, [["#1f1d1a", "puntos calientes armonizados (índice, media=100)"], ["#0072B2", "incendios reportados (índice)", "5,3"]], pad.l + 8, 18);
  $("reportedNote").textContent = `Correlación anual r = ${r.toFixed(2)} (${ys[0]}–${ys[ys.length - 1]}). Fuente reportada: data/reported.csv.`;
}

// ---------- mapa ----------
function initMap() {
  map = L.map("map", { preferCanvas: true }).setView([37.4, -4.6], 7);
  osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 13, attribution: "© OpenStreetMap" }).addTo(map);
  gibs = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{time}/{tileMatrixSet}/{z}/{y}/{x}.jpg",
    { layer: "MODIS_Terra_CorrectedReflectance_TrueColor", time: META.ultimo_dato, tileMatrixSet: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9, maxZoom: 13, attribution: "Imagen: NASA GIBS / EOSDIS" });
  drawn = new L.FeatureGroup().addTo(map);
  map.addControl(new L.Control.Draw({ draw: { polyline: false, marker: false, circlemarker: false, circle: false, polygon: { shapeOptions: { color: "#c2410c" } }, rectangle: { shapeOptions: { color: "#c2410c" } } }, edit: { featureGroup: drawn, edit: false } }));
  map.on(L.Draw.Event.CREATED, (e) => {
    drawn.clearLayers(); drawn.addLayer(e.layer);
    S.aoi = "draw"; S.aoiGeom = e.layer.toGeoJSON().geometry;
    document.querySelector('input[name=aoi][value=draw]').checked = true;
    update(true);
  });
  L.geoJSON(STATIC, { style: { color: "#6d28d9", weight: 2, fill: false } }).bindTooltip((l) => `Fuente estática descartada · ${l.feature.properties.dias} días con detección`).addTo(map);
  ptsLayer = L.layerGroup().addTo(map);
}
function renderMap(fit) {
  if (aoiLayer) map.removeLayer(aoiLayer);
  if (S.aoi === "circle" && S.circle) aoiLayer = L.circle([S.circle.lat, S.circle.lon], { radius: S.circle.km * 1000, color: "#c2410c", fill: false }).addTo(map);
  else if (S.aoiGeom && S.aoi !== "draw") aoiLayer = L.geoJSON(S.aoiGeom, { style: { color: "#c2410c", weight: 2, fill: false } }).addTo(map);
  else if (S.aoi === "all") aoiLayer = L.geoJSON(PROV, { style: { color: "#a8a29e", weight: 1, fill: false } }).addTo(map);
  else aoiLayer = null;
  if (fit && aoiLayer) map.fitBounds(aoiLayer.getBounds(), { padding: [10, 10] });
  ptsLayer.clearLayers();
  let [kA, kB] = range();
  if (S.mapMonth != null) kA = kB = S.mapMonth;
  const idx = [];
  for (let i = N - 1; i >= 0; i--) if (SEL[i] && K[i] >= kA && K[i] <= kB && P.c[i] > 0) idx.push(i);
  const cap = 15000, shown = idx.slice(0, cap);
  const r = L.canvas({ padding: 0.3 });
  for (const i of shown) L.circleMarker([P.y[i] / 1e4, P.x[i] / 1e4], { renderer: r, radius: INSTR[P.s[i]] === "MODIS" ? 3 : 2, stroke: false, fillOpacity: 0.55, fillColor: INSTR[P.s[i]] === "MODIS" ? "#0072B2" : "#D55E00" }).addTo(ptsLayer);
  $("mapnote").innerHTML = ` · ${fmt(idx.length)} detecciones que cuentan ${S.mapMonth != null ? `en <b>${MESES_L[mOf(S.mapMonth) - 1]} ${yOf(S.mapMonth)}</b> (<a href="#" id="mapAll">ver todo el periodo</a>)` : "en el periodo"}${idx.length > cap ? ` (se dibujan las ${fmt(cap)} más recientes)` : ""}`;
  const a = $("mapAll"); if (a) a.onclick = (e) => { e.preventDefault(); S.mapMonth = null; renderMap(false); };
}

// ---------- descargas ----------
function csvPoints() {
  const [kA, kB] = range(), out = ["fecha,hora_utc,latitud,longitud,satelite,instrumento,frp_mw,categoria,peso_armonizado"];
  for (let i = 0; i < N; i++) {
    if (!SEL[i] || K[i] < kA || K[i] > kB) continue;
    const dt = new Date(DAY0 + P.d[i] * 864e5).toISOString().slice(0, 10), t = String(P.t[i]).padStart(4, "0");
    out.push([dt, t.slice(0, 2) + ":" + t.slice(2), (P.y[i] / 1e4).toFixed(4), (P.x[i] / 1e4).toFixed(4), SATS[P.s[i]], INSTR[P.s[i]], (P.f[i] / 10).toFixed(1), `"${CAT_NAMES[P.c[i]]}"`, W.est[P.c[i] * 12 + M[i] - 1].toFixed(3)].join(","));
  }
  download(`puntos_calientes_${aoiName()}.csv`, out.join("\n"));
}
function csvCalendar() {
  const [kA, kB] = range(), out = ["anio,mes,armonizado,ic90_inf,ic90_sup,mediana_mes,anomalia_pct,percentil,sin_armonizar,modis_terra,modis_aqua,viirs_snpp,viirs_noaa20,viirs_noaa21,fuente,mes_incompleto"];
  for (let k = kA; k <= kB; k++) {
    if (!validMonth(k)) continue;
    const m = mOf(k), b = BASE[m - 1], v = AGG.H[k];
    out.push([yOf(k), m, v.toFixed(1), AGG.Lo[k].toFixed(1), AGG.Hi[k].toFixed(1), b.med.toFixed(1), b.med > 0 ? (100 * (v - b.med) / b.med).toFixed(0) : "", pctRank(b.vals, v).toFixed(0), AGG.naive[k], ...AGG.raw.map((r) => r[k]), F.choice[`${yOf(k)}-${String(m).padStart(2, "0")}`], k === KL && lastMonthPartial() ? 1 : 0].join(","));
  }
  download(`calendario_${aoiName()}.csv`, out.join("\n"));
}
function aoiName() { return S.aoi === "all" ? "andalucia" : S.aoi === "prov" ? $("prov").value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") : S.aoi === "circle" ? `${S.circle.lat}_${S.circle.lon}_${S.circle.km}km` : "zona_dibujada"; }

// ---------- control ----------
function update(fit = false) {
  S.mapMonth = null;
  $("status").textContent = "Calculando…";
  setTimeout(() => {
    computeSelection(); aggregate();
    renderKPIs(); renderCalendar(); renderClim(); renderAnnual(); renderReported(); renderMap(fit);
    updateStatus();
  }, 10);
}
function updateStatus() {
  const n = SEL.reduce((s, v) => s + v, 0);
  $("status").innerHTML = `${fmt(n)} detecciones en la zona · último dato ${LAST.getUTCDate()} ${MESES[LAST.getUTCMonth()]} ${LAST.getUTCFullYear()}<br><small>generado ${META.generado.slice(0, 10)}</small>`;
}
function setProv() {
  const f = PROV.features.find((x) => x.properties.name === $("prov").value);
  S.aoiGeom = f.geometry;
}
async function main() {
  try { await load(); } catch (e) { $("status").textContent = "No se pudieron cargar los datos (" + e.message + "). ¿Has servido la carpeta web/ con un servidor local?"; return; }
  if (META.sinteticos) $("synthetic").hidden = false;
  $("ovl").textContent = `${F.overlap[0]}–${F.overlap[1]}`;
  $("nstatic").textContent = `(${STATIC.features.length} celdas en esta versión)`;
  PROV.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b, "es")).forEach((n) => $("prov").add(new Option(n, n)));
  $("prov").value = "Málaga";
  $("from").min = $("to").min = `${yOf(K0)}-${String(mOf(K0)).padStart(2, "0")}`;
  $("from").max = $("to").max = $("to").value = `${yOf(KL)}-${String(mOf(KL)).padStart(2, "0")}`;
  $("from").value = $("from").min;
  initMap();
  $("gibsDate").min = "2000-02-24"; $("gibsDate").max = META.ultimo_dato; $("gibsDate").value = META.ultimo_dato;
  ["gibsOn", "gibsDate", "gibsBands"].forEach((id) => $(id).addEventListener("change", updateGibs));
  initVoice();
  document.querySelectorAll("input[name=aoi]").forEach((r) => r.addEventListener("change", () => {
    S.aoi = r.value;
    if (S.aoi === "all") S.aoiGeom = null;
    if (S.aoi === "prov") setProv();
    if (S.aoi === "circle") S.circle = { lat: +$("lat").value, lon: +$("lon").value, km: +$("rad").value };
    if (S.aoi === "draw") { const l = drawn.getLayers()[0]; S.aoiGeom = l ? l.toGeoJSON().geometry : null; if (!l) { $("status").textContent = "Dibuja un rectángulo o polígono con los botones del mapa."; return; } }
    update(true);
  }));
  $("prov").addEventListener("change", () => { document.querySelector('input[name=aoi][value=prov]').checked = true; S.aoi = "prov"; setProv(); update(true); });
  $("applyCircle").addEventListener("click", () => { document.querySelector('input[name=aoi][value=circle]').checked = true; S.aoi = "circle"; S.circle = { lat: +$("lat").value, lon: +$("lon").value, km: +$("rad").value }; update(true); });
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => { S.mode = r.value; renderCalendar(); }));
  $("nums").addEventListener("change", renderCalendar);
  ["from", "to"].forEach((id) => $(id).addEventListener("change", () => { renderCalendar(); renderAnnual(); renderMap(false); }));
  $("dlPoints").addEventListener("click", csvPoints);
  $("dlCal").addEventListener("click", csvCalendar);
  $("dlSvg").addEventListener("click", () => download(`calendario_${aoiName()}.svg`, new XMLSerializer().serializeToString($("cal").querySelector("svg")), "image/svg+xml"));
  addEventListener("resize", () => { renderCalendar(); renderClim(); renderAnnual(); renderReported(); });
  renderValidation();
  update(false);
}
main();


// ---------- imagen del día (NASA GIBS) ----------
function gibsLayerName(date, trueColor) {
  if (date < "2012-01-20") return trueColor ? "MODIS_Terra_CorrectedReflectance_TrueColor" : "MODIS_Terra_CorrectedReflectance_Bands721";
  if (date < "2020-01-01") return trueColor ? "VIIRS_SNPP_CorrectedReflectance_TrueColor" : "VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1";
  return trueColor ? "VIIRS_NOAA20_CorrectedReflectance_TrueColor" : "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1";
}
function updateGibs() {
  const date = $("gibsDate").value || META.ultimo_dato, tc = $("gibsBands").value === "true";
  gibs.options.layer = gibsLayerName(date, tc); gibs.options.time = date;
  if ($("gibsOn").checked) { if (map.hasLayer(osm)) map.removeLayer(osm); if (!map.hasLayer(gibs)) gibs.addTo(map); gibs.redraw(); gibs.bringToBack(); }
  else { if (map.hasLayer(gibs)) map.removeLayer(gibs); if (!map.hasLayer(osm)) osm.addTo(map).bringToBack(); }
}
function busiestDay(y, m) {
  const c = {};
  for (let i = 0; i < N; i++) if (SEL[i] && Y[i] === y && M[i] === m && P.c[i] > 0) c[DD[i]] = (c[DD[i]] || 0) + 1;
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best ? +best[0] : 15;
}
function focusMonth(y, m, showImage = true) {
  S.mapMonth = kOf(y, m);
  const d = busiestDay(y, m), last = new Date(LAST), dt = new Date(Date.UTC(y, m - 1, d));
  $("gibsDate").value = (dt > last ? last : dt).toISOString().slice(0, 10);
  if (showImage) $("gibsOn").checked = true;
  updateGibs(); renderMap(false);
  $("map").scrollIntoView({ behavior: "smooth", block: "center" });
  return d;
}

// ---------- asistente de voz (sin servidor: reconocimiento del navegador + reglas) ----------
const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[¿?¡!.,]/g, " ");
function zoneLabel() { return S.aoi === "all" ? "Andalucía" : S.aoi === "prov" ? $("prov").value : S.aoi === "circle" ? `un radio de ${S.circle.km} km` : "la zona dibujada"; }
function setMode(mode) { S.mode = mode; document.querySelector(`input[name=mode][value=${mode}]`).checked = true; renderCalendar(); }
function setAll() { S.aoi = "all"; S.aoiGeom = null; document.querySelector("input[name=aoi][value=all]").checked = true; }
function setProvByName(name) { $("prov").value = name; S.aoi = "prov"; setProv(); document.querySelector("input[name=aoi][value=prov]").checked = true; }
function interpret(text) {
  const t = norm(text);
  let zoneChanged = false;
  for (const f of PROV.features) {
    const n = f.properties.name;
    if (t.includes(norm(n).trim())) { setProvByName(n); zoneChanged = true; break; }
  }
  if (!zoneChanged && /andalucia|toda la region|todo andaluc/.test(t)) { setAll(); zoneChanged = true; }
  if (zoneChanged) { S.mapMonth = null; computeSelection(); aggregate(); renderKPIs(); renderClim(); renderAnnual(); renderReported(); renderCalendar(); renderMap(true); updateStatus(); }
  const z = zoneLabel(), say = [];
  const mesIdx = MESES_L.findIndex((mm) => t.includes(norm(mm).trim()));
  const yearM = t.match(/\b(20[0-2]\d)\b/);
  const pct = (k) => `percentil ${fmt(k.p)}, ${levelTxt(k.p)}`;

  if (/sin armoniz|bruto|crudo|salto|2012/.test(t) && !/imagen|foto|satelite/.test(t)) {
    setMode("raw");
    const avg = (arr, y0, y1) => { let s = 0; for (let y = y0; y <= y1; y++) for (let m = 1; m <= 12; m++) s += arr[kOf(y, m)]; return s / (y1 - y0 + 1); };
    const n0 = avg(AGG.naive, 2009, 2011), n1 = avg(AGG.naive, 2013, 2015), h0 = avg(AGG.H, 2009, 2011), h1 = avg(AGG.H, 2013, 2015);
    const x = n0 > 0 ? n1 / n0 : NaN, xh = h0 > 0 ? h1 / h0 : NaN;
    say.push(`Así queda ${z} si juntamos los sensores sin armonizar: de una media de ${fmt(n0)} puntos al año en 2009–2011 se pasa a ${fmt(n1)} en 2013–2015, ${Number.isFinite(x) ? `multiplicado por ${x.toFixed(1)}` : ""}, solo por cambiar de MODIS a VIIRS. Con la serie armonizada el cambio entre esos mismos periodos es de ${Number.isFinite(xh) ? `${xh.toFixed(1)} veces` : "–"}. Di «armonizado» para verla.`);
  } else if (/anomal|raro|inusual|fuera de lo normal/.test(t)) {
    setMode("anom");
    const k = KPI.find((x) => x.id === "ultimo");
    say.push(`Te muestro las anomalías en ${z}: rojo es más actividad de lo normal para ese mes y azul, menos. ${k ? `El último mes completo, ${k.mes}, tuvo ${fmt(k.n)} puntos calientes frente a una mediana de ${fmt(k.med)}: ${pct(k)}.` : ""}`);
  } else if (/armoniz|corregid|continua/.test(t)) {
    setMode("count");
    say.push(`Esta es la serie armonizada de ${z}: todo expresado en puntos equivalentes VIIRS, de 2000 a hoy, sin el salto de 2012.`);
  }
  if (/imagen|foto|satelite|ver el dia|como se veia/.test(t)) {
    const y = yearM ? +yearM[1] : yOf(KL), m = mesIdx >= 0 ? mesIdx + 1 : (yearM ? REC.order[0] + 1 : mOf(KL));
    const d = focusMonth(y, m, true);
    say.push(`Aquí tienes la imagen de satélite del ${d} de ${MESES_L[m - 1]} de ${y}, el día con más detecciones de ese mes en ${z}, con los puntos calientes encima.`);
  } else if (mesIdx >= 0 && yearM) {
    const y = +yearM[1], m = mesIdx + 1, k = kOf(y, m);
    if (validMonth(k)) {
      focusMonth(y, m, false);
      const p = pctRank(BASE[m - 1].vals, AGG.H[k]);
      say.push(`En ${MESES_L[m - 1]} de ${y}, ${z} tuvo ${fmt(AGG.H[k])} puntos calientes armonizados; la mediana de ${MESES_L[m - 1]} es ${fmt(BASE[m - 1].med)}: percentil ${fmt(p)}, ${levelTxt(p)}.`);
    }
  }
  if (/cuando|temporada|epoca|que meses|ciclo/.test(t)) {
    const o = REC.order;
    say.push(`En ${z} la actividad típica se concentra en ${MESES_L[o[0]]} y ${MESES_L[o[1]]}, seguidos de ${MESES_L[o[2]]}.`);
    $("clim").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (/peor ano|record|mas fuego|mas incendios|ano con mas/.test(t) && REC.rec) {
    say.push(`El año con más actividad en ${z} fue ${REC.rec[0]}, con unos ${fmt(REC.rec[1])} puntos calientes armonizados.`);
  }
  if (/este mes|ahora|hoy|mes en curso|como va|como esta|situacion|riesgo/.test(t) || !say.length) {
    const k = KPI.find((x) => x.id === "mes"), a = KPI.find((x) => x.id === "anio");
    if (k) say.push(`En ${z}, ${k.lab.toLowerCase()} lleva ${fmt(k.n)} puntos calientes, frente a una mediana de ${fmt(k.med)} para esos mismos días: ${pct(k)}. ${a ? `En lo que va de año: ${fmt(a.n)}, ${levelTxt(a.p)}.` : ""}`);
  }
  return say.join(" ");
}
function answer(q) {
  const txt = interpret(q);
  $("answer").hidden = false;
  $("answer").innerHTML = `<div class="q">«${q.replace(/</g, "&lt;")}»</div>${txt}`;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(txt.replace(/\./g, ". ")); u.lang = "es-ES"; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith("es-ES")); if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
}
function initVoice() {
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("ask").value.trim(); if (q) answer(q); });
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("mic").textContent = "🎤 Voz no disponible en este navegador (usa Chrome)"; $("mic").disabled = true; return; }
  const rec = new SR(); rec.lang = "es-ES"; rec.interimResults = true; rec.maxAlternatives = 1;
  let final = "";
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(" "); $("ask").value = final; };
  rec.onend = () => { $("mic").classList.remove("on"); $("mic").textContent = "🎤 Pulsa y habla"; if (final.trim()) answer(final.trim()); };
  rec.onerror = (e) => { $("answer").hidden = false; $("answer").textContent = "No te he oído (" + e.error + "). Puedes escribir la pregunta."; };
  $("mic").addEventListener("click", () => { final = ""; speechSynthesis.cancel(); $("mic").classList.add("on"); $("mic").textContent = "Escuchando…"; rec.start(); });
}
