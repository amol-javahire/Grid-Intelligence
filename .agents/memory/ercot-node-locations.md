---
name: ERCOT node location data
description: How ercot_node_locations table was built, what sources were used, and what lat/lon coverage we have for 804 resource nodes.
---

## What's in ercot_node_locations (819 rows)

- **804 resource nodes** from CDR 12301 (Apr–May 2026 pricing window)
- **15 hub/zone centroids** (HB_NORTH, HB_WEST, etc. + LZ_* zones)
- All 804 resource nodes have **exact load zone** from ERCOT Bus Mapping (CDR 10008)

## Zone distribution (resource nodes)

| Zone | Count |
|------|-------|
| LZ_WEST | 259 |
| LZ_SOUTH | 255 |
| LZ_NORTH | 173 |
| LZ_HOUSTON | 117 |

All 804 nodes fall in only 4 zones — CDR 12301 (7-day rolling window) captures nodes from the most active renewable build-out areas.

## Lat/lon coverage (current)

| Source | Count |
|--------|-------|
| EIA 860 exact name match | 110 |
| EIA 860 fuzzy match (rapidfuzz, score ≥ 80) | 105 |
| Zone centroid (approximate) | 589 |
| Known hub/zone centroids | 15 |

**Total geo-located: 215 of 804 resource nodes (27%)**

**Why only 215:** ERCOT does not publish node lat/lon in any free CDR report. HIFLD ArcGIS substations API returns empty (inaccessible). OSM Overpass didn't help because ERCOT substation codes (e.g. "BYRSW", "LMESA") are internal abbreviations not in OSM. The 589 zone_centroid ones use the 4-zone bounding box centroid.

## Fuzzy matching approach (script: scripts/src/geo-locate-ercot-nodes.py)

- Extracts prefix before first `_` from node name (e.g., `AJAXWIND_RN` → "AJAXWIND")
- Strips tech tokens (SLR, WND, WIND, ESS, BESS) with `\b` word boundary regex
- Strips generic EIA words (Wind, Solar, Farm, Project, LLC, etc.)
- Scores with rapidfuzz: `0.5*partial_ratio + 0.3*token_sort_ratio + 0.2*ratio`
- Guards: minimum EIA clean name length `max(4, len(node_clean)-2)` to prevent short plant names ("H 4" → "h") matching everything via partial_ratio
- Threshold 80 gives ~105 high-confidence matches; 72–78 range has false positives
- `location_source='eia_fuzzy_match'` (vs `'eia_name_match'` for exact, `'zone_centroid'`)

## UI display

- Teal MapPin = exact EIA name match
- Amber MapPin = fuzzy EIA match
- Grey text = zone centroid (honest approximation)
- Stats header shows: "215 geo-located (110 exact · 105 fuzzy EIA match) · 589 zone centroid"

## Data sources used (all free, no auth)

1. **gridstatus Python library** (no API key): `Ercot().get_settlement_points_electrical_bus_mapping()` → node name + zone + substation (no lat/lon)
2. **EIA 860 candidates table** (already in DB): name + lat/lon → 787 ERCOT plants for matching
3. **rapidfuzz** (installed in pypsa venv): fuzzy string matching

## What would get full coverage

- **gridstatus.io API key** (paid): historical LMP data embeds per-node coordinates
- **ERCOT GIS portal** (EMIL): publishes a Substation Geographic file — not confirmed free/public
- **Better fuzzy approach**: nodes like `AJAXWIND_RN` (Ajax Wind Farm) don't match because "Ajax Wind Farm" may not be in 2024 EIA 860 Operable sheet (pre-commercial, retired, or named differently)

## API endpoint

`GET /api/ercot-node-locations?nodeType=resource_node&zone=LZ_WEST&limit=1000`

Returns: nodeName, nodeType, loadZone, hub, substation, latitude, longitude, locationSource, eiaPlantName, avgDaPrice, avgRtPrice, monthsAvailable
