/* Interfaz: zona y años, frase de portada, pestañas, guía y asistente por voz. */
"use strict";

const TABS = ["resumen", "calendario", "incendios", "metodo"];
let currentTab = "resumen";

function showTab(name, focus = false) {
  if (!TABS.includes(name)) return;
  currentTab = name;
  TABS.forEach((t) => { const on = t === name; $("tab-" + t).setAttribute("aria-selected", on); $("tab-" + t).tabIndex = on ? 0 : -1; $("p-" + t).hidden = !on; });
  if (focus) $("tab-" + name).focus();
  requestAnimationFrame(() => {   // los gráficos se dibujan con su ancho real al mostrarse
    if (name === "resumen") renderClim();
    if (name === "calendario") { renderCalendar(); renderStripes(); }
    if (name === "incendios") renderEvents();
    if (name === "metodo") { renderAnnual(); renderReported(); }
  });
}
function initTabs() {
  TABS.forEach((t, i) => {
    const el = $("tab-" + t);
    el.addEventListener("click", () => showTab(t));
    el.addEventListener("keydown", (e) => {
      const j = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
      if (j !== undefined) { e.preventDefault(); showTab(TABS[j], true); }
    });
  });
}

// ---------- Zona ----------
function selectZone(z) {
  if (drawTool) { drawTool.disable(); drawTool = null; }
  S.event = null; S.mapMonth = null;
  if (z === "draw") {
    S.zone = "draw"; S.geom = null; drawn.clearLayers(); syncZone(); scrollToMap();
    drawTool = new L.Draw.Rectangle(map, { shapeOptions: { color: "#FFB04A", weight: 2, fillOpacity: 0.05 } }); drawTool.enable();
    return;
  }
  if (z === "circle") { S.zone = "circle"; S.circle = null; syncZone(); $("lat").focus(); return; }
  S.zone = z; S.geom = null; drawn.clearLayers(); syncZone(); update(true);
}
function syncZone() {
  $("zone").value = S.zone;
  $("circleRow").hidden = S.zone !== "circle";
  const hint = $("zoneHint");
  if (S.zone === "draw" && !S.geom) { hint.hidden = false; hint.textContent = "Arrastra sobre el mapa para dibujar un rectángulo. Con el botón del pentágono (arriba a la derecha del mapa) puedes dibujar un polígono."; }
  else if (S.zone === "circle" && !S.circle) { hint.hidden = false; hint.textContent = "Escribe las coordenadas del centro y el radio, y pulsa «Ver zona»."; }
  else hint.hidden = true;
}
function initZone() {
  const z = $("zone");
  z.add(new Option("Toda Europa", "EU"));
  const g = document.createElement("optgroup"); g.label = "Países";
  D.meta.paises.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).forEach((p) => g.appendChild(new Option(p.nombre, p.iso)));
  z.appendChild(g);
  const o = document.createElement("optgroup"); o.label = "Otra zona";
  o.appendChild(new Option("Dibujarla en el mapa…", "draw")); o.appendChild(new Option("Alrededor de un punto…", "circle"));
  z.appendChild(o);
  z.addEventListener("change", () => selectZone(z.value));
  $("applyCircle").addEventListener("click", () => { S.zone = "circle"; S.circle = { lat: +$("lat").value, lon: +$("lon").value, km: +$("rad").value }; syncZone(); update(true); });
}
function initYears() {
  const y0 = yOf(0);
  for (let y = y0; y <= CY; y++) { $("yFrom").add(new Option(y, y)); $("yTo").add(new Option(y, y)); }
  $("yFrom").value = S.yA; $("yTo").value = S.yB;
  const apply = (which) => {
    let a = +$("yFrom").value, b = +$("yTo").value;
    if (a > b) { if (which === "from") b = a; else a = b; $("yFrom").value = a; $("yTo").value = b; }
    S.yA = a; S.yB = b; S.mapMonth = null;
    renderCalendar(); renderAnnual(); renderMapLayer(false); renderEvents(); renderStripes();
  };
  $("yFrom").addEventListener("change", () => apply("from"));
  $("yTo").addEventListener("change", () => apply("to"));
}

