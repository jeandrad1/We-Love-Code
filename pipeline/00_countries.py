"""Crea data/europa_paises.geojson (países de Europa sin Rusia, recortados a la caja) y la versión
simplificada para la web. Descarga Natural Earth si no está."""
import json

import requests
import shapely
from shapely.geometry import box, mapping, shape

import config as C


def main():
    if not C.NE_COUNTRIES.exists():
        C.NE_COUNTRIES.parent.mkdir(parents=True, exist_ok=True)
        C.NE_COUNTRIES.write_bytes(requests.get(C.NE_URL, timeout=120).content)
    ne = json.load(open(C.NE_COUNTRIES))
    clip = box(*C.BBOX)
    geoms = {}
    for f in ne["features"]:
        a3 = f["properties"]["ADM0_A3"]
        a3 = C.MERGE.get(a3, a3)
        if a3 not in C.COUNTRIES:
            continue
        g = shape(f["geometry"]).intersection(clip)
        geoms[a3] = shapely.union_all([geoms[a3], g]) if a3 in geoms else g
    missing = set(C.COUNTRIES) - set(geoms)
    if missing:
        print("¡Faltan países en Natural Earth!", missing)
    feats, web = [], []
    for a3, g in sorted(geoms.items()):
        props = {"iso": a3, "nombre": C.COUNTRIES[a3]}
        feats.append({"type": "Feature", "properties": props, "geometry": mapping(g)})
        web.append({"type": "Feature", "properties": props,
                    "geometry": mapping(shapely.set_precision(g.simplify(0.03, preserve_topology=True), 0.001))})
    json.dump({"type": "FeatureCollection", "features": feats}, open(C.COUNTRIES_GEOJSON, "w"))
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    json.dump({"type": "FeatureCollection", "features": web}, open(C.WEB_DATA / "paises.geojson", "w"), separators=(",", ":"))
    print(f"{len(feats)} países")


if __name__ == "__main__":
    main()
