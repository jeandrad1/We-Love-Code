"""Armoniza MODIS (Terra/Aqua, 1 km) y VIIRS (S-NPP/NOAA-20/NOAA-21, 375 m).

Unidad común: "puntos calientes equivalentes VIIRS S-NPP" (lo que habría detectado un único
VIIRS 375 m). Así la serie continúa sin saltos cuando MODIS y S-NPP desaparecen.

Método (calibración en cadena por mes del año, con suavizado ±1 mes y bootstrap por años):
  r[m]   = VIIRS S-NPP / (Terra + Aqua)          en el solape 2012-2020
  a[m]   = (Terra + Aqua) / Terra                2003-2011 (para 2000-11 → 2002-06, sin Aqua)
  k20[m] = S-NPP / NOAA-20, k21[m] = S-NPP / NOAA-21   en sus solapes

Para cada mes se elige UNA fuente (S-NPP > NOAA-20 > NOAA-21 > Terra+Aqua > Terra) y cada
punto caliente recibe una categoría que dice qué factor le aplica (0 = no cuenta).
Así la web puede recalcular la serie armonizada para cualquier polígono que dibuje el usuario.

Validación: dejar un año fuera dentro del solape, y prueba fuera de ventana (2021+).
"""
import json

import numpy as np
import pandas as pd

import config as C

SATS = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
CAT = {"none": 0, "ref": 1, "r": 2, "ar": 3, "k20": 4, "k21": 5}
rng = np.random.default_rng(42)


def monthly_counts(df):
    df = df.assign(year=df.datetime.dt.year, month=df.datetime.dt.month)
    t = df.pivot_table(index=["year", "month"], columns="sat", values="latitude", aggfunc="size", fill_value=0)
    for s in SATS:
        if s not in t:
            t[s] = 0
    return t[SATS]


def covered_table(index, coverage):
    """True si el satélite tiene datos para todo el mes (o hasta el último día disponible)."""
    gmax = max(pd.Timestamp(v[1]) for v in coverage.values())
    rows = []
    for y, m in index:
        start = pd.Timestamp(y, m, 1)
        end = min(start + pd.offsets.MonthEnd(0), gmax)
        row = {}
        for s in SATS:
            if s in coverage:
                lo, hi = map(pd.Timestamp, coverage[s])
                row[s] = lo <= start and hi >= end - pd.Timedelta(days=2)
            else:
                row[s] = False
        rows.append(row)
    return pd.DataFrame(rows, index=index)


def ratio_by_month(d):
    """Factor por mes del año = Σnum/Σden en ventana circular de ±SMOOTH meses.
    d: DataFrame con columnas num, den y columna 'month'."""
    by = d.groupby("month")[["num", "den"]].sum().reindex(range(1, 13), fill_value=0)
    out = np.full(12, np.nan)
    for m in range(1, 13):
        win = [((m - 1 + k) % 12) + 1 for k in range(-C.SMOOTH_MONTHS, C.SMOOTH_MONTHS + 1)]
        n, dd = by.loc[win, "num"].sum(), by.loc[win, "den"].sum()
        out[m - 1] = n / dd if dd > 0 else np.nan
    total = by.den.sum()
    glob = by.num.sum() / total if total > 0 else np.nan
    return np.where(np.isnan(out), glob, out)


def frame(num, den, mask):
    d = pd.DataFrame({"num": num, "den": den})[mask].reset_index()
    return d


def pooled_ratio(num, den, mask, years_subset=None):
    d = frame(num, den, mask)
    if years_subset is not None:
        d = d[d.year.isin(years_subset)]
    return ratio_by_month(d)


def factor_with_ci(num, den, mask):
    d = frame(num, den, mask)
    years = sorted(d.year.unique())
    if not years or d.den.sum() == 0:
        return None
    est = ratio_by_month(d)
    groups = {y: g for y, g in d.groupby("year")}
    boots = []
    for _ in range(C.N_BOOT):
        ys = rng.choice(years, size=len(years), replace=True)
        boots.append(ratio_by_month(pd.concat([groups[y] for y in ys])))
    b = np.array(boots)
    lo, hi = np.nanquantile(b, C.CI[0], axis=0), np.nanquantile(b, C.CI[1], axis=0)
    return {"est": est.round(4).tolist(), "lo": lo.round(4).tolist(), "hi": hi.round(4).tolist(),
            "years": [int(y) for y in years]}


