"""Armoniza la potencia radiativa del fuego (FRP) entre MODIS y VIIRS.

Por qué no basta con armonizar los recuentos: un píxel MODIS (1 km) y un píxel VIIRS (375 m) no miden lo mismo
por detección. Un mismo fuego es 1 detección MODIS con una FRP, o varias VIIRS que reparten esa FRP. Lo que sí
es comparable es la FRP TOTAL de un área y un periodo (la suma sobre todas las detecciones).

Método (paralelo al de los recuentos, 03_harmonize.py):
  1) Factores de FRP: g[país] = FRP total S-NPP / FRP total (Terra+Aqua) en el solape 2012–2020, con intervalo
     bootstrap por años y respaldo europeo; a (Terra → Terra+Aqua), kf20 y kf21 (NOAA-20/21 → S-NPP).
     Cada mes se usa UN sensor, como en los recuentos (misma elección: F["choice"]).
  2) Comprobación física Aqua ↔ S-NPP. Aqua y S-NPP pasan casi a la vez (13:30 y 01:30 hora solar local), así que
     se emparejan por celda de 0.05° (~4-5 km), día local y pase, sumando la FRP de cada sensor. Responde a:
       - ¿Es lineal la relación? (cociente S-NPP/Aqua por tramos de FRP; se agrupa por la media geométrica
         de las dos para no sesgar los extremos)
       - ¿Cuánta FRP ve S-NPP donde Aqua no ve nada (fuegos pequeños) y al revés?
       - ¿El cociente emparejado coincide con el de totales mensuales? (comprobación de coherencia)
     Terra (10:30) no tiene un VIIRS coincidente: su enlace con VIIRS descansa en que Terra ≈ Aqua.

Entradas : data/clean/AAAA.parquet, data/agg/factors.json (03), data/clean/coverage.json (02)
Salidas  : data/agg/frp_factors.json    factores de FRP (misma estructura que factors.json)
           data/agg/frp_matched.json    diagnóstico del emparejamiento Aqua ↔ S-NPP
           data/agg/monthly_sums.csv    detecciones y FRP por país, mes y satélite
           web/data/frp_series.json     FRP armonizada por país y mes (como series.json): h, lo, hi, naive (MW)
Después de ejecutarlo, vuelve a ejecutar 06_points.py: añade los multiplicadores f, fl, fh a weights.parquet
(FRP armonizada de cualquier zona = sum(frp * f)).

Límites: la FRP depende del ángulo de visión, la saturación y el momento del pase; el factor corrige el nivel
medio por país, no estos efectos. Un factor único supone relación lineal: mira "por_tramo" y "lineal".
"""
import json

import numpy as np
import pandas as pd

import config as C
import harmonize_lib as H

CELL = 0.05                     # grados (~4-5 km): escala a la que son comparables 375 m y 1 km
WIN_DAY, WIN_NIGHT = (11.5, 16.5), (0.0, 4.5)     # hora solar local de los pases de la tarde y de la noche
BINS = [0, 5, 10, 20, 40, 80, 160, 320, np.inf]   # MW, media geométrica de la FRP de la celda en ambos sensores


# ---------------------------------------------------------------- emparejamiento Aqua <-> S-NPP
def match_year(df, okset):
    """df: lat, lon, datetime (UTC), sat, frp de un año. Devuelve (estadísticas, pares donde ven los dos)."""
    d = df[df.sat.isin(["Aqua", "SNPP"])]
    d = d[pd.to_numeric(d.frp, errors="coerce") > 0]
    d = d[(d.datetime.dt.year * 100 + d.datetime.dt.month).isin(okset).values]
    out = {"n": {s: int((d.sat == s).sum()) for s in ("Aqua", "SNPP")}, "n_win": {"Aqua": 0, "SNPP": 0}, "pase": {}}
    if d.empty:
        return out, pd.DataFrame({"pas": [], "a": [], "s": []})
    loc = d.datetime + pd.to_timedelta(d.lon.astype("float64") / 15.0, unit="h")   # hora solar local
    lh = (loc.dt.hour + loc.dt.minute / 60).values
    pas = np.where((lh >= WIN_DAY[0]) & (lh < WIN_DAY[1]), "D", np.where(lh < WIN_NIGHT[1], "N", ""))
    inwin = pas != ""
    out["n_win"] = {s: int(((d.sat == s).values & inwin).sum()) for s in ("Aqua", "SNPP")}
    d, loc, pas = d[inwin], loc[inwin], pas[inwin]
    t = pd.DataFrame({"cx": np.floor(d.lon.values / CELL).astype(np.int32), "cy": np.floor(d.lat.values / CELL).astype(np.int32),
                      "ld": loc.dt.floor("D").values, "pas": pas, "sat": d.sat.values, "frp": d.frp.astype(float).values})
    g = t.groupby(["cx", "cy", "ld", "pas", "sat"]).frp.sum().unstack("sat", fill_value=0.0)
    for s in ("Aqua", "SNPP"):
        if s not in g:
            g[s] = 0.0
    A, S, P = g["Aqua"].values, g["SNPP"].values, g.index.get_level_values("pas").values
    for p in ("D", "N"):
        m = P == p
        a, s = A[m], S[m]
        both, a_only, s_only = (a > 0) & (s > 0), (a > 0) & (s == 0), (s > 0) & (a == 0)
        out["pase"][p] = dict(sA=float(a.sum()), sS=float(s.sum()), sA_both=float(a[both].sum()), sS_both=float(s[both].sum()),
                              sA_only=float(a[a_only].sum()), sS_only=float(s[s_only].sum()),
                              n_both=int(both.sum()), n_A_only=int(a_only.sum()), n_S_only=int(s_only.sum()))
    bm = (A > 0) & (S > 0)
    return out, pd.DataFrame({"pas": P[bm], "a": A[bm], "s": S[bm]})


