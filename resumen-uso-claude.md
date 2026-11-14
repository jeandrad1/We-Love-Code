# Resumen: para qué hemos usado Claude

NASA Space Apps Challenge 2026, reto «Harmonization of MODIS and VIIRS Hot Spots» (propuesto por CONAE). Claude nos ha ayudado desde elegir el enfoque hasta tener la web montada.

## 1. Planteamiento

- Explicación del reto y propuestas para que fuera más útil que un simple calendario: anomalías frente a lo habitual, comparar un incendio con los anteriores, validar la corrección y un asistente por voz.
- Revisión del PDF que nos pasaron sobre qué reto elegir.
- Recomendación de empezar por Andalucía, ya que estamos en Málaga.

## 2. Versión Andalucía

- Cadena de procesado en Python: descarga de NASA FIRMS, limpieza (incluido quitar fuentes fijas de calor como industria o plantas solares) y corrección de MODIS para que se pueda comparar con VIIRS.
- Web estática con mapa, calendario de fuego, descargas CSV, datos oficiales de INFOCA, fotos de satélite de NASA GIBS y asistente de voz.
- Publicación en GitHub Pages.
- Segunda pasada para que la web se entendiera mejor: lenguaje llano, accesibilidad y colores que no dependen solo del color.

## 3. Paso a toda Europa (40 países, sin Rusia)

- Un factor de corrección MODIS→VIIRS para cada país, con su validación año a año.
- Detección de incendios agrupando focos cercanos en el espacio y en el tiempo.
- Datos preparados para que la web cargue rápido.
- Rediseño visual con el tema oscuro «noche orbital».

## 4. Problemas que fueron saliendo

- Fallos en la descarga de FIRMS: el servidor equivocado y el límite de 5 días por consulta.
- Cómo aprovechar los datos ya descargados en vez de bajarlos otra vez.
- Dónde guardar los datos para que todo el equipo pueda usarlos.
- El aviso de «API key required» de CARTO: ahora el mapa base es de Esri, que no pide clave.
- Cuidado con no subir la clave de FIRMS al repositorio.

## 5. Ajustes de diseño en la web

- Los filtros de años y la leyenda pasaron al mapa.
- Se quitó el bloque de texto de la portada y el mapa va en un recuadro para arreglar el scroll.
- Revisión de cómo se ve en móvil y otros tamaños de pantalla.
- Distribución final del mapa: vistas arriba, años abajo a la izquierda y leyenda abajo a la derecha.

## Dónde está todo

- Versión Europa: carpeta `NasaSpaceAppChallenge2026-Europa` del proyecto y el zip `fuego-europa.zip`.
- Versión Andalucía: carpeta `NasaSpaceAppChallenge2026` del proyecto.
