"""Configuración común del pipeline (Europa sin Rusia)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
RAW_COUNTRY = RAW / "country"      # zips o CSV anuales por país de FIRMS (https://firms.modaps.eosdis.nasa.gov/country/)
RAW_API = RAW / "api"              # descargas recientes por API (NRT)
RAW_ARCHIVE = RAW / "archive"      # CSV del formulario "Archive Download" (opcional)
CLEAN = DATA / "clean"
AGG = DATA / "agg"
WEB_DATA = ROOT / "web" / "data"

NE_COUNTRIES = RAW / "ne_50m_admin_0_countries.geojson"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
COUNTRIES_GEOJSON = DATA / "europa_paises.geojson"

# Caja de Europa (incluye Azores, Canarias y Chipre; excluye Svalbard y territorios de ultramar)
BBOX = (-32.0, 27.0, 45.0, 72.0)

# Europa sin Rusia: UE-27 + Reino Unido, Noruega, Suiza, Islandia, Balcanes, Ucrania, Moldavia y Bielorrusia.
# Código ADM0_A3 de Natural Earth -> nombre en español. Åland (ALD) se une a Finlandia.
COUNTRIES = {
    "ALB": "Albania", "AUT": "Austria", "BEL": "Bélgica", "BIH": "Bosnia y Herzegovina", "BGR": "Bulgaria",
    "BLR": "Bielorrusia", "CHE": "Suiza", "CYP": "Chipre", "CZE": "Chequia", "DEU": "Alemania",
    "DNK": "Dinamarca", "ESP": "España", "EST": "Estonia", "FIN": "Finlandia", "FRA": "Francia",
    "GBR": "Reino Unido", "GRC": "Grecia", "HRV": "Croacia", "HUN": "Hungría", "IRL": "Irlanda",
    "ISL": "Islandia", "ITA": "Italia", "KOS": "Kosovo", "LTU": "Lituania", "LUX": "Luxemburgo",
    "LVA": "Letonia", "MDA": "Moldavia", "MKD": "Macedonia del Norte", "MLT": "Malta", "MNE": "Montenegro",
    "NLD": "Países Bajos", "NOR": "Noruega", "POL": "Polonia", "PRT": "Portugal", "ROU": "Rumanía",
    "SRB": "Serbia", "SVK": "Eslovaquia", "SVN": "Eslovenia", "SWE": "Suecia", "UKR": "Ucrania",
}
MERGE = {"ALD": "FIN"}
# Nombres alternativos que puede usar FIRMS en los ficheros por país
ALIASES = {
    "CZE": ["Czech Republic", "Czechia"], "MKD": ["Macedonia", "North Macedonia", "The former Yugoslav Republic of Macedonia"],
    "MDA": ["Moldova", "Republic of Moldova"], "BIH": ["Bosnia and Herzegovina"], "GBR": ["United Kingdom", "UK"],
    "KOS": ["Kosovo"], "NLD": ["Netherlands", "The Netherlands"],
}

START_YEAR = 2000

# Fuentes de la API para el año en curso (los años completos vienen de los resúmenes por país)
FIRMS_SOURCES = ["MODIS_NRT", "MODIS_SP", "VIIRS_SNPP_NRT", "VIIRS_SNPP_SP",
                 "VIIRS_NOAA20_NRT", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_NRT"]

# Calidad
MODIS_MIN_CONF = 30
VIIRS_CONF_OK = {"n", "h", "nominal", "high"}

# Fuentes fijas de calor (industria, antorchas, plantas solares): celda con VIIRS en muchos días y meses
STATIC_CELL_DEG = 0.01
STATIC_MIN_DAYS = 25
STATIC_MIN_CAL_MONTHS = 8

# Armonización: un factor MODIS->VIIRS por país (con respaldo europeo si hay pocos datos)
OVERLAP_MODIS_VIIRS = (2012, 2020)     # después, las órbitas de Terra y Aqua derivan
MIN_MODIS_FOR_COUNTRY_FACTOR = 400     # detecciones MODIS en el solape para usar factor propio
N_BOOT = 500
CI = (0.05, 0.95)

# Agregados para la web
GRID_DEG = 0.5                 # rejilla del mapa (~50 km)
RECENT_POINT_MONTHS = 24       # meses recientes con focos individuales en la web
EVENT_CELL_DEG = 0.02          # agrupación de incendios: ~2 km
EVENT_DAYS = 2                 # y 2 días
EVENT_MIN_FOCOS = 15           # incendios que se guardan (en focos corregidos)
EVENT_POINTS_TOP = 200         # incendios de Europa con todos sus focos (para verlos avanzar)
EVENT_POINTS_TOP_COUNTRY = 10  # y los mayores de cada país
EVENT_MAX_POINTS = 3000        # como mucho, focos guardados por incendio (muestra aleatoria)

SAT_CODES = {"Terra": 0, "Aqua": 1, "SNPP": 2, "NOAA20": 3, "NOAA21": 4}