// ---------- Portada ----------
function renderHero() {
  const a = KPI.find((k) => k.id === "anio"), m = KPI.find((k) => k.id === "mes");
  const z = zoneLabel(), Z1 = z[0].toUpperCase() + z.slice(1);
  $("kicker").textContent = `Satélites de la NASA, datos hasta el ${DD} de ${MESES_L[CM - 1]} de ${CY}`;
  const d = diffTxt(a.n, a.med);
  $("headline").innerHTML = `${Z1} lleva <span class="num">${fmt(a.n)}</span> focos de calor en ${CY}`;
  $("verdict").className = "verdict " + level(a.p);
  $("verdict").innerHTML = `<span aria-hidden="true">${arrow(a.p)}</span> ${d[0].toUpperCase() + d.slice(1)} a estas alturas del año.`;
  $("subline").innerHTML = `Este mes va <span class="lvl">${levelTxt(m.p).replace("dentro de lo habitual", "normal")}</span>: ${fmt(m.n)} focos hasta el día ${DD}, cuando lo habitual son ${fmt(m.med)}. ` +
    `<a href="#" id="whatLink">¿Qué es un foco de calor?</a>`;
  $("whatLink").onclick = (e) => { e.preventDefault(); $("help").showModal(); };
}

// ---------- Guía y asistente ----------
function initHelp() {
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  let seen = false;
  try { seen = localStorage.getItem("guiaEuropa") === "1"; localStorage.setItem("guiaEuropa", "1"); } catch (e) { /* sin almacenamiento */ }
  if (!seen) $("help").showModal();
}
function initAssistant() {
  const btn = $("assistantBtn"), panel = $("assistantPanel");
  const toggle = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", open); if (open) $("ask").focus(); };
  btn.addEventListener("click", () => toggle(panel.hidden));
  $("assistantClose").addEventListener("click", () => { toggle(false); btn.focus(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { toggle(false); btn.focus(); } });
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("ask").value.trim(); if (q) answer(q); });
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("mic").textContent = "La voz necesita Chrome; puedes escribir"; $("mic").disabled = true; return; }
  const rec = new SR(); rec.lang = "es-ES"; rec.interimResults = true;
  let final = "";
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(" "); $("ask").value = final; };
  rec.onend = () => { $("mic").classList.remove("on"); $("mic").textContent = "Pulsa y habla"; if (final.trim()) answer(final.trim()); };
  rec.onerror = (e) => { $("answer").hidden = false; $("answer").textContent = "No te he oído (" + e.error + "). Puedes escribir la pregunta."; };
  $("mic").addEventListener("click", () => { final = ""; speechSynthesis.cancel(); $("mic").classList.add("on"); $("mic").textContent = "Escuchando…"; rec.start(); });
}
const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[¿?¡!.,]/g, " ");
function setMode(mode) { S.mode = mode; document.querySelector(`input[name=mode][value=${mode}]`).checked = true; showTab("calendario"); }
function interpret(text) {
  const t = norm(text), say = [];
  let zoneChanged = false;
  const names = D.meta.paises.map((p) => [norm(p.nombre).trim(), p.iso]).sort((a, b) => b[0].length - a[0].length);
  for (const [n, iso] of names) if (t.includes(n)) { S.zone = iso; zoneChanged = true; break; }
  if (!zoneChanged && /europa|todo el continente/.test(t)) { S.zone = "EU"; zoneChanged = true; }
  if (zoneChanged) { S.event = null; S.mapMonth = null; drawn.clearLayers(); syncZone(); update(true); }
  const z = zoneLabel(), Z1 = z[0].toUpperCase() + z.slice(1);
  const mesIdx = MESES_L.findIndex((mm) => t.includes(mm)), yearM = t.match(/\b(20[0-2]\d)\b/);
  if (/sin corregir|sin armoniz|bruto|salto|2012/.test(t) && !/foto|imagen|satelite/.test(t)) {
    setMode("raw");
    const avg = (arr, a, b) => { let s = 0; for (let y = a; y <= b; y++) for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i >= 0) s += arr[i]; } return s / (b - a + 1); };
    if (Z.raw) { const n0 = avg(Z.naive, 2009, 2011), n1 = avg(Z.naive, 2013, 2015), h0 = avg(Z.h, 2009, 2011), h1 = avg(Z.h, 2013, 2015);
      say.push(`Si mezclamos los satélites sin corregir, ${z} pasa de ${fmt(n0)} focos al año en 2009–2011 a ${fmt(n1)} en 2013–2015: ${nf1.format(n1 / n0)} veces más, solo por cambiar de satélite. ${Math.abs(h1 / h0 - 1) < 0.1 ? "Con los datos corregidos, en realidad apenas cambia." : `Con los datos corregidos, el cambio real es de ${nf1.format(h1 / h0)} veces.`}`); }
  } else if (/anomal|raro|inusual|habitual/.test(t) && !/pais/.test(t)) {
    setMode("anom"); say.push(`En el calendario, en rojo los meses con más fuego de lo habitual en ${z} y en azul los que tuvieron menos.`);
  }
  if (/foto|imagen|satelite|como se veia/.test(t) && mesIdx >= 0) {
    const y = yearM ? +yearM[1] : CY; focusMonth(y, mesIdx + 1).then(() => {});
    say.push(`Te enseño ${MESES_L[mesIdx]} de ${y} en el mapa, con la foto del satélite de su día con más fuego.`);
  } else if (mesIdx >= 0 && yearM) {
    const y = +yearM[1], m = mesIdx + 1, i = iOf(y, m);
    if (validMonth(i)) { focusMonth(y, m); const p = pctRank(BASE[m - 1].vals, Z.h[i]); say.push(`En ${MESES_L[m - 1]} de ${y}, ${z} tuvo ${fmt(Z.h[i])} focos de calor; lo habitual en ${MESES_L[m - 1]} son ${fmt(BASE[m - 1].med)}, así que fue ${levelTxt(p)}.`); }
  }
  if (/cuando|temporada|epoca|que meses/.test(t)) { showTab("resumen"); say.push(`En ${z} se quema sobre todo en ${MESES_L[REC.order[0]]} y ${MESES_L[REC.order[1]]}, seguidos de ${MESES_L[REC.order[2]]}.`); }
  if (/(mayor|ultimo|reciente|grande|actual)\w* incendio|incendio\w* (mas grande|mayor|reciente|actual)|compara\w* (el|un|este) incendio/.test(t)) say.push(eventsSpeech(t));
  else if (/que paises|paises van|pais va peor|peor pais|ranking/.test(t)) {
    const r = Object.values(COUNTRY_STATS).filter((c) => c.ytdMed > 20).sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, 3);
    S.zone = "EU"; syncZone(); setMapView("paises"); update(false); showTab("resumen");
    say.push(`Los países con más fuego respecto a lo habitual este año son ${r.map((c) => `${c.name} (${fmt(c.ytd)} focos, lo habitual son ${fmt(c.ytdMed)})`).join(", ")}.`);
  } else if (/peor ano|record|ano con mas/.test(t) && REC.rec) say.push(`El año con más fuego en ${z} fue ${REC.rec[0]}, con unos ${fmt(REC.rec[1])} focos de calor.`);
  if (!say.length || (/este ano|este mes|como va|como esta|ahora|hoy|situacion/.test(t) && say.length < 2)) {
    const a = KPI.find((k) => k.id === "anio"), m = KPI.find((k) => k.id === "mes");
    say.push(`${Z1} lleva ${fmt(a.n)} focos de calor en ${CY}, ${diffTxt(a.n, a.med)} a estas alturas: ${levelTxt(a.p)}. Este mes van ${fmt(m.n)}, cuando lo habitual son ${fmt(m.med)}.`);
  }
  return say.join(" ");
}
function answer(q) {
  const txt = interpret(q);
  $("answer").hidden = false; $("answer").innerHTML = `<div class="q">«${q.replace(/</g, "&lt;")}»</div>${txt}`;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(txt); u.lang = "es-ES"; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith("es-ES")); if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
}

function initUI() {
  initZone(); initYears(); initTabs(); initHelp(); initAssistant();
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => { S.mode = r.value; renderCalendar(); }));
  $("nums").addEventListener("change", renderCalendar);
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => showTab(currentTab), 200); });
  syncZone();
}
