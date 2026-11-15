# PyrOrbit Code

NASA Space Apps Challenge 2026, reto *Harmonization of MODIS and VIIRS Hot Spots* (propuesto por CONAE).

Un calendario de focos de calor para 40 países europeos, de 2000 a hoy. Combina MODIS (Terra y Aqua, 1 km) y VIIRS (S-NPP, NOAA-20 y NOAA-21, 375 m) en una sola serie comparable, y lo muestra en una web: mapa de Europa de noche con sus fuegos, calendario por meses, comparación con lo habitual, incendios y descargas.

**Europa** son aquí la UE-27, Reino Unido, Noruega, Suiza, Islandia, los Balcanes, Ucrania, Moldavia y Bielorrusia. Rusia queda fuera. La lista está en `pipeline/config.py`.

> Los datos que trae `web/data/` son **sintéticos** (la web lo avisa con un banner). Para usar los reales, sigue los pasos 1–3.

## 1. Instalar

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Descargar los datos

```bash
cd pipeline
python 00_countries.py                    # polígonos de los países (Natural Earth)
export FIRMS_MAP_KEY=89a4b097fa2024d4a25f619a406e05dc             # https://firms.modaps.eosdis.nasa.gov/api/map_key/
python 01_download_firms.py               # años completos + año en curso
```

- **Años completos:** salen de los resúmenes anuales por país de FIRMS (un zip por año e instrumento, con un CSV por país): https://firms.modaps.eosdis.nasa.gov/country/. El script prueba la ruta habitual de esos zips. Si no la encuentra, descárgalos a mano desde esa página y déjalos tal cual en `data/raw/country/`. Son grandes (todo el mundo), así que empezad cuanto antes.
- **Alternativa:** el formulario *Archive Download* de FIRMS, dibujando un polígono de Europa. Los CSV van a `data/raw/archive/`.
- **Año en curso:** se descarga por la API (NRT) en teselas de 10°. Antes de la demo, repetid `python 01_download_firms.py --solo-reciente`.

## 3. Procesar

```bash
python 02_clean.py        # esquema común, calidad, país de cada foco, fuentes fijas de calor
python 03_harmonize.py    # factores MODIS→VIIRS por país + validación
python 04_aggregate.py    # datos para la web (añadid --sinteticos solo con datos de prueba)
python 05_reported.py     # área quemada por país (GWIS / Copernicus, vía Our World in Data)
```

Con 8 millones de focos de prueba, los pasos 02–04 tardan unos 3 minutos.

## 4. Ver y publicar la web

```bash
cd web && python -m http.server 8000     # http://localhost:8000
```

Para publicarla en GitHub Pages: subid el repositorio y elegid *Settings → Pages → Source: GitHub Actions*. El flujo `.github/workflows/pages.yml` publica la carpeta `web/`.

## Método

- **Unidad común: focos equivalentes VIIRS S-NPP.** Cada mes se cuenta con un solo satélite (S-NPP > NOAA-20 > NOAA-21 > Terra+Aqua > Terra), nunca sumando.
- **Un factor MODIS→VIIRS por país**, calibrado en el solape 2012–2020, con intervalo del 90 % por bootstrap de años. Hace falta uno por país porque el tipo de fuego cambia mucho: en el Mediterráneo hay grandes incendios forestales que MODIS ve bien; en el este, muchas quemas agrícolas pequeñas que MODIS se pierde. Los países con menos de 400 detecciones MODIS en el solape usan el factor europeo.
- **NOAA-20 y NOAA-21** se calibran contra S-NPP. El factor `a` cubre los meses anteriores a Aqua.
- **Validación:** se esconde un año del solape, se estima VIIRS a partir de MODIS y se compara con la realidad. Se hace por país y para Europa, comparando tres opciones: sin corregir, factor europeo y factor por país.
- **Limpieza:** se descartan las detecciones de baja confianza y las fuentes fijas de calor: celdas de ~1 km con VIIRS en 25 días o más repartidos en 8 meses o más del año (industria, antorchas, plantas solares). Las quemas agrícolas se repiten, pero en pocos meses, y se conservan.
- **Incendios:** los focos a ≤2 km y ≤2 días entre sí se unen en un incendio. Se guardan los de 15 focos o más.
- **La web no carga millones de puntos.** Carga series por país, una rejilla de ~50 km para mapas y zonas dibujadas, los incendios y los focos individuales de los últimos 24 meses.

Limitaciones:
- Las zonas dibujadas se calculan con celdas de ~50 km, así que son aproximadas.
- Un mes sin focos puede deberse a nubes.
- El área quemada de GWIS es otra medición por satélite, no una estadística oficial. Si conseguís las tablas oficiales de EFFIS por país, ponedlas en `data/raw/reportado_extra.csv` con las columnas `iso,year,incendios,hectareas_oficiales` y la web las ofrecerá también.

## Estructura

```
pipeline/  config.py, 00_countries.py … 05_reported.py
tests/     make_synthetic.py (datos de prueba para Europa)
web/       index.html, style.css, app.js (núcleo), map.js (mapa), extras.js (países, incendios, franjas), ui.js (portada, pestañas, voz)
```

## Ideas para la demo

1. **Portada:** el mapa de Europa de noche y la frase «Europa lleva X focos de calor este año…».
2. **Mapa «Frente a lo habitual»:** qué países van peor este año. Al pulsar uno, toda la web pasa a ese país.
3. **Calendario «Sin corregir»:** el salto falso de 2012. Después, «Cantidad» con la serie corregida.
4. **Incendios:** el más reciente comparado con los anteriores. Al pulsarlo se ve avanzar en el mapa, con la foto del satélite.
5. **Voz:** «¿qué países van peor?», «el mayor incendio de Portugal».