def summarize_matched(parts, pairs, monthly_ratio):
    tot = lambda p, k: sum(x["pase"][p][k] for x in parts if p in x["pase"])
    n_all = {s: sum(x["n"][s] for x in parts) for s in ("Aqua", "SNPP")}
    n_win = {s: sum(x["n_win"][s] for x in parts) for s in ("Aqua", "SNPP")}

    def block(ps):
        sA, sS = sum(tot(p, "sA") for p in ps), sum(tot(p, "sS") for p in ps)
        sAb, sSb = sum(tot(p, "sA_both") for p in ps), sum(tot(p, "sS_both") for p in ps)
        nb, na, ns = (sum(tot(p, k) for p in ps) for k in ("n_both", "n_A_only", "n_S_only"))
        return {"ratio_total": sS / sA if sA else None, "ratio_ambas": sSb / sAb if sAb else None,
                "frp_solo_viirs_pct": 100 * sum(tot(p, "sS_only") for p in ps) / sS if sS else None,
                "frp_solo_aqua_pct": 100 * sum(tot(p, "sA_only") for p in ps) / sA if sA else None,
                "celdas_aqua_vistas_por_viirs_pct": 100 * nb / (nb + na) if nb + na else None,
                "n_celdas_ambas": int(nb), "n_celdas_solo_viirs": int(ns), "n_celdas_solo_aqua": int(na)}
    res = {"celda_grados": CELL, "ventanas_hora_local": {"tarde": WIN_DAY, "noche": WIN_NIGHT},
           "detecciones_en_ventana_pct": {s: 100 * n_win[s] / n_all[s] if n_all[s] else None for s in n_all},
           "tarde": block(["D"]), "noche": block(["N"]), "total": block(["D", "N"]), "por_tramo": []}
    if len(pairs):
        m = np.sqrt(pairs.a.values * pairs.s.values)
        ratio = pairs.s.values / pairs.a.values
        for lo, hi in zip(BINS[:-1], BINS[1:]):
            sel = (m >= lo) & (m < hi)
            if sel.sum():
                res["por_tramo"].append({"desde_mw": lo, "hasta_mw": None if np.isinf(hi) else hi, "n": int(sel.sum()),
                                         "ratio_mediano": float(np.median(ratio[sel])), "p25": float(np.quantile(ratio[sel], .25)),
                                         "p75": float(np.quantile(ratio[sel], .75))})
        big = [t["ratio_mediano"] for t in res["por_tramo"] if t["n"] >= 200]
        res["lineal"] = bool(big and max(big) / min(big) < 1.5)
    res["coherencia"] = {"ratio_mensual_aqua": monthly_ratio, "ratio_emparejado": res["total"]["ratio_total"]}
    return res


