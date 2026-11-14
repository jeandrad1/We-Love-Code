"""Datos de referencia por país y año para comparar con los focos de calor.

1) Área quemada anual por país del Global Wildfire Information System (GWIS, Copernicus/JRC), que
   Our World in Data publica en CSV. Es otra medida independiente (cartografía de zonas quemadas,
   todas las coberturas: bosque, matorral y cultivos), no los focos de calor.
2) Opcional: estadísticas oficiales que pongáis en data/raw/reportado_extra.csv con columnas
   iso,year,incendios,hectareas_oficiales (por ejemplo, las tablas por país de los informes de EFFIS).

Salida: web/data/reportado.csv  (iso, year, hectareas_gwis[, incendios, hectareas_oficiales])
"""
import pandas as pd

import config as C

OWID = "https://ourworldindata.org/grapher/annual-area-burnt-by-wildfires-gwis.csv?v=1&csvType=full&useColumnShortNames=false"
CODE_FIX = {"OWID_KOS": "KOS"}


def main():
    df = pd.read_csv(OWID, storage_options={"User-Agent": "Our World In Data data fetch/1.0"})
    val = [c for c in df.columns if c not in ("Entity", "Code", "Year")][-1]
    df["iso"] = df.Code.replace(CODE_FIX)
    df = df[df.iso.isin(C.COUNTRIES)].rename(columns={"Year": "year", val: "hectareas_gwis"})[["iso", "year", "hectareas_gwis"]]
    extra = C.RAW / "reportado_extra.csv"
    if extra.exists():
        df = df.merge(pd.read_csv(extra), on=["iso", "year"], how="outer")
    df = df[df.year >= 2001].sort_values(["iso", "year"])
    df.to_csv(C.WEB_DATA / "reportado.csv", index=False)
    print(f"{len(df)} filas, {df.iso.nunique()} países, {df.year.min()}–{df.year.max()}")


if __name__ == "__main__":
    main()
