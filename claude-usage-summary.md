# Summary: what we used Claude for

NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots" (proposed by CONAE). Claude helped us from choosing the approach to getting the website built.

## 1. Planning

- Explanation of the challenge and proposals to make it more useful than a simple calendar: anomalies against usual levels, comparing a fire with earlier ones, validating the correction and a voice assistant.
- Review of the PDF we were given about which challenge to choose.
- Recommendation to start with Andalusia, since we are in Málaga.

## 2. Andalusia version

- Python processing pipeline: NASA FIRMS download, cleaning (including removing fixed heat sources such as industry or solar plants) and correction of MODIS so it can be compared with VIIRS.
- Static website with a map, fire calendar, CSV downloads, official INFOCA data, NASA GIBS satellite imagery and a voice assistant.
- Publication on GitHub Pages.
- A second pass to make the website easier to understand: plain language, accessibility and colours that do not rely on colour alone.

## 3. Move to all of Europe (40 countries, without Russia)

- A MODIS→VIIRS correction factor for each country, with year-by-year validation.
- Fire detection by grouping hotspots that are close in space and time.
- Data prepared so the website loads fast.
- Visual redesign with the dark "orbital night" theme.

## 4. Problems that came up

- Failures downloading from FIRMS: the wrong server and the 5-day limit per query.
- How to reuse the data already downloaded instead of downloading it again.
- Where to store the data so the whole team can use it.
- The CARTO "API key required" warning: the base map is now from Esri, which needs no key.
- Care not to commit the FIRMS key to the repository.

## 5. Website design adjustments

- The year filters and the legend moved onto the map.
- The text block on the landing page was removed and the map sits in a frame to fix scrolling.
- Review of how it looks on mobile and other screen sizes.
- Final map layout: views at the top, years bottom left and legend bottom right.

## Where everything is

- Europe version: the project folder `NasaSpaceAppChallenge2026-Europa` and the zip `fuego-europa.zip`.
- Andalusia version: the project folder `NasaSpaceAppChallenge2026`.
