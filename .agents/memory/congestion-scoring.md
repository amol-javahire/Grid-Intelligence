---
name: Congestion scoring (ERCOT + CAISO)
description: How interconnection_score (congestion) is computed for ERCOT and CAISO candidates using real market data.
---

## ERCOT — script: score-ercot-congestion.ts
Primary signal: hub DA price basis vs HB_BUSAVG ($29.16/MWh), real CDR 13060, 2024-2026 (28 months).
- HB_PAN (Panhandle): $20.38/MWh, -30% basis → scores ~5-25 for renewables
- HB_WEST: $26.76/MWh, -8% basis → scores ~15-45
- HB_NORTH: $29.49/MWh, +1% → scores ~47-58
- HB_SOUTH: $30.58/MWh, +5% → scores ~54-63
- HB_HOUSTON: $35.42/MWh, +21.5% → scores ~81-89
Zone mapping: LZ_WEST lon < -101.5 → HB_PAN; LZ_WEST otherwise → HB_WEST; LZ_NORTH → HB_NORTH; etc.
Asset adj: renewables penalized in constrained zones; storage/gas/nuclear get bonus.

## CAISO — script: score-caiso-congestion.ts
Primary signals: zone DA price basis vs reference ($33.19) + volatility penalty.
Real OASIS PRC_LMP, 2024-2026:
- NP15: $37.42/MWh (+12.8% basis), vol 16.9 → gas/geo ~75, solar ~60
- SP15: $30.77/MWh (-7.3% basis), vol 22.3 → gas ~45, solar ~28
- ZP26: $29.56/MWh (-10.9% basis), vol 22.4 → gas ~41, solar ~23

**Why:** interconnection_score was flat (ERCOT 24-94 rough range, CAISO 76-84 narrow band). Real hub-price basis and zone volatility create meaningful differentiation that reflects chronic transmission constraint patterns, not just synthetic values.

**How to apply:** After new ERCOT data is seeded (seed-ercot-real), re-run score-ercot-congestion. After new CAISO OASIS data (seed-caiso-real), re-run score-caiso-congestion. Both scripts recompute overall_score inline.

## Combined score scripts in order (refresh sequence)
1. seed-ercot-nodes-cdr → seed-ercot-real → score-ercot-curtailment → score-ercot-congestion
2. seed-caiso-real → score-caiso-curtailment → score-caiso-congestion
