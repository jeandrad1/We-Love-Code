# Calendario de quemas de Andalucía 🔥🛰

NASA Space Apps Challenge 2026 · Reto *Harmonization of MODIS and VIIRS Hot Spots* (CONAE)

Una serie única de puntos calientes de 2000 a hoy para Andalucía, que combina MODIS (Terra/Aqua, 1 km) y VIIRS (S-NPP, NOAA-20 y NOAA-21, 375 m), y una web para consultarla por provincia, por zona dibujada o por coordenadas.

> ⚠ Los datos que trae `web/data/` ahora mismo son **sintéticos**, solo para probar (la web lo avisa con un banner). Sigue los pasos 1–3 con tu clave de FIRMS para generar los reales.

## Estructura

```
pipeline/
  config.py               región, fuentes, filtros y ventana de calibración
  01_download_firms.py    descarga FIRMS por API (reanudable)
  02_clean.py             esquema común, confianza, recorte a Andalucía, fuentes estáticas
  03_harmonize.py         factores MODIS→VIIRS por mes + IC bootstrap + validación
  04_export_web.py        datos compactos para la web
tests/make_synthetic.py   genera CSV sintéticos con formato FIRMS
web/                      web estática (sin backend): index.html, app.js, style.css, data/
data/andalucia.geojson    polígono de Andalucía (Natural Earth, simplificado)
```

## 1 · Instalar

```bash
python -m venv .venv && source .venv/bin/activate   # en Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2 · Datos reales

1. Pide una MAP_KEY gratuita: https://firms.modaps.eosdis.nasa.gov/api/map_key/
2. **Hacedlo ya**, en paralelo: en https://firms.modaps.eosdis.nasa.gov/download/ pedid el archivo de **España**, en CSV, para MODIS C6.1, VIIRS S-NPP, VIIRS NOAA-20 y VIIRS NOAA-21, desde 2000. Llega por email y puede tardar. Dejad los CSV tal cual en `data/raw/archive/`.
3. Mientras tanto, o en vez de eso, por API:
   ```bash
   export FIRMS_MAP_KEY=xxxx
   python pipeline/01_download_firms.py            # todo; reanudable si se corta
   python pipeline/01_download_firms.py --start 2026-09-01   # solo lo reciente (NRT)
   ```
   **Antes de la demo**, vuelve a lanzar la segunda línea para que el "mes en curso" esté al día.

## 3 · Procesar

```bash
cd pipeline
python 02_clean.py
python 03_harmonize.py      # imprime los factores y la validación
python 04_export_web.py     # (para datos de prueba: --synthetic)
```

## 4 · Ver la web

```bash
cd web && python -m http.server 8000     # abre http://localhost:8000
```

Para publicarla, sube la carpeta `web/` a GitHub Pages o Netlify. Es estática y no necesita servidor.

## Método de armonización

- **Unidad común:** puntos calientes *equivalentes VIIRS S-NPP*. El futuro es VIIRS, así que la serie sigue sin saltos cuando MODIS y S-NPP se apagan.
- **Calibración por mes del año** (con ventana ±1 mes), porque la proporción VIIRS/MODIS depende del tipo de fuego. Las quemas agrícolas son pequeñas y MODIS ve pocas; los incendios de verano son grandes.
  - `r[m]` = S-NPP / (Terra+Aqua), en el solape 2012–2020. Se corta en 2020 porque las órbitas de Terra y Aqua derivan después.
  - `a[m]` = (Terra+Aqua) / Terra, para 2000-11 → 2002-06, cuando aún no existía Aqua.
  - `k20[m]`, `k21[m]` = S-NPP / NOAA-20 y S-NPP / NOAA-21, para continuar la serie tras S-NPP.
- **Una sola fuente por mes**, sin sumar nunca sensores: S-NPP > NOAA-20 > NOAA-21 > MODIS. Cada punto lleva una categoría que indica qué factor le aplica, así que la web recalcula la serie para cualquier polígono.
- **Incertidumbre:** intervalo del 90 % por bootstrap de años, que se muestra en la web y en el CSV.
- **Validación:** se deja un año fuera dentro del solape, más una prueba fuera de ventana (2021+). Se compara con "sin armonizar" y con "factor único sin estacionalidad".
- **Limpieza:** se quita la confianza baja, se queda solo `type = 0` y se descartan fuentes estáticas: celdas de ~1 km con VIIRS en ≥25 días distintos repartidos en ≥8 meses del año (industria, termosolares). Las quemas agrícolas se repiten, pero en pocos meses, y se conservan.

Limitaciones: los factores son regionales (toda Andalucía) y se aplican a cualquier subzona; en zonas pequeñas, fíjate en el intervalo. Un mes sin detecciones puede deberse a nubes.

## Asistente de voz e imagen del día

- **Voz:** botón «Pulsa y habla» (Web Speech API; funciona en Chrome y usa el reconocimiento de Google, así que necesita internet). Las preguntas se interpretan con reglas en `app.js` (función `interpret`), sin LLM ni servidor: provincias, «este mes», «anomalías», «sin armonizar / salto», «cuándo se quema», «peor año», «imagen de agosto de 2022», «agosto de 2017». La respuesta se lee en voz alta y se escribe en el panel. Si el micrófono falla, la caja de texto hace lo mismo.
- **Imagen del día (NASA GIBS):** sustituye el mapa base por la imagen de satélite del día elegido: MODIS Terra antes de 2012, VIIRS S-NPP de 2012 a 2019 y NOAA-20 después. Hay dos opciones: color real (se ve el humo) o falso color (se ven las zonas quemadas). Al pulsar una celda del calendario, el mapa se filtra a ese mes y muestra la imagen de su día con más detecciones.

Para la demo: ensayad las frases exactas y llevad grabado un vídeo de reserva por si fallan el micrófono o la red.

## Comparación con lo reportado (opcional, recomendable)

Si existe `web/data/reported.csv` con columnas `year,provincia,incendios`, la web muestra la serie armonizada frente a los incendios oficiales y su correlación anual. Tienes una plantilla en `data/reported_PLANTILLA.csv`. Fuentes posibles:

- Estadística General de Incendios Forestales (EGIF), MITECO: incendios por provincia y año.
- REDIAM (Junta de Andalucía): áreas recorridas por el fuego.

Usa `provincia = Andalucía` para el total regional y el nombre de la provincia para cada una.

## Ideas para la demo (3 min)

1. Modo **"Sin armonizar"**: el salto de 2012 parece un aumento de incendios, pero es el cambio de sensor.
2. Modo **"Puntos armonizados"**: la serie es continua, y el panel de validación lo demuestra con números.
3. Provincia de **Jaén o Córdoba**: con datos reales esperamos ver un pico en invierno y primavera por la quema de restos de poda del olivar, además del de verano. En las marismas del Guadalquivir (Sevilla), uno en otoño por la paja de arroz. Comprobadlo antes de contarlo, porque en los datos sintéticos está puesto a mano.
4. **Mes en curso frente a la mediana** de los mismos días en años anteriores. Es la pregunta que haría un gestor del INFOCA.
5. Descargar el CSV y el calendario en SVG.
