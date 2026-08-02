# ERCOT PyPSA Validation and Implementation Plan

**Status:** Implementation specification  
**Prepared:** 2026-07-28  
**Scope:** ERCOT nodal congestion, curtailment, dispatch, scarcity, storage, transmission relief, large loads, and investment scenarios  
**Primary implementation target:** `artifacts/pypsa-engine/`

## Executive decision

The application has a useful ERCOT PyPSA prototype, but neither current network tier is ready to be described as a validated ERCOT grid model:

- Tier 1 is a five-bus, single-hour illustrative network with hardcoded capacities, transfer limits, and load shares.
- Tier 2 contains ERCOT electrical-bus names, resource-node mappings, and some coordinates, but its transmission branches are produced by a geographic k-nearest-neighbour algorithm. Branch ratings and reactances are estimated. It is therefore a **synthetic graph with ERCOT-labelled buses**, not a real ERCOT electrical topology.

The current “Tier 2 real topology” label must be removed. Its results may be retained as experimental/synthetic, but should not support claims about an actual line, historical congestion, nodal price, curtailment pocket, transmission upgrade, or shift factor.

The recommended hierarchy is:

1. **Tier A — Five-zone illustrative:** keep the current fast model for educational sensitivities.
2. **Tier B — Market-calibrated reduced network:** build approximately 12–25 electrically meaningful buses/cutsets using actual ERCOT bus mappings, Load Distribution Factors, observed binding constraints, shadow prices, delayed state-estimator flows, and documented transfer paths.
3. **Tier C — Detailed network:** use a properly licensed/public or participant-authorized ERCOT/WECC-style network case with authoritative connectivity, transformers, impedances, ratings, contingencies, and topology vintage. A 100–500-bus reduction may be appropriate, but bus count is an output of validation—not a target.

PyPSA can solve all three sizes. Data rights and electrical fidelity are the limiting factors.

ERCOT differs materially from AESO: ERCOT publishes actual nodal and settlement-point prices. Historical basis, capture price, and PPA analytics must continue to use observed ERCOT prices. PyPSA should be used for historical reconstruction, validation, and counterfactual scenarios—not as a substitute for settled price data.

## What “validated” should mean

| Model tier | Permitted claim | Minimum evidence |
|---|---|---|
| Tier A — Illustrative | Demonstrates ERCOT-shaped sensitivities | Deterministic tests and truthful assumptions |
| Tier B — Calibrated reduced network | Reproduces material constraints, zonal transfers, dispatch, and price separation | Authoritative mappings, observed constraint data, chronological backtest, holdout results |
| Tier C — Detailed planning/operations approximation | Supports defined nodal, contingency, and investment studies | Authoritative topology/parameters, effective-dated outages, generator/load mapping, security studies, engineering review |

Even Tier C is not ERCOT’s production SCED. The application must distinguish:

- electrical-bus LMP;
- resource-node LMP;
- hub/load-zone LMP;
- settlement-point price;
- price adders; and
- PyPSA modelled marginal price.

## Current implementation audit

Primary files reviewed:

- `artifacts/pypsa-engine/network.py`
- `artifacts/pypsa-engine/seed_topology.py`
- `scripts/src/seed-ercot-shift-factors.py`
- `artifacts/pypsa-engine/simulators.py`
- `artifacts/pypsa-engine/expansion.py`
- `artifacts/pypsa-engine/dispatch_seeder.py`
- `artifacts/api-server/src/data/ercot-topology.ts`

### Useful capabilities already present

- PyPSA/HiGHS dispatch and DC-OPF execution.
- Five-zone user-facing scenarios.
- Database-backed ERCOT price, load, fuel-mix, generator, node, and SCED ingestion paths.
- Actual ERCOT nodal/hub prices for historical customer analytics.
- SCED delayed-disclosure ingestion with resource output, limits, and offer information.
- Storage dispatch, curtailment, scarcity, transmission-relief, and multi-period expansion prototypes.
- Model tier and data-source fields in some API responses.

