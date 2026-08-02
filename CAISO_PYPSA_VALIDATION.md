# CAISO PyPSA Validation and Implementation Plan

**Status:** Implementation specification  
**Prepared:** 2026-07-28  
**Scope:** CAISO nodal congestion, curtailment, imports/exports, dispatch, storage, resource adequacy, transmission, and investment scenarios  
**Primary implementation target:** `artifacts/pypsa-engine/`

## Executive decision

The application does not currently contain a CAISO PyPSA network. It contains:

- actual CAISO OASIS price ingestion for three trading-hub aggregate pricing nodes;
- an in-progress all-node DA/RT OASIS seeder;
- monthly CAISO price-stat tables and user-facing price pages; and
- an older script that creates synthetic CAISO-style node names and synthetic monthly price patterns.

The immediate priority is to establish a clean, provenance-controlled CAISO price/data foundation and remove synthetic rows from customer-facing analytics. A PyPSA network should be added only after the node universe, pricing-node mappings, constraints, interties, generator locations, regional load, and available network data are audited.

Recommended model hierarchy:

1. **Tier A — Three-hub historical analytics:** NP15, SP15, and ZP26 actual OASIS data. This is price analytics, not a physical PyPSA grid.
2. **Tier B — Calibrated reduced CAISO network:** approximately 20–40 internal buses plus explicit external/intertie boundary connections, built around CAISO transmission access areas, local-capacity areas, major load/generation pockets, branch groups/nomograms, and repeatedly binding constraints.
3. **Tier C — Detailed Western/CAISO network:** a 100–500+ bus reduced network from authorized planning cases, WECC/PyPSA-USA inputs, and CAISO mappings, with topology/parameter vintages and boundary-market treatment.

Three buses are not enough for CAISO congestion or curtailment. CAISO has material local constraints within and between the broad NP15/SP15/ZP26 price areas, extensive imports, hydro, storage, renewable concentration pockets, and interaction with the wider West. Bus count must follow electrical constraints, not a visual map.

Historical customer-facing prices must always come from OASIS. PyPSA is for reconstruction and forward/counterfactual scenarios.

## What “validated” should mean

| Model tier | Permitted claim | Minimum evidence |
|---|---|---|
| Tier A — Actual price analytics | Describes observed hub/node prices | OASIS provenance, interval completeness, corrected market labels |
| Tier B — Calibrated reduced network | Reproduces material CAISO constraints, transfers, curtailment, and spatial price components | Constraint-preserving network, interties, mapped resources/load, chronological holdout |
| Tier C — Detailed planning approximation | Supports defined local-capacity, transmission, storage, and Western-market studies | Authorized topology/parameters, security data, effective-dated cases, engineering review |

Do not describe any PyPSA output as CAISO’s actual IFM, RUC, RTM, WEIM, or EDAM result. CAISO’s market software includes commitment, bids, mitigation, contingencies, nomograms, losses, imports, GHG components, exceptional dispatch, and other constraints that a basic DC-OPF does not reproduce.

## Current implementation audit

Primary files reviewed:

- `CAISO_SCOPE.md`
- `infra/seed-caiso-nodal.py`
- `infra/probe-caiso-oasis.py`
- `scripts/src/seed-caiso-hourly.ts`
- `scripts/src/seed-caiso-real.ts`
- `scripts/src/seed-caiso-nodes.ts`
- `lib/db/src/schema/caiso_hub_da_rt_hourly.ts`
- `lib/db/src/schema/caiso_node_stats.ts`
- `artifacts/grid-platform/src/pages/caiso.tsx`
- `artifacts/grid-platform/src/pages/caiso-hourly.tsx`

### Useful capabilities already present

