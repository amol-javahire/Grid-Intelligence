# CAISO Build-Out Scope

What it takes to bring CAISO to ERCOT depth — and what CAISO has that ERCOT
doesn't. Drives both the seeding roadmap and the final tab architecture.

**Companion docs:** [REPLIT_ARCHITECTURE.md](REPLIT_ARCHITECTURE.md) (per-tab),
[DATA_SOURCES.md](DATA_SOURCES.md) (source registry), [CLAUDE.md](CLAUDE.md).

---

## 1. Where CAISO stands today (Azure, Jul 2026)

| Table | Rows | Coverage |
|-------|------|----------|
| `caiso_hub_da_rt_hourly` | 65,655 | 3 zones (NP15/SP15/ZP26) × ~29 months, DA + RT hourly |
| `caiso_node_stats` | 81 | 3 zones × ~27 months, monthly aggregates |
| `queue_projects` | (shared) | CAISO interconnection queue included in the 3,493 total |
| `caiso_node_locations` | **missing** | Blocks `assign-and-score-nodal` — see task #17 |

**ERCOT for contrast:** 11.7M node-hours across **1,109** settlement nodes,
25.5M dispatch rows, 19,946 monthly node-stat rows, 340-bus network model.

The gap is not marginal. CAISO today is **3 zones**; ERCOT is **1,109 nodes**.

---

## 2. Path to ERCOT parity

| ERCOT capability | CAISO equivalent | Source | Effort | Notes |
|---|---|---|---|---|
| Hourly nodal DA/RT, 1,109 nodes | Hourly nodal DA/RT, **~4,000–5,000 pnodes** | OASIS `PRC_LMP` (DAM), `PRC_INTVL_LMP` (RTM 5-min) | **L** | Bigger universe than ERCOT. 31-day max per request; no auth. RTM needs 5-min→hourly rollup. |
| `ercot_node_stats` monthly rollups | `caiso_node_stats` at node level | Derived from above | **S** | Same regen SQL pattern we used for ERCOT. |
| Node → zone mapping | `caiso_node_locations` | OASIS pnode listing + zone attribution | **M** | Needed for nodal scoring; currently blocking task #17. |
| Congestion Intelligence (6 pages) | Same 6 pages, CAISO data | Derived from node stats | **S** | Pages already exist — they read whichever stats table is passed. |
| Load by zone | CAISO load by TAC area | EIA-930 (`respondent=CISO`) | **S** | Same script/API as ERCOT; just a different respondent code. |
| Fuel mix | CAISO fuel mix | EIA-930 | **S** | Same script. |
| Gas & spark spread | SoCal Citygate / PG&E Citygate | EIA / vendor | **M** | **Different hubs** — Waha and Henry Hub are irrelevant to CAISO economics. |
| SCED 60-day dispatch (25.5M rows) | *(no direct analog)* | — | **Gap** | See §4. |
| 340-bus PyPSA topology | CAISO reduced-order network | Would need building | **L** | See §4. |

Effort: S = days · M = 1–2 weeks · L = 3+ weeks

---

## 3. What CAISO has that ERCOT does not

These are **opportunities, not gaps** — they add analysis ERCOT structurally cannot support.

**Resource Adequacy (capacity market).** ERCOT is energy-only; CAISO has an RA
construct with capacity value and local/flexible RA requirements. This is a
whole PPA revenue stream that does not exist in ERCOT and materially changes
deal economics. Warrants its own screen and a scoring dimension.

**Published actual curtailment.** CAISO publishes measured wind and solar
curtailment (economic vs self-scheduled) directly. In ERCOT we *derive*
curtailment from SCED HSL-minus-output. CAISO's is a primary figure — arguably
better evidence than our ERCOT method.

**The duck curve.** CAISO's solar penetration produces structural midday
negative pricing and a steep evening ramp. That makes storage arbitrage and
capture-rate analysis far more interesting than in ERCOT, and it is the
strongest use case for the battery simulator.

**WEIM / EDAM footprint.** The Western Energy Imbalance Market extends beyond
CAISO proper — relevant for any client with western assets outside CA.

**REC economics.** WREGIS at roughly $10–12/MWh versus ERCOT TRC at ~$1.50/MWh.
CAISO RECs are a real value driver rather than a rounding error.

---

## 4. Honest gaps

**No SCED 60-day analog.** ERCOT's per-resource hourly dispatch with offer
curves has no direct CAISO equivalent. CAISO publishes aggregated generation
and delayed public bid data, but not the same per-resource granularity. This
means the **Dispatch / SCED tab, capacity factors, and generation-weighted
capture price cannot be reproduced for CAISO as built.** Options: derive a
coarser capture price from EIA-930 fuel-mix-weighted zonal prices, or scope the
tab as ERCOT-only and say so in the UI.

**No network topology.** The 340-bus ERCOT model came from HIFLD plus CDR bus
data. An equivalent CAISO reduced-order network would have to be constructed —
so **the PyPSA simulators stay ERCOT-only** for now. That is defensible: they
are explicitly ERCOT-calibrated (5-bus zones, ERCOT peak load, Uri preset).

---

## 5. Suggested phasing

1. **Node universe + locations** — pull the CAISO pnode list, build
   `caiso_node_locations` with zone attribution. Unblocks task #17 (nodal scoring).
2. **Hourly nodal DA** — `PRC_LMP` DAM across all pnodes, Jan 2025→now. Mirrors
   the ERCOT DA seed; expect a longer run given ~4× the node count.
3. **Hourly nodal RT** — `PRC_INTVL_LMP`, 5-min → hourly. The heavy one.
4. **Regenerate `caiso_node_stats`** from hourly — same SQL pattern as ERCOT.
   Lights up CAISO Congestion Intelligence immediately.
5. **EIA-930 load + fuel mix** for CISO — same script, new respondent.
6. **Curtailment + Resource Adequacy** — the CAISO-differentiated screens.
7. **Gas hubs** — SoCal / PG&E Citygate for a CAISO spark spread.

Phases 1–4 are what make CAISO feel like a first-class market. 6 is what makes
it *better* than ERCOT in places.

---

## 6. What this means for the tab architecture

**If CAISO reaches phases 1–5**, ERCOT and CAISO become close to symmetric —
both have nodal prices, node stats, congestion intelligence, load and fuel mix.
Symmetry argues for a **global ISO toggle** rather than per-ISO nav groups,
because the same page genuinely works for both markets.

**Three tabs stay ERCOT-only regardless:** Dispatch/SCED, the PyPSA simulators,
and the Waha-based gas analysis. These need either an explicit ERCOT badge or
their own group.

**Recommended end state:** global ISO switch in the header driving all
cross-market and market-data pages, with a small "ERCOT only" affordance on the
three exceptions. Cleaner than nav groups, scales to MISO/SPP later, and by then
the coverage-honesty objection has gone away because coverage is real.

**Decision point:** hold the nav rework until phase 4 completes. Rearranging now
against today's 3-zone CAISO would bake in an asymmetry we are about to remove.
