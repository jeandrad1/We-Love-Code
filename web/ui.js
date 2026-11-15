/* Interface: area and years, headline, tabs, guide and voice assistant. */
"use strict";

const TABS = ["resumen", "calendario", "incendios", "metodo"];
let currentTab = "resumen";

function showTab(name, focus = false) {
  if (!TABS.includes(name)) return;
  currentTab = name;
  TABS.forEach((t) => { const on = t === name; $("tab-" + t).setAttribute("aria-selected", on); $("tab-" + t).tabIndex = on ? 0 : -1; $("p-" + t).hidden = !on; });
  if (focus) $("tab-" + name).focus();
  requestAnimationFrame(() => {   // charts are drawn with their real width when shown
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

// ---------- Area ----------
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
  if (S.zone === "draw" && !S.geom) { hint.hidden = false; hint.textContent = "Drag on the map to draw a rectangle. With the pentagon button (top right of the map) you can draw a polygon."; }
  else if (S.zone === "circle" && !S.circle) { hint.hidden = false; hint.textContent = "Enter the center coordinates and the radius, then click “Show area”."; }
  else hint.hidden = true;
}
function initZone() {
  const z = $("zone");
  z.add(new Option("All of Europe", "EU"));
  const g = document.createElement("optgroup"); g.label = "Countries";
  D.meta.paises.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "en")).forEach((p) => g.appendChild(new Option(p.nombre, p.iso)));
  z.appendChild(g);
  const o = document.createElement("optgroup"); o.label = "Other area";
  o.appendChild(new Option("Draw it on the map…", "draw")); o.appendChild(new Option("Around a point…", "circle"));
  z.appendChild(o);
  z.addEventListener("change", () => selectZone(z.value));
  $("applyCircle").addEventListener("click", () => { S.zone = "circle"; S.circle = { lat: +$("lat").value, lon: +$("lon").value, km: +$("rad").value }; syncZone(); update(true); });
}
function initYears() {
  const y0 = yOf(0), A = $("yFrom"), B = $("yTo");
  [A, B].forEach((r) => { r.min = y0; r.max = CY; });
  A.value = S.yA; B.value = S.yB;
  // Ticks every 5 years under the slider
  const pos = (y) => (100 * (y - y0)) / Math.max(1, CY - y0);
  const ticks = [y0]; for (let y = Math.ceil((y0 + 1) / 5) * 5; y < CY - 1; y += 5) ticks.push(y); ticks.push(CY);
  $("tsTicks").innerHTML = ticks.map((y) => `<span style="left:${pos(y)}%">${y}</span>`).join("");
  const paint = () => {
    const a = +A.value, b = +B.value;
    $("dualFill").style.left = pos(a) + "%"; $("dualFill").style.right = (100 - pos(b)) + "%";
    $("tsRange").textContent = a === b ? `${a}` : `${a} – ${b}`;
    A.setAttribute("aria-valuetext", `from ${a}`); B.setAttribute("aria-valuetext", `to ${b}`);
    // The left handle stays on top if they are together at the end
    A.style.zIndex = a >= CY - 1 ? 3 : 2; B.style.zIndex = 2;
    document.querySelectorAll(".quick button").forEach((q) => {
      const r = q.dataset.range, on = b === CY && (r === "all" ? a === y0 : a === Math.max(y0, CY - (+r) + 1));
      q.setAttribute("aria-pressed", on);
    });
  };
  const apply = () => {
    S.yA = +A.value; S.yB = +B.value; S.mapMonth = null;
    renderCalendar(); renderAnnual(); renderMapLayer(false); renderEvents(); renderStripes();
  };
  A.addEventListener("input", () => { if (+A.value > +B.value) A.value = B.value; paint(); });
  B.addEventListener("input", () => { if (+B.value < +A.value) B.value = A.value; paint(); });
  A.addEventListener("change", apply); B.addEventListener("change", apply);
  document.querySelectorAll(".quick button").forEach((q) => q.addEventListener("click", () => {
    const r = q.dataset.range;
    A.value = r === "all" ? y0 : Math.max(y0, CY - (+r) + 1); B.value = CY;
    paint(); apply();
  }));
  paint();
}

