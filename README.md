# PyrOrbit Code

**NASA Space Apps Challenge 2026** · Challenge: *Harmonization of MODIS and VIIRS Hot Spots* (proposed by CONAE)

**Live demo (v2):** <https://jeandrad1.github.io/We-Love-Code/>

PyrOrbit is a hot-spot calendar for 40 European countries, from 2000 to today. It merges MODIS (Terra and Aqua, 1 km) and VIIRS (S-NPP, NOAA-20 and NOAA-21, 375 m) detections into a single, comparable time series and presents it in a web app with:

- a night-time map of Europe showing its fires,
- a month-by-month calendar,
- a comparison against the usual levels for each country and month,
- individual fire events, and
- data downloads.

**Europe** here means the EU-27, the United Kingdom, Norway, Switzerland, Iceland, the Balkans, Ukraine, Moldova and Belarus. Russia is excluded. The full list lives in [`pipeline/config.py`](pipeline/config.py).

> [!NOTE]
> The data shipped in `web/data/` is **synthetic** (the web app shows a banner saying so). To use real data, follow steps 1–3 below.

## Quick start

To just look at the web app with the bundled sample data:

```bash
cd web
python -m http.server 8000     # open http://localhost:8000
```

## 1. Install

Requires Python 3.10+.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Download the data

You need a free FIRMS MAP_KEY: <https://firms.modaps.eosdis.nasa.gov/api/map_key/>

```bash
cd pipeline
python 00_countries.py                     # country polygons (Natural Earth)
export FIRMS_MAP_KEY=<your-map-key>        # Windows PowerShell: $env:FIRMS_MAP_KEY="<your-map-key>"
python 01_download_firms.py                # full past years + current year
```

- **Full years** come from the FIRMS yearly country summaries (one zip per year and instrument, with one CSV per country): <https://firms.modaps.eosdis.nasa.gov/country/>. The script tries the usual URL for those zips. If it can't find them, download them manually from that page and drop them, unchanged, into `data/raw/country/`. They are large (global coverage), so start early.
- **Alternative:** use the FIRMS *Archive Download* form and draw a polygon around Europe. Put the resulting CSVs in `data/raw/archive/`.
- **Current year** is fetched from the NRT API in 10° tiles. To refresh only recent data, run `python 01_download_firms.py --solo-reciente`. Use `--desde YYYY-MM-DD` to choose the start date (defaults to 1 January).

## 3. Process

```bash
python 02_clean.py        # common schema, quality filter, country per hot spot, static heat sources
python 03_harmonize.py    # per-country MODIS→VIIRS factors + validation
python 04_aggregate.py    # web data (add --sinteticos only when using test data)
python 05_reported.py     # burned area per country (GWIS / Copernicus, via Our World in Data)
```

With 8 million test hot spots, steps 02–04 take about 3 minutes.

To generate synthetic test data instead of downloading real data, run `python tests/make_synthetic.py [scale]`.

## 4. Run and publish the web app

```bash
cd web
python -m http.server 8000     # http://localhost:8000
```

To publish on GitHub Pages, push the repository and choose *Settings → Pages → Source: GitHub Actions*. The workflow [`.github/workflows/static.yml`](.github/workflows/static.yml) deploys the `web/` folder.

## Method

- **Common unit: VIIRS S-NPP-equivalent hot spots.** Each month is counted from a single satellite, never summed, in this order of preference: S-NPP > NOAA-20 > NOAA-21 > Terra+Aqua > Terra.
- **One MODIS→VIIRS factor per country**, calibrated over the 2012–2020 overlap, with a 90 % interval from a bootstrap over years. A per-country factor is needed because fire regimes differ widely: the Mediterranean has large forest fires that MODIS sees well, while the east has many small agricultural burns that MODIS misses. Countries with fewer than 400 MODIS detections in the overlap fall back to the European factor.
- **NOAA-20 and NOAA-21** are calibrated against S-NPP. The factor `a` covers the months before Aqua was launched.
- **Validation:** one overlap year is held out, VIIRS is estimated from MODIS, and the estimate is compared with the actual VIIRS count. This is done per country and for Europe as a whole, comparing three options: uncorrected, European factor, and per-country factor.
- **Cleaning:** low-confidence detections are dropped, as are static heat sources: ~1 km cells with VIIRS detections on 25 or more days spread over 8 or more months of the year (industry, gas flares, solar plants). Agricultural burns also recur, but within a few months, so they are kept.
- **Fire events:** hot spots within ≤2 km and ≤2 days of each other are merged into a single fire. Fires with 15 or more hot spots are kept.
- **The web app never loads millions of points.** It loads per-country series, a ~50 km grid for maps and user-drawn areas, the fire events, and individual hot spots for the last 24 months only.

### Limitations

- User-drawn areas are computed from ~50 km cells, so results are approximate.
- A month with no hot spots may be due to cloud cover.
- GWIS burned area is another satellite-based measurement, not an official statistic. If you have the official EFFIS tables per country, place them in `data/raw/reportado_extra.csv` with the columns `iso,year,incendios,hectareas_oficiales` and the web app will show them too.

## Project structure

```
pipeline/   config.py, 00_countries.py … 05_reported.py   data download and processing
tests/      make_synthetic.py                              synthetic test data for Europe
web/        index.html, style.css
            app.js     core
            map.js     map
            extras.js  countries, fire events, bands
            ui.js      landing page, tabs, voice
docs/       challenge form, method, setup guide, structure
```

## Data sources

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) — MODIS and VIIRS active fire detections
- [Natural Earth](https://www.naturalearthdata.com/) — country boundaries
- [GWIS / Copernicus](https://gwis.jrc.ec.europa.eu/) via [Our World in Data](https://ourworldindata.org/) — burned area per country