def main():
    df = pd.read_parquet(C.CLEAN / "hotspots.parquet")
    coverage = json.load(open(C.CLEAN / "coverage.json"))
    cnt = monthly_counts(df)
    first = pd.Timestamp(min(v[0] for v in coverage.values()))
    last = pd.Timestamp(max(v[1] for v in coverage.values()))
    idx = pd.MultiIndex.from_tuples(
        [(p.year, p.month) for p in pd.period_range(first, last, freq="M")], names=["year", "month"])
    cnt = cnt.reindex(idx, fill_value=0)
    cov = covered_table(idx, coverage)
    yrs = cnt.index.get_level_values(0)
    modis = cnt.Terra + cnt.Aqua

    f = {}
    o0, o1 = C.OVERLAP_MODIS_VIIRS
    m_r = cov.SNPP & cov.Terra & cov.Aqua & (yrs >= o0) & (yrs <= o1)
    f["r"] = factor_with_ci(cnt.SNPP, modis, m_r)
    m_a = cov.Terra & cov.Aqua & (yrs <= 2011)
    f["a"] = factor_with_ci(modis, cnt.Terra, m_a)
    f["k20"] = factor_with_ci(cnt.SNPP, cnt.NOAA20, cov.SNPP & cov.NOAA20)
    f["k21"] = factor_with_ci(cnt.SNPP, cnt.NOAA21, cov.SNPP & cov.NOAA21)
    if f["k21"] is None and f["k20"] is not None:  # sin solape S-NPP/NOAA-21: encadenar vía NOAA-20
        k = factor_with_ci(cnt.NOAA20, cnt.NOAA21, cov.NOAA20 & cov.NOAA21)
        if k:
            f["k21"] = {key: (np.array(f["k20"][key]) * np.array(k[key])).round(4).tolist()
                        for key in ("est", "lo", "hi")} | {"years": k["years"]}
    if f["r"] is None:
        raise SystemExit("No hay solape MODIS/VIIRS para calibrar. ¿Faltan datos?")
    for k_, v in f.items():
        print(f"{k_:>4}:", None if v is None else np.round(v["est"], 2))

    # Fuente elegida por mes
    def pick(row_cov, y):
        if row_cov.SNPP:
            return "ref", "SNPP"
        if row_cov.NOAA20 and f["k20"]:
            return "k20", "NOAA20"
        if row_cov.NOAA21 and f["k21"]:
            return "k21", "NOAA21"
        if row_cov.Terra and row_cov.Aqua:
            return "r", "MODIS"
        if row_cov.Terra:
            return "ar", "Terra"
        return "none", None
    choice = {i: pick(cov.loc[i], i[0]) for i in idx}

    # Categoría por punto
    ym = list(zip(df.datetime.dt.year, df.datetime.dt.month))
    cats = []
    for (y, m), s in zip(ym, df.sat):
        c, src = choice[(y, m)]
        ok = (src == s) or (src == "MODIS" and s in ("Terra", "Aqua"))
        cats.append(CAT[c] if ok else 0)
    df["cat"] = np.array(cats, dtype=np.int8)

    # Serie mensual armonizada (región completa)
    def fac(name, m, key="est"):
        if name == "ref":
            return 1.0
        if name == "ar":
            return f["a"][key][m - 1] * f["r"][key][m - 1] if f["a"] else f["r"][key][m - 1]
        if name == "none":
            return np.nan
        return f[name][key][m - 1]
    rows = []
    for (y, m) in idx:
        c, src = choice[(y, m)]
        base = {"ref": cnt.SNPP, "k20": cnt.NOAA20, "k21": cnt.NOAA21, "r": modis, "ar": cnt.Terra}.get(c)
        n = base.loc[(y, m)] if base is not None else np.nan
        rows.append({"year": y, "month": m, "fuente": src, **{s.lower(): int(cnt.loc[(y, m), s]) for s in SATS},
                     "armonizado": n * fac(c, m), "lo": n * fac(c, m, "lo"), "hi": n * fac(c, m, "hi")})
    monthly = pd.DataFrame(rows)

    # Validación: dejar un año fuera (solape) y prueba fuera de ventana
    val = {"loyo": [], "fuera_ventana": []}
    mask_all = cov.SNPP & cov.Terra & cov.Aqua
    in_years = sorted(set(yrs[m_r]))
    glob_r = cnt.SNPP[m_r].sum() / modis[m_r].sum()
    def rec(y, r_month):
        sel = mask_all & (yrs == y)
        obs = cnt.SNPP[sel]
        months = obs.index.get_level_values(1)
        pred = modis[sel].values * r_month[months - 1]
        pred_flat = modis[sel].values * glob_r
        return {"year": int(y), "observado": int(obs.sum()), "pred_mensual": float(pred.sum()),
                "pred_factor_unico": float(pred_flat.sum()), "modis_bruto": int(modis[sel].sum()),
                "mae_mensual": float(np.abs(pred - obs.values).mean()),
                "mae_factor_unico": float(np.abs(pred_flat - obs.values).mean())}
    for y in in_years:
        r_loo = pooled_ratio(cnt.SNPP, modis, m_r, years_subset=[x for x in in_years if x != y])
        val["loyo"].append(rec(y, r_loo))
    for y in sorted(set(yrs[mask_all & (yrs > o1)])):
        val["fuera_ventana"].append(rec(y, np.array(f["r"]["est"])))
    def summ(lst):
        if not lst:
            return {}
        e = lambda k: float(np.median([abs(r[k] - r["observado"]) / max(r["observado"], 1) for r in lst]) * 100)
        return {"err_anual_mediano_pct_mensual": e("pred_mensual"),
                "err_anual_mediano_pct_factor_unico": e("pred_factor_unico"),
                "err_anual_mediano_pct_sin_armonizar": e("modis_bruto"),
                "mae_mensual": float(np.mean([r["mae_mensual"] for r in lst])),
                "mae_factor_unico": float(np.mean([r["mae_factor_unico"] for r in lst]))}
    val["resumen_loyo"] = summ(val["loyo"])
    val["resumen_fuera_ventana"] = summ(val["fuera_ventana"])
    print("validación (dejar un año fuera):", json.dumps(val["resumen_loyo"], indent=1))

    C.HARM.mkdir(parents=True, exist_ok=True)
    df.to_parquet(C.HARM / "points.parquet", index=False)
    monthly.to_csv(C.HARM / "monthly_andalucia.csv", index=False)
    json.dump({"factors": f, "overlap": C.OVERLAP_MODIS_VIIRS, "cats": CAT,
               "choice": {f"{y}-{m:02d}": c[1] for (y, m), c in choice.items()}},
              open(C.HARM / "factors.json", "w"), indent=1)
    json.dump(val, open(C.HARM / "validation.json", "w"), indent=1)


if __name__ == "__main__":
    main()
