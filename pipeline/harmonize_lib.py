"""Pesos de armonización: una única fuente de verdad para 04_aggregate.py y 06_points.py.

El peso de una detección depende solo de (país, mes, satélite). Por eso NO se guarda en cada punto:
se calcula una tabla pequeña (iso, k, s -> w, wl, wh) y los puntos se unen a ella.
  k  = índice de mes desde enero de 2000   (kof)
  s  = código de satélite (C.SAT_CODES)
  w  = detecciones equivalentes S-NPP que vale una detección (0 o ausente = no cuenta ese mes)
  wl, wh = extremos del intervalo (factor MODIS->VIIRS del bootstrap)
Si se recalibra (p. ej. factores por estación), solo se regenera esta tabla, no los puntos.
"""
import pandas as pd
import numpy as np
import config as C



def kof(y, m):
    return (y - 2000) * 12 + (m - 1)


def build_weights(F, FF=None):
    """Construye los pesos de armonización. 
    Si se proporciona FF (factores FRP), se usan; de lo contrario, se usa F (factores de recuento).
    """
    target = FF if FF is not None else F
    a = target["a"]["est"] if target.get("a") else 1.0
    rows = []
    for ym, src in target["choice"].items():
        if src is None:
            continue
        k = kof(int(ym[:4]), int(ym[5:7]))
        for iso, r in target["r"].items():
            if src == "SNPP":
                sw = {"SNPP": (1.0, 1.0, 1.0)}
            elif src in ("NOAA20", "NOAA21"):
                f = target.get("k20" if src == "NOAA20" else "k21")
                if f is None:
                    continue
                sw = {src: (f["est"], f["lo"], f["hi"])}
            elif src == "MODIS":
                sw = {s: (r["est"], r["lo"], r["hi"]) for s in ("Terra", "Aqua")}
            elif src == "Terra":
                sw = {"Terra": (a * r["est"], a * r["lo"], a * r["hi"])}
            else:
                continue
            for s, (w, lo, hi) in sw.items():
                rows.append((iso, k, C.SAT_CODES[s], w, lo, hi))
    W = pd.DataFrame(rows, columns=["iso", "k", "s", "w", "wl", "wh"])
    return W.astype({"k": "int16", "s": "int8"})


def attach_weights(df, W):
    """df con columnas iso, k, s -> DataFrame (índice nuevo, mismo orden) con w, wl, wh añadidos.
    Una detección sin fila en W (otro sensor ese mes) recibe 0 y no cuenta."""
    out = df.merge(W, on=["iso", "k", "s"], how="left")
    cols = ["w", "wl", "wh"]
    out[cols] = out[cols].fillna(0.0)
    return out

SATS = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
rng = np.random.default_rng(42)

def load_sums():
    """Carga o calcula los sumatorios mensuales de FRP y recuentos (n) por país, mes y satélite.
    Guarda y lee desde data/agg/monthly_sums.csv e incluye las columnas 'k' y 's' para los cruces.
    """
    sums_path = C.AGG / "monthly_sums.csv"
    if sums_path.exists():
        sums = pd.read_csv(sums_path)
    else:
        parts = []
        for f in sorted(C.CLEAN.glob("[0-9]*.parquet")):
            df = pd.read_parquet(f, columns=["datetime", "sat", "iso", "frp"])
            df["y"] = df.datetime.dt.year
            df["m"] = df.datetime.dt.month
            df["frp"] = pd.to_numeric(df["frp"], errors="coerce").fillna(0)
            
            g = df.groupby(["iso", "y", "m", "sat"]).agg(
                frp=("frp", "sum"),
                n=("frp", "count")
            )
            parts.append(g)
            
        if not parts:
            raise FileNotFoundError("No se encontraron ficheros parquet en data/clean/ para generar monthly_sums.csv")
            
        sums = pd.concat(parts).groupby(level=[0, 1, 2, 3]).sum().reset_index()
        C.AGG.mkdir(parents=True, exist_ok=True)
        sums.to_csv(sums_path, index=False)
        
    # Asegurar que existan las columnas 'k' y 's' (código numérico) para emparejar con W
    if "k" not in sums.columns:
        sums["k"] = kof(sums["y"], sums["m"])
    if "s" not in sums.columns and "sat" in sums.columns:
        sums["s"] = sums["sat"].map(C.SAT_CODES)
        
    return sums

