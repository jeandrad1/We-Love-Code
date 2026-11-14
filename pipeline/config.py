"""Configuración común del pipeline. Cambia aquí la región o los parámetros."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW_API = DATA / "raw" / "api"          # descargas por API (01_download_firms.py)
RAW_ARCHIVE = DATA / "raw" / "archive"  # CSV del formulario "Archive Download" de FIRMS
CLEAN = DATA / "clean"
HARM = DATA / "harmonized"
WEB_DATA = ROOT / "web" / "data"

# Región de interés: polígono de Andalucía (Natural Earth admin-1, simplificado)
AOI_GEOJSON = DATA / "andalucia.geojson"
# Caja que la contiene (oeste, sur, este, norte) para pedir datos a FIRMS
BBOX = (-7.60, 35.95, -1.60, 38.80)

START_DATE = "2000-11-01"   # primeros datos MODIS Terra

# Fuentes de FIRMS. SP = procesamiento estándar (archivo), NRT = casi tiempo real.
# El script 02 se queda con SP cuando hay ambos para el mismo satélite y día.
FIRMS_SOURCES = [
    "MODIS_SP", "MODIS_NRT",
    "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
]

# Filtros de calidad
MODIS_MIN_CONF = 30                 # 0-100; <30 = baja confianza
VIIRS_CONF_OK = {"n", "h", "nominal", "high"}

# Filtro de fuentes estáticas (industria, termosolares, vertederos...):
# celda de rejilla con detecciones VIIRS en muchos días distintos y repartidas por
# muchos meses del año. Las quemas agrícolas se repiten, pero concentradas en pocos meses.
STATIC_CELL_DEG = 0.01
STATIC_MIN_DAYS = 25
STATIC_MIN_CAL_MONTHS = 8

# Armonización
# Ventana de solape para calibrar MODIS -> VIIRS. Se corta en 2020 porque las órbitas
# de Terra y Aqua derivan después (cambia su hora de paso). Ajustable.
OVERLAP_MODIS_VIIRS = (2012, 2020)
SMOOTH_MONTHS = 1                   # ventana circular ±1 mes al estimar factores
N_BOOT = 1000
CI = (0.05, 0.95)

SAT_CODES = {"Terra": 0, "Aqua": 1, "SNPP": 2, "NOAA20": 3, "NOAA21": 4}
