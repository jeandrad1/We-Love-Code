"""Armoniza MODIS (1 km) y VIIRS (375 m) para Europa.

Unidad común: «focos equivalentes VIIRS S-NPP».
  - Cada mes se cuenta con UNA fuente (S-NPP > NOAA-20 > NOAA-21 > Terra+Aqua > Terra), nunca sumando sensores.
  - r[país] = S-NPP / (Terra+Aqua) en el solape 2012–2020, con intervalo bootstrap por años.
    Cada país tiene su propio factor (el régimen de fuego cambia mucho: quemas agrícolas pequeñas en el
    este, grandes incendios forestales en el Mediterráneo). Si un país tiene pocos datos, usa el europeo.
  - a = (Terra+Aqua)/Terra (2000-11 → 2002-06), k20 = S-NPP/NOAA-20, k21 = S-NPP/NOAA-21: factores europeos.
Validación: se esconde cada año del solape y se predice VIIRS a partir de MODIS, por país y para Europa.
"""
import json

import numpy as np
import pandas as pd

import config as C

SATS = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
rng = np.random.default_rng(42)


def monthly_counts():
    parts = []
    for f in sorted(C.CLEAN.glob("[0-9]*.parquet")):
        df = pd.read_parquet(f, columns=["datetime", "sat", "iso"])
        df["y"] = df.datetime.dt.year; df["m"] = df.datetime.dt.month
        parts.append(df.groupby(["iso", "y", "m", "sat"]).size())
    s = pd.concat(parts).groupby(level=[0, 1, 2, 3]).sum()
    t = s.unstack("sat", fill_value=0)
    for x in SATS:
        if x not in t:
            t[x] = 0
    return t[SATS]


def coverage_table(months, cov):
    gmax = max(pd.Timestamp(v[1]) for v in cov.values())
    rows = {}
    for y, m in months:
        start = pd.Timestamp(y, m, 1); end = min(start + pd.offsets.MonthEnd(0), gmax)
        rows[(y, m)] = {s: (s in cov and pd.Timestamp(cov[s][0]) <= start and pd.Timestamp(cov[s][1]) >= end - pd.Timedelta(days=2)) for s in SATS}
    return rows


def pooled(num, den):
    return float(num.sum() / den.sum()) if den.sum() > 0 else float("nan")


def boot(num_by_year, den_by_year):
    ys = num_by_year.index.values
    if len(ys) == 0 or den_by_year.sum() == 0:
        return None
    est = pooled(num_by_year, den_by_year)
    b = []
    for _ in range(C.N_BOOT):
        pick = rng.choice(ys, len(ys), replace=True)
        b.append(pooled(num_by_year.loc[pick], den_by_year.loc[pick]))
    lo, hi = np.nanquantile(b, C.CI)
    return {"est": round(est, 4), "lo": round(float(lo), 4), "hi": round(float(hi), 4), "years": [int(y) for y in ys]}