- Real CAISO OASIS DA hub-price ingestion.
- Hub-level NP15/SP15/ZP26 history and monthly/hourly analytics.
- A Polars-based all-APNode seeder that can request DAM and five-minute RTM prices and aggregate them hourly.
- Seed logs and idempotent node/hour upserts.
- Existing queue, candidate, congestion-scoring, and map application structures that can be extended after provenance review.
- CAISO-specific commercial opportunities already recognized in `CAISO_SCOPE.md`: curtailment, storage/duck curve, resource adequacy, and Western market interaction.

### Critical deficiencies

| Area | Current behaviour | Validation issue | Required correction |
|---|---|---|---|
| PyPSA network | None | No physical/constraint model exists | Build only after Phase 1 data audit |
| Price scope | Main tables/pages focus on three trading-hub APNodes | Hubs conceal nodal congestion and cannot locate project basis | Complete actual PNode/APNode universe and mappings |
| Synthetic nodes | `seed-caiso-nodes.ts` invents node names and price profiles | Synthetic data can be mistaken for OASIS actuals | Retire script; identify, quarantine, and remove synthetic rows |
| RT label | `seed-caiso-hourly.ts` uses `PRC_HASP_LMP` but UI labels it “RT” | HASP is not the five-minute RTM series | Rename existing field/display to HASP or replace with `PRC_INTVL_LMP` RTM |
| Seeder comments | `infra/seed-caiso-nodal.py` header still references HASP while defaults use RTM | Documentation and execution disagree | Make market run/query/version explicit in every row/run |
| DST | RT seeder loops 24 local hours and stores timezone-naive hourly timestamps | Pacific transition days have 23 or 25 hours; repeated fall hour cannot be uniquely stored | Use UTC primary key plus local timestamp/offset/fold and variable-length days |
| Completeness | A day may be logged despite missing RT hours | Partial OASIS throttling/truncation can become “complete” | Track expected intervals/nodes/components and retry partial hours |
| Price components | Seeder keeps only total LMP | Cannot distinguish energy, congestion, losses, and applicable GHG effects | Store total and each published component |
| Node type | `ALL_APNODES` output is not a physical bus list | APNodes can be aggregates; price node does not establish topology or coordinates | Maintain PNode/APNode/resource/trading-hub types and effective-dated mappings |
| Locations | `caiso_node_locations` is missing/incomplete | Blocks project-to-node and generator-to-bus mapping | Build from CAISO mappings plus CEC/EIA/project sources with confidence |
| Curtailment | Negative price or RT–DA spread is used as a curtailment signal | Negative prices/spreads are not measured curtailment | Ingest CAISO renewable curtailment reports and keep price exposure separate |
| Capture ratio | Current page can divide average RT by average DA | A renewable capture rate requires generation-weighted plant/node prices | Use hourly generation/profile weights and define denominator |
| Resource dispatch | No ERCOT-like resource SCED table | Cannot validate plant-level dispatch from price data alone | Use available CAISO/CEC resource/system data and state the granularity limit |
| Queue | Multiple real and synthetic seed paths exist in the project | Provenance/status may be mixed | Rebuild from current CAISO queue reports with source vintage |
| Network geography | HIFLD/CEC line geometry may be available | Geometry alone lacks electrical connectivity/ratings/reactance | Use only as corroboration unless parameters are sourced |

## Immediate data-cleanup decisions

### Retire synthetic price generation

`scripts/src/seed-caiso-nodes.ts` must not be used in production. It explicitly generates synthetic node names and synthetic 2022–2025 monthly values.

Claude must:

1. Determine whether any current `caiso_node_stats` rows originated from that script.
2. Add `source`, `source_query`, `market_run`, `node_type`, `quality_class`, and `seed_run_id`.
3. Quarantine/delete synthetic rows only after a reproducible identification query and backup/export.
4. Regenerate stats exclusively from actual `caiso_nodal_da_rt_hourly`.
5. Update `DATA_SOURCES.md`, which currently lists the synthetic script beside the real OASIS seeder.

### Correct market labels

Use distinct columns/products:

