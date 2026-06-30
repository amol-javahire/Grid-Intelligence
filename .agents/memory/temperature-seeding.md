---
name: Temperature data seeding
description: hourly_temperatures table; 11 zones at 21,168 rows; seed script location and climate baselines.
---

# Temperature Data Seeding

## Table
`hourly_temperatures` — columns: (iso, zone, year, month, day, hour, temp_f, temp_c)
Unique constraint on (iso, zone, year, month, day, hour) — INSERT ON CONFLICT DO NOTHING for idempotence.

## Final State
All 11 zones at 21,168 rows each (Jan 2024 – May 2026, 28 months):
- ERCOT: COAS, EAST, FWES, NCEN, NRTH, SCEN, SOUT, WEST
- CAISO: NP15, SP15, ZP26

## Seeder
`scripts/src/seed-temperatures-completion.py` — run from `artifacts/pypsa-engine/` venv:
```
cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-temperatures-completion.py
```

## Climate Baselines (mean_f, seasonal_amplitude_f, diurnal_range_f)
```python
CLIMATES = {
    ("ERCOT", "WEST"):  (62.0, 18.0, 22.0),  # West Texas — hot summers, cold winters
    ("CAISO", "NP15"):  (58.0,  8.0, 14.0),  # Bay Area — mild, foggy
    ("CAISO", "SP15"):  (66.0, 10.0, 18.0),  # LA — warm, sunnier
    ("CAISO", "ZP26"):  (64.0, 16.0, 24.0),  # Central Valley — desert-like
}
```

## Row Count Formula
28 months × actual days × 24 hours = 21,168 rows per zone (verified in DB).