def main():
    cnt = monthly_counts()                       # índice (iso, y, m) -> satélites
    cov = json.load(open(C.CLEAN / "coverage.json"))
    months = sorted({(y, m) for _, y, m in cnt.index})
    first = pd.Timestamp(min(v[0] for v in cov.values())); last = pd.Timestamp(max(v[1] for v in cov.values()))
    months = [(p.year, p.month) for p in pd.period_range(first, last, freq="M")]
    covt = coverage_table(months, cov)
    eu = cnt.groupby(level=[1, 2]).sum().reindex(pd.MultiIndex.from_tuples(months), fill_value=0)

    def mask(cond):
        return pd.Series([cond(covt[(y, m)], y) for y, m in eu.index], index=eu.index)
    o0, o1 = C.OVERLAP_MODIS_VIIRS
    m_r = mask(lambda c, y: c["SNPP"] and c["Terra"] and c["Aqua"] and o0 <= y <= o1)
    by_year = lambda s, msk: s[msk.values].groupby(level=0).sum()

    F = {"overlap": [o0, o1]}
    F["eu"] = boot(by_year(eu.SNPP, m_r), by_year(eu.Terra + eu.Aqua, m_r))
    F["a"] = boot(by_year(eu.Terra + eu.Aqua, mask(lambda c, y: c["Terra"] and c["Aqua"] and y <= 2011)), by_year(eu.Terra, mask(lambda c, y: c["Terra"] and c["Aqua"] and y <= 2011)))
    F["k20"] = boot(by_year(eu.SNPP, mask(lambda c, y: c["SNPP"] and c["NOAA20"])), by_year(eu.NOAA20, mask(lambda c, y: c["SNPP"] and c["NOAA20"])))
    F["k21"] = boot(by_year(eu.SNPP, mask(lambda c, y: c["SNPP"] and c["NOAA21"])), by_year(eu.NOAA21, mask(lambda c, y: c["SNPP"] and c["NOAA21"])))
    if F["k21"] is None and F["k20"]:
        k = boot(by_year(eu.NOAA20, mask(lambda c, y: c["NOAA20"] and c["NOAA21"])), by_year(eu.NOAA21, mask(lambda c, y: c["NOAA20"] and c["NOAA21"])))
        if k:
            F["k21"] = {key: round(F["k20"][key] * k[key], 4) for key in ("est", "lo", "hi")} | {"years": k["years"]}
    if not F["eu"]:
        raise SystemExit("No hay solape MODIS/VIIRS para calibrar.")

    r = {}
    for iso in C.COUNTRIES:
        if iso not in cnt.index.get_level_values(0):
            r[iso] = F["eu"] | {"fuente": "europeo", "n_modis": 0}; continue
        c = cnt.loc[iso].reindex(pd.MultiIndex.from_tuples(months), fill_value=0)
        mod = by_year(c.Terra + c.Aqua, m_r); n_mod = int(mod.sum())
        if n_mod >= C.MIN_MODIS_FOR_COUNTRY_FACTOR:
            r[iso] = boot(by_year(c.SNPP, m_r), mod) | {"fuente": "propio", "n_modis": n_mod}
        else:
            r[iso] = F["eu"] | {"fuente": "europeo", "n_modis": n_mod}
    F["r"] = r
    print("factor europeo MODIS→VIIRS:", F["eu"]["est"])
    print("por país:", {k: v["est"] for k, v in r.items() if v["fuente"] == "propio"})

    def pick(c):
        if c["SNPP"]: return "SNPP"
        if c["NOAA20"] and F["k20"]: return "NOAA20"
        if c["NOAA21"] and F["k21"]: return "NOAA21"
        if c["Terra"] and c["Aqua"]: return "MODIS"
        if c["Terra"]: return "Terra"
        return None
    F["choice"] = {f"{y}-{m:02d}": pick(covt[(y, m)]) for y, m in months}

    # Validación: dejar un año fuera, por país y para Europa
    val = {"europa": [], "paises": {}}
    in_years = sorted({y for (y, m), v in m_r.items() if v})
    def loyo(c):
        out = []
        num, den = by_year(c.SNPP, m_r), by_year(c.Terra + c.Aqua, m_r)
        r_eu_all = by_year(eu.SNPP, m_r); d_eu_all = by_year(eu.Terra + eu.Aqua, m_r)
        for y in in_years:
            if y not in num.index:
                continue
            others = [x for x in in_years if x != y and x in num.index]
            rc = pooled(num.loc[others], den.loc[others])
            re_ = pooled(r_eu_all.loc[[x for x in in_years if x != y]], d_eu_all.loc[[x for x in in_years if x != y]])
            out.append({"year": int(y), "observado": int(num.loc[y]), "modis": int(den.loc[y]),
                        "pred_pais": float(den.loc[y] * rc) if np.isfinite(rc) else None, "pred_europeo": float(den.loc[y] * re_)})
        return out
    val["europa"] = loyo(eu)
    for iso in C.COUNTRIES:
        if iso in cnt.index.get_level_values(0):
            val["paises"][iso] = loyo(cnt.loc[iso].reindex(pd.MultiIndex.from_tuples(months), fill_value=0))
    def err(rows, key):
        e = [abs(r[key] - r["observado"]) / r["observado"] for r in rows if r.get(key) is not None and r["observado"] >= 50]
        return round(100 * float(np.median(e)), 1) if e else None
    all_rows = [r for rows in val["paises"].values() for r in rows]
    val["resumen"] = {
        "europa": {"sin_corregir": err(val["europa"], "modis"), "factor_europeo": err(val["europa"], "pred_europeo")},
        "paises": {"sin_corregir": err(all_rows, "modis"), "factor_europeo": err(all_rows, "pred_europeo"), "factor_por_pais": err(all_rows, "pred_pais")},
    }
    print("validación:", json.dumps(val["resumen"], indent=1))
    C.AGG.mkdir(parents=True, exist_ok=True)
    json.dump(F, open(C.AGG / "factors.json", "w"), indent=1)
    json.dump(val, open(C.AGG / "validation.json", "w"))


if __name__ == "__main__":
    main()