- `DAM` — hourly Integrated Forward Market LMP from `PRC_LMP`.
- `HASP`/RTPD where deliberately requested — fifteen-minute scheduling/dispatch product, labelled exactly.
- `RTM` — five-minute real-time interval LMP from `PRC_INTVL_LMP`.
- Hourly RT analytics — arithmetic or settlement-defined aggregation of RTM intervals, labelled “hourly average of 5-minute RTM,” not native hourly RT.

Do not merge HASP and RTM in the same `rt_price` column without a source field.

## Recommended network resolution

### Tier B: 20–40 internal buses plus external boundaries

Candidate aggregation must preserve:

- Greater Bay Area and other local-capacity/load pockets;
- LA Basin;
- San Diego;
- Sacramento/Northern California load;
- Humboldt/North Coast;
- Central Valley/Fresno;
- Central Coast/Diablo area;
- Kern/Tehachapi renewable corridor;
- Imperial Valley;
- desert solar/storage areas;
- Sierra/hydro regions;
- major internal branch groups/nomograms; and
- principal import/export interfaces.

This list is illustrative, not an official topology. Use CAISO Full Network Model mappings, Transmission Access Charge areas, RUC/AS regions, local-capacity study areas, transmission planning cases, and observed constraints to determine the final buses.

External boundaries should represent major scheduling interfaces/regions rather than one unlimited “imports” generator. Preserve the relevant ties toward the Pacific Northwest/COI, Nevada/Utah, Arizona/Palo Verde, LADWP, IID/WALC, Mexico, and other material BAAs as supported by CAISO Atlas/OASIS mappings.

### Tier C: Western network

