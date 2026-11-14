"""Une todas las descargas en un esquema común, recorta a Andalucía y limpia.

Salidas:
  data/clean/hotspots.parquet   un punto caliente por fila
  data/clean/coverage.json      primer/último día con datos por satélite (para la armonización)
  web/data/static_sources.geojson  celdas descartadas como fuentes estáticas
"""
import json
import re

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

import config as C

ARCHIVE_PATTERNS = [  # nombre de fichero del formulario de archivo de FIRMS -> instrumento/satélite
    (re.compile(r"M-C61|MODIS", re.I), "MODIS", None),
    (re.compile(r"J2V|NOAA21", re.I), "VIIRS", "NOAA21"),
    (re.compile(r"J1V|NOAA20", re.I), "VIIRS", "NOAA20"),
    (re.compile(r"SV-C2|SUOMI|SNPP", re.I), "VIIRS", "SNPP"),
]


def modis_sat(v):
    v = str(v).strip().lower()
    return "Terra" if v in ("t", "terra") else "Aqua" if v in ("a", "aqua") else None


def read_one(path, instrument, sat, processing):
    df = pd.read_csv(path, dtype={"acq_time": str, "confidence": str, "satellite": str})
    if df.empty:
        return None
    df["instrument"] = instrument
    df["sat"] = df["satellite"].map(modis_sat) if instrument == "MODIS" else sat
    df["processing"] = processing
    return df


def load_raw():
    parts = []
    for d in sorted(C.RAW_API.glob("*")):
        src = d.name
        instrument = "MODIS" if src.startswith("MODIS") else "VIIRS"
        sat = {"SNPP": "SNPP", "NOAA20": "NOAA20", "NOAA21": "NOAA21"}.get(src.split("_")[1]) if instrument == "VIIRS" else None
        proc = "SP" if src.endswith("SP") else "NRT"
        for f in sorted(d.glob("*.csv")):
            df = read_one(f, instrument, sat, proc)
            if df is not None:
                parts.append(df)
    for f in sorted(C.RAW_ARCHIVE.glob("*.csv")):
        for pat, instrument, sat in ARCHIVE_PATTERNS:
            if pat.search(f.name):
                proc = "NRT" if "nrt" in f.name.lower() else "SP"
                df = read_one(f, instrument, sat, proc)
                if df is not None:
                    parts.append(df)
                break
        else:
            print(f"  ¿{f.name}? no reconozco el sensor, lo salto")
    if not parts:
        raise SystemExit("No hay datos en data/raw/. Ejecuta 01_download_firms.py o copia CSV del archivo.")
    return pd.concat(parts, ignore_index=True)


def main():
    df = load_raw()
    print(f"filas brutas: {len(df):,}")
    df = df.dropna(subset=["sat"])
    t = df["acq_time"].astype(str).str.zfill(4)
    df["datetime"] = pd.to_datetime(df["acq_date"] + " " + t.str[:2] + ":" + t.str[2:], utc=True)
    df["date"] = df["datetime"].dt.date

    # Cobertura temporal por satélite ANTES de filtrar (un mes sin fuegos ≠ un mes sin datos)
    cov = df.groupby("sat")["date"].agg(["min", "max"])
    coverage = {s: [str(r["min"]), str(r["max"])] for s, r in cov.iterrows()}

    # SP manda sobre NRT para el mismo satélite y día
    sp_days = set(map(tuple, df.loc[df.processing == "SP", ["sat", "date"]].drop_duplicates().values))
    is_dup_nrt = (df.processing == "NRT") & pd.Series(
        [(s, d) in sp_days for s, d in zip(df.sat, df.date)], index=df.index)
    df = df[~is_dup_nrt]
    df = df.drop_duplicates(subset=["sat", "latitude", "longitude", "datetime"])

    # Confianza
    conf = df["confidence"].astype(str).str.strip().str.lower()
    num = pd.to_numeric(conf, errors="coerce")
    ok = np.where(df.instrument == "MODIS", num >= C.MODIS_MIN_CONF, conf.isin(C.VIIRS_CONF_OK))
    df = df[ok]

    # Tipo (solo en datos SP): 0 = fuego de vegetación presunto
    if "type" in df:
        df = df[df["type"].isna() | (df["type"] == 0)]

    # Recorte al polígono de Andalucía
    aoi = shapely.union_all([shape(f["geometry"]) for f in json.load(open(C.AOI_GEOJSON))["features"]])
    shapely.prepare(aoi)
    df = df[shapely.contains_xy(aoi, df.longitude.values, df.latitude.values)]
    print(f"tras confianza, tipo y recorte: {len(df):,}")

    # Fuentes estáticas, detectadas con VIIRS (más preciso) y aplicadas a ambos sensores
    g = C.STATIC_CELL_DEG
    df["cx"] = np.floor(df.longitude / g).astype(int)
    df["cy"] = np.floor(df.latitude / g).astype(int)
    v = df[df.instrument == "VIIRS"]
    st = v.groupby(["cx", "cy"]).agg(days=("date", "nunique"),
                                      months=("datetime", lambda s: s.dt.month.nunique()))
    st = st[(st.days >= C.STATIC_MIN_DAYS) & (st.months >= C.STATIC_MIN_CAL_MONTHS)]
    bad = set()
    for cx, cy in st.index:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                bad.add((cx + dx, cy + dy))
    is_static = pd.Series([(x, y) in bad for x, y in zip(df.cx, df.cy)], index=df.index)
    print(f"fuentes estáticas: {len(st)} celdas, {is_static.sum():,} detecciones descartadas")
    feats = [{"type": "Feature",
              "properties": {"dias": int(r.days), "meses": int(r.months)},
              "geometry": {"type": "Polygon", "coordinates": [[
                  [cx * g, cy * g], [(cx + 1) * g, cy * g], [(cx + 1) * g, (cy + 1) * g],
                  [cx * g, (cy + 1) * g], [cx * g, cy * g]]]}}
             for (cx, cy), r in st.iterrows()]
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    json.dump({"type": "FeatureCollection", "features": feats},
              open(C.WEB_DATA / "static_sources.geojson", "w"))
    df = df[~is_static]

    cols = ["latitude", "longitude", "datetime", "instrument", "sat", "processing", "frp", "daynight", "confidence"]
    out = df[cols].sort_values("datetime").reset_index(drop=True)
    C.CLEAN.mkdir(parents=True, exist_ok=True)
    out.to_parquet(C.CLEAN / "hotspots.parquet", index=False)
    json.dump(coverage, open(C.CLEAN / "coverage.json", "w"), indent=1)
    print(out.groupby("sat").size().to_string())
    print("cobertura:", coverage)


if __name__ == "__main__":
    main()
