---
name: ERCOT Queue Real Data
description: How to pull and refresh real ERCOT interconnection queue data from ERCOT GIS Report
---

## Source
ERCOT GIS Report **pg7-200-er** — public EMIL portal, no auth, no API key.
- gridstatus Python lib wraps it: `from gridstatus import Ercot; ercot.get_interconnection_queue()`
- Returns ~1,793 projects (active + completed); live from ERCOT EMIL on each call.
- Companion report **pg7-201-er** = transmission upgrade cost per project (future use for interconnect risk scoring).

## Script
`scripts/src/seed-ercot-queue-real.py` — run via pypsa venv:
```
pnpm --filter @workspace/scripts run seed-ercot-queue-real
```

## Column Mapping
| gridstatus column | queue_projects column |
|---|---|
| Queue ID | queue_id |
| Project Name | project_name |
| Fuel + Technology | fuel_type (normalized) |
| Capacity (MW) | capacity_mw |
| Status | status (active/completed/withdrawn) |
| County + State | county, state → lat/lng via centroid dict |
| CDR Reporting Zone | study_group_phase (LZ_WEST/LZ_NORTH/LZ_SOUTH/LZ_HOUSTON) |
| Queue Date | request_date |
| Interconnection Location | interconnection_node |
| Withdrawn Date | withdrawal_date |

## Fuel normalization
- "Other" + "Battery Energy Storage" technology → storage (885 of 889 "Other" rows)
- Solar → solar, Wind → wind, Gas → natural_gas, Nuclear → nuclear, Water → hydro

## CDR zone mapping
WEST/PANHANDLE → LZ_WEST, NORTH → LZ_NORTH, SOUTH → LZ_SOUTH, COASTAL/HOUSTON → LZ_HOUSTON

## Geocoding
Texas county centroid dict covers ~68% of projects. Non-Texas counties or unmapped ones get null lat/lng.

## Stats (as of July 2026 pull)
- 1,793 total: 1,224 active (300 GW), 569 completed (134 GW)
- Fuel mix (active): storage 676, solar 372, natural_gas 91, wind 78
- Date range: Nov 2013 – Jun 2026 (real INR queue IDs like 15INR0064b)

**Why:** pg_stat_user_tables shows stale row counts — always use COUNT(*) directly for accurate numbers.
