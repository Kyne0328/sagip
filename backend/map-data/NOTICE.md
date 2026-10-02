# SAGIP Tagum offline basemap package

Package: `tagum-protomaps-20261002-z15`

This PMTiles archive is a bounded extract of the official Protomaps daily basemap build `https://build.protomaps.com/20261002.pmtiles`.

- Source replication time: 2026-10-02T04:00:00Z
- Protomaps Basemap version: 4.15.2
- Source data: OpenStreetMap and Natural Earth
- Tagum OpenStreetMap administrative relation used to establish the city boundary: 15986415
- Tagum boundary bbox observed from OpenStreetMap/Nominatim: west 125.7338476, south 7.2464576, east 125.8872506, north 7.5105777
- Packaged operational bbox: west 125.6886, south 7.2015, east 125.9326, north 7.5555 (approximately 5 km buffer)
- Zoom range: 0-15
- Archive bytes: 5,630,162
- SHA-256: `443884615d37bb15e789dd7b665b1016084cd3b9582db00ae2492f593b5daf70`

Attribution shown in the responder console: `© OpenStreetMap contributors · Protomaps`.

OpenStreetMap data is licensed under the Open Data Commons Open Database License (ODbL). Protomaps documents its downloadable basemap as an ODbL Produced Work and requires OpenStreetMap attribution. Natural Earth source data is public domain. See https://www.openstreetmap.org/copyright and https://docs.protomaps.com/basemaps/downloads for current license/source details.

Reproducible extraction command (go-pmtiles v1.31.2):

`pmtiles extract https://build.protomaps.com/20261002.pmtiles tagum-protomaps-20261002.pmtiles --bbox=125.6886,7.2015,125.9326,7.5555 --maxzoom=15`

This package being present and hash-verified is not by itself CP8 field acceptance. Designated-device storage persistence, offline reopen, cartographic legibility, edge coverage, and operational suitability still require the field runbook.
