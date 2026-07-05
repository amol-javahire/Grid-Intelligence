---
name: LTA PDF parsing
description: How the AESO LTA quarterly PDF reports are parsed by lta_parse.py; column index quirk in Table 1.
---

# LTA PDF Parsing (AESO Long-Term Adequacy Metrics)

## Script
`artifacts/pypsa-engine/lta_parse.py` — called by API server via `execSync` (Node.js `child_process`).
Python interpreter: `/home/runner/workspace/artifacts/pypsa-engine/.venv/bin/python3`
Library: `pdfplumber` (already installed in the venv).

## Key quirk: Table 1 column indices
pdfplumber extracts Table 1 header and data rows with *different column offsets* due to merged cells.
Do NOT build col_map from the header row. Use hardcoded data-row positions:
- solar=1, wind=2, storage=3, gas=7, hydro=8, total=11

## AIL Forecast regex
Text layout in PDF: `"Alberta Internal Load (AIL)\n10,417 MW\nForecast\n..."` (value comes BEFORE the word "Forecast").
Working regex: `r"Alberta Internal Load \(AIL\)\s*\n\s*([\d,]+)\s*MW"`

## Two-year probability table
pdfplumber extracts the 3 column headers on one line and values on the next:
- `"Worst Shortfall Hour (MW) # of Hours in Shortfall Total Energy Not Served (MWh)\n0.025 0.001 0.06"`
- Integer hours count (e.g. 7) appears on the following line — use `\b(\d{1,3})\b` to avoid matching the 4-digit year.

## API endpoints
- `GET /api/aeso/lta/reports` — hardcoded list of 14 quarterly PDFs (2023–2026), sourced from aeso.ca
- `GET /api/aeso/lta/data?url=<pdf_url>` — downloads PDF, parses via Python, returns JSON

## Report PDF base URL
`https://www.aeso.ca/download/listedfiles/<filename>.pdf`
Filenames vary by quarter (e.g. `Long-term-adequacy-metrics-May-2026.pdf`, `2026_02_LTA.pdf`).

**Why:** pdfplumber merged-cell handling causes header and data rows to have misaligned column indices; hardcoding was the only reliable fix across all reports tested.