For studies where WEIM/EDAM or external congestion is material, a CAISO-only copper plate outside the boundary is inadequate. Evaluate [PyPSA-USA](https://github.com/PyPSA/pypsa-usa) Western Interconnection networks and clustering. Its ReEDS NARIS and TAMU options are planning/synthetic networks; they still require CAISO-specific calibration against OASIS constraints, prices, flows, and planning studies.

## Network and geospatial source hierarchy

1. [CAISO Network and Resource Modeling](https://www.caiso.com/market-operations/network-resource-modeling) for Full Network Model schedules, work scopes, pricing-node mappings, intertie constraints, branch groups, and LDF releases.
2. [CAISO OASIS](https://www.caiso.com/systems-applications/portals-applications/open-access-same-time-information-system-oasis) and Atlas reference reports for PNode/APNode, TAC area, trading hub, AS/RUC region, tie-point, scheduling-point, and transmission-interface mappings.
3. [CAISO Transmission Planning](https://www.caiso.com/generation-transmission/transmission/transmission-planning) for current study plans, base cases where available, reliability/local/economic studies, and approved transmission projects.
4. [CAISO Generator Interconnection](https://www.caiso.com/generation-transmission/generation/generator-interconnection) for queue, POI, deliverability, and Generator Interconnection Resource ID information.
5. [California Energy Commission generation data](https://www.energy.ca.gov/data-reports/energy-almanac/california-electricity-data/electric-generation-capacity-and-energy) and QFER source files for plant identity, capacity, generation, fuel, and location corroboration.
6. CEC/California open GIS or HIFLD line/substation geometry as secondary spatial evidence only.
7. Utility/AHJ filings for exact project and substation details where permitted.

The public CAISO FNM references and work scopes do not necessarily provide the complete electrical case. If the detailed case requires Market Participant Portal, WECC, or protected access, document the right to use it before storing or deploying it.

For every bus/branch/resource mapping, record source, effective date, quality class, confidence, and licence/access restriction.

## OASIS data required for calibration

The [CAISO OASIS Interface Specification](https://www.caiso.com/documents/oasisapispecification.pdf) documents relevant products. Verify the current specification/version before implementation.

### Prices and mappings

- `PRC_LMP` — DAM LMP and energy/congestion/loss components.
- `PRC_INTVL_LMP` — five-minute RTM LMP and components.
- `PRC_HASP_LMP` — HASP when a fifteen-minute study explicitly needs it.
- `ATL_PNODE_MAP` — trading hub to PNode mapping.
- `ATL_TAC_AREA` — TAC area to PNode mapping.
- `ATL_AS_REGION_MAP` and RUC-zone mappings.
- Full Network Model Pricing Node Mapping references.
- price corrections and market-run/version metadata.

### Constraints and transmission

- `PRC_NOMOGRAM` / `PRC_RTM_NOMO` — branch/nomogram shadow prices.
- `PRC_CNSTR` / real-time intertie/flowgate shadow-price products.
- branch group, intertie constraint, scheduling point, and transmission-interface mappings.
- market available transmission capacity/current usage reports.
- transmission outage reports where access is authorized.

Store:

- constraint/nomogram name;
- monitored branch/group;
- contingency identity where published;
- market run;
- interval;
- limit/flow if provided;
- shadow price;
- competitive/non-competitive status where applicable; and
- topology/FNM vintage.

### Demand, supply, imports, and market results

- CAISO demand actual/forecast and net-load series.
- supply by fuel and renewable actual/forecast.
- market awards/schedules where public.
- intertie schedules, transmission usage, ATC/TTC, and outages.
- ancillary-service requirements/awards/prices.
- RUC and exceptional-dispatch data where public.
- greenhouse-gas allowance/shadow-price components when relevant to the selected market footprint.

OASIS scheduled/tagged imports are not automatically actual physical tie-line flow. Preserve the product definition and do not relabel schedules as actual flow.

## Curtailment and generation validation

Use [CAISO Daily Renewable Reports](https://www.caiso.com/documents/daily-renewable-report-mar-06-2026.html) and the [historical wind/solar curtailment library](https://www.caiso.com/library/daily-wind-solar-real-time-dispatch-curtailment-reports). The older report series stopped in 2025 and was replaced by the Daily Renewable Report, so the ingestion must support both formats without silently changing definitions.

Store:

- wind/solar;
- MWh and maximum MW;
- economic versus self-schedule/exceptional-dispatch classification where available;
- system condition versus local congestion reason where available;
- CAISO versus WEIM scope;
- preliminary/revised status;
- source report version.

CAISO’s published curtailment is generally system/technology/reason level, not necessarily plant-level. It is an excellent system validation target but cannot by itself assign curtailment to an individual PPA project.

For generation:

- Use CEC QFER plant/unit capacity and generation for monthly/annual energy checks.
- Use CAISO supply/renewable reports for system/interval validation.
- Use CAISO resource/PNode mappings where public/authorized.
- Use EIA-860/923 and CEC plant coordinates as supporting sources.
- Do not infer plant dispatch by multiplying a hub price by a generic fuel profile.

## Interties and the Western footprint

Imports are a core CAISO supply resource and must not be represented as one unlimited generator.

For each material interface collect:

- scheduling point/tie/interface identifiers and mapping;
- DAM/HASP/RTM schedules or awards;
- import/export direction;
- ATC/TTC/market transfer capability;
- transmission outages and derates;
- external price or boundary offer proxy;
- GHG attribution where applicable;
- BAA and WEIM/EDAM participation/effective dates.

Historical replay options:

- Fix the boundary to observed schedules/flows and validate internal results.
- Or make boundary dispatch endogenous and reserve observed interchange as a validation target.

Do not use observed schedules as both a fixed input and an independent success metric.

## Resource adequacy, storage, and local reliability

CAISO studies must include attributes that do not exist in the same form in ERCOT:

- system, local, and flexible Resource Adequacy;
- local-capacity areas and deficiencies;
- deliverability status;
- flexible-ramp/net-load requirements;
- use-limited resources;
- hydro energy/inflow constraints;
- storage duration/SOC and hybrid-resource rules;
- must-offer obligations and exceptional dispatch;
- import RA and maximum import capability.

Sources include:

- [CAISO Resource Adequacy](https://www.caiso.com/generation-transmission/resource-adequacy)
- [Local Capacity Requirements processes](https://stakeholdercenter.caiso.com/RecurringStakeholderProcesses/Local-capacity-requirements-process-2026)
- [Flexible Capacity Needs Assessment](https://stakeholdercenter.prod.caiso.com/RecurringStakeholderProcesses/Flexible-capacity-needs-assessment-2026)
- [Resource Adequacy evaluation reports](https://www.caiso.com/library/resource-adequacy-evaluation-reports)

Do not describe CAISO RA as a centralized capacity market price. Model it as reliability/procurement constraints and scenario value using the applicable CPUC/local-regulatory framework.

Storage studies must be chronological and should separately value:

- DA energy;
- RT energy/deviations;
- ancillary services;
- RA capacity/local value;
- curtailment charging;
- degradation/cycle limits;
- interconnection charging restrictions;
- hybrid shared POI/export limit;
- terminal SOC/water-value assumptions.

## Queue, transmission projects, and large loads

Rebuild a versioned CAISO queue from the current [ISO queue report](https://www.caiso.com/generation-transmission/generation/generator-interconnection). Include:

- queue/project ID;
- active/completed/withdrawn status;
- technology and MW;
- requested/approved POI;
- study cluster;
- deliverability/TPD allocation;
- suspension status;
- target dates;
- network-upgrade dependencies;
- resource ID once assigned;
- coordinates and mapping confidence;
- publication vintage.

For transmission projects, use the current CAISO Transmission Planning Process and approved project list.

For data centres and large loads, combine public CAISO/utility/CEC/CPUC records and CEC siting proceedings. Distinguish grid demand from backup generation and on-site supply. Do not add announced nameplate load to a forecast without energization probability, location/POI, load factor, ramp/flexibility, and date.

## Required trailing-12-month data audit

Use the previous completed Pacific operating day. Store UTC interval as the primary time key plus local time, offset, DST fold, interval-ending convention, market run, and publication timestamp.

| Dataset | Minimum audit |
|---|---|
| DAM LMP/components | Expected 23/24/25 hours, node type/universe, corrected values |
| Five-minute RTM LMP/components | Expected 276/288/300 intervals per node/day, missing OASIS hours |
| HASP/RTPD | Separate product and table/columns |
| PNode/APNode/TAC/hub/RUC/AS mappings | Effective dates and membership reconciliation |
| Constraints/nomograms/shadow prices | Names, intervals, market run, contingencies, FNM vintage |
| Demand/net load/supply | Interval completeness and public-dashboard totals |
| Renewable curtailment | Format change, scope, MWh/MW/reason, preliminary/revised |
| Interties | Interface mapping, schedule/usage/capability/outages, direction |
| Generation/resources | CAISO/CEC/EIA identifiers, capacity, location, PNode/POI |
| Queue/transmission projects | Current vintage, status, POI, dates |

Expected interval counts must be calculated from the actual Pacific day. Do not hardcode 24 hours.

## Additional data required for authenticity

### Priority 0

- actual DAM and five-minute RTM LMP components across the intended PNode/APNode universe;
- effective-dated PNode/APNode/TAC/hub and resource mappings;
- system/TAC/local load allocation;
- constraint/nomogram/intertie shadow prices;
- import/export schedules/usage and transfer capability;
- renewable generation and published curtailment;
- resource registry, capacity, technology, location, and POI;
- a defensible reduced topology with source/quality metadata.

### Priority 1

- branch/transformer connectivity, reactance, ratings, phase shifters, and topology vintage;
- transmission and generation outages;
- generator offers/costs, ramps, minimum output, commitment, and use limits where available;
- hydro inflows/reservoir/energy budgets;
- storage SOC, efficiency, AS, degradation, duration, hybrid POI constraints;
- local/flexible/system RA requirements and deliverability;
- SoCal Citygate, PG&E Citygate, Malin or appropriate regional fuel prices;
- carbon allowance/GHG treatment;
- weather and renewable availability by region;
- losses and market-power mitigation/exceptional-dispatch treatment.

### Priority 2

- queue probability and deliverability scenarios;
- approved transmission projects and alternative timing;
- CPUC/CEC portfolio, demand, electrification, and load-growth cases;
- data-centre/large-load locations and flexible-load profiles;
- WEIM/EDAM footprint and market-design cases;
- stochastic hydro/weather/outage/import/gas/carbon assumptions;
- current capital cost, financing, and interconnection-upgrade estimates.

## PyPSA use cases for CAISO

| Use case | Applicability | Implementation note |
|---|---|---|
| Economic dispatch | High | Approximate IFM/RTM only with explicit limitations |
| DC-LOPF | High | Core congestion/counterfactual model once constraints and boundaries are calibrated |
| Unit commitment/rolling horizon | High | Required for gas fleet, ramps, hydro, storage, and multi-day conditions |
| Storage | Very high | Chronology, RA, AS, hybrid POI, negative prices, and degradation matter |
| Hydro | Very high | Use reservoir/energy budgets and water values; not an always-available zero-cost generator |
| Interties/Western market | Very high | Explicit boundary buses and interface limits/prices |
| Resource adequacy | High | Model system/local/flexible requirements as constraints/scenarios |
| Curtailment | High | Validate system results against CAISO reports; avoid unsupported plant allocation |
| Transmission investment | High | Compare named TPP upgrades and local-capacity relief |
| Generation/storage investment | High | Include deliverability, queue, RA, curtailment, and transmission |
| Security-constrained LOPF | High/later | Use CAISO/WECC credible contingencies and emergency ratings |
| AC power flow | Medium/later | Selected voltage/reactive studies with adequate data |
| Representative periods | Planning only | Preserve spring oversupply, heat events, hydro years, ramps, and local congestion |
| Stochastic/MGA | High/later | Hydro, wildfire/outage, imports, load, gas/carbon, and build uncertainty |

[PyPSA](https://github.com/pypsa/pypsa) supports these functions. [PyPSA-USA](https://github.com/PyPSA/pypsa-usa) is a strong workflow/network benchmark for the Western Interconnection but is not a ready-made reproduction of CAISO markets.

## Implementation plan for Claude

### Phase 0 — data truth and labelling

1. Retire `seed-caiso-nodes.ts` from production commands.
2. Identify and quarantine synthetic node/stat rows.
3. Add immutable provenance, market run, query name/version, node type, component, and quality class.
4. Relabel existing `PRC_HASP_LMP` data as HASP; do not call it five-minute RTM.
5. Fix the OASIS seeder’s comments/configuration so executed query and metadata agree.
6. Redesign time keys around UTC and handle 23/25-hour days and repeated local hours.
7. Require per-node/per-component expected-interval completeness before a day is marked seeded.
8. Add price-component ingestion and reconciliation (`LMP = energy + congestion + loss [+ applicable components]`).
9. Add tests for DST, OASIS XML error ZIPs, truncation, duplicate intervals, partial hours, and corrections.

**Gate:** No synthetic value or HASP price is presented as actual nodal RTM.

### Phase 1 — trailing-12-month CAISO foundation

1. Complete DAM and five-minute RTM price ingestion for a carefully defined node universe.
2. Ingest Atlas/FNM/TAC/hub/RUC/AS mappings and version them.
3. Ingest constraint, nomogram, branch/intertie shadow prices and market-run metadata.
4. Ingest demand, net load, supply, renewable, curtailment, intertie, capability, and outage data.
5. Rebuild `caiso_node_stats` only from actual interval data.
6. Audit queue/transmission/resource/location data and create a source register.
7. Validate sampled values against OASIS and CAISO reports.

**Gate:** Coverage reports pass and every customer-facing CAISO number has a source/run identifier.

### Phase 2 — reduced network assembly

1. Determine accessible CAISO/WECC planning/FNM case data and usage rights.
2. Build a 20–40-bus internal network using local/TAC areas, material constraints, branch groups, load/generation pockets, and planning studies.
3. Add explicit external boundary buses/interfaces.
4. Map generators/storage through resource ID/PNode/POI evidence; use nearest geometry only as a flagged fallback.
5. Allocate load using CAISO/utility planning evidence and reconcile to actual demand.
6. Calibrate equivalent branch limits/susceptance against observed constraint activation, flows/usage, and congestion components.
7. Version topology and mappings.
8. Compare a separately labelled PyPSA-USA Western case.

**Gate:** The model reproduces major transfer directions and constraint-driven price separation on untouched dates.

### Phase 3 — chronological operational model

1. Add hourly or five/fifteen-minute snapshots appropriate to the study.
2. Add unit commitment/ramps/outages, renewable availability, hydro energy, storage SOC, and interties.
3. Use rolling horizon and preserve boundary states.
4. Separate historical replay from endogenous boundary/dispatch experiments.
5. Layer losses, GHG components, RA/flex constraints, and other market features only with individual tests.
6. Store complete run manifests and input/model vintages.

**Gate:** Energy/state balances reconcile and no hidden emergency supply is used.

### Phase 4 — calibration and holdout validation

Use seasonal/rolling holdouts and report:

- system and regional generation error;
- renewable generation/curtailment error by reason and technology;
- import/export schedule or flow error where endogenous;
- interface/constraint activation precision/recall;
- constraint shadow-price error;
- PNode congestion-component and spatial-spread error;
- total LMP error only after components are aligned;
- load/net-load/ramp error;
- hydro energy and storage SOC/dispatch error;
- unserved energy;
- results by local area, TAC area, season, hydro condition, heat event, and oversupply period.

Do not validate a lossless DC model directly against total LMP without separating energy, congestion, and loss components.

### Phase 5 — commercial/planning scenarios

- storage energy/AS/RA/hybrid valuation;
- plant/PPA capture price and curtailment distributions;
- local-capacity and deliverability value;
- named transmission upgrades;
- generation/storage queue and retirement scenarios;
- import/hydro/gas/carbon sensitivities;
- data-centre/electrification/large-load scenarios;
- WEIM/EDAM boundary/footprint scenarios;
- capacity/transmission expansion.

### Phase 6 — advanced

- N-1 SCLOPF;
- selected AC power-flow and voltage studies;
- stochastic hydro/weather/wildfire/outage/import cases;
- probabilistic queue/transmission timing;
- MGA/near-optimal portfolios.

## Recommended data-model additions

- `caiso_price_interval`
- `caiso_price_component`
- `caiso_node_mapping_vintage`
- `caiso_resource_node_mapping_vintage`
- `caiso_network_bus_vintage`
- `caiso_network_branch_vintage`
- `caiso_constraint_interval`
- `caiso_intertie_interval`
- `caiso_transmission_outage`
- `caiso_regional_load_interval`
- `caiso_resource_availability_interval`
- `caiso_renewable_curtailment_interval`
- `caiso_ra_requirement`
- `caiso_model_project`
- `caiso_model_run`
- `caiso_model_run_metric`
- `caiso_data_provenance`
- `caiso_data_coverage`

Use `TIMESTAMPTZ`/UTC interval keys. Keep HASP and RTM separate.

## Definition of done for the first credible release

The model may be labelled **Calibrated Reduced CAISO Network** only when:

- synthetic CAISO node prices are removed/quarantined;
- DAM, HASP, and five-minute RTM are correctly separated;
- DST-safe interval coverage and component reconciliation pass;
- a source-linked 20–40-bus reduced network and explicit boundaries exist;
- generators, storage, load, queue, and interties map to model buses with confidence;
- chronology includes hydro, storage, outages, and imports;
- constraint, curtailment, transfer, generation, and congestion-component holdout tests pass;
- actual OASIS data remains the source of historical nodal/hub prices;
- every run retains solver/model/data versions and limitations.

## Instructions to give Claude

> Implement `CAISO_PYPSA_VALIDATION.md` in phases on a separate Git branch. Begin with Phase 0 and do not build a network until CAISO data provenance is clean. Retire `seed-caiso-nodes.ts`, identify/quarantine every synthetic row, and regenerate statistics only from actual OASIS interval data. Separate DAM, HASP, and five-minute RTM; the current HASP hub series must not be labelled RTM. Fix UTC/DST storage so 23/25-hour Pacific days and repeated hours are preserved, and store LMP energy/congestion/loss components. Audit the trailing 12 months of prices, mappings, constraints/nomograms, shadow prices, curtailment, demand, generation, interties, capability, outages, queue, resources, and locations. Then build a source-linked 20–40-bus CAISO reduced network with explicit Western boundary interfaces, calibrated against observed constraints and congestion components. Use actual OASIS prices for historical PPA/basis/capture analytics; PyPSA is for reconstruction and scenarios. Submit each phase with migrations, tests, source links, coverage reports, holdout validation, data-rights notes, and unresolved gaps.

## Source index

### CAISO

- [CAISO OASIS](https://www.caiso.com/systems-applications/portals-applications/open-access-same-time-information-system-oasis)
- [OASIS Interface Specification](https://www.caiso.com/documents/oasisapispecification.pdf)
- [CAISO Network and Resource Modeling](https://www.caiso.com/market-operations/network-resource-modeling)
- [CAISO Transmission Planning](https://www.caiso.com/generation-transmission/transmission/transmission-planning)
- [CAISO Transmission Operations/Outages](https://www.caiso.com/generation-transmission/transmission/transmission-operations)
- [CAISO Generator Interconnection and Queue](https://www.caiso.com/generation-transmission/generation/generator-interconnection)
- [CAISO Interchange Scheduling](https://www.caiso.com/market-operations/interchange-scheduling)
- [CAISO Resource Adequacy](https://www.caiso.com/generation-transmission/resource-adequacy)
- [CAISO Daily Renewable Report example](https://www.caiso.com/documents/daily-renewable-report-mar-06-2026.html)
- [CAISO historical wind/solar curtailment reports](https://www.caiso.com/library/daily-wind-solar-real-time-dispatch-curtailment-reports)
- [CAISO Market Performance renewable-resource reporting](https://www.caiso.com/content/monthly-market-performance/apr-2026/renewable-resource.html)
- [CEC Electric Generation Capacity and Energy](https://www.energy.ca.gov/data-reports/energy-almanac/california-electricity-data/electric-generation-capacity-and-energy)
- [CEC QFER Power Plant Generation](https://www.energy.ca.gov/data-reports/energy-almanac/california-electricity-data/quarterly-fuel-and-energy-report-qfer-1)
- [CEC QFER source files](https://www.energy.ca.gov/files/webqfer-source-files)

### Modelling

- [PyPSA](https://github.com/pypsa/pypsa)
- [PyPSA examples](https://docs.pypsa.org/latest/examples/examples/)
- [PyPSA-USA](https://github.com/PyPSA/pypsa-usa)
- [PyPSA-USA spatial/network configuration](https://pypsa-usa.readthedocs.io/en/latest/config-spatial.html)

## Related project documents

- `CAISO_SCOPE.md`
- `TECHNICAL_NOTES.md`
- `DATA_SOURCES.md`
- `ERCOT_PYPSA_VALIDATION.md`
- `AESO_PYPSA_VALIDATION.md`

