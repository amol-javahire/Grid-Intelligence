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

## Lat/lon coverage (current — after 4-phase pipeline v2)

| Source | Count |
|--------|-------|
| EIA 860 exact name match | 110 |
| EIA 860 fuzzy match (score ≥ 80) | 137 |
| Queue lat/lon match (score ≥ 75) | 44 |
| County centroid (queue name match, score ≥ 72) | 46 |
| EIA 860 LMP direct match | 1 |
| Zone centroid (approximate) | 466 |
| Known hub/zone centroids | 15 |

**Total geo-located: 338 of 804 resource nodes (42%)**

**Why ~466 still zone_centroid:** ERCOT does not publish node lat/lon in any free CDR report. Nodes without matches tend to be very new projects (post-2024), inactive/retired units, or nodes with highly abbreviated names that don't appear in EIA 860 or the queue.

## 4-phase geolocation pipeline (script: scripts/src/geo-locate-ercot-nodes-v2.py)

**Phase 1 — EIA-860 direct LMP node match**
- `3_1_Generator_Y2024.xlsx` column "RTO/ISO LMP Node Designation" is the ERCOT settlement point name
- Normalize: strip dots/spaces/dashes, uppercase; match against ercot_node_locations.node_name
- source = `eia_lmp_direct`

**Phase 2 — EIA-860 fuzzy plant name match**
- TX plants from `2___Plant_Y2024.xlsx` (June 2026 release, 1,367 TX plants)
- Clean node prefix + clean EIA name; rapidfuzz composite score
- **Key fix**: for nc ≤ 5 chars, use `token_sort*0.5 + ratio*0.5` only (no partial_ratio — causes false positives like 'ang' matching 'lANGer', 'adl' matching 'crADLe')
- For nc < 4 chars, score = 0 (skip entirely)
- Threshold 80; source = `eia_fuzzy_match`

**Phase 3 — ERCOT queue project lat/lon match**
- `queue_projects WHERE market='ERCOT' AND latitude IS NOT NULL`
- Same fuzzy scoring; threshold 75 (queue names are slightly noisier)
- source = `queue_latlon_match`

**Phase 4 — County centroid fallback**
- `queue_projects WHERE market='ERCOT'` with county but no lat/lon
- Fuzzy match project_name to node prefix; threshold 72
- TX county centroid dict (all 254 counties) in the script
- source = `county_centroid`; eia_plant_name = "ProjectName (county: XYZ)"

## EIA-860 data files

Both ZIPs identical: `attached_assets/eia8602024_1777780153233.zip` and `_1777780224772.zip`
- `2___Plant_Y2024.xlsx` — Plant Code → (Plant Name, State, Lat, Lon)
- `3_1_Generator_Y2024.xlsx` — Generator rows; col "RTO/ISO LMP Node Designation" (idx 13) = ERCOT node

## UI display in nodal.tsx (ERCOT Resource Node Browser)

- Teal MapPin = exact EIA name match or eia_lmp_direct
- Amber MapPin = fuzzy EIA match
- Purple MapPin = queue lat/lon match
- Slate MapPin = county centroid
- Grey text = zone centroid (honest approximation)
- Stats header: "338 geo-located (111 exact · 137 fuzzy EIA · 44 queue · 46 county) · 466 zone centroid"

## API endpoint

`GET /api/ercot-node-locations?nodeType=resource_node&zone=LZ_WEST&limit=1000`

Returns: nodeName, nodeType, loadZone, hub, substation, latitude, longitude, locationSource, eiaPlantName, avgDaPrice, avgRtPrice, monthsAvailable
