"""Genera CSV con el formato de FIRMS pero SINTÉTICOS, para probar el pipeline sin clave.

Simula: incendios de verano, quema de restos de poda de olivar (ene-abr, Jaén/Córdoba),
quema de paja de arroz (oct-nov, marismas del Guadalquivir), dos fuentes estáticas, y que VIIRS
ve ~3-5× más puntos que MODIS (más en fuegos pequeños). NO son datos reales.

    python tests/make_synthetic.py && python pipeline/02_clean.py && ...
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import config as C  # noqa: E402

rng = np.random.default_rng(7)
aoi = shapely.union_all([shape(f["geometry"]) for f in json.load(open(C.AOI_GEOJSON))["features"]])
shapely.prepare(aoi)
END = pd.Timestamp("2026-11-13")
SAT_LIFE = {"Terra": ("2000-11-01", END), "Aqua": ("2002-07-04", END),
            "SNPP": ("2012-01-20", "2026-10-31"), "NOAA20": ("2018-04-01", END), "NOAA21": ("2023-02-01", END)}
SAT_PASS = {"Terra": 1030, "Aqua": 1330, "SNPP": 1330, "NOAA20": 1240, "NOAA21": 1420}  # hora local aprox.


def inside(lon, lat):
    return shapely.contains_xy(aoi, lon, lat)


def sample_in_box(n, box):
    out = []
    while len(out) < n:
        lon = rng.uniform(box[0], box[2], n * 3)
        lat = rng.uniform(box[1], box[3], n * 3)
        ok = inside(lon, lat)
        out += list(zip(lon[ok], lat[ok]))
    return np.array(out[:n])


events = []  # (fecha, lon, lat, tamaño_relativo, días)
days = pd.date_range("2000-11-01", END)
year_mult = {y: rng.lognormal(0, 0.35) for y in range(2000, 2027)}
for y in (2004, 2012, 2017, 2022, 2025):
    year_mult[y] *= 2.0
for d in days:
    m, ym = d.month, year_mult[d.year] * (1 + 0.01 * (d.year - 2000))
    # Incendios forestales (jun-oct, pico agosto)
    lam = ym * 1.6 * np.exp(-((m - 8) ** 2) / 2.5)
    for _ in range(rng.poisson(lam)):
        lonlat = sample_in_box(1, (-7.5, 36.1, -1.7, 38.7))[0]
        size = rng.pareto(1.3) + 0.3
        events.append((d, *lonlat, size, int(min(1 + size * 1.5, 12))))
    # Quema de poda de olivar (ene-abr) — fuegos pequeños
    if m in (1, 2, 3, 4):
        for _ in range(rng.poisson(ym * 3.0)):
            lonlat = sample_in_box(1, (-4.9, 37.4, -2.8, 38.3))[0]
            events.append((d, *lonlat, rng.uniform(0.05, 0.3), 1))
    # Paja de arroz en las marismas (oct-nov)
    if m in (10, 11):
        for _ in range(rng.poisson(ym * 2.0)):
            lonlat = sample_in_box(1, (-6.3, 36.95, -5.95, 37.25))[0]
            events.append((d, *lonlat, rng.uniform(0.1, 0.5), 1))

STATIC = [(-6.25, 37.44), (-6.93, 37.20)]  # termosolar y polo industrial (ficticios aprox.)

rows = {s: [] for s in SAT_LIFE}
for sat, (a, b) in SAT_LIFE.items():
    a, b = pd.Timestamp(a), pd.Timestamp(b)
    is_v = sat != "Terra" and sat != "Aqua"
    sens = {"SNPP": 1.0, "NOAA20": 0.93, "NOAA21": 0.97}.get(sat, 1.0)
    for (d0, lon, lat, size, ndays) in events:
        for k in range(ndays):
            d = d0 + pd.Timedelta(days=k)
            if not (a <= d <= b) or rng.random() < 0.15:  # nubes / sin paso
                continue
            sz = size * np.exp(-0.4 * k)
            if is_v:
                n = rng.poisson(sens * (0.8 + 6 * sz))
                spread = 0.004
            else:
                pdet = 1 - np.exp(-2.2 * sz)
                n = rng.poisson(1 + 1.2 * sz) if rng.random() < pdet else 0
                spread = 0.008
            for _ in range(n):
                rows[sat].append((lat + rng.normal(0, spread), lon + rng.normal(0, spread), d,
                                  max(1.0, rng.lognormal(np.log(5 + 30 * sz), 0.6))))
    for (lon, lat) in STATIC:
        for d in pd.date_range(max(a, pd.Timestamp("2009-01-01")), b):
            if rng.random() < (0.35 if is_v else 0.08):
                rows[sat].append((lat + rng.normal(0, 0.001), lon + rng.normal(0, 0.001), d, 8.0))

out = C.RAW_ARCHIVE
out.mkdir(parents=True, exist_ok=True)
fname = {"Terra": "M-C61", "Aqua": "M-C61", "SNPP": "SV-C2", "NOAA20": "J1V-C2", "NOAA21": "J2V-C2"}
frames = {}
for sat, r in rows.items():
    df = pd.DataFrame(r, columns=["latitude", "longitude", "date", "frp"])
    df = df[inside(df.longitude.values, df.latitude.values)]
    is_v = sat in ("SNPP", "NOAA20", "NOAA21")
    df["acq_date"] = df.date.dt.strftime("%Y-%m-%d")
    df["acq_time"] = [f"{SAT_PASS[sat] - 100 + rng.integers(-20, 20):04d}" for _ in range(len(df))]
    df["scan"], df["track"] = (0.4, 0.4) if is_v else (1.0, 1.0)
    df["satellite"] = {"Terra": "Terra", "Aqua": "Aqua", "SNPP": "N", "NOAA20": "N20", "NOAA21": "N21"}[sat]
    df["instrument"] = "VIIRS" if is_v else "MODIS"
    if is_v:
        df["confidence"] = rng.choice(["l", "n", "h"], len(df), p=[0.1, 0.7, 0.2])
        df["bright_ti4"], df["bright_ti5"] = 330.0, 295.0
        df["version"] = "2"
    else:
        df["confidence"] = rng.integers(10, 100, len(df))
        df["brightness"], df["bright_t31"] = 320.0, 295.0
        df["version"] = "6.1"
    df["daynight"] = "D"
    df["type"] = 0
    df["frp"] = df.frp.round(1)
    frames.setdefault(fname[sat], []).append(df.drop(columns="date"))
for k, fr in frames.items():
    df = pd.concat(fr)
    df.to_csv(out / f"fire_archive_{k}_SINTETICO.csv", index=False)
    print(k, len(df))
