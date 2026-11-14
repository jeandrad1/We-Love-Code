"""Aplica la armonización a cada foco y prepara los datos agregados que usa la web.

La web no carga millones de puntos: carga series por país, una rejilla de ~50 km, los incendios
(agrupados aquí) y los focos individuales solo de los últimos meses.

Salidas en web/data/:
  meta.json             fechas, países, rejilla, meses con focos individuales
  series.json           por país y mes: corregido (+ intervalo), sin corregir, MODIS y VIIRS en bruto
  diario.json           por país y día: focos corregidos (para las franjas)
  parcial.json          mes en curso hasta el día de hoy, por año (país y celda), para comparar con justicia
  rejilla.json          por celda de la rejilla y mes: focos corregidos
  incendios.json        incendios agrupados (≤2 km y ≤2 días) con tamaño, fechas y país
  incendios_focos.json  focos de los mayores incendios (para verlos avanzar en el mapa)
  focos/AAAA-MM.json    focos individuales de los últimos meses
  factores.json, validacion.json
"""
import argparse
import json
import shutil
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

import config as C

D0 = pd.Timestamp("2000-01-01", tz="UTC")
SATC = C.SAT_CODES


def kof(y, m):
    return (y - 2000) * 12 + (m - 1)


def cluster(lon, lat, day):
    """Agrupa focos a ≤ EVENT_CELL_DEG (~2 km) y ≤ EVENT_DAYS días: componentes conexas de celdas-día."""
    G = C.EVENT_CELL_DEG
    cx = np.floor(lon / G).astype(np.int64) + 5000
    cy = np.floor(lat / G).astype(np.int64) + 5000
    d = day.astype(np.int64)
    pack = lambda a, b, c: (a * 10000 + b) * 20000 + c
    key = pack(cx, cy, d)
    uk, inv = np.unique(key, return_inverse=True)
    ucx = uk // 20000 // 10000; ucy = (uk // 20000) % 10000; ud = uk % 20000
    rows, cols = [], []
    idx = np.arange(len(uk))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dd in range(0, C.EVENT_DAYS + 1):
                if dd == 0 and (dx, dy) == (0, 0):
                    continue
                nk = pack(ucx + dx, ucy + dy, ud + dd)
                pos = np.searchsorted(uk, nk)
                ok = pos < len(uk)
                ok[ok] = uk[pos[ok]] == nk[ok]
                rows.append(idx[ok]); cols.append(pos[ok])
    r = np.concatenate(rows) if rows else np.array([], int); c = np.concatenate(cols) if cols else np.array([], int)
    g = coo_matrix((np.ones(len(r), np.int8), (r, c)), shape=(len(uk), len(uk)))
    _, lab = connected_components(g, directed=False)
    return lab[inv]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sinteticos", action="store_true", help="marca los datos como de prueba en la web")
    a = ap.parse_args()
    F = json.load(open(C.AGG / "factors.json"))
    cov = json.load(open(C.CLEAN / "coverage.json"))
    LAST = pd.Timestamp(max(v[1] for v in cov.values()))
    FIRST = pd.Timestamp(min(v[0] for v in cov.values()))
    K0, KL = kof(FIRST.year, FIRST.month), kof(LAST.year, LAST.month)
    NK = KL + 1
    cm, dd = LAST.month, LAST.day
    isos = list(C.COUNTRIES)
    choice = F["choice"]
    r_est = {iso: F["r"][iso]["est"] for iso in isos}; r_lo = {iso: F["r"][iso]["lo"] for iso in isos}; r_hi = {iso: F["r"][iso]["hi"] for iso in isos}
    fa = F["a"]["est"] if F.get("a") else 1.0
    kk = {s: F[s] for s in ("k20", "k21") if F.get(s)}

    ser = {iso: {x: np.zeros(NK) for x in ("h", "lo", "hi", "naive", "modis", "viirs")} for iso in isos}
    daily = {iso: {} for iso in isos}
    part_c = {iso: {} for iso in isos}
    grid, part_g = {}, {}
    G = C.GRID_DEG
    events, ev_pts = [], []
    recent_from = KL - C.RECENT_POINT_MONTHS + 1
    focos_dir = C.WEB_DATA / "focos"
    if focos_dir.exists():
        shutil.rmtree(focos_dir)
    focos_dir.mkdir(parents=True)
    recientes = []

    for f in sorted(C.CLEAN.glob("[0-9]*.parquet")):
        df = pd.read_parquet(f)
        y = df.datetime.dt.year.values; m = df.datetime.dt.month.values
        k = kof(y, m)
        ym = pd.Series(y * 100 + m)
        src = ym.map({int(key.replace("-", "")): v for key, v in choice.items()}).values
        sat = df.sat.values; iso = df.iso.values
        re_ = pd.Series(iso).map(r_est).values.astype(float); rl = pd.Series(iso).map(r_lo).values.astype(float); rh = pd.Series(iso).map(r_hi).values.astype(float)
        w = np.zeros(len(df)); wl = np.zeros(len(df)); wh = np.zeros(len(df))
        sel = (src == "SNPP") & (sat == "SNPP"); w[sel] = wl[sel] = wh[sel] = 1
        for s_, key in (("NOAA20", "k20"), ("NOAA21", "k21")):
            if key in kk:
                sel = (src == s_) & (sat == s_); w[sel] = kk[key]["est"]; wl[sel] = kk[key]["lo"]; wh[sel] = kk[key]["hi"]
        sel = (src == "MODIS") & np.isin(sat, ["Terra", "Aqua"]); w[sel] = re_[sel]; wl[sel] = rl[sel]; wh[sel] = rh[sel]
        sel = (src == "Terra") & (sat == "Terra"); w[sel] = fa * re_[sel]; wl[sel] = fa * rl[sel]; wh[sel] = fa * rh[sel]
        naive = (w > 0).astype(float)
        day = (df.datetime.values.astype("datetime64[D]") - np.datetime64("2000-01-01")).astype(int)
        t = pd.DataFrame({"iso": iso, "k": k, "w": w, "wl": wl, "wh": wh, "naive": naive,
                          "modis": np.isin(sat, ["Terra", "Aqua"]).astype(float), "viirs": (sat == "SNPP").astype(float)})
        for (i_, k_), row in t.groupby(["iso", "k"]).sum(numeric_only=True).iterrows():
            s = ser[i_]
            s["h"][k_] += row.w; s["lo"][k_] += row.wl; s["hi"][k_] += row.wh
            s["naive"][k_] += row.naive; s["modis"][k_] += row.modis; s["viirs"][k_] += row.viirs
        cnt = w > 0
        if not cnt.any():
            continue
        dfc = pd.DataFrame({"iso": iso[cnt], "day": day[cnt], "w": w[cnt], "k": k[cnt], "y": y[cnt], "m": m[cnt],
                            "dom": df.datetime.dt.day.values[cnt], "lon": df.lon.values[cnt], "lat": df.lat.values[cnt],
                            "s": pd.Series(sat[cnt]).map(SATC).values, "frp": df.frp.fillna(0).values[cnt]})
        for (i_, d_), v in dfc.groupby(["iso", "day"]).w.sum().items():
            daily[i_][int(d_)] = daily[i_].get(int(d_), 0) + v
        dfc["cell"] = (np.floor(dfc.lon / G).astype(int)).astype(str) + "," + (np.floor(dfc.lat / G).astype(int)).astype(str)
        for (c_, k_), v in dfc.groupby(["cell", "k"]).w.sum().items():
            grid[(c_, int(k_))] = grid.get((c_, int(k_)), 0) + v
        pm = dfc[(dfc.m == cm) & (dfc.dom <= dd)]
        for (i_, y_), v in pm.groupby(["iso", "y"]).w.sum().items():
            part_c[i_][int(y_)] = part_c[i_].get(int(y_), 0) + v
        for (c_, y_), v in pm.groupby(["cell", "y"]).w.sum().items():
            part_g[(c_, int(y_))] = part_g.get((c_, int(y_)), 0) + v
        # Incendios
        lab = cluster(dfc.lon.values, dfc.lat.values, dfc.day.values)
        dfc["ev"] = lab
        dfc["wlon"] = dfc.w * dfc.lon; dfc["wlat"] = dfc.w * dfc.lat
        gr = dfc.groupby("ev")
        e = pd.DataFrame({"w": gr.w.sum(), "n": gr.size(), "d0": gr.day.min(), "d1": gr.day.max(),
                          "lon": gr.wlon.sum() / gr.w.sum(), "lat": gr.wlat.sum() / gr.w.sum(), "frp": gr.frp.max()})
        big = e.w >= C.EVENT_MIN_FOCOS
        sub = dfc[dfc.ev.isin(e.index[big])]
        e.loc[big, "iso"] = sub.groupby(["ev", "iso"]).size().reset_index().sort_values(0).groupby("ev").iso.last()
        e.loc[big, "peak"] = sub.groupby(["ev", "day"]).size().reset_index().sort_values(0).groupby("ev").day.last()
        e = e[e.w >= C.EVENT_MIN_FOCOS]
        base = len(events)
        e["gid"] = np.arange(base, base + len(e))
        events.extend(e.to_dict("records"))
        keep = dfc[dfc.ev.isin(e.index)]
        if len(keep):
            keep = keep.assign(gid=keep.ev.map(e.gid))
            ev_pts.append(keep[["gid", "lon", "lat", "day", "s"]])
        # Focos individuales recientes
        for k_, g in dfc[dfc.k >= recent_from].groupby("k"):
            name = f"{2000 + k_ // 12}-{k_ % 12 + 1:02d}"
            out = {"x": np.round(g.lon * 1000).astype(int).tolist(), "y": np.round(g.lat * 1000).astype(int).tolist(),
                   "d": g.day.astype(int).tolist(), "s": g.s.astype(int).tolist(), "f": np.round(g.frp * 10).astype(int).tolist(),
                   "w": np.round(g.w, 2).tolist(), "p": g.iso.tolist()}
            json.dump(out, open(focos_dir / f"{name}.json", "w"), separators=(",", ":"))
            recientes.append(name)
        print(f"  {f.stem}: {len(df):,} focos, {cnt.sum():,} cuentan, {len(e):,} incendios ≥{C.EVENT_MIN_FOCOS}")

    W = C.WEB_DATA
    r1 = lambda a_: [round(float(x), 1) for x in a_]
    json.dump({iso: {k_: r1(v[K0:]) for k_, v in s.items()} for iso, s in ser.items()}, open(W / "series.json", "w"), separators=(",", ":"))
    json.dump({iso: [[d_, round(v, 1)] for d_, v in sorted(dct.items())] for iso, dct in daily.items()}, open(W / "diario.json", "w"), separators=(",", ":"))
    cells = sorted({c_ for c_, _ in grid}, key=lambda s: tuple(map(int, s.split(","))))
    ci = {c_: i for i, c_ in enumerate(cells)}
    gk = sorted(grid)
    json.dump({"deg": G, "celdas": [list(map(int, c_.split(","))) for c_ in cells],
               "c": [ci[c_] for c_, _ in gk], "k": [k_ - K0 for _, k_ in gk], "v": [round(grid[x] * 10) for x in gk]},
              open(W / "rejilla.json", "w"), separators=(",", ":"))
    years = list(range(FIRST.year, LAST.year + 1))
    json.dump({"mes": cm, "dia": dd, "anios": years,
               "paises": {iso: [round(part_c[iso].get(y_, 0), 1) for y_ in years] for iso in isos},
               "c": [ci[c_] for c_, _ in part_g if c_ in ci], "y": [y_ for c_, y_ in part_g if c_ in ci],
               "v": [round(part_g[x] * 10) for x in part_g if x[0] in ci]}, open(W / "parcial.json", "w"), separators=(",", ":"))
    ev = pd.DataFrame(events)
    if len(ev):
        ev = ev.sort_values("w", ascending=False).reset_index(drop=True)
        top = set(ev.gid.head(C.EVENT_POINTS_TOP)) | set(ev.groupby("iso").head(C.EVENT_POINTS_TOP_COUNTRY).gid)
        ev["pts"] = ev.gid.isin(top)
        json.dump({c_: (np.round(ev[c_], 3).tolist() if c_ in ("lon", "lat") else np.round(ev[c_], 1).tolist() if c_ in ("w", "frp") else ev[c_].tolist())
                   for c_ in ("w", "n", "d0", "d1", "lon", "lat", "frp", "iso", "peak", "gid", "pts")}, open(W / "incendios.json", "w"), separators=(",", ":"))
        P = pd.concat(ev_pts) if ev_pts else pd.DataFrame(columns=["gid"])
        P = P[P.gid.isin(top)]
        P = P.sample(frac=1, random_state=1)
        P = P[P.groupby("gid").cumcount() < C.EVENT_MAX_POINTS].sort_values(["gid", "day"])
        json.dump({str(g_): {"x": np.round(g.lon * 1000).astype(int).tolist(), "y": np.round(g.lat * 1000).astype(int).tolist(),
                             "d": g.day.astype(int).tolist(), "s": g.s.astype(int).tolist()} for g_, g in P.groupby("gid")},
                  open(W / "incendios_focos.json", "w"), separators=(",", ":"))
    shutil.copy(C.AGG / "factors.json", W / "factores.json")
    shutil.copy(C.AGG / "validation.json", W / "validacion.json")
    meta = {"generado": datetime.now(timezone.utc).isoformat(timespec="minutes"), "ultimo_dato": str(LAST.date()),
            "k0": K0, "nk": NK - K0, "rejilla": G, "recientes": sorted(set(recientes)), "cobertura": cov,
            "paises": [{"iso": i_, "nombre": C.COUNTRIES[i_]} for i_ in isos], "sinteticos": a.sinteticos}
    json.dump(meta, open(W / "meta.json", "w"), indent=1)
    sizes = {p.name: f"{p.stat().st_size / 1e6:.1f} MB" for p in W.glob("*.json")}
    print("web/data:", sizes, f"| focos/: {len(recientes)} meses")


if __name__ == "__main__":
    main()
