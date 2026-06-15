---
name: ERCOT Hourly CDR Seeder
description: How the 263k-row ercot_hub_hourly table was built from CDR XLSX files via Python multiprocessing
---

## The approach that works

Python multiprocessing XML parser (`scripts/parse_ercot_hourly.py`) using `zipfile` + `cElementTree.iterparse` + `multiprocessing.Pool(6)` — processes 12 monthly sheets in parallel in ~60s. Generates CSV, then bulk-loads via `psql \COPY`.

**Why not Node.js XLSX**: The `xlsx` library (SheetJS) OOMs on 22MB annual files. Python `openpyxl` works but is slow (5+ min per file). Raw XML parsing via `cElementTree.iterparse` is 10× faster and uses <500MB RAM.

## Critical format differences between RTM and DAM files

| Field | RTM (CDR 13061) | DAM (CDR 13060) |
|-------|-----------------|-----------------|
| Hour column | Integer 1–24 or numeric string | **"HH:MM" string** (e.g. "01:00") — stored as shared string |
| Date column | "MM/DD/YYYY" string | "MM/DD/YYYY" string |
| Columns | A=date, B=hour, C=?, D=dst_flag, E=sp, F=?, G=price | A=date, B=hour, C=dst_flag, D=sp, E=price |
| DST flag | "Y" to skip repeated hours | same |

**Why:** DAM stores ALL non-numeric cells as shared strings (including time values). RTM stores hours as either integers or numeric strings. `parse_hour()` helper handles both: split on ":", take index 0 for HH:MM; otherwise `int(float(val))` for numeric strings.

## Bulk load command

```bash
psql "$DATABASE_URL" -c "TRUNCATE ercot_hub_hourly;"
psql "$DATABASE_URL" -c "\COPY ercot_hub_hourly(node,node_type,year,month,day,hour,da_price,rt_price) FROM '/tmp/ercot_hourly_data.csv' WITH (FORMAT csv, NULL '')"
```

## Result
- 2024: 131,745 rows (15 nodes × 365 days × 24 hours, minus DST hour)
- 2025: 131,385 rows
- Total: 263,130 rows

## API endpoints added
- `GET /api/ercot/hub-hourly?node=LZ_WEST&year=2024&month=7` — 24-row avg hourly profile + totalRows
- `GET /api/ercot/hub-hourly/nodes` — 15 nodes with year/row counts

**How to apply:** If ever re-seeding, re-run `python3 scripts/parse_ercot_hourly.py` then COPY. Cached XLSXs at `/tmp/ercot-hourly-cache/` (ephemeral — re-download if missing).
