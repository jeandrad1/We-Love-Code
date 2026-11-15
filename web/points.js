/* Focos individuales: cálculo exacto para zonas dibujadas o circulares y CSV de detecciones.
   Lee web/data/points/ (salida de pipeline/06_points.py) con DuckDB-WASM, que solo se descarga cuando se necesita.

   Flujo: update() pinta enseguida con la rejilla de ~50 km (app.js) y llama a refineZone(); cuando
   termina la consulta exacta, se sustituye Z (finishZone) y se repinta (render). Si algo falla
   (sin puntos desplegados, sin red, zona enorme), se queda la aproximación y se avisa. */
"use strict";

const PTS = {
  base: "data/points/",
  // Versión fijada. Comprueba que existe: npm view @duckdb/duckdb-wasm versions
  duck: "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm",
  maxTiles: 30,          // ≈ 30 MB de teselas; por encima se usa la rejilla de ~50 km
  manifest: null, engine: null, files: new Map(), token: 0, done: "",
};

// ---------- utilidades ----------
function ptsHint(msg) { const h = $("zoneHint"); h.hidden = !msg; if (msg) h.textContent = msg; }
function ptsWalk(c, f) { if (typeof c[0] === "number") f(c); else c.forEach((x) => ptsWalk(x, f)); }
function ptsBBox(coords) {
  let w = 180, s = 90, e = -180, n = -90;
  ptsWalk(coords, ([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); });
  return [w, s, e, n];
}
// Caja [oeste, sur, este, norte] de la zona elegida; null si no hay zona utilizable (o es toda Europa)
function ptsZoneBBox() {
  let bb = null;
  if (S.zone === "circle" && S.circle) {
    const { lat, lon, km } = S.circle, dl = km / 111.32, dn = km / (111.32 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
    bb = [lon - dn, lat - dl, lon + dn, lat + dl];
  } else if (S.zone === "draw" && S.geom) bb = ptsBBox(S.geom.coordinates);
  else if (S.zone !== "EU" && !zoneIsCustom()) {
    const f = D.paises.features.find((x) => x.properties.iso === S.zone);
    if (f) bb = ptsBBox(f.geometry.coordinates).map((v, i) => v + (i < 2 ? -0.05 : 0.05));
  }
  return bb && bb.every(Number.isFinite) ? bb : null;
}
const ptsTiles = (man, [w, s, e, n]) => man.tiles.filter((t) => t.bbox[0] <= e && t.bbox[2] >= w && t.bbox[1] <= n && t.bbox[3] >= s);
const ptsMB = (tiles) => Math.max(1, Math.round(tiles.reduce((a, t) => a + t.bytes, 0) / 1e6));

// ---------- carga: manifiesto, motor y teselas ----------
function ptsManifest() {
  if (!PTS.manifest) PTS.manifest = fetch(PTS.base + "manifest.json").then((r) => { if (!r.ok) throw new Error("manifest.json " + r.status); return r.json(); });
  return PTS.manifest;
}
function ptsEngine() {
  if (!PTS.engine) {
    PTS.engine = (async () => {
      const duck = await import(PTS.duck);
      const bundle = await duck.selectBundle(duck.getJsDelivrBundles());
      const url = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
      const db = new duck.AsyncDuckDB(new duck.ConsoleLogger(), new Worker(url));
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(url);
      return { db, conn: await db.connect() };
    })().catch((e) => { PTS.engine = null; throw e; });
  }
  return PTS.engine;
}
// Se descarga el fichero entero (≈ 1 MB por tesela) y se entrega a DuckDB en memoria:
// no depende de que el servidor admita peticiones por rangos (python -m http.server no las admite).
function ptsFile(db, name) {
  if (!PTS.files.has(name)) {
    PTS.files.set(name, fetch(PTS.base + name).then(async (r) => {
      if (!r.ok) throw new Error(name + " " + r.status);
      await db.registerFileBuffer(name, new Uint8Array(await r.arrayBuffer()));
    }).catch((e) => { PTS.files.delete(name); throw e; }));
  }
  return PTS.files.get(name);
}
async function ptsOpen(tiles) {
  const { db, conn } = await ptsEngine();
  await Promise.all([ptsFile(db, "weights.parquet"), ...tiles.map((t) => ptsFile(db, t.file))]);
  return conn;
}
const ptsFrom = (tiles) => `read_parquet([${tiles.map((t) => `'${t.file}'`).join(",")}]) p
  LEFT JOIN read_parquet('weights.parquet') w ON w.iso = p.iso AND w.k = p.k AND w.s = p.s`;
const ptsWhere = (bb) => `p.lon BETWEEN ${bb[0]} AND ${bb[2]} AND p.lat BETWEEN ${bb[1]} AND ${bb[3]}`;

// ---------- cálculo exacto de la zona ----------
// c = columnas (arrays tipados) de las detecciones dentro de la caja de la zona, con su peso ya unido.
// Mismas definiciones que 04_aggregate.py: h/lo/hi = suma de pesos; naive = detecciones que cuentan (w>0);
// modis = todas las de Terra/Aqua; viirs = todas las de S-NPP; parcial = mes en curso hasta el día de hoy.
function ptsAggregate(c) {
  const n = c.lon.length;
  const z = { h: new Float64Array(NK), lo: new Float64Array(NK), hi: new Float64Array(NK), naive: new Float64Array(NK),
    modis: new Float64Array(NK), viirs: new Float64Array(NK), partial: {}, raw: true, daily: true, exact: true, nrows: 0 };
  D.parcial.anios.forEach((y) => (z.partial[y] = 0));
  const day = new Map();
  for (let i = 0; i < n; i++) {
    if (!inZonePoint(c.lon[i], c.lat[i])) continue;     // la caja es solo un filtro previo: aquí se aplica el polígono o el círculo exactos
    const k = c.k[i], j = k - K0;
    if (j < 0 || j >= NK) continue;
    z.nrows++;
    const w = c.w[i], s = c.s[i];
    z.h[j] += w; z.lo[j] += c.wl[i]; z.hi[j] += c.wh[i];
    if (s <= 1) z.modis[j]++; else if (s === 2) z.viirs[j]++;
    if (w > 0) {
      z.naive[j]++;
      day.set(c.dn[i], (day.get(c.dn[i]) || 0) + w);
      const y = 2000 + Math.floor(k / 12);
      if (k % 12 + 1 === CM && c.dm[i] <= DD && y in z.partial) z.partial[y] += w;
    }
  }
  z.dailyPairs = [...day].sort((a, b) => a[0] - b[0]);
  return z;
}

async function refineZone() {
  const token = ++PTS.token;               // cualquier cambio de zona invalida la consulta anterior
  PTS.done = "";
  if (!zoneIsCustom() || !ptsZoneBBox()) return;
  try {
    const man = await ptsManifest(), bb = ptsZoneBBox(), tiles = ptsTiles(man, bb);
    if (!tiles.length) { ptsHint("No hay focos individuales en esta zona. Se muestra la aproximación con celdas de ~50 km."); return; }
    if (tiles.length > PTS.maxTiles) { ptsHint("La zona es muy grande para calcularla foco a foco: se muestra con celdas de ~50 km. Dibuja una más pequeña para el detalle completo."); return; }
    ptsHint(`Calculando con los focos individuales de la zona (${ptsMB(tiles)} MB la primera vez)…`);
    const conn = await ptsOpen(tiles);
    if (token !== PTS.token) return;
    const res = await conn.query(`
      SELECT p.lon::DOUBLE AS lon, p.lat::DOUBLE AS lat, p.k::INTEGER AS k, p.s::INTEGER AS s,
             datediff('day', DATE '2000-01-01', CAST(p.datetime AS DATE))::INTEGER AS dn,
             date_part('day', p.datetime)::INTEGER AS dm,
             coalesce(w.w, 0)::DOUBLE AS w, coalesce(w.wl, 0)::DOUBLE AS wl, coalesce(w.wh, 0)::DOUBLE AS wh
      FROM ${ptsFrom(tiles)} WHERE ${ptsWhere(bb)}`);
    if (token !== PTS.token) return;
    const col = (name) => res.getChild(name).toArray();
    const z = ptsAggregate({ lon: col("lon"), lat: col("lat"), k: col("k"), s: col("s"), dn: col("dn"), dm: col("dm"), w: col("w"), wl: col("wl"), wh: col("wh") });
    finishZone(z);
    render(false);
    PTS.done = `Zona calculada con ${fmt(z.nrows)} focos individuales, sin aproximar a celdas.`;
    ptsHint(PTS.done);
  } catch (e) {
    if (token !== PTS.token) return;
    console.warn("[points] se queda la aproximación:", e);
    ptsHint("No se pudieron cargar los focos individuales; se muestra la aproximación con celdas de ~50 km.");
  }
}

// ---------- CSV de detecciones ----------
// País o zona: todas las detecciones de los años elegidos. Toda Europa (o sin puntos): el CSV antiguo de los últimos 24 meses.
async function csvPoints() {
  const man = await ptsManifest().catch(() => null);
  const bb = S.zone === "EU" ? null : ptsZoneBBox(), tiles = man && bb ? ptsTiles(man, bb) : [];
  if (!tiles.length || tiles.length > PTS.maxTiles) {
    ptsHint(S.zone === "EU" ? "Para toda Europa se descargan solo los últimos 24 meses. Elige un país o una zona para tener todos los años." : "Esta zona es demasiado grande: se descargan solo los últimos 24 meses.");
    return csvPointsRecent();
  }
  try {
    ptsHint(`Preparando el CSV (${ptsMB(tiles)} MB de datos la primera vez)…`);
    const conn = await ptsOpen(tiles);
    const kA = (S.yA - 2000) * 12, kB = (S.yB - 2000) * 12 + 11;
    const byIso = !zoneIsCustom() && COUNTRY_NAME[S.zone] ? ` AND p.iso = '${S.zone}'` : "";
    const res = await conn.query(`
      SELECT strftime(p.datetime, '%Y-%m-%d %H:%M') AS t, p.lat::DOUBLE AS lat, p.lon::DOUBLE AS lon, p.iso AS iso,
             p.s::INTEGER AS s, p.frp AS frp, p.nrt AS nrt,
             coalesce(w.w, 0)::DOUBLE AS w, coalesce(w.wl, 0)::DOUBLE AS wl, coalesce(w.wh, 0)::DOUBLE AS wh
      FROM ${ptsFrom(tiles)}
      WHERE ${ptsWhere(bb)} AND p.k BETWEEN ${kA} AND ${kB}${byIso}
      ORDER BY p.datetime`);
    const t = res.getChild("t"), iso = res.getChild("iso"), frp = res.getChild("frp"), nrt = res.getChild("nrt");
    const lat = res.getChild("lat").toArray(), lon = res.getChild("lon").toArray(), s = res.getChild("s").toArray();
    const w = res.getChild("w").toArray(), wl = res.getChild("wl").toArray(), wh = res.getChild("wh").toArray();
    const out = ["fecha_utc,latitud,longitud,pais,satelite,instrumento,frp_mw,producto,cuenta_en_serie,peso,peso_min,peso_max"];
    for (let i = 0; i < lat.length; i++) {
      if (zoneIsCustom() && !inZonePoint(lon[i], lat[i])) continue;
      const f = frp.get(i);
      out.push([t.get(i), lat[i].toFixed(5), lon[i].toFixed(5), iso.get(i), SATS[s[i]], INSTR[s[i]], f == null || Number.isNaN(f) ? "" : f.toFixed(1),
        nrt.get(i) ? "NRT" : "SP", w[i] > 0 ? 1 : 0, w[i].toFixed(3), wl[i].toFixed(3), wh[i].toFixed(3)].join(","));
    }
    download(`focos_${slug()}_${S.yA}-${S.yB}.csv`, out.join("\n"));
    ptsHint(out.length > 1 ? `CSV con ${fmt(out.length - 1)} focos descargado.` : "No hay focos en esta zona y estos años.");
    setTimeout(() => ptsHint(PTS.done), 4000);
  } catch (e) {
    console.warn("[points] CSV:", e);
    ptsHint("No se pudo preparar el CSV completo: se descargan los últimos 24 meses.");
    return csvPointsRecent();
  }
}