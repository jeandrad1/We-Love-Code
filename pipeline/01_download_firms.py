"""Descarga los focos de calor de FIRMS para Europa.

Dos partes:
  1) Años completos: resúmenes anuales por país de FIRMS (un zip por año e instrumento con un CSV por país).
     Página: https://firms.modaps.eosdis.nasa.gov/country/
     El script prueba la ruta habitual de esos zips. Si FIRMS la cambia, descárgalos a mano desde esa
     página y déjalos en data/raw/country/ (zip o CSV sueltos, tal cual): el paso 02 los lee igual.
     Alternativa: formulario "Archive Download" con un polígono de Europa -> CSV en data/raw/archive/.
  2) Año en curso: API de área (NRT), en teselas de 10°, para todas las fuentes.

Uso:
    export FIRMS_MAP_KEY=tu_clave
    python 01_download_firms.py                       # todo
    python 01_download_firms.py --solo-reciente       # solo el año en curso (antes de la demo)
"""
import argparse
import io
import re
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

import config as C

BASE = "https://firms.modaps.eosdis.nasa.gov"
INSTR = {"modis": 2000, "viirs-snpp": 2012, "viirs-jpss1": 2018, "viirs-jpss2": 2023}
ZIP_PATTERNS = ["https://firms2.modaps.eosdis.nasa.gov/data/country/zips/{inst}_{year}_all_countries.zip",
                BASE + "/data/country/zips/{inst}_{year}_all_countries.zip"]
TILE_DEG = 25      # teselas grandes: menos peticiones a la API


def download_country_zips(last_full_year):
    C.RAW_COUNTRY.mkdir(parents=True, exist_ok=True)
    fallos = []
    for inst, y0 in INSTR.items():
        for y in range(max(y0, C.START_YEAR), last_full_year + 1):
            out = C.RAW_COUNTRY / f"{inst}_{y}_all_countries.zip"
            if out.exists() and out.stat().st_size > 1000:
                continue
            ok = False
            for pat in ZIP_PATTERNS:
                url = pat.format(inst=inst, year=y)
                try:
                    with requests.get(url, stream=True, timeout=600) as r:
                        if r.status_code != 200:
                            continue
                        tmp = out.with_suffix(".part")
                        with open(tmp, "wb") as fh:
                            for chunk in r.iter_content(1 << 20):
                                fh.write(chunk)
                    if open(tmp, "rb").read(2) != b"PK":      # no es un zip (p. ej. una página de error)
                        tmp.unlink(); continue
                    tmp.rename(out)
                    ok = True
                    print(f"  {out.name}: {out.stat().st_size / 1e6:.0f} MB")
                    break
                except requests.RequestException as ex:
                    print(f"  {url}: {ex}", file=sys.stderr)
            if not ok:
                fallos.append(f"{inst} {y}")
    if fallos:
        print("\nNo se pudieron descargar automáticamente:", ", ".join(fallos))
        print("Descárgalos a mano desde https://firms.modaps.eosdis.nasa.gov/country/ y déjalos en", C.RAW_COUNTRY)


class DayRangeError(Exception):
    pass


def availability(key):
    r = requests.get(f"{BASE}/api/data_availability/csv/{key}/ALL", timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    return {row.data_id: (str(row.min_date)[:10], str(row.max_date)[:10]) for row in df.itertuples()}


def fetch(key, source, bbox, start, day_range):
    try:
        return _fetch(key, source, bbox, start, day_range)
    except DayRangeError as ex:   # la API admite menos días: se parte la petición
        mx, out, d0 = ex.args[0], [], date.fromisoformat(start)
        for k in range(0, day_range, mx):
            txt = _fetch(key, source, bbox, (d0 + timedelta(days=k)).isoformat(), min(mx, day_range - k))
            out.append(txt if not out else txt.split("\n", 1)[1] if "\n" in txt else "")
        return "".join(out)


def _fetch(key, source, bbox, start, day_range):
    w, s, e, n = bbox
    url = f"{BASE}/api/area/csv/{key}/{source}/{w},{s},{e},{n}/{day_range}/{start}"
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=300)
        except requests.RequestException:
            time.sleep(10 * (attempt + 1)); continue
        t = r.text
        if r.ok and t.startswith("latitude"):
            return t
        if "limit" in t.lower():
            print("   límite de transacciones; espero 60 s", file=sys.stderr); time.sleep(60); continue
        if r.ok and not t.strip():
            return "latitude\n"
        m = re.search(r"Expects \[1\.\.(\d+)\]", t)
        if m and day_range > int(m.group(1)):
            raise DayRangeError(int(m.group(1)))
        raise RuntimeError(f"{source} {start}: {r.status_code} {t[:200]}")
    raise RuntimeError("demasiados reintentos")


def land_tiles():
    """Teselas de la caja de Europa que tocan algún país (las de solo mar no se piden)."""
    import json
    import shapely
    from shapely.geometry import box, shape
    land = shapely.union_all([shape(f["geometry"]) for f in json.load(open(C.COUNTRIES_GEOJSON))["features"]])
    w0, s0, e0, n0 = C.BBOX
    out = []
    for x in range(int(w0), int(e0), TILE_DEG):
        for y in range(int(s0), int(n0), TILE_DEG):
            t = (x, y, min(x + TILE_DEG, e0), min(y + TILE_DEG, n0))
            if land.intersects(box(*t)):
                out.append(t)
    return out


def download_recent(key, start, end, day_range=5):
    avail = availability(key)
    tiles = land_tiles()
    for src in C.FIRMS_SOURCES:
        if src not in avail:
            continue
        lo = max(start, date.fromisoformat(avail[src][0])); hi = min(end, date.fromisoformat(avail[src][1]))
        if lo > hi:
            continue
        out = C.RAW_API / src; out.mkdir(parents=True, exist_ok=True)
        print(f"[{src}] {lo} → {hi}, {len(tiles)} teselas")
        d = lo
        while d <= hi:
            for t in tiles:
                f = out / f"{d.isoformat()}_{t[0]}_{t[1]}.csv"
                recent = src.endswith("NRT") and (end - d).days <= 12
                if f.exists() and not recent:
                    continue
                f.write_text(fetch(key, src, t, d.isoformat(), min(day_range, (hi - d).days + 1)))
                n_req = getattr(download_recent, "n", 0) + 1; download_recent.n = n_req
                if n_req % 50 == 0:
                    print(f"   {n_req} peticiones… ({src} {d})")
                time.sleep(0.3)
            d += timedelta(days=day_range)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    ap.add_argument("--solo-reciente", action="store_true", help="no intenta los zips anuales")
    ap.add_argument("--desde", help="fecha AAAA-MM-DD desde la que pedir a la API (por defecto, 1 de enero)")
    a = ap.parse_args()
    today = date.today()
    if not a.solo_reciente:
        download_country_zips(today.year - 1)
    if not a.key:
        sys.exit("Para el año en curso hace falta la clave: export FIRMS_MAP_KEY=...")
    # Si el resumen anual del año pasado aún no está publicado, se pide también por API
    start = date(today.year, 1, 1)
    if not list(C.RAW_COUNTRY.glob(f"*viirs*{today.year - 1}*")):
        start = date(today.year - 1, 1, 1)
        print(f"Sin resumen anual de {today.year - 1}: se descarga por API desde {start}")
    if a.desde:
        start = date.fromisoformat(a.desde)
    download_recent(a.key, start, today)


if __name__ == "__main__":
    main()