### Critical deficiencies

| Area | Current behaviour | Validation issue | Required correction |
|---|---|---|---|
| Tier 2 topology | Each bus connects to up to six geographically nearest buses | Geographic proximity does not establish an electrical branch; artificial cliques and zero-length branches appear | Relabel synthetic; replace with an authoritative/reduced electrical graph |
| Bus universe | Only selected 345 kV buses with resource nodes | Omits lower-voltage network, load buses, transformers, series devices, and buses without generation | Build from a defensible network case or constraint-preserving reduction |
| Coordinates | Many buses use jittered load-zone centroids | Map placement is not an actual substation coordinate and distorts kNN topology | Store true/estimated coordinates separately with confidence; never derive connectivity from jittered points |
| Branch limits | Defaults such as 800/600 MW and corridor capacity divided by six | Not actual normal/emergency ratings or monitored-element limits | Use reported ratings/limits or calibrated interface equivalents |
| Reactance | Derived from geographic length and scaled for numerical stability | Changes PTDFs and congestion patterns without electrical evidence | Use source impedances or calibrated equivalents with sensitivity ranges |
| “Shift factors” | Computed on the synthetic graph and normalized within nearest-centroid EIA zones | These are internal load-allocation weights, not published ERCOT shift factors or LDFs | Rename; use ERCOT Load Distribution Factors and actual constraint shift-factor data when available |
| Generator mapping | EIA plants map to the geographically nearest synthetic bus and aggregate by carrier | Plant coordinates do not prove the connected bus; aggregation loses resource constraints | Use ERCOT resource-node/electrical-bus mapping and resource identifiers |
| Load mapping | EIA sub-BA load multiplied by synthetic PTDF-derived weights | PTDF is not a load distribution method; zone assignment is geographic | Use ERCOT LDFs and reconcile to weather/forecast/study-area load |
| Time | Dispatch and most simulators use one snapshot | No ramps, commitment, storage chronology, outages, forecasts, or scarcity sequence | Run chronological snapshots with rolling horizon |
| Renewables | One system-wide wind CF and solar CF | Erases geographic/weather diversity and can create false local curtailment | Use resource/region-specific hourly availability and forecasts |
| Storage | Main network treats storage as a zero-cost generator | Storage cannot charge and has no energy/SOC constraint | Use `StorageUnit` or `Store` + `Link` with chronology |
| Emergency supply | Large hidden “peaker” capacity, often at $499/MWh | Conceals topology/supply failures and truncates scarcity economics | Use explicit unserved-energy components at current approved assumptions; report every MWh |
| Market design | Single-stage cost-minimizing DC-OPF | Does not reproduce DAM, RUC, SCED, ancillary co-optimization, mitigation, adders, losses, or heuristic pricing | State approximation; add features in validated increments |
| Congestion flag | Loading threshold (95%) | A highly loaded branch is not necessarily an economically binding monitored constraint | Report utilization and constraint dual/shadow price separately |
| Price aggregation | Arithmetic mean of bus LMPs | Unloaded and low-load buses receive equal weight | Use load-weighted values and compare equivalent price components |
| Solver status | Objective presence is treated as optimal | Does not validate solver status/termination | Require returned status and condition; expose infeasible/unbounded/error |
| Fallback | Missing DB topology silently uses Tier 1 | User may think a detailed model ran | Fail closed for requested Tier 2/3; require explicit opt-in to fallback |
| Expansion | Five hardcoded buses, four synthetic seasonal days, stale 2024 ATB inputs | Misses extreme chronology, retirements, queue, transmission, reliability rules, and current costs | Rebuild after operational model validation using current assumptions and stress periods |
| Battery backtest | Optimizes on a blended average-hour signal, clips negative prices, then calculates revenue at DA | Dispatch signal and settlement price differ; average days erase chronology; clipping changes charging incentives | Optimize actual chronological DA or RT prices under an explicitly selected settlement strategy |

