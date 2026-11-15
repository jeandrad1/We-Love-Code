"""Almacén de puntos: todas las detecciones limpias, consultables por AOI sin perder resolución.

Entrada : data/clean/AAAA.parquet   (salida de 02: todos los sensores, ya filtradas y sin duplicados)
          data/agg/factors.json     (salida de 03)
Salida  : web/data/points/tile_<tx>_<ty>.parquet   detecciones CRUDAS, teselas de POINTS_TILE_DEG°,
                                                   ordenadas en curva Z por celda de POINTS_CELL_DEG°
                                                   y luego por fecha (las estadísticas de los grupos de
                                                   filas permiten leer solo lo que toca el AOI)
          web/data/points/weights.parquet           (iso, k, s) -> w, wl, wh
          web/data/points/manifest.json             teselas (caja, filas, bytes), satélites, versión
Al final comprueba que sum(w) por país y mes coincide con series.json (si 04 ya se ejecutó).

Uso:  python 06_points.py
"""
import json
import shutil
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

import config as C
from harmonize_lib import attach_weights, build_weights, kof  # noqa: F401

OUT = C.WEB_DATA / "points"
TMP = C.AGG / "tiles_tmp"
COLS = ["datetime", "lat", "lon", "s", "k", "frp", "iso", "nrt"]


def zorder(ix, iy):
    """Entrelaza los bits de dos enteros (<65536): celdas vecinas quedan cerca en el fichero."""
    def spread(v):
        v = v.astype(np.uint64)
        for sh, mask in ((8, 0x00FF00FF), (4, 0x0F0F0F0F), (2, 0x33333333), (1, 0x55555555)):
            v = (v | (v << np.uint64(sh))) & np.uint64(mask)
        return v
    return spread(ix) | (spread(iy) << np.uint64(1))


def split_by_tile():
    """Pasada 1: un año cada vez (poca memoria) -> TMP/<tx>_<ty>/<año>.parquet"""
    if TMP.exists():
        shutil.rmtree(TMP)
    T, n = C.POINTS_TILE_DEG, 0
    for f in sorted(C.CLEAN.glob("[0-9]*.parquet")):
        df = pd.read_parquet(f)
        tx = np.floor(df.lon.values / T).astype(int)
        ty = np.floor(df.lat.values / T).astype(int)
        for (a, b), g in df.groupby([tx, ty]):
            d = TMP / f"{a}_{b}"
            d.mkdir(parents=True, exist_ok=True)
            g.to_parquet(d / f"{f.stem}.parquet", index=False)
        n += len(df)
        print(f"  {f.stem}: {len(df):,} detecciones")
    return n


def write_tiles(W):
    """Pasada 2: una tesela cada vez -> ordenar -> escribir. Devuelve manifiesto y suma de pesos."""
    T, cell = C.POINTS_TILE_DEG, C.POINTS_CELL_DEG
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("tile_*.parquet"):
        old.unlink()
    tiles, acc, total = [], None, 0
    for d in sorted(TMP.iterdir()):
        tx, ty = map(int, d.name.split("_"))
        df = pd.concat([pd.read_parquet(p) for p in sorted(d.glob("*.parquet"))], ignore_index=True)
        df["s"] = df.sat.map(C.SAT_CODES).astype("int8")
        df["k"] = ((df.datetime.dt.year - 2000) * 12 + df.datetime.dt.month - 1).astype("int16")
        df["nrt"] = df.proc.eq("NRT")
        # control de calidad: la suma de pesos por país y mes se compara luego con series.json
        g = attach_weights(df[["iso", "k", "s"]], W).groupby(["iso", "k"])[["w", "wl", "wh"]].sum()
        acc = g if acc is None else acc.add(g, fill_value=0.0)
        ix = np.clip(np.floor((df.lon.values - tx * T) / cell), 0, 65535).astype(np.int64)
        iy = np.clip(np.floor((df.lat.values - ty * T) / cell), 0, 65535).astype(np.int64)
        df["_z"] = zorder(ix, iy)
        df = df.sort_values(["_z", "datetime"], kind="stable")
        out = df[COLS].astype({"lat": "float32", "lon": "float32", "frp": "float32"})
        out["iso"] = out.iso.astype("category")
        name = f"tile_{tx}_{ty}.parquet"
        pq.write_table(pa.Table.from_pandas(out, preserve_index=False), OUT / name,
                       compression="zstd", compression_level=9, row_group_size=C.POINTS_ROW_GROUP,
                       coerce_timestamps="ms", allow_truncated_timestamps=True)
        size = (OUT / name).stat().st_size
        tiles.append({"file": name, "bbox": [tx * T, ty * T, (tx + 1) * T, (ty + 1) * T],
                      "rows": int(len(out)), "bytes": int(size)})
        total += len(out)
        print(f"  {name}: {len(out):,} filas, {size / 1e6:.1f} MB")
    return tiles, acc, total


def reconcile(acc):
    """sum(w) de los puntos == series.json['h'] para cada país y mes (series.json va redondeado a 0.1)."""
    sp, mp = C.WEB_DATA / "series.json", C.WEB_DATA / "meta.json"
    if not (sp.exists() and mp.exists()):
        print("  (sin series.json/meta.json: ejecuta 04 para poder reconciliar)")
        return
    S, k0 = json.load(open(sp)), json.load(open(mp))["k0"]
    got = acc["w"].to_dict()
    worst = max((abs(got.get((iso, i + k0), 0.0) - v) for iso, s in S.items() for i, v in enumerate(s["h"])), default=0.0)
    print(f"  reconciliación con series.json: diferencia máxima {worst:.3f} focos equivalentes")
    if worst > 0.051:
        raise SystemExit("Los puntos y series.json NO cuadran: 04 y 06 no usan los mismos pesos/datos.")


def main():
    F = json.load(open(C.AGG / "factors.json"))
    W = build_weights(F)
    OUT.mkdir(parents=True, exist_ok=True)
    W.astype({"w": "float32", "wl": "float32", "wh": "float32"}).to_parquet(OUT / "weights.parquet", index=False)
    print(f"pesos: {len(W):,} filas")
    n = split_by_tile()
    tiles, acc, total = write_tiles(W)
    assert total == n, f"se perdieron filas: {n:,} -> {total:,}"
    reconcile(acc)
    shutil.rmtree(TMP)
    manifest = {"generado": datetime.now(timezone.utc).isoformat(timespec="minutes"),
                "tile_deg": C.POINTS_TILE_DEG, "cell_deg": C.POINTS_CELL_DEG,
                "satelites": C.SAT_CODES, "filas": total, "bytes": sum(t["bytes"] for t in tiles),
                "columnas": {"datetime": "UTC, ms", "lat": "float32", "lon": "float32", "s": "satélite (int8)",
                             "k": "mes desde 2000-01 (int16)", "frp": "MW", "iso": "país", "nrt": "true = procesamiento NRT (provisional)"},
                "tiles": tiles}
    json.dump(manifest, open(OUT / "manifest.json", "w"), indent=1)
    print(f"{total:,} detecciones en {len(tiles)} teselas, {manifest['bytes'] / 1e6:.0f} MB")


if __name__ == "__main__":
    main()