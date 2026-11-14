"""Descarga puntos calientes de NASA FIRMS (API de área) para la caja de Andalucía.

Uso:
    export FIRMS_MAP_KEY=tu_clave      # https://firms.modaps.eosdis.nasa.gov/api/map_key/
    python pipeline/01_download_firms.py                 # todo el histórico + NRT
    python pipeline/01_download_firms.py --start 2024-01-01 --sources VIIRS_NOAA20_NRT

Es reanudable: cada trozo se guarda en data/raw/api/<FUENTE>/<fecha>.csv y no se vuelve a pedir.
Para el histórico completo suele ser más rápido el formulario "Archive Download" de FIRMS
(pide España, CSV); deja esos CSV en data/raw/archive/ y el script 02 los lee igual.
Siempre vuelve a correr este script para los últimos días (NRT) antes de la demo.
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


def availability(key):
    r = requests.get(f"{BASE}/api/data_availability/csv/{key}/ALL", timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    return {row.data_id: (row.min_date, row.max_date) for row in df.itertuples()}


def fetch(key, source, start, day_range):
    w, s, e, n = C.BBOX
    url = f"{BASE}/api/area/csv/{key}/{source}/{w},{s},{e},{n}/{day_range}/{start}"
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=120)
        except requests.RequestException as ex:
            print(f"   red: {ex}; reintento", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
            continue
        txt = r.text
        if r.ok and txt.startswith("latitude"):
            return txt
        if "limit" in txt.lower():
            print("   límite de transacciones; espero 60 s", file=sys.stderr)
            time.sleep(60)
            continue
        if r.ok and txt.strip() == "":
            return "latitude\n"
        raise RuntimeError(f"{source} {start}: {r.status_code} {txt[:200]}")
    raise RuntimeError(f"{source} {start}: demasiados reintentos")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default=os.environ.get("FIRMS_MAP_KEY"))
    ap.add_argument("--start", default=C.START_DATE)
    ap.add_argument("--end", default=date.today().isoformat())
    ap.add_argument("--sources", nargs="*", default=C.FIRMS_SOURCES)
    ap.add_argument("--day-range", type=int, default=10, help="días por petición (la API admite 1-10)")
    ap.add_argument("--refresh-days", type=int, default=12,
                    help="vuelve a pedir los trozos NRT de los últimos N días aunque existan")
    a = ap.parse_args()
    if not a.key:
        sys.exit("Falta la clave: export FIRMS_MAP_KEY=... o --key")

    avail = availability(a.key)
    today = date.today()
    for src in a.sources:
        if src not in avail:
            print(f"[{src}] no disponible en FIRMS, lo salto")
            continue
        lo = max(date.fromisoformat(a.start), date.fromisoformat(str(avail[src][0])[:10]))
        hi = min(date.fromisoformat(a.end), date.fromisoformat(str(avail[src][1])[:10]))
        out = C.RAW_API / src
        out.mkdir(parents=True, exist_ok=True)
        print(f"[{src}] {lo} → {hi}")
        d, n = lo, 0
        while d <= hi:
            f = out / f"{d.isoformat()}.csv"
            recent = src.endswith("NRT") and (today - d).days <= a.refresh_days
            if not f.exists() or recent:
                dr = min(a.day_range, (hi - d).days + 1)
                f.write_text(fetch(a.key, src, d.isoformat(), dr))
                n += 1
                time.sleep(0.5)
            d += timedelta(days=a.day_range)
        print(f"[{src}] {n} peticiones nuevas")


if __name__ == "__main__":
    main()
