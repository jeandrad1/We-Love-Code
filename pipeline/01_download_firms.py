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
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

import config as C

BASE = "https://firms.modaps.eosdis.nasa.gov"
INSTR = {"modis": 2000, "viirs-snpp": 2012, "viirs-jpss1": 2018, "viirs-jpss2": 2023}
ZIP_PATTERNS = [BASE + "/data/country/zips/{inst}_{year}_all_countries.zip",
                BASE + "/data/world/zips/{inst}_{year}_all_countries.zip"]


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
                        if r.status_code != 200 or "zip" not in r.headers.get("content-type", "zip"):
                            continue
                        tmp = out.with_suffix(".part")
                        with open(tmp, "wb") as fh:
                            for chunk in r.iter_content(1 << 20):
                                fh.write(chunk)
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


def availability(key):
    r = requests.get(f"{BASE}/api/data_availability/csv/{key}/ALL", timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    return {row.data_id: (str(row.min_date)[:10], str(row.max_date)[:10]) for row in df.itertuples()}


def fetch(key, source, bbox, start, day_range):
    w, s, e, n = bbox
    url = f"{BASE}/api/area/csv/{key}/{source}/{w},{s},{e},{n}/{day_range}/{start}"
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=180)
        except requests.RequestException:
            time.sleep(10 * (attempt + 1)); continue
        t = r.text
        if r.ok and t.startswith("latitude"):
            return t
        if "limit" in t.lower():
            print("   límite de transacciones; espero 60 s", file=sys.stderr); time.sleep(60); continue
        if r.ok and not t.strip():
            return "latitude\n"
        raise RuntimeError(f"{source} {start}: {r.status_code} {t[:200]}")
    raise RuntimeError("demasiados reintentos")


def download_recent(key, start, end, day_range=10):
    avail = availability(key)
    w0, s0, e0, n0 = C.BBOX
    tiles = [(x, y, min(x + 10, e0), min(y + 10, n0)) for x in range(int(w0), int(e0), 10) for y in range(int(s0), int(n0), 10)]
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
                time.sleep(0.3)
            d += timedelta(days=day_range)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    ap.add_argument("--solo-reciente", action="store_true")
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
    download_recent(a.key, start, today)


if __name__ == "__main__":
    main()