// ---------- Header ----------
function renderHero() {
  // No hero block: the plain-words summary lives in the Summary tab
  document.title = `PyrOrbit Code · ${zoneLabel()}`;
  $("dataDate").textContent = `Data up to ${DD} ${MESES_L[CM - 1]} ${CY}`;
}
// ---------- Guide and assistant ----------
function initHelp() {
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  let seen = false;
  try { seen = localStorage.getItem("guiaEuropa") === "1"; localStorage.setItem("guiaEuropa", "1"); } catch (e) { /* no storage */ }
  if (!seen) $("help").showModal();
}
function initAssistant() {
  const btn = $("assistantBtn"), panel = $("assistantPanel");
  const toggle = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", open); if (open) $("ask").focus(); };
  btn.addEventListener("click", () => toggle(panel.hidden));
  // On mobile the floating button would cover the year bar: it moves away while that is on screen
  if ("IntersectionObserver" in window) {
    const box = document.querySelector(".assistant");
    new IntersectionObserver(([e]) => box.classList.toggle("fab-away", e.isIntersecting && innerWidth <= 560 && panel.hidden), { threshold: 0 })
      .observe(document.querySelector(".map-bottom"));
  }
  $("assistantClose").addEventListener("click", () => { toggle(false); btn.focus(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { toggle(false); btn.focus(); } });
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("ask").value.trim(); if (q) answer(q); });
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("mic").textContent = "Voice needs Chrome; you can type instead"; $("mic").disabled = true; return; }
  const rec = new SR(); rec.lang = "en-US"; rec.interimResults = true;
  let final = "";
  rec.onresult = (e) => { final = [...e.results].map((r) => r[0].transcript).join(" "); $("ask").value = final; };
  rec.onend = () => { $("mic").classList.remove("on"); $("mic").textContent = "Press and speak"; if (final.trim()) answer(final.trim()); };
  rec.onerror = (e) => { $("answer").hidden = false; $("answer").textContent = "I could not hear you (" + e.error + "). You can type the question."; };
  $("mic").addEventListener("click", () => { final = ""; speechSynthesis.cancel(); $("mic").classList.add("on"); $("mic").textContent = "Listening…"; rec.start(); });
}
const norm = (t) => t.toLowerCase().replace(/(\d),(\d{3})\b/g, "$1$2").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[¿?¡!.,]/g, " ");
const COUNTRY_ALIASES = { CZE: ["czech republic"], GBR: ["uk", "britain", "great britain", "england"], MKD: ["macedonia"], NLD: ["holland", "the netherlands"], BIH: ["bosnia"], BLR: ["byelorussia"] };
function setMode(mode) { S.mode = mode; document.querySelector(`input[name=mode][value=${mode}]`).checked = true; showTab("calendario"); }
function interpret(text) {
  const t = norm(text), say = [];
  let zoneChanged = false;
  const names = [];
  D.meta.paises.forEach((p) => { names.push([norm(p.nombre).trim(), p.iso]); (COUNTRY_ALIASES[p.iso] || []).forEach((a) => names.push([a, p.iso])); });
  names.sort((a, b) => b[0].length - a[0].length);
  for (const [n, iso] of names) if (new RegExp("\\b" + n + "\\b").test(t)) { S.zone = iso; zoneChanged = true; break; }
  if (!zoneChanged && /\beurope\b|whole continent/.test(t)) { S.zone = "EU"; zoneChanged = true; }
  if (zoneChanged) { S.event = null; S.mapMonth = null; drawn.clearLayers(); syncZone(); update(true); }
  const z = zoneLabel(), Z1 = z[0].toUpperCase() + z.slice(1);
  const yearM = t.match(/\b(20[0-2]\d)\b/);
  // Whole words only; "may" counts as the month only next to a year or after in/of/during (not "may I see…")
  const mesIdx = MESES_L.findIndex((mm) => { const w = mm.toLowerCase(); return new RegExp("\\b" + w + "\\b").test(t) && (w !== "may" || !!yearM || /\b(in|of|during|last|this) may\b/.test(t)); });
  if (/uncorrected|unharmoni[sz]ed|raw data|\bjump\b|2012/.test(t) && !/photo|image|satellite photo|picture/.test(t)) {
    setMode("raw");
    const avg = (arr, a, b) => { let s = 0; for (let y = a; y <= b; y++) for (let m = 1; m <= 12; m++) { const i = iOf(y, m); if (i >= 0) s += arr[i]; } return s / (b - a + 1); };
    if (Z.raw) { const n0 = avg(Z.naive, 2009, 2011), n1 = avg(Z.naive, 2013, 2015), h0 = avg(Z.h, 2009, 2011), h1 = avg(Z.h, 2013, 2015);
      say.push(`If we mix the satellites without correcting, ${z} goes from ${fmt(n0)} hotspots a year in 2009–2011 to ${fmt(n1)} in 2013–2015: ${nf1.format(n1 / n0)} times more, just because of the change of satellite. ${Math.abs(h1 / h0 - 1) < 0.1 ? "With the corrected data, it hardly changes in reality." : `With the corrected data, the real change is ${nf1.format(h1 / h0)} times.`}`); }
  } else if (/anomal|unusual|abnormal|usual/.test(t) && !/countr/.test(t)) {
    setMode("anom"); say.push(`In the calendar, months with more fire than usual in ${z} are red and months with less are blue.`);
  }
  if (/photo|image|satellite|picture|how .* looked/.test(t) && mesIdx >= 0) {
    const y = yearM ? +yearM[1] : CY; focusMonth(y, mesIdx + 1).then(() => {});
    say.push(`Here is ${MESES_L[mesIdx]} ${y} on the map, with the satellite photo of its day with the most fire.`);
  } else if (mesIdx >= 0 && yearM) {
    const y = +yearM[1], m = mesIdx + 1, i = iOf(y, m);
    if (validMonth(i)) { focusMonth(y, m); const p = pctRank(BASE[m - 1].vals, Z.h[i]); say.push(`In ${MESES_L[m - 1]} ${y}, ${z} had ${fmt(Z.h[i])} hotspots; the usual for ${MESES_L[m - 1]} is ${fmt(BASE[m - 1].med)}, so it was ${levelTxt(p)}.`); }
  }
  if (/\bwhen\b|season|which months|what months/.test(t)) { showTab("resumen"); say.push(`In ${z} it burns mostly in ${MESES_L[REC.order[0]]} and ${MESES_L[REC.order[1]]}, followed by ${MESES_L[REC.order[2]]}.`); }
  if (/(biggest|largest|greatest|latest|last|recent|current|worst)\s+(wild)?fires?|(wild)?fires?\s+(biggest|largest|latest)|compar\w* (the|a|this) (wild)?fire/.test(t)) say.push(eventsSpeech(t));
  else if (/which countries|countries (are|do|have)|worst countr|country .*worst|ranking/.test(t)) {
    const r = Object.values(COUNTRY_STATS).filter((c) => c.ytdMed > 20).sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, 3);
    S.zone = "EU"; syncZone(); setMapView("paises"); update(false); showTab("resumen");
    say.push(`The countries with the most fire relative to usual this year are ${r.map((c) => `${c.name} (${fmt(c.ytd)} hotspots, usual is ${fmt(c.ytdMed)})`).join(", ")}.`);
  } else if (/worst year|record|year with the most|most fire/.test(t) && REC.rec) say.push(`The year with the most fire in ${z} was ${REC.rec[0]}, with about ${fmt(REC.rec[1])} hotspots.`);
  if (!say.length || (/this year|this month|how is|how's|how are|how does|\bnow\b|today|situation/.test(t) && say.length < 2)) {
    const a = KPI.find((k) => k.id === "anio"), m = KPI.find((k) => k.id === "mes");
    say.push(`${Z1} has ${fmt(a.n)} hotspots so far in ${CY}, ${diffTxt(a.n, a.med)} at this point: ${levelTxt(a.p)}. This month there are ${fmt(m.n)}, when the usual is ${fmt(m.med)}.`);
  }
  return say.join(" ");
}
function answer(q) {
  const txt = interpret(q);
  $("answer").hidden = false; $("answer").innerHTML = `<div class="q">“${q.replace(/</g, "&lt;")}”</div>${txt}`;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(txt); u.lang = "en-US"; u.rate = 1.05;
    const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith("en-")); if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
}

// Real height of the top bar, so the tabs sit right below it when scrolling
function trackBar() {
  const bar = document.querySelector(".bar");
  const set = () => document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px");
  set(); if ("ResizeObserver" in window) new ResizeObserver(set).observe(bar);
}

function initUI() {
  trackBar();
  initZone(); initYears(); initTabs(); initHelp(); initAssistant();
  document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => { S.mode = r.value; renderCalendar(); }));
  $("nums").addEventListener("change", renderCalendar);
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => showTab(currentTab), 200); });
  syncZone();
}