def month_coverage(cov):
    """Genera la tabla de cobertura booleana para cada mes y satélite."""
    first = pd.Timestamp(min(v[0] for v in cov.values()))
    last = pd.Timestamp(max(v[1] for v in cov.values()))
    months = [(p.year, p.month) for p in pd.period_range(first, last, freq="M")]
    gmax = last
    covt = {}
    for y, m in months:
        start = pd.Timestamp(y, m, 1)
        end = min(start + pd.offsets.MonthEnd(0), gmax)
        covt[(y, m)] = {
            s: (s in cov and pd.Timestamp(cov[s][0]) <= start and pd.Timestamp(cov[s][1]) >= end - pd.Timedelta(days=2))
            for s in SATS
        }
    return months, covt


def wide(sums, metric):
    """Convierte el DataFrame de sumas en formato ancho por satélite para una métrica ('frp' o 'n')."""
    piv = sums.pivot_table(index=["iso", "y", "m"], columns="sat", values=metric, fill_value=0.0)
    for s in SATS:
        if s not in piv.columns:
            piv[s] = 0.0
    return piv[SATS]


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


def estimate_factors(ftab, ntab, covt, months, countries):
    """Estima los factores de calibración de FRP mediante Bootstrap por años."""
    eu = ftab.groupby(level=[1, 2]).sum().reindex(pd.MultiIndex.from_tuples(months), fill_value=0)
    
    def mask(cond):
        return pd.Series([cond(covt[(y, m)], y) for y, m in eu.index], index=eu.index)
        
    o0, o1 = C.OVERLAP_MODIS_VIIRS
    m_r = mask(lambda c, y: c["SNPP"] and c["Terra"] and c["Aqua"] and o0 <= y <= o1)
    by_year = lambda s, msk: s[msk.values].groupby(level=0).sum()
    
    FF = {"overlap": [o0, o1]}
    FF["eu"] = boot(by_year(eu.SNPP, m_r), by_year(eu.Terra + eu.Aqua, m_r))
    FF["a"] = boot(
        by_year(eu.Terra + eu.Aqua, mask(lambda c, y: c["Terra"] and c["Aqua"] and y <= 2011)),
        by_year(eu.Terra, mask(lambda c, y: c["Terra"] and c["Aqua"] and y <= 2011))
    )
    FF["k20"] = boot(by_year(eu.SNPP, mask(lambda c, y: c["SNPP"] and c["NOAA20"])), by_year(eu.NOAA20, mask(lambda c, y: c["SNPP"] and c["NOAA20"])))
    FF["k21"] = boot(by_year(eu.SNPP, mask(lambda c, y: c["SNPP"] and c["NOAA21"])), by_year(eu.NOAA21, mask(lambda c, y: c["SNPP"] and c["NOAA21"])))
    
    if FF["k21"] is None and FF["k20"]:
        k = boot(by_year(eu.NOAA20, mask(lambda c, y: c["NOAA20"] and c["NOAA21"])), by_year(eu.NOAA21, mask(lambda c, y: c["NOAA20"] and c["NOAA21"])))
        if k:
            FF["k21"] = {key: round(FF["k20"][key] * k[key], 4) for key in ("est", "lo", "hi")} | {"years": k["years"]}
            
    r = {}
    for iso in countries:
        if iso not in ftab.index.get_level_values(0):
            r[iso] = FF["eu"] | {"fuente": "europeo", "n_modis": 0}
            continue
        c = ftab.loc[iso].reindex(pd.MultiIndex.from_tuples(months), fill_value=0)
        mod = by_year(c.Terra + c.Aqua, m_r)
        n_mod = int(mod.sum())
        if n_mod >= C.MIN_MODIS_FOR_COUNTRY_FACTOR:
            r[iso] = boot(by_year(c.SNPP, m_r), mod) | {"fuente": "propio", "n_modis": n_mod}
        else:
            r[iso] = FF["eu"] | {"fuente": "europeo", "n_modis": n_mod}
    FF["r"] = r
    
    def pick(c):
        if c["SNPP"]: return "SNPP"
        if c["NOAA20"] and FF.get("k20"): return "NOAA20"
        if c["NOAA21"] and FF.get("k21"): return "NOAA21"
        if c["Terra"] and c["Aqua"]: return "MODIS"
        if c["Terra"]: return "Terra"
        return None
    FF["choice"] = {f"{y}-{m:02d}": pick(covt[(y, m)]) for y, m in months}
    return FF