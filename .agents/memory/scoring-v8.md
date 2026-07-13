---
name: Scoring engine v8 — Waha gas coupling
description: Waha vs Henry Hub gas price routing for West Texas zones in the candidate scoring engine
---

# Scoring engine v8 — Waha gas coupling

## The rule
West Texas ERCOT zones (LZ_WEST, HB_WEST, HB_PAN) use the **Waha hub gas price** for thermal fuel-cost deduction instead of Henry Hub. All other zones (ERCOT non-West, CAISO, PJM) use Henry Hub.

**Why:** Gas plants in the Permian Basin burn Waha-priced gas. When Waha trades at a deep discount to Henry Hub (e.g. −$5/MMBtu), competing gas plant economics change and LZ_WEST power prices are depressed, which affects how renewables there should be scored.

## How to apply
- `WAHA_ZONES = new Set(["LZ_WEST", "HB_WEST", "HB_PAN"])` constant
- `effectiveGasPrice(signalZone)` helper returns `avgWahaPrice` if zone in WAHA_ZONES, else `avgGasPrice`
- Gas price loading queries HH and Waha **separately** from gas_prices with `GROUP BY hub`
- Module-level vars: `avgGasPrice` (HH), `avgWahaPrice`, `wahaBasisDiscount` (= waha−HH, typically negative), `wahaBasisVol` (Waha stddev)
- `basisRiskScore()` takes optional `signalZone` param; applies `discountMagnitude × 1.0 + vol × 0.5` penalty when zone in WAHA_ZONES and discount < 0
- `capturePriceScore()` and `marketRevenueScore()` accept optional `gasPrice` param (overrides module-level)

## Important caveat
Waha can go **negative** (avg −$1.01/MMBtu over the trailing 12 months as of Jul 2026). A negative gas price makes thermal fuel cost negative, inadvertently boosting gas plant scores. A follow-up fix should floor effectiveGasPrice at 0 when used for fuel-cost deduction (while retaining the volatility/discount penalty in basisRiskScore).

## Data
gas_prices table: henry_hub (651 rows, avg $2.89 all-time, $3.42 trailing 12-mo), waha (677 rows, avg $0.17 all-time, −$1.01 trailing 12-mo, vol $2.57)
