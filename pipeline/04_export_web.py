"""Exporta los datos armonizados al formato compacto que lee la web (web/data/).

points.json va en columnas de enteros (comprime muy bien con gzip en GitHub Pages / Netlify):
  x, y : lon/lat × 1e4      d : días desde 2000-01-01      t : hora UTC hhmm
  s    : satélite (0 Terra, 1 Aqua, 2 S-NPP, 3 NOAA-20, 4 NOAA-21)
  c    : categoría de armonización (0 no cuenta, 1 ref, 2 r, 3 a·r, 4 k20, 5 k21)
  f    : FRP × 10 (MW)
"""
import argparse
import json
import shutil
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import config as C


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", action="store_true", help="marca los datos como sintéticos en la web")
    a = ap.parse_args()
    df = pd.read_parquet(C.HARM / "points.parquet")
    d0 = pd.Timestamp("2000-01-01", tz="UTC")
    out = {
        "x": np.round(df.longitude * 1e4).astype(int).tolist(),
        "y": np.round(df.latitude * 1e4).astype(int).tolist(),
        "d": ((df.datetime - d0).dt.days).astype(int).tolist(),
        "t": (df.datetime.dt.hour * 100 + df.datetime.dt.minute).astype(int).tolist(),
        "s": df.sat.map(C.SAT_CODES).astype(int).tolist(),
        "c": df["cat"].astype(int).tolist(),
        "f": np.round(df.frp.fillna(0) * 10).astype(int).tolist(),
    }
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(C.WEB_DATA / "points.json", "w"), separators=(",", ":"))
    for name in ("factors.json", "validation.json"):
        shutil.copy(C.HARM / name, C.WEB_DATA / name)
    shutil.copy(C.AOI_GEOJSON, C.WEB_DATA / "andalucia.geojson")
    cov = json.load(open(C.CLEAN / "coverage.json"))
    meta = {"generado": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "ultimo_dato": max(v[1] for v in cov.values()), "cobertura": cov,
            "n_puntos": len(df), "sinteticos": a.synthetic}
    json.dump(meta, open(C.WEB_DATA / "meta.json", "w"), indent=1)
    print(f"web/data listo: {len(df):,} puntos, último dato {meta['ultimo_dato']}")


if __name__ == "__main__":
    main()