### Existing topology data must be quarantined

`artifacts/api-server/src/data/ercot-topology.ts` embeds the synthetic branch set. Several buses share fallback centroids, producing zero-length branches with minimum reactance. Do not use this file as evidence that the production database contains real lines.

Add fields such as:

- `topology_class`: `illustrative`, `synthetic`, `reported`, `reduced`, `licensed`
- `parameter_quality`: `reported`, `derived`, `calibrated`, `assumed`
- `network_vintage`
- `source_url`
- `source_case`
- `confidence`

## Recommended network resolution

### Tier A: retain the five-zone demonstration

Keep NORTH, WEST, PANHANDLE, SOUTH, and HOUSTON for sub-second educational scenarios. Label every output `Illustrative 5-Zone ERCOT`.

### Tier B: 12–25 constraint-preserving buses

Do not simply split the map into equal areas. Form buses around actual:

- weather/load zones and ERCOT study areas;
- major generation pockets such as Panhandle, West Texas/Permian, coastal wind, and solar/storage clusters;
- Houston, Dallas–Fort Worth, Austin, and San Antonio load pockets;
- observed repeatedly binding constraints and interfaces;
- DC ties and asynchronous boundaries;
- large-load/data-centre concentration areas; and
- named transmission upgrade corridors.

Use historical price/constraint clustering and electrical mappings to choose the final aggregation. Preserve the buses on each side of important monitored constraints.

### Tier C: detailed network

