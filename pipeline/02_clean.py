"""Lee todas las descargas (zips por país, CSV por país, API, archivo), las pone en un esquema común,
asigna país, filtra calidad y fuentes fijas de calor, y guarda un parquet por año.

Salidas:
  data/clean/AAAA.parquet         lat, lon, datetime, sat, proc, frp, iso
  data/clean/coverage.json        primer y último día con datos de cada satélite
  web/data/fuentes_fijas.geojson  celdas descartadas (industria, antorchas, plantas solares)
"""
import json
import re
import unicodedata
import zipfile
from collections import defaultdict

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

import config as C

PARTS = C.CLEAN / "parts"


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", s)


def european_names():
    ne = json.load(open(C.NE_COUNTRIES))
    names = set()
    for f in ne["features"]:
        p = f["properties"]; a3 = C.MERGE.get(p["ADM0_A3"], p["ADM0_A3"])
        if a3 in C.COUNTRIES:
            for k in ("NAME", "NAME_LONG", "ADMIN", "NAME_EN", "FORMAL_EN", "SOVEREIGNT"):
                if p.get(k):
                    names.add(norm(p[k]))
    for v in C.ALIASES.values():
        names.update(norm(x) for x in v)
    names.discard("")
    return names


def instrument_of(name):
    n = name.lower()
    if "modis" in n or "m-c61" in n or "m6" in n:
        return "MODIS", None
    if "jpss2" in n or "noaa21" in n or "j2v" in n:
        return "VIIRS", "NOAA21"
    if "jpss1" in n or "noaa20" in n or "j1v" in n:
        return "VIIRS", "NOAA20"
    if "snpp" in n or "suomi" in n or "sv-c2" in n or "viirs" in n:
        return "VIIRS", "SNPP"
    return None, None


class Countries:
    def __init__(self):
        g = json.load(open(C.COUNTRIES_GEOJSON))
        self.items = []
        for f in g["features"]:
            geom = shape(f["geometry"]); shapely.prepare(geom)
            self.items.append((f["properties"]["iso"], geom, geom.bounds))

    def assign(self, lon, lat):
        out = np.full(len(lon), "", dtype=object)
        for iso, geom, (a, b, c, d) in self.items:
            m = (out == "") & (lon >= a) & (lon <= c) & (lat >= b) & (lat <= d)
            if m.any():
                idx = np.where(m)[0]
                inside = shapely.contains_xy(geom, lon[idx], lat[idx])
                out[idx[inside]] = iso
        return out


def standardize(df, instrument, sat, proc):
    if df.empty or "latitude" not in df:
        return None
    df = df.copy()
    if instrument == "MODIS":
        s = df.get("satellite", pd.Series("", index=df.index)).astype(str).str.strip().str.lower()
        df["sat"] = np.where(s.isin(["t", "terra"]), "Terra", np.where(s.isin(["a", "aqua"]), "Aqua", None))
    else:
        df["sat"] = sat
    df = df.dropna(subset=["sat"])
    t = df["acq_time"].astype(str).str.replace(":", "").str.zfill(4)
    df["datetime"] = pd.to_datetime(df["acq_date"].astype(str) + " " + t.str[:2] + ":" + t.str[2:], utc=True, errors="coerce")
    df = df.dropna(subset=["datetime"])
    conf = df["confidence"].astype(str).str.strip().str.lower()
    ok = (pd.to_numeric(conf, errors="coerce") >= C.MODIS_MIN_CONF) if instrument == "MODIS" else conf.isin(C.VIIRS_CONF_OK)
    df = df[ok.values]
    if "type" in df:
        tt = pd.to_numeric(df["type"], errors="coerce")
        df = df[tt.isna() | (tt == 0)]
    w, s_, e, n = C.BBOX
    df = df[(df.longitude >= w) & (df.longitude <= e) & (df.latitude >= s_) & (df.latitude <= n)]
    return pd.DataFrame({"lat": df.latitude.astype("float32").values, "lon": df.longitude.astype("float32").values,
                         "datetime": df.datetime.values, "sat": df.sat.values, "proc": proc,
                         "frp": pd.to_numeric(df.get("frp", 0), errors="coerce").astype("float32").values})


def iter_sources(names):
    """Devuelve (DataFrame bruto, instrumento, satélite, procesamiento) de cada fichero de entrada."""
    rd = lambda f: pd.read_csv(f, dtype={"acq_time": str, "confidence": str, "satellite": str, "acq_date": str}, low_memory=False)
    for z in sorted(C.RAW_COUNTRY.glob("*.zip")):
        inst, sat = instrument_of(z.name)
        with zipfile.ZipFile(z) as zf:
            for m in zf.namelist():
                if not m.lower().endswith(".csv"):
                    continue
                stem = m.rsplit("/", 1)[-1][:-4]
                country = re.sub(r"^.*?_\d{4}_", "", stem)
                if norm(country) not in names:
                    continue
                i2, s2 = instrument_of(m)
                with zf.open(m) as fh:
                    yield rd(fh), i2 or inst, s2 or sat, "SP", m
    for f in sorted(C.RAW_COUNTRY.rglob("*.csv")):
        country = re.sub(r"^.*?_\d{4}_", "", f.stem)
        if norm(country) not in names:
            continue
        inst, sat = instrument_of(f.name)
        yield rd(f), inst, sat, "SP", f.name
    for d in sorted(C.RAW_API.glob("*")):
        inst, sat = instrument_of(d.name)
        proc = "SP" if d.name.endswith("SP") else "NRT"
        for f in sorted(d.glob("*.csv")):
            yield rd(f), inst, sat, proc, f.name
    for f in sorted(C.RAW_ARCHIVE.glob("*.csv")):
        inst, sat = instrument_of(f.name)
        yield rd(f), inst, sat, ("NRT" if "nrt" in f.name.lower() else "SP"), f.name


