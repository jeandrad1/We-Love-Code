/* Mapa: Europa de noche con una capa de «brillo» dibujada en canvas (los fuegos se suman como luz). */
"use strict";

let map,
  base,
  labels,
  gibs,
  glow,
  countryLayer,
  zoneLayer,
  drawn,
  drawTool = null;
const EU_BOUNDS = [
  [34.5, -11],
  [70.5, 41],
];

// Capa propia: dibuja manchas de luz con mezcla aditiva («lighter»), como se vería desde el espacio
const GlowLayer = L.Layer.extend({
  initialize() {
    this.items = [];
  },
  onAdd(m) {
    this._m = m;
    this._c = L.DomUtil.create("canvas", "glow-layer");
    Object.assign(this._c.style, {
      position: "absolute",
      pointerEvents: "none",
    });
    m.getPanes().overlayPane.appendChild(this._c);
    m.on("moveend zoomend resize", this._draw, this);
    m.on("zoomstart", () => (this._c.style.opacity = 0));
    this._draw();
  },
  onRemove(m) {
    L.DomUtil.remove(this._c);
    m.off("moveend zoomend resize", this._draw, this);
  },
  set(items) {
    this.items = items;
    if (this._m) this._draw();
  },
  _draw() {
    const m = this._m,
      sz = m.getSize(),
      dpr = devicePixelRatio || 1,
      c = this._c;
    c.width = sz.x * dpr;
    c.height = sz.y * dpr;
    c.style.width = sz.x + "px";
    c.style.height = sz.y + "px";
    c.style.opacity = 1;
    L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
    const g = c.getContext("2d");
    g.scale(dpr, dpr);
    g.globalCompositeOperation = "lighter";
    for (const it of this.items) {
      const p = m.latLngToContainerPoint([it.lat, it.lon]);
      const r = it.deg
        ? Math.max(
            2,
            m.latLngToContainerPoint([it.lat, it.lon + it.deg]).x - p.x,
            p.y - m.latLngToContainerPoint([it.lat + it.deg, it.lon]).y,
          ) * 0.9
        : it.r;
      if (p.x < -r || p.y < -r || p.x > sz.x + r || p.y > sz.y + r) continue;
      const [cr, cg, cb] = it.rgb,
        gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},${it.a})`);
      gr.addColorStop(0.45, `rgba(${cr},${cg},${cb},${it.a * 0.45})`);
      gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = gr;
      g.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
    }
  },
});
const rgbOf = (s) => s.match(/\d+/g).map(Number);

const CARTOCDN_API_KEY = "cb1_592t_1_c94fb43a95d1252e552211cc"; // Reemplaza con tu clave

function initMap() {
  map = L.map("map", {
    zoomSnap: 0.25,
    minZoom: 3,
    maxZoom: 12,
    worldCopyJump: false,
    attributionControl: true,
    zoomControl: false,
  }).fitBounds(EU_BOUNDS);
  L.control.zoom({ position: "topright" }).addTo(map);
  base = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?api_key=" + CARTOCDN_API_KEY, 
  {
    subdomains: "abcd", 
    maxZoom: 19 
  }
).addTo(map);
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  labels = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png?api_key=" + CARTOCDN_API_KEY, 
  { 
    pane: "labels", 
    subdomains: "abcd", 
    opacity: 0.55 
  }
).addTo(map);
  gibs = L.tileLayer(
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{time}/{tileMatrixSet}/{z}/{y}/{x}.jpg",
    {
      layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
      time: D.meta.ultimo_dato,
      tileMatrixSet: "GoogleMapsCompatible_Level9",
      maxNativeZoom: 9,
      maxZoom: 12,
    },
  );
  countryLayer = L.geoJSON(D.paises, {
    style: () => ({
      color: "#2A3F5C",
      weight: 0.8,
      fillOpacity: 0,
      fillColor: "#000",
    }),
    onEachFeature: (f, l) => {
      l.on("mouseover", () => l.setStyle({ color: "#9CB0C9", weight: 1.6 }));
      l.on("mouseout", () => styleCountries());
      l.on("click", () => {
        if (S.zone !== "draw") selectZone(f.properties.iso);
      });
      l.bindTooltip(() => countryTip(f.properties.iso), { sticky: true });
    },
  }).addTo(map);
  glow = new GlowLayer().addTo(map);
  drawn = new L.FeatureGroup().addTo(map);
  map.addControl(
    new L.Control.Draw({
      position: "topright",
      draw: {
        polyline: false,
        marker: false,
        circlemarker: false,
        circle: false,
        polygon: {
          shapeOptions: { color: "#FFB04A", weight: 2, fillOpacity: 0.05 },
        },
        rectangle: {
          shapeOptions: { color: "#FFB04A", weight: 2, fillOpacity: 0.05 },
        },
      },
      edit: false,
    }),
  );
  map.on(L.Draw.Event.CREATED, (e) => {
    drawn.clearLayers();
    drawn.addLayer(e.layer);
    drawTool = null;
    S.zone = "draw";
    S.geom = e.layer.toGeoJSON().geometry;
    syncZone();
    update(false);
  });
  document.querySelectorAll("input[name=mapView]").forEach((r) =>
    r.addEventListener("change", () => {
      S.mapView = r.value;
      if (S.mapView !== "focos") S.mapMonth = null;
      S.event = null;
      renderMapLayer(false);
    }),
  );
  $("gibsDate").min = "2000-02-24";
  $("gibsDate").max = D.meta.ultimo_dato;
  $("gibsDate").value = D.meta.ultimo_dato;
  ["gibsOn", "gibsDate", "gibsBands"].forEach((id) =>
    $(id).addEventListener("change", updateGibs),
  );
}
function countryTip(iso) {
  const c = COUNTRY_STATS && COUNTRY_STATS[iso];
  if (!c) return COUNTRY_NAME[iso];
  return `<b>${COUNTRY_NAME[iso]}</b><br>${CY} hasta hoy: ${fmt(c.ytd)} focos<br><span class="arrow ${level(c.ytdP)}">${arrow(c.ytdP)}</span> ${levelWord(c.ytdP)} (lo habitual: ${fmt(c.ytdMed)})`;
}
function styleCountries() {
  countryLayer.eachLayer((l) => {
    const iso = l.feature.properties.iso,
      sel = iso === S.zone;
    if (S.mapView === "paises" && !S.event && COUNTRY_STATS[iso]) {
      const c = COUNTRY_STATS[iso],
        t = Math.log2((c.ytd + 1) / (c.ytdMed + 1)) / 2;
      l.setStyle({
        fillColor: ramp(DIVERG, (Math.max(-1, Math.min(1, t)) + 1) / 2),
        fillOpacity: 0.78,
        color: sel ? "#FFB04A" : "#0E1A2C",
        weight: sel ? 2.5 : 0.8,
      });
    } else
      l.setStyle({
        fillOpacity: 0,
        color: sel ? "#FFB04A" : "#2A3F5C",
        weight: sel ? 2.2 : 0.8,
      });
  });
}

// ---------- capas según la vista ----------
function heatItems(iA, iB, cellFilter) {
  const R = D.rejilla,
    g = R.deg,
    sum = new Float64Array(R.celdas.length);
  for (let t = 0; t < R.c.length; t++) {
    const k = R.k[t];
    if (k >= iA && k <= iB) sum[R.c[t]] += R.v[t] / 10;
  }
  const per = Math.max(1, (iB - iA + 1) / 12),
    vals = [];
  sum.forEach((v) => v > 0 && vals.push(v / per));
  const vmax = Math.max(1, quantile(vals, 0.985)),
    items = [];
  sum.forEach((v0, ci) => {
    if (v0 <= 0 || (cellFilter && !cellFilter(ci))) return;
    const v = v0 / per,
      t = Math.log1p(v) / Math.log1p(vmax),
      [cx, cy] = R.celdas[ci];
    items.push({
      lat: (cy + 0.5) * g,
      lon: (cx + 0.5) * g,
      deg: g,
      rgb: rgbOf(ramp(THERMAL, 0.2 + 0.8 * t)),
      a: 0.25 + 0.6 * Math.min(1, t),
    });
  });
  return { items, vmax, per };
}
async function renderMapLayer(fit) {
  styleCountries();
  if (zoneLayer) {
    map.removeLayer(zoneLayer);
    zoneLayer = null;
  }
  if (S.zone === "circle" && S.circle)
    zoneLayer = L.circle([S.circle.lat, S.circle.lon], {
      radius: S.circle.km * 1000,
      color: "#FFB04A",
      weight: 2,
      fill: false,
    }).addTo(map);
  if (fit) fitZone();
  const note = $("mapnote"),
    lg = $("mapLegend");
  const thermalLegend = (a, b) =>
    `<span>${a}</span><div class="ramp" style="background:linear-gradient(90deg,${THERMAL.slice(2).join(",")})"></div><span>${b}</span>`;
  if (S.event) return; // un incendio concreto se dibuja en focusEvent
  if (S.mapView === "paises") {
    glow.set([]);
    lg.innerHTML = `<span>Menos que lo habitual</span><div class="ramp" style="background:linear-gradient(90deg,${DIVERG.join(",")})"></div><span>Más</span>`;
    note.textContent = `Cada país coloreado según sus focos de calor en ${CY} hasta el ${DD} de ${MESES_L[CM - 1]}, comparado con un año normal en las mismas fechas. Pulsa un país para verlo.`;
    return;
  }
  if (S.mapView === "focos") {
    const rec = D.meta.recientes,
      i = S.mapMonth != null ? S.mapMonth : NK - 1,
      name = `${yOf(i)}-${String(mOf(i)).padStart(2, "0")}`;
    if (rec.includes(name)) {
      const p = await loadMonth(name),
        items = [];
      for (let t = 0; t < p.x.length; t++) {
        const tf = Math.min(1, Math.log1p(p.f[t] / 10) / Math.log1p(300));
        items.push({
          lat: p.y[t] / 1000,
          lon: p.x[t] / 1000,
          r: 3 + 6 * tf,
          rgb: rgbOf(ramp(THERMAL, 0.45 + 0.55 * tf)),
          a: 0.85,
        });
      }
      glow.set(items);
      lg.innerHTML = thermalLegend("fuego débil", "intenso");
      note.innerHTML = `${fmt(p.x.length)} focos de calor en ${MESES_L[mOf(i) - 1]} de ${yOf(i)}. Para ver otro mes, púlsalo en el Calendario.`;
      return;
    }
    const h = heatItems(i, i);
    glow.set(h.items);
    lg.innerHTML = thermalLegend("poco", "mucho fuego");
    note.innerHTML = `${MESES_L[mOf(i) - 1]} de ${yOf(i)} en celdas de ~50 km (los focos uno a uno solo están para los últimos ${rec.length} meses). <a href="#" id="mapAll">Ver todos los años</a>`;
    $("mapAll").onclick = (e) => {
      e.preventDefault();
      S.mapMonth = null;
      setMapView("calor");
    };
    return;
  }
  const iA = Math.max(0, iOf(S.yA, 1)),
    iB = Math.min(NK - 1, iOf(S.yB, 12));
  const h = heatItems(
    S.mapMonth != null ? S.mapMonth : iA,
    S.mapMonth != null ? S.mapMonth : iB,
  );
  glow.set(h.items);
  lg.innerHTML = thermalLegend("poco", "mucho fuego");
  note.textContent =
    S.mapMonth != null
      ? `${MESES_L[mOf(S.mapMonth) - 1]} de ${yOf(S.mapMonth)}.`
      : `Focos de calor por año entre ${S.yA} y ${S.yB}, en celdas de unos 50 km. Pulsa un país para verlo o elige «Dibujarla en el mapa» en Zona.`;
}
function setMapView(v) {
  S.mapView = v;
  document.querySelector(`input[name=mapView][value=${v}]`).checked = true;
  renderMapLayer(false);
}
function fitZone() {
  const opt = {
    padding: [30, 30],
    paddingTopLeft: [
      innerWidth > 1000 ? Math.min(520, innerWidth * 0.46) : 20,
      30,
    ],
  };
  if (S.zone === "EU") map.fitBounds(EU_BOUNDS, opt);
  else if (S.zone === "circle" && zoneLayer)
    map.fitBounds(zoneLayer.getBounds(), opt);
  else if (S.zone === "draw" && drawn.getLayers().length)
    map.fitBounds(drawn.getBounds(), opt);
  else
    countryLayer.eachLayer((l) => {
      if (l.feature.properties.iso === S.zone)
        map.fitBounds(l.getBounds(), opt);
    });
}
function scrollToMap() {
  scrollTo({
    top: 0,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

// Pulsar un mes del calendario: ese mes en el mapa, con la foto de su día con más fuego
async function focusMonth(y, m) {
  const i = iOf(y, m),
    name = `${y}-${String(m).padStart(2, "0")}`;
  S.mapMonth = i;
  S.event = null;
  let day = 15;
  if (D.meta.recientes.includes(name)) {
    const p = await loadMonth(name),
      c = {};
    for (let t = 0; t < p.x.length; t++)
      if (
        inZonePoint(p.x[t] / 1000, p.y[t] / 1000) &&
        (zoneIsCustom() || S.zone === "EU" || p.p[t] === S.zone)
      )
        c[p.d[t]] = (c[p.d[t]] || 0) + 1;
    const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    if (best) day = new Date(DAY0 + best[0] * 864e5).getUTCDate();
    setMapView("focos");
  } else setMapView("calor");
  const dt = new Date(Date.UTC(y, m - 1, day));
  $("gibsDate").value = (dt > LAST ? LAST : dt).toISOString().slice(0, 10);
  updateGibs();
  scrollToMap();
  return day;
}
function gibsLayerName(date, trueColor) {
  if (date < "2012-01-20")
    return trueColor
      ? "MODIS_Terra_CorrectedReflectance_TrueColor"
      : "MODIS_Terra_CorrectedReflectance_Bands721";
  if (date < "2020-01-01")
    return trueColor
      ? "VIIRS_SNPP_CorrectedReflectance_TrueColor"
      : "VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1";
  return trueColor
    ? "VIIRS_NOAA20_CorrectedReflectance_TrueColor"
    : "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1";
}
function updateGibs() {
  const date = $("gibsDate").value || D.meta.ultimo_dato,
    tc = $("gibsBands").value === "true";
  gibs.options.layer = gibsLayerName(date, tc);
  gibs.options.time = date;
  if ($("gibsOn").checked) {
    if (map.hasLayer(base)) map.removeLayer(base);
    if (!map.hasLayer(gibs)) gibs.addTo(map);
    gibs.redraw();
    gibs.bringToBack();
  } else {
    if (map.hasLayer(gibs)) map.removeLayer(gibs);
    if (!map.hasLayer(base)) base.addTo(map).bringToBack();
  }
}