def matched_diagnostics(covt, ftab):
    o0, o1 = C.OVERLAP_MODIS_VIIRS
    ok = {y * 100 + m for (y, m), c in covt.items() if c["SNPP"] and c["Aqua"] and o0 <= y <= o1}
    parts, pairs = [], []
    for f in sorted(C.CLEAN.glob("[0-9]*.parquet")):
        if not o0 <= int(f.stem) <= o1:
            continue
        st, pr = match_year(pd.read_parquet(f, columns=["lat", "lon", "datetime", "sat", "frp"]), ok)
        parts.append(st); pairs.append(pr)
        print(f"  {f.stem}: {sum(st['n'].values()):,} detecciones Aqua+S-NPP, {len(pr):,} celdas con ambos")
    if not parts:
        return None
    eu = ftab.groupby(level=[1, 2]).sum()
    sel = np.array([(y * 100 + m) in ok for y, m in eu.index])
    ratio_m = float(eu.SNPP[sel].sum() / eu.Aqua[sel].sum()) if eu.Aqua[sel].sum() else None
    return summarize_matched(parts, pd.concat(pairs, ignore_index=True), ratio_m)


# ---------------------------------------------------------------- serie de FRP armonizada
def frp_series(sums, W, K0, KL):
# Seleccionamos w, wl, wh de W y los renombramos para que coincidan con f, fl, fh
    W_renamed = W[["iso", "k", "s", "w", "wl", "wh"]].rename(columns={"w": "f", "wl": "fl", "wh": "fh"})
    S = sums.merge(W_renamed, on=["iso", "k", "s"], how="left").fillna({"f": 0.0, "fl": 0.0, "fh": 0.0})
    S["h"], S["lo"], S["hi"] = S.frp * S.f, S.frp * S.fl, S.frp * S.fh
    S["naive"] = S.frp.where(S.f > 0, 0.0)          # FRP de los satélites que cuentan ese mes, sin corregir
    ks = np.arange(K0, KL + 1)
    out = {}
    for iso in C.COUNTRIES:
        g = S[S.iso == iso].groupby("k")[["h", "lo", "hi", "naive"]].sum().reindex(ks, fill_value=0.0)
        out[iso] = {c: [round(float(v), 1) for v in g[c].values] for c in g.columns}
    return out


def main():
    F = json.load(open(C.AGG / "factors.json"))
    cov = json.load(open(C.CLEAN / "coverage.json"))
    sums = H.load_sums()
    months, covt = H.month_coverage(cov)
    ftab, ntab = H.wide(sums, "frp"), H.wide(sums, "n")
    FF = H.estimate_factors(ftab, ntab, covt, months, list(C.COUNTRIES))
    json.dump(FF, open(C.AGG / "frp_factors.json", "w"), indent=1)
    print("FRP: factor europeo S-NPP/(Terra+Aqua):", FF["eu"]["est"], f"({FF['eu']['lo']}–{FF['eu']['hi']})",
          "| cuentas:", F["eu"]["est"])
    print("     por país (propio):", {k: v["est"] for k, v in FF["r"].items() if v["fuente"] == "propio"})
    print("     a =", FF["a"] and FF["a"]["est"], " kf20 =", FF["k20"] and FF["k20"]["est"], " kf21 =", FF["k21"] and FF["k21"]["est"])
    missing = [k for k in ("k20", "k21", "a") if F.get(k) and not FF.get(k)]
    if missing:
        print("  AVISO: hay factores de recuento pero no de FRP para", missing, "-> esos meses no tendrán FRP armonizada")

    # serie de FRP armonizada (mismo origen de meses que series.json)
    first = pd.Timestamp(min(v[0] for v in cov.values())); last = pd.Timestamp(max(v[1] for v in cov.values()))
    K0, KL = H.kof(first.year, first.month), H.kof(last.year, last.month)
    W = H.build_weights(F, FF)
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    json.dump(frp_series(sums, W, K0, KL), open(C.WEB_DATA / "frp_series.json", "w"), separators=(",", ":"))

    print("Emparejando Aqua ↔ S-NPP…")
    diag = matched_diagnostics(covt, ftab)
    if diag:
        json.dump(diag, open(C.AGG / "frp_matched.json", "w"), indent=1)
        t = diag["total"]
        print(f"  ratio S-NPP/Aqua en celdas emparejadas: {t['ratio_total']:.2f} (totales mensuales: {diag['coherencia']['ratio_mensual_aqua']:.2f}); "
              f"donde ven los dos: {t['ratio_ambas']:.2f}")
        print(f"  FRP de S-NPP donde Aqua no ve nada: {t['frp_solo_viirs_pct']:.0f} %; celdas de Aqua vistas también por S-NPP: {t['celdas_aqua_vistas_por_viirs_pct']:.0f} %")
        print("  relación lineal:", diag.get("lineal"), "| detecciones dentro de las ventanas de pase:", {k: round(v) for k, v in diag["detecciones_en_ventana_pct"].items()})
    print("Ahora ejecuta 06_points.py para llevar los multiplicadores de FRP a weights.parquet.")


if __name__ == "__main__":
    main()