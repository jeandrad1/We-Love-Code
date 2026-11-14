"""Genera focos SINTÉTICOS para Europa con el formato de FIRMS (CSV anuales por país + API del año en curso),
para probar el pipeline y la web sin clave. NO son datos reales.

Regímenes simulados: incendios de verano en el Mediterráneo, quemas agrícolas de primavera y de rastrojo
en el este (Ucrania, Moldavia, Bielorrusia, Polonia, Rumanía…), quemas de brezal en Reino Unido e Irlanda,
pocos fuegos en el centro y el norte (con un año excepcional en Suecia). VIIRS ve más focos que MODIS.
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

rng = np.random.default_rng(11)
SCALE = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
END = pd.Timestamp("2026-11-13")
LIFE = {"Terra": ("2000-11-01", END), "Aqua": ("2002-07-04", END), "SNPP": ("2012-01-20", "2026-10-31"),
        "NOAA20": ("2018-04-01", END), "NOAA21": ("2023-02-01", END)}
D0 = pd.Timestamp("2000-01-01")
MED = {"PRT": 4, "ESP": 5, "ITA": 4, "GRC": 3, "HRV": 1, "ALB": 1, "MKD": .8, "MNE": .4, "CYP": .3, "FRA": 1.5, "BIH": .5, "SVN": .1, "MLT": .02}
EAST = {"UKR": 14, "MDA": 1.5, "BLR": 3, "POL": 2.5, "LTU": 1, "LVA": .8, "EST": .4, "ROU": 5, "SRB": 2.5, "BGR": 3, "HUN": 1.5, "SVK": .5, "KOS": .3}
ATL = {"GBR": 1.2, "IRL": .6, "ISL": .02}
CEN = {"DEU": .6, "CZE": .3, "AUT": .15, "CHE": .05, "BEL": .1, "NLD": .1, "LUX": .02, "DNK": .1, "NOR": .2, "SWE": .4, "FIN": .3}
SEASON = {  # perfil mensual (ene..dic)
    "med": np.array([.3, .4, .6, .4, .3, .8, 2.4, 3.2, 2.2, 1.0, .5, .3]),
    "east": np.array([.3, .4, 2.6, 3.0, .8, .4, 1.8, 2.2, 1.2, 1.4, .6, .2]),
    "atl": np.array([.6, 1.4, 2.8, 2.4, 1.0, .4, .4, .4, .3, .3, .2, .3]),
    "cen": np.array([.2, .3, .9, 1.2, .8, .7, 1.3, 1.3, .8, .5, .2, .1]),
}
REG = {**{k: ("med", v) for k, v in MED.items()}, **{k: ("east", v) for k, v in EAST.items()},
       **{k: ("atl", v) for k, v in ATL.items()}, **{k: ("cen", v) for k, v in CEN.items()}}
SIZE = {"med": (1.2, 0.25), "east": (3.0, 0.08), "atl": (2.2, 0.1), "cen": (2.0, 0.1)}  # pareto a, mínimo

geo = {f["properties"]["iso"]: shape(f["geometry"]) for f in json.load(open(C.COUNTRIES_GEOJSON))["features"]}
NE = {f["properties"]["ADM0_A3"]: f["properties"]["NAME"] for f in json.load(open(C.NE_COUNTRIES))["features"]}


def pool(g, n=6000):
    a, b, c, d = g.bounds; out = []
    while len(out) < n:
        x = rng.uniform(a, c, n * 3); y = rng.uniform(b, d, n * 3)
        ok = shapely.contains_xy(g, x, y); out += list(zip(x[ok], y[ok]))
    return np.array(out[:n])


days = pd.date_range("2000-11-01", END)
dmonth = days.month.values - 1; dyear = days.year.values
year_mult = {y: rng.lognormal(0, .3) for y in range(2000, 2027)}
for y in (2003, 2007, 2017, 2022, 2025):
    year_mult[y] *= 1.8
ev = []
for iso, (reg, rate) in REG.items():
    if iso not in geo:
        continue
    P = pool(geo[iso])
    lam = rate * SCALE * SEASON[reg][dmonth] * np.array([year_mult[y] for y in dyear]) * (1 + .01 * (dyear - 2000))
    if iso == "SWE":
        lam = lam * np.where((dyear == 2018) & (dmonth == 6), 25, 1)
    n = rng.poisson(lam)
    di = np.repeat(np.arange(len(days)), n)
    loc = P[rng.integers(0, len(P), len(di))]
    a_, mn = SIZE[reg]
    size = np.minimum(mn + rng.pareto(a_, len(di)) * mn * 2, 12)
    ev.append(pd.DataFrame({"day": di, "lon": loc[:, 0], "lat": loc[:, 1], "size": size, "iso": iso}))
ev = pd.concat(ignore_index=True, objs=ev)
ev["ndays"] = np.clip(1 + (ev["size"] * 1.2).astype(int), 1, 14)
# Expande a días de actividad
rep = ev.loc[ev.index.repeat(ev.ndays)].copy()
rep["k"] = rep.groupby(level=0).cumcount()
rep["day"] = rep.day + rep.k
rep["sz"] = rep["size"] * np.exp(-.35 * rep.k)
rep = rep[rep.day < len(days)]
print(f"{len(ev):,} incendios simulados, {len(rep):,} incendio-días")

STATIC = [(5.9, 51.5), (23.4, 46.2), (-0.9, 37.6), (16.9, 52.4), (36.2, 49.9)]
rows = []
for sat, (a, b) in LIFE.items():
    a = (pd.Timestamp(a) - D0).days; b = (pd.Timestamp(b) - D0).days
    is_v = sat not in ("Terra", "Aqua")
    sens = {"SNPP": 1.0, "NOAA20": .95, "NOAA21": .97}.get(sat, 1.0)
    dd = (days[0] - D0).days + rep.day.values
    ok = (dd >= a) & (dd <= b) & (rng.random(len(rep)) > .15)
    r = rep[ok]; dd = dd[ok]
    if is_v:
        n = rng.poisson(sens * (0.9 + 5 * r.sz.values)); spread = .004
    else:
        pdet = 1 - np.exp(-1.6 * r.sz.values)
        n = np.where(rng.random(len(r)) < pdet, rng.poisson(1 + 1.1 * r.sz.values), 0); spread = .008
    idx = np.repeat(np.arange(len(r)), n)
    lon = r.lon.values[idx] + rng.normal(0, spread, len(idx)); lat = r.lat.values[idx] + rng.normal(0, spread, len(idx))
    frp = np.maximum(1, rng.lognormal(np.log(5 + 25 * r.sz.values[idx]), .6))
    rows.append(pd.DataFrame({"sat": sat, "d": dd[idx], "lon": lon, "lat": lat, "frp": frp.round(1), "iso": r.iso.values[idx]}))
    sd = np.arange(max(a, (pd.Timestamp("2008-01-01") - D0).days), b + 1)
    for (x, y) in STATIC:
        keep = sd[rng.random(len(sd)) < (.3 if is_v else .07)]
        rows.append(pd.DataFrame({"sat": sat, "d": keep, "lon": x + rng.normal(0, .001, len(keep)), "lat": y + rng.normal(0, .001, len(keep)), "frp": 9.0, "iso": "?"}))
pts = pd.concat(rows, ignore_index=True)
pts["date"] = D0 + pd.to_timedelta(pts.d, unit="D")
pts["year"] = pts.date.dt.year
pass_t = {"Terra": 1030, "Aqua": 1300, "SNPP": 1240, "NOAA20": 1150, "NOAA21": 1330}
pts["acq_time"] = [f"{pass_t[s] + int(v):04d}" for s, v in zip(pts.sat, rng.integers(-40, 40, len(pts)))]
print(f"{len(pts):,} focos simulados")

# Asigna país real por posición (los de fuentes fijas y los que cruzan fronteras)
from shapely import STRtree  # noqa: E402
isos = list(geo); tree = STRtree([geo[i] for i in isos])
pi, gi = tree.query(shapely.points(pts.lon.values, pts.lat.values), predicate="within")
cty = np.full(len(pts), "", dtype=object); cty[pi] = np.array(isos)[gi]
pts["cty"] = cty
pts = pts[pts.cty != ""]

C.RAW_COUNTRY.mkdir(parents=True, exist_ok=True)
inst = {"Terra": "modis", "Aqua": "modis", "SNPP": "viirs-snpp", "NOAA20": "viirs-jpss1", "NOAA21": "viirs-jpss2"}
satcol = {"Terra": "Terra", "Aqua": "Aqua", "SNPP": "N", "NOAA20": "N20", "NOAA21": "N21"}
for f in C.RAW_COUNTRY.glob("*.csv"):
    f.unlink()
for d in C.RAW_API.glob("*"):
    for f in d.glob("*.csv"):
        f.unlink()


def fmt(g, sat):
    v = sat not in ("Terra", "Aqua")
    out = pd.DataFrame({"latitude": g.lat.round(5), "longitude": g.lon.round(5),
                        ("bright_ti4" if v else "brightness"): 330.0, "scan": .4 if v else 1.0, "track": .4 if v else 1.0,
                        "acq_date": g.date.dt.strftime("%Y-%m-%d"), "acq_time": g.acq_time, "satellite": satcol[sat],
                        "instrument": "VIIRS" if v else "MODIS",
                        "confidence": rng.choice(["l", "n", "h"], len(g), p=[.1, .7, .2]) if v else rng.integers(10, 100, len(g)),
                        "version": "2" if v else "6.1", ("bright_ti5" if v else "bright_t31"): 295.0, "frp": g.frp, "daynight": "D", "type": 0})
    return out


n_files = 0
for (y, sat_inst, cty), g in pts.groupby(["year", pts.sat.map(inst), "cty"]):
    if y >= 2026:
        continue
    name = NE.get(cty, cty).replace(" ", "_")
    parts = [fmt(gg, s) for s, gg in g.groupby("sat")]
    pd.concat(parts).to_csv(C.RAW_COUNTRY / f"{sat_inst}_{y}_{name}.csv", index=False); n_files += 1
src = {"Terra": "MODIS_NRT", "Aqua": "MODIS_NRT", "SNPP": "VIIRS_SNPP_NRT", "NOAA20": "VIIRS_NOAA20_NRT", "NOAA21": "VIIRS_NOAA21_NRT"}
for s_, g in pts[pts.year >= 2026].groupby(pts.sat.map(src)):
    d = C.RAW_API / s_; d.mkdir(parents=True, exist_ok=True)
    pd.concat([fmt(gg, s) for s, gg in g.groupby("sat")]).to_csv(d / "2026_sintetico.csv", index=False)
print(f"{n_files} ficheros anuales por país + API 2026")