def main():
    names = european_names()
    countries = Countries()
    PARTS.mkdir(parents=True, exist_ok=True)
    for old in PARTS.glob("*.parquet"):
        old.unlink()
    cov = {}
    n_in = n_out = k = 0
    for raw, inst, sat, proc, label in iter_sources(names):
        if inst is None:
            print("  no reconozco el instrumento de", label); continue
        n_in += len(raw)
        df = standardize(raw, inst, sat, proc)
        if df is None or df.empty:
            continue
        for s, g in df.groupby("sat"):
            lo, hi = g.datetime.min().date(), g.datetime.max().date()
            c0 = cov.get(s); cov[s] = [min(c0[0], lo), max(c0[1], hi)] if c0 else [lo, hi]
        df["iso"] = countries.assign(df.lon.values.astype("float64"), df.lat.values.astype("float64"))
        df = df[df.iso != ""]
        df["year"] = df.datetime.dt.year
        for y, g in df.groupby("year"):
            g.drop(columns="year").to_parquet(PARTS / f"{y}_{k:05d}.parquet", index=False); k += 1
        n_out += len(df)
        if k % 50 == 0:
            print(f"  {n_in:,} leídos, {n_out:,} en Europa…")
    if not k:
        raise SystemExit("No hay datos en data/raw/. Ejecuta 01_download_firms.py o copia los CSV.")
    print(f"leídos {n_in:,}; en Europa tras calidad: {n_out:,}")

    years = sorted({int(p.name[:4]) for p in PARTS.glob("*.parquet")})
    # 1) SP manda sobre NRT y fuera duplicados; 2) estadística de celdas VIIRS para fuentes fijas
    g = C.STATIC_CELL_DEG
    days = defaultdict(int); months = defaultdict(int)
    for y in years:
        df = pd.concat([pd.read_parquet(p) for p in sorted(PARTS.glob(f"{y}_*.parquet"))], ignore_index=True)
        df["date"] = df.datetime.dt.floor("D")
        sp = df[df.proc == "SP"][["sat", "date"]].drop_duplicates()
        sp["has_sp"] = True
        df = df.merge(sp, on=["sat", "date"], how="left")
        df = df[~((df.proc == "NRT") & df.has_sp.fillna(False))].drop(columns="has_sp")
        df = df.drop_duplicates(subset=["sat", "lat", "lon", "datetime"])
        df.drop(columns="date").to_parquet(C.CLEAN / f"{y}.parquet", index=False)
        v = df[df.sat.isin(["SNPP", "NOAA20", "NOAA21"])]
        if len(v):
            cx = np.floor(v.lon / g).astype(int).values; cy = np.floor(v.lat / g).astype(int).values
            t = pd.DataFrame({"cx": cx, "cy": cy, "d": v.date.values, "m": v.datetime.dt.month.values})
            for (a, b), n in t.drop_duplicates(["cx", "cy", "d"]).groupby(["cx", "cy"]).size().items():
                days[(a, b)] += n
            for (a, b), ms in t.groupby(["cx", "cy"]).m.unique().items():
                months[(a, b)] |= int(sum(1 << (int(x) - 1) for x in ms))
        print(f"  {y}: {len(df):,} focos")
    for p in PARTS.glob("*.parquet"):
        p.unlink()
    static = {c for c, n in days.items() if n >= C.STATIC_MIN_DAYS and bin(months[c]).count("1") >= C.STATIC_MIN_CAL_MONTHS}
    bad = {(a + dx, b + dy) for a, b in static for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    print(f"fuentes fijas: {len(static)} celdas")
    removed = 0
    for y in years:
        f = C.CLEAN / f"{y}.parquet"; df = pd.read_parquet(f)
        cx = np.floor(df.lon / g).astype(int).values; cy = np.floor(df.lat / g).astype(int).values
        if bad:
            key = (cx.astype(np.int64) + 100000) * 1000000 + (cy + 100000)
            badk = np.array([(a + 100000) * 1000000 + (b + 100000) for a, b in bad], dtype=np.int64)
            keep = ~np.isin(key, badk)
        else:
            keep = np.ones(len(df), bool)
        removed += (~keep).sum()
        df[keep].to_parquet(f, index=False)
    print(f"descartados por fuente fija: {removed:,}")
    feats = [{"type": "Feature", "properties": {"dias": int(days[(a, b)])},
              "geometry": {"type": "Point", "coordinates": [round((a + .5) * g, 3), round((b + .5) * g, 3)]}} for a, b in static]
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    json.dump({"type": "FeatureCollection", "features": feats}, open(C.WEB_DATA / "fuentes_fijas.geojson", "w"), separators=(",", ":"))
    json.dump({s: [str(a), str(b)] for s, (a, b) in cov.items()}, open(C.CLEAN / "coverage.json", "w"), indent=1)
    print("cobertura:", {s: [str(a), str(b)] for s, (a, b) in cov.items()})


if __name__ == "__main__":
    main()
