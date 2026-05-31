---
name: CAISO curtailment scoring
description: How curtailment_score is computed for CAISO candidates — zone mapping, real OASIS data sources, and refresh flow.
---

## Rule
CAISO candidate curtailment_score is computed by `scripts/src/score-caiso-curtailment.ts` using:
1. **Zone mapping** by lat/lon: NP15 (lat ≥ 37.5), ZP26 (lat 35-37.5 AND lon ≤ -118.5), SP15 (everything else)
2. **Real OASIS neg_price_percent** from `caiso_node_stats` (28 months, 2024-2026, public OASIS PRC_LMP)
3. **Asset-type multipliers**: solar highest exposure; geothermal/nuclear lowest
4. **DA-RT spread adjustment** (real OASIS, secondary signal)

`pricing_hub_node` is written with the mapped zone (NP15/SP15/ZP26).
Script also recomputes `overall_score` inline (risk_adjusted_value weights).

**Why:** All 1,484 CAISO candidates had flat curtailment_score ≈ 16.7. Real OASIS data clearly differentiates zones — ZP26 Central Valley (duck curve + solar saturation) scores lowest.

**How to apply:** After new CAISO OASIS data seeded (`pnpm --filter @workspace/scripts run seed-caiso-real`), re-run `pnpm --filter @workspace/scripts run score-caiso-curtailment`.

## Real signal (as of May 2026, 28 months 2024-2026)
| Zone | Neg-Price % | Description |
|------|-------------|-------------|
| NP15 | 3.82% | Northern CA — hydro-balanced, low curtailment |
| SP15 | 13.19% | Southern CA — heavy solar saturation (duck curve) |
| ZP26 | 14.79% | Central CA — highest curtailment, San Joaquin solar |

## Score ranges (as of May 2026)
| Zone | Solar | Wind | Storage | Gas | Hydro/Geo |
|------|-------|------|---------|-----|-----------|
| NP15 | 92.3 | 93.4 | 96.0 | 97.2 | 97-98 |
| SP15 | 72.8 | 76.8 | 86.7 | 91.6 | 91-94 |
| ZP26 | 68.5 | 75.2 | 85.1 | 90.7 | 89-93 |