Possible inputs include an authorized ERCOT planning/operations case, a properly licensed synthetic US network, or a PyPSA-USA Texas model. [PyPSA-USA](https://github.com/PyPSA/pypsa-usa) supports Texas and Western Interconnection workflows and flexible clustering, but its ReEDS/TAMU networks remain planning/synthetic inputs. They are useful foundations—not proof of ERCOT operational fidelity.

Do not call a detailed model “real ERCOT topology” unless every branch and transformer has an authoritative source and permitted use.

## Authoritative ERCOT validation data

### Prices and pricing mechanics

- [ERCOT Market Prices](https://www.ercot.com/mktinfo/prices/index.html) links DA/RT LMPs, settlement-point prices, DAM shadow prices, price adders, corrections, and historical hub/load-zone prices.
- [System-Wide Prices](https://www.ercot.com/gridmktinfo/dashboards/systemwideprices) explains the distinction between LMPs and settlement-point prices.
- NP4-190-CD — DAM Settlement Point Prices.
- NP6-905-CD — RT Settlement Point Prices at resource nodes, hubs, and load zones.
- DAM Hourly LMPs and DAM Shadow Prices.
- Real-Time LMPs by electrical bus/resource node.
- Historical real-time price adders by SCED and settlement interval.
- Price-correction notices and corrected vintages.

Model validation must compare like with like:

- PyPSA DC nodal marginal price is closest to the energy-plus-congestion result of its own network balance.
- Compare congestion components/price separation before comparing total SPP.
- Do not expect PyPSA to reproduce losses or adders until those are explicitly represented.
- Apply ERCOT’s electrical-bus-to-resource-node/heuristic pricing mapping before evaluating resource-node error.

### Network, load, and constraints

- [ERCOT Transmission](https://www.ercot.com/gridinfo/transmission) for electrical-bus mapping and network-model documentation.
- [ERCOT Modeling](https://www.ercot.com/gridinfo/modeling) for Network Operations Model/CIM schemas and modelling expectations.
- NP4-160-SG — Settlement Points List and Electrical Buses Mapping.
- Electrical Bus Mapping for Heuristic Pricing.
- [NP4-159-CD Load Distribution Factors](https://www.ercot.com/mp/data-products/data-product-details?id=NP4-159-CD).
- [Actual System Load by Weather Zone](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-345-CD).
- Actual System Load by Forecast Zone and Study Area.
- NP6-619-ER — delayed state-estimator transmission line flows.
- NP6-622-ER — delayed state-estimator transformer information.
- DAM and SCED binding constraints, shadow prices, contingencies, and shift factors where included in public disclosures.
- Transmission outages, ratings, topology changes, and network-model production schedule.

The delayed state-estimator reports are especially valuable for checking branch names, direction, loading, topology vintage, and reduced-interface flows. Verify current access, retention, and field definitions before designing a backfill.

### Resources and dispatch

- [ERCOT Generation](https://www.ercot.com/gridinfo/generation/index.html) for capacity, fuel mix, renewable production/forecasts, and adequacy reports.
- NP3-965-ER — 60-Day SCED Disclosure, including resource offers, output/base point, HSL/LSL and related SCED fields.
- 60-Day DAM Disclosure for DA commitments/offers where applicable.
- Resource-node/electrical-bus mapping.
- Resource asset registration/effective dates and Energy Storage Resource fields.
- Wind and solar actual/forecast/HSL reports.
- Outage and derate data.
- Ancillary-service responsibilities, awards, prices, and capability.

SCED data can support dispatch and curtailment validation, but `HSL - output` is not automatically transmission curtailment. It can include economic dispatch, reserve awards, ramp limits, unit status, telemetered constraints, and other causes. Use constraints, prices, offers, and resource state to classify curtailment.

### Queue, transmission projects, and large loads

- [ERCOT Resource Adequacy / Generator Interconnection Status](https://www.ercot.com/gridinfo/resource) for the current monthly GIS queue and capacity trends.
- [ERCOT Planning and TPIT](https://www.ercot.com/gridinfo/planning/) for Regional Transmission Plans, LTSA, constraints/needs, and transmission-project status.
- [ERCOT Large Load Integration](https://www.ercot.com/services/rq/large-load-integration) for the current large-load study/batch process, forms, and requirements.
- [ERCOT Large Load Working Group](https://www.ercot.com/committees/tac/llwg) for active design assumptions and stakeholder material.

Customer-specific large-load information may be protected. Store only public/authorized attributes and distinguish:

- requested MW;
- substantiated/study-eligible MW;
- approved/contracted MW;
- energized MW; and
- scenario MW.

Do not treat the headline large-load request total as a load forecast.

## Required trailing-12-month data audit

Use the previous completed ERCOT operating day as the endpoint. Store local interval, UTC interval, Central Prevailing Time offset, hour-ending/interval-ending convention, and DST flag.

Audit:

| Dataset | Minimum check |
|---|---|
| DA/RT electrical-bus, resource-node, hub, and load-zone prices | Expected intervals, node coverage, adders/components, corrections |
| Weather/forecast/study-area load | Hourly completeness and reconciliation to system load |
| Fuel mix and renewable actual/forecast | Interval coverage and agreement with public totals |
| SCED resource data | Resource/interval coverage, offers, HSL/LSL, output/base point, AS fields |
| Line/transformer state-estimator data | Branch identifiers, flows, ratings if present, topology status |
| Binding constraints/shadow prices | Constraint, contingency, monitored element, shift factor, cap, shadow price |
| Transmission outages | Start/end, element mapping, planned/forced, derate |
| DC ties | Actual/scheduled flow, direction, limits, outages |
| Generator/storage registry | Effective-dated name, node/bus, fuel, capacity, operating parameters |
| Queue/TPIT/large loads | Publication vintage, status, POI/location, MW, in-service date |

For delayed disclosures, the observation date and publication date differ. Store both.

The project’s SCED seed log must be validated against known correction notices and expected file members. A successful ZIP download is not proof that all resource files/columns were complete.

## Additional data required for authenticity

### Priority 0

- authoritative electrical connectivity or a calibrated constraint-preserving reduced network;
- electrical-bus/resource-node/settlement-point mappings;
- ERCOT Load Distribution Factors;
- hourly regional load;
- actual generator output, HSL/LSL, offers, and resource status;
- actual line/transformer flows and topology status;
- binding constraints, contingencies, shadow prices, and applicable shift factors;
- DA/RT price components and adders;
- DC-tie flows and limits;
- source/version/provenance metadata.

### Priority 1

- normal/emergency ratings, impedances, transformers, phase shifters, and losses;
- unit commitment, ramps, minimum output, start-up costs, outages, and RUC/must-run effects;
- storage SOC, charging load, duration, efficiency, AS awards, and hybrid constraints;
- renewable plant-level availability and forecasts;
- gas prices at Waha, Houston Ship Channel/Katy or appropriate plant region—not only Henry Hub;
- weather and forced-outage drivers;
- ancillary-service requirements and co-optimization logic;
- explicit scarcity and reliability-deployment price adders;
- transmission service-provider project/outage changes by effective date.

### Priority 2

- current GIS/queue and probability-weighted project buildout;
- TPIT transmission upgrades and alternative in-service dates;
- Batch Zero/large-load scenarios with location, ramping, flexibility, and energization probability;
- retirements, mothballs, and seasonal ratings;
- current NREL ATB/EIA cost vintages and interconnection costs;
- reliability-standard/adequacy assumptions current for each study year;
- stochastic weather, outage, gas, and large-load scenarios.

## PyPSA use cases for ERCOT

| Use case | Applicability | Implementation note |
|---|---|---|
| Economic dispatch | High | Reconstruct SCED directionally, but document missing market rules |
| Unit commitment/rolling horizon | High | Necessary for thermal ramps, starts, scarcity sequences, and storage |
| DC-LOPF | High | Core counterfactual congestion tool once topology is credible |
| AC power flow | Medium/later | Use selected stressed snapshots with complete voltage/reactive data |
| Security-constrained LOPF | High/later | Use actual credible contingencies and emergency ratings |
| Storage dispatch | High | Model DA, RT, ancillary services, SOC, degradation, and settlement separately |
| Transmission relief | High | Compare named upgrades; never “upgrade” a synthetic kNN branch |
| Capacity expansion | High | Add current costs, queue, retirements, reliability rules, and extreme periods |
| Representative periods | Planning only | Include extreme scarcity, renewable-lull, and congestion days; do not validate history with four synthetic days |
| Stochastic optimization | High/later | Weather, forced outages, gas, large loads, and queue uncertainty |
| MGA/near-optimal planning | Useful | Show alternative portfolios with similar cost/reliability |
| PPA/capture/basis | High | Historical metrics use actual SPP/LMP; model only forward/counterfactual deltas |

[PyPSA](https://github.com/pypsa/pypsa) supplies these components. [PyPSA-USA](https://github.com/PyPSA/pypsa-usa) should be evaluated for workflow, clustering, resource-data, production-cost, and expansion patterns. Do not copy a PyPSA-USA network into the customer-facing app without an ERCOT-specific provenance and validation layer.

## Implementation plan for Claude

### Phase 0 — truth, safety, and regression tests

1. Rename Tier 2 to `Synthetic ERCOT 345-kV kNN Network`.
2. Remove “real topology,” “real line,” and “genuine local congestion” claims from API/UI/docs.
3. Require explicit requested tier; do not silently fall back.
4. Return optimizer status, termination condition, objective, energy-balance residual, unserved energy, and dependency versions.
5. Replace hidden peakers with explicit unserved-energy components and current, source-linked assumptions.
6. Use load-weighted price metrics and constraint duals.
7. Add data-quality classes and source/vintage fields to every topology response.
8. Correct the battery backtest: actual chronological price series, selected DA/RT strategy, negative prices retained, SOC boundaries, cycle limits, and matching settlement revenue.
9. Add regression tests for congestion, islanding, load shedding, storage conservation, negative prices, fallback prevention, DST, and cost reconciliation.

**Gate:** No endpoint can present the kNN graph as actual ERCOT topology.

### Phase 1 — data and coverage foundation

1. Audit the trailing 12 months of prices/load/fuel mix and available delayed SCED/state-estimator history.
2. Ingest/refresh electrical-bus, resource-node, heuristic-pricing, and LDF mappings with effective dates.
3. Ingest line/transformer flow, constraint, shadow-price, contingency, outage, and DC-tie series.
4. Create source-specific raw tables plus normalized interval keys.
5. Add row-level completeness ledgers; do not mark a day complete from a partial file.
6. Validate three sample intervals per source against ERCOT’s public display/report.
7. Preserve corrections and source vintages rather than overwriting without history.

**Gate:** Every required series has a coverage report and documented limitations.

### Phase 2 — replace the network

1. Determine whether an authorized ERCOT network/planning case is available.
2. In parallel, build a 12–25-bus constraint-preserving model from public mappings, LDFs, repeatedly binding constraints, delayed flows, and named transfer paths.
3. Map generators/storage by official resource-node/electrical-bus relationships.
4. Map load using LDFs and reconcile to actual totals.
5. Represent DC ties as directional/bidirectional `Link` components with hourly limits/flows.
6. Calibrate equivalent branch susceptance/limits using flows, shift factors, and price separation.
7. Version topology and parameters by operating date.
8. Compare a PyPSA-USA Texas network as a separate benchmark; retain its synthetic/planning label.

**Gate:** The reduced network reproduces signs and material magnitudes of observed transfers/constraint activation on untouched dates.

### Phase 3 — chronological market approximation

1. Run hourly or SCED-resolution snapshots as required by the use case.
2. Add unit status, HSL/LSL, ramps, commitment, outages, renewable availability, storage SOC, and DC ties.
3. Use rolling horizon with state transfer.
4. Separate historical replay from endogenous counterfactual dispatch.
5. Add price losses/adders only in distinct, testable layers.
6. Store run manifest, input vintage, topology vintage, solver version, and assumption set.

**Gate:** No unexplained infeasibility or load shedding; state and energy balances reconcile.

### Phase 4 — calibration and holdout validation

Calibrate on earlier months and retain at least one untouched seasonal/rolling holdout.

Report:

- generator/resource/fuel dispatch MAE and bias;
- renewable output/availability/curtailment error;
- line/interface flow MAE, correlation, and direction accuracy;
- constraint activation precision/recall and shadow-price error;
- electrical-bus/resource-node congestion-component error;
- DA/RT price-duration and spike performance;
- load, losses, DC-tie, and energy-balance residuals;
- storage SOC/dispatch validation;
- unserved-energy hours/MWh;
- results by weather zone, load zone, season, scarcity period, and high-renewable period.

Do not calibrate to total SPP while omitting losses/adders and then attribute the residual to network error.

### Phase 5 — scenarios and commercial analytics

- named transmission upgrades and outage sensitivities;
- renewable/storage/thermal queue additions and retirements;
- data-centre/large-load locations, ramps, flexibility, and phased energization;
- PPA capture/basis/curtailment deltas;
- storage DA/RT/AS strategies;
- scarcity and fuel-price sensitivities;
- current reliability/market-design cases;
- capacity and transmission expansion.

### Phase 6 — advanced

- N-1 SCLOPF and contingency ranking;
- selected AC power-flow checks;
- stochastic weather/outage/gas/large-load cases;
- probabilistic queue and transmission timing;
- near-optimal/MGA portfolios.

## Recommended data-model additions

- `ercot_network_bus_vintage`
- `ercot_network_branch_vintage`
- `ercot_network_transformer_vintage`
- `ercot_resource_bus_mapping_vintage`
- `ercot_load_distribution_factor`
- `ercot_constraint_interval`
- `ercot_constraint_shift_factor`
- `ercot_state_estimator_branch_flow`
- `ercot_state_estimator_transformer`
- `ercot_transmission_outage`
- `ercot_dc_tie_interval`
- `ercot_large_load_project`
- `ercot_model_run`
- `ercot_model_run_metric`
- `ercot_data_provenance`
- `ercot_data_coverage`

Keep actuals, estimates, scenarios, and results in separate fields/tables.

## Definition of done for the first credible release

The model may be labelled **Calibrated Reduced ERCOT Network** only when:

- synthetic kNN topology is no longer used for production claims;
- buses/branches/equivalents have traceable sources and vintages;
- generator, storage, load, and DC-tie mappings are documented;
- the required trailing-12-month and delayed-disclosure datasets have coverage reports;
- chronological dispatch includes outages, availability, storage state, and explicit unserved energy;
- material flows, constraints, dispatch, and congestion price components pass holdout thresholds;
- actual SPP/LMP remains the source for historical basis/capture analytics;
- PyPSA price and settlement price are separately labelled;
- solver status, run inputs, versions, and validation metrics are retained.

## Instructions to give Claude

> Implement `ERCOT_PYPSA_VALIDATION.md` in phases on a separate Git branch. Start with Phase 0: the current Tier 2 is a synthetic k-nearest-neighbour network and must not be called real ERCOT topology. Do not expand or tune that graph. Audit the trailing 12 months of ERCOT prices/load and all available delayed SCED, line-flow, transformer, constraint, shadow-price, outage, and DC-tie data. Replace synthetic load weights with ERCOT Load Distribution Factors and map resources through official resource-node/electrical-bus mappings. Build a traceable 12–25-bus constraint-preserving network first, or use an authorized detailed network case if available. Historical basis, capture price, and PPA metrics must use actual ERCOT data; PyPSA is for reconstruction and counterfactual scenarios. Correct the battery backtest to use chronological prices without clipping negative prices. Submit each phase with source links, migrations, tests, coverage reports, holdout validation, unresolved gaps, and an explicit model/data-quality label.

## Source index

### ERCOT

- [ERCOT Market Information](https://www.ercot.com/mktinfo)
- [ERCOT Market Prices](https://www.ercot.com/mktinfo/prices/index.html)
- [ERCOT System-Wide Prices](https://www.ercot.com/gridmktinfo/dashboards/systemwideprices)
- [ERCOT Load](https://www.ercot.com/gridinfo/load/index)
- [ERCOT Generation](https://www.ercot.com/gridinfo/generation/index.html)
- [ERCOT Transmission](https://www.ercot.com/gridinfo/transmission)
- [ERCOT Modeling](https://www.ercot.com/gridinfo/modeling)
- [ERCOT Planning](https://www.ercot.com/gridinfo/planning/)
- [ERCOT Resource Adequacy and GIS Queue](https://www.ercot.com/gridinfo/resource)
- [ERCOT Large Load Integration](https://www.ercot.com/services/rq/large-load-integration)
- [ERCOT Large Load Working Group](https://www.ercot.com/committees/tac/llwg)
- [ERCOT Nodal Protocols](https://www.ercot.com/mktrules/nprotocols/current)
- [NP4-159-CD Load Distribution Factors](https://www.ercot.com/mp/data-products/data-product-details?id=NP4-159-CD)
- [NP6-345-CD Actual System Load by Weather Zone](https://www.ercot.com/mp/data-products/data-product-details?id=NP6-345-CD)

### Modelling

- [PyPSA](https://github.com/pypsa/pypsa)
- [PyPSA examples](https://docs.pypsa.org/latest/examples/examples/)
- [PyPSA-USA](https://github.com/PyPSA/pypsa-usa)
- [PyPSA-USA spatial/network configuration](https://pypsa-usa.readthedocs.io/en/latest/config-spatial.html)

## Related project documents

- `TECHNICAL_NOTES.md`
- `DATA_SOURCES.md`
- `REPLIT_ARCHITECTURE.md`
- `AESO_PYPSA_VALIDATION.md`

