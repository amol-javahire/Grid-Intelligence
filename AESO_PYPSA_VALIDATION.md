# AESO PyPSA Validation and Implementation Plan

**Status:** Implementation specification  
**Prepared:** 2026-07-28  
**Scope:** Alberta congestion, curtailment, dispatch, storage, interties, generation/load growth, and transmission-investment scenarios  
**Primary implementation target:** `artifacts/pypsa-engine/`

## Executive decision

The current AESO PyPSA feature is an **illustrative three-bus, single-hour DC optimal power flow (DC-OPF)**. It is useful for demonstrating how a transmission constraint can create different modelled marginal prices and renewable curtailment, but it is **not yet a validated representation of Alberta's transmission system, historical dispatch, historical congestion, or future market prices**.

The next version should use a staged model hierarchy:

1. Retain the current three-bus model as an explicitly labelled **educational/demo model**.
2. Build an **8–12 internal-bus Alberta model**, plus separate BC, Saskatchewan, and Montana boundary buses, for the first defensible historical and scenario model.
3. Expand to a **15–30-bus reduced electrical network** only when the available topology, line/transformer parameters, generator interconnection points, and regional load allocation support the added detail.
4. Consider a detailed substation-level model only if AESO/AUC data rights and engineering inputs permit it.

PyPSA can handle far more than 8–12 buses. Computation is not the limiting factor at this scale; the limiting factors are electrical topology, line ratings/reactances, regional load allocation, asset-to-bus mapping, outage history, and validation data. Adding arbitrary buses would create false precision. Every new bus must represent an electrically meaningful area or cutset.

The highest-priority correction is the treatment of interties. BC and Saskatchewan are currently always-available generators at one Alberta bus with fixed marginal costs and no export capability. They should instead be separately modelled boundary connections with observed hourly imports/exports for historical replay and time-varying transfer limits and external prices for forward scenarios. Montana/MATL must also be included.

## What “validated” should mean

Use the following labels in the application and API:

| Model tier | Permitted claim | Minimum evidence |
|---|---|---|
| Tier A — Illustrative | Demonstrates DC-OPF mechanics and sensitivities | Deterministic tests and truthful assumptions |
| Tier B — Calibrated reduced network | Reproduces material Alberta dispatch and transfer patterns at a zonal/corridor level | Authoritative topology, mapped assets/load, 12-month chronological backtest, holdout results |
| Tier C — Detailed planning model | Supports engineering-grade network/security studies within a documented scope | Detailed electrical parameters, outage/security inputs, engineering review, reproducible validation |

Do not call Tier A “validated,” “historical congestion,” “AESO nodal pricing,” or “a forecast.” Alberta currently has a system-wide pool price, so modelled nodal marginal prices are scenario outputs—not observed AESO nodal prices.

## Current implementation audit

The audit is based on `artifacts/pypsa-engine/aeso_network.py` and the current AESO data ingestion files.

### What is implemented correctly for a demonstration

- A PyPSA network is created and solved with HiGHS.
- The network can illustrate constrained transfer, generator dispatch, locational marginal-cost differences, and renewable curtailment.
- Wind, solar, gas, cogeneration, hydro, biomass, and high-cost balancing supply are represented at an aggregate level.
- The API returns scenario inputs, line flows, generator dispatch, modelled marginal prices, and curtailment.
- The model is small enough to respond interactively.

### Material deficiencies

| Area | Current behaviour | Why it is not authentic | Required correction |
|---|---|---|---|
| Time | One snapshot | Cannot represent ramps, outages, storage state of charge, hydro energy, chronological curtailment, or annual economics | Run hourly chronological snapshots; use rolling horizon when unit commitment is enabled |
| Network | Three buses and two radial lines | Calgary and Edmonton are combined; major Alberta regions and parallel corridors are absent; limits/reactances are not traceable to a source | Build an evidence-based 8–12-bus reduced network and publish a source/assumption register |
| Interties | BC and SK are generators at CENTRAL; imports only; fixed prices; no Montana | Cannot reproduce hourly direction changes, outages, scheduled/actual differences, or external price coupling | Use external buses and bidirectional `Link` components with hourly bounds; include BC, SK, and MATL |
| Demand | AIL is proportionally allocated using static regional shares | AIL is provincial demand and does not establish where power is consumed | Obtain/estimate POD, substation, or regional hourly load and document allocation uncertainty |
| Generation | Aggregate generators and static availability | Loses generator location, outages, ramping, minimum output, heat rates, and unit-specific capability | Build asset-level inputs from hourly TNG/MC/outages and the AESO asset registry, then aggregate only after bus mapping |
| Dispatch cost | Simplified marginal costs | Does not reproduce the AESO merit order, offer behaviour, carbon costs, start-up costs, reserve opportunity costs, or cogeneration constraints | Add hourly offer/merit-order inputs where permitted; otherwise use calibrated engineering costs and disclose the limitation |
| Balancing | A 25,000 MW hidden slack generator can serve load | Can conceal inadequate supply, bad intertie treatment, or network infeasibility; its dispatch and cost are omitted from reported totals | Replace with explicit load-shedding generators by bus, report every MWh and cost, and fail validation when used unexpectedly |
| Solver result | Output is labelled `optimal` when marginal prices exist | Marginal-price presence is not a solver-status check | Capture and require optimizer status and termination condition; expose infeasible/unbounded/error states |
| Congestion | A line is “congested” at 98% loading | Loading is useful, but a binding economic constraint should be identified from the applicable constraint dual/shadow price | Report both utilization and binding-constraint duals |
| Average price | Arithmetic average of bus prices | Gives an equal weight to buses with different loads | Report system marginal price and load-weighted model price; keep zonal prices separately |
| Total cost | Excludes slack and interties from some summaries | Produces incomplete balances and economics | Reconcile all generation, storage, imports, exports, shedding, losses, and objective value |
| Curtailment | Available renewable energy minus dispatched energy in one hour | Does not distinguish economic curtailment, transmission constraint, outage, negative offers, or availability error | Calculate hourly potential, dispatch, and reason codes; aggregate by plant, region, month, and scenario |
| Dependencies | Broad minimum versions such as `pypsa>=0.28.0` | Results and APIs can change across versions | Pin PyPSA, Linopy, HiGHS, NumPy, and required dependencies; record versions in every run |

## Recommended Alberta network resolution

### First production candidate: 8–12 internal buses

Start with electrically meaningful areas such as the following. These are **candidate aggregation areas, not an official AESO bus model**, and must be revised using the AESO single-line diagrams, planning areas, substations, and transfer paths:

1. Southwest / Pincher Creek–Lethbridge wind area
2. Southeast / Medicine Hat–Brooks
3. Calgary / Foothills
4. Central / Red Deer
5. Edmonton
6. Central East / Industrial Heartland–Lloydminster
7. Northwest / Grande Prairie–Peace River
8. Northeast / Fort McMurray

Add separate external boundary buses for:

9. British Columbia
10. Saskatchewan
11. Montana

One or more additional internal buses should be added only where a known interface, load pocket, generation pocket, or data-centre cluster would otherwise be hidden. Calgary and Edmonton should not remain one bus.

### How to form the reduced network

- Start with substations, transmission line endpoints, voltage, circuit IDs, and AESO planning areas.
- Identify material cutsets/corridors from AESO planning and congestion material.
- Assign each generator to its actual connected substation where known; otherwise use a documented nearest-substation candidate and a confidence flag.
- Assign load using POD/substation/regional evidence rather than population alone.
- Cluster substations within electrically coherent areas while preserving cutsets, interties, major generation pockets, Calgary/Edmonton load pockets, and data-centre connection locations.
- Aggregate parallel circuits using an electrically consistent equivalent.
- Preserve voltage levels or transformers where they constrain transfer.
- Store the mapping from every source asset, line, substation, and load series to its reduced bus.
- Version the topology so historical replays use the network in service during each hour.

Coordinates and line geometry are not enough for power flow. The model also needs connectivity, circuit status, thermal limits, reactance or equivalent susceptance, transformers, and ideally normal/emergency ratings. If public data omits electrical parameters, use calibrated corridor transfer limits rather than inventing line-level precision, mark those values `estimated`, and expose sensitivity ranges.

## Intertie correction

### Required historical data

For the trailing 12 months—from 12 months before the run date through the previous completed Alberta day—obtain hourly:

- BC scheduled and actual interchange
- Saskatchewan scheduled and actual interchange
- Montana/MATL scheduled and actual interchange
- Direction/sign convention
- ATC and, where available, TTC/TRM for each path and direction
- Intertie outages and derates
- External/boundary price or a documented proxy

Use `America/Edmonton`, preserve AESO hour-ending fields, and explicitly handle the 23/25-hour daylight-saving days. Store the raw source sign and a normalized sign, with **positive MW defined as imports into Alberta**.

### Existing data that must be audited

The current project contains:

- `scripts/src/seed-aeso-real.ts`, which calls `itc/v1/interchange` and writes `aeso_interchange`;
- `infra/probe-aeso-hourly-sources.py`, which probes possible interchange endpoints;
- `infra/collect-aeso-csd-snapshot.py`, which captures current CSD interchange snapshots; and
- `aeso_interchange`, with scheduled, actual, and net MW fields.

Do not assume this means the 12-month history is present or authoritative. The public [AESO API catalogue](https://www.aeso.ca/market/market-and-system-reporting/aeso-application-programming-interface-api/) lists interchange capability and outage products, but does not clearly identify the `itc/v1/interchange` history used by the seeder. The seeder also skips a whole month if any row for that month exists, which can preserve partial months.

Claude must:

1. Query `aeso_interchange` for coverage by date, hour ending, intertie, transfer type, data type, and non-null actual/scheduled MW.
2. Compare expected and observed hour counts, including daylight-saving days.
3. Confirm that `itc/v1/interchange`, its fields, version, sign convention, and allowed historical range are documented by AESO.
4. Compare sampled hours with the [AESO Current Supply Demand report](https://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=html) or another official AESO report.
5. Change monthly completeness logic to date/hour/intertie upserts with an explicit coverage ledger.

### If actual historical interchange is missing

Use this order of operations:

1. Request the trailing-12-month hourly actual and scheduled series from AESO or the relevant AESO API support/contact channel.
2. Check whether official metered-volume assets can reconstruct an intertie only after AESO confirms the asset mapping, accounting treatment, sign, and units.
3. Backfill hourly [AESO ATC public-report](https://itc-integ.aeso.ca/itc/public/atc) data as time-varying transfer bounds. ATC is **capability, not actual flow**, and cannot substitute for historical interchange.
4. Continue hourly CSD snapshots prospectively with source timestamp, retrieval timestamp, raw payload hash, and validation status.
5. If an official backfill cannot be obtained, mark historical actual flow as missing. Do not interpolate or fabricate it.

The [AESO historical BC and MATL flow download](https://www.aeso.ca/market/market-and-system-reporting/data-requests/bc-and-matl-intertie-flows/) covers an older period and is useful for methodology checks, but it does not supply the requested latest-12-month actual interchange.

### PyPSA representation

Use separate boundary buses with controllable bidirectional `Link` components:

- For a historical replay, fix hourly link flow to observed actual interchange and use ATC/TTC to QA the observations.
- For a market or forward scenario, allow endogenous import/export within hourly directional limits and apply an external price/bid series at the boundary.
- Do not use the same actual-flow series both as a fixed model input and as an independent validation target.
- Model intertie outages and derates in the hourly link limits.
- Reconcile `Alberta generation + net imports - storage charging - losses - load shed = AIL` every hour within a documented tolerance.

## Generator-level data and geospatial mapping

The project has an hourly AESO Metered Volume ingestion path in `infra/seed-aeso-generation.py`. Before using it, produce a coverage and quality report for the trailing 12 months:

- expected versus observed hours by asset;
- duplicate and missing `(date, hour_ending, asset_id)` keys;
- generator/load/retailer asset-class separation;
- negative or impossible values;
- changes to asset IDs or names;
- fuel type, owner/participant, maximum capability, and status coverage;
- agreement between summed generation and system TNG;
- agreement between generation, AIL, and net actual interchange after accounting for losses and other asset classes.

Do not force observed hourly generation as the dispatch decision in the main OPF and then claim the model reproduced dispatch. Use observed generation as a calibration/validation target. It may be fixed only in a dedicated historical power-flow reconstruction or for documented must-run/cogeneration conditions.

For each generator, collect:

- AESO asset ID and official name
- technology, fuel/sub-fuel, participant/owner
- registered maximum capability and hourly available capability
- hourly TNG/metered volume
- outages/derates and commissioning/retirement dates
- ramp limits, minimum stable output, start-up/shut-down costs where supportable
- heat rate or efficiency and emissions intensity
- latitude/longitude with source and confidence
- connected substation/bus and voltage, with source and confidence
- queue/project linkage where applicable

The [AESO Historical Generation Data page](https://www.aeso.ca/market/market-and-system-reporting/data-requests/historical-generation-data/) provides individual-unit CSD history and explains its limitations. Keep CSD generation and Metered Volume provenance separate rather than silently splicing them.

## Transmission topology and locations

Use the following hierarchy:

1. [AESO 2025 Long-term Transmission Plan and single-line diagrams](https://www.aeso.ca/grid/grid-planning/long-term-transmission-plan/) for electrical structure, planning areas, major corridors, and expected upgrades.
2. [AESO AIES map](https://www.aeso.ca/assets/AIES_Map.pdf) for current high-level line, substation, voltage, facility-ID, generator, and planning-area context.
3. [AESO Transmission Capability Map](https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/) for connection capability context and current line/substation GIS where reuse is permitted.
4. [Alberta Powerlines open data](https://open.canada.ca/data/en/dataset/03dbd872-5b9d-4513-86e5-39a14cc2dfee) as geometry corroboration under the applicable open-data licence.
5. AUC applications and decisions for exact project land descriptions, facilities, line alterations, and connection details not otherwise available.

Before downloading, storing, scraping, or redistributing an interactive map, check its licence and terms. The [AESO Congestion Portal](https://congestion.aeso.ca/) is valuable for manual comparison of N-0 thermal-congestion frequency and congested energy, but its published restrictions should be reviewed before any automated extraction or republication.

Create a provenance table for every network value:

| Field | Example |
|---|---|
| `source_url` | Direct official page/API/document |
| `source_document` | Document title and revision |
| `source_date` | Publication/effective date |
| `retrieved_at` | UTC retrieval timestamp |
| `licence_or_terms` | Licence and redistribution restriction |
| `quality_class` | `reported`, `derived`, `estimated`, or `scenario` |
| `confidence` | High/medium/low |
| `derivation` | Formula or mapping method |
| `valid_from`, `valid_to` | Network vintage |

## Interconnection queue, generators, large loads, and data centres

Build one versioned project table containing generation, storage, transmission-connected load, and separately classified off-grid/behind-the-fence projects.

Recommended fields:

- project ID, name, developer/participant
- project class: generation, storage, load, data centre, transmission, hybrid
- technology/fuel
- requested MW and import/export direction
- status/stage and status date
- application/contract/approval identifiers
- target in-service and phased energization dates
- latitude/longitude and location-confidence field
- requested/approved connection substation, line, planning area, and reduced-model bus
- network upgrades and dependencies
- source URL/document, publication vintage, and licence
- grid-connected, behind-the-fence, off-grid, or unknown

Primary sources:

- [AESO Transmission Projects and Connection Project Reporting](https://www.aeso.ca/grid/transmission-projects/) for current monthly project lists, maps, project status, and available GIS downloads.
- [AESO Large Load Projects](https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects/) for the current staged large-load allocation and named contracted projects.
- [AESO connection requirements for transmission-connected data centres](https://aesoengage.aeso.ca/connection-requirements-for-transmission-connected-data-centres) for ramping, intermittency, voltage/frequency sensitivity, and model assumptions.
- [AUC featured applications](https://www.auc.ab.ca/featured-applications/) and eFiling records for project-specific locations, on-site generation, backup generation, and whether a project is grid-connected or off-grid.

Do not add every announced data centre to AIL. An off-grid or behind-the-fence project must be a separate scenario unless its grid connection and expected net grid demand are established.

For data-centre scenarios, model more than a flat MW block:

- phased energization;
- minimum/base and maximum load;
- hourly ramp limits and step changes;
- interruptible/curtailable load;
- uptime and load-factor scenarios;
- on-site generation and storage;
- backup-generation restrictions;
- reactive-power/power-quality requirements where an AC study is eventually performed;
- delays, cancellation probability, and mutually exclusive project cases.

## Additional data required for authenticity

### Priority 0 — required before claiming historical calibration

| Dataset | Resolution | Use |
|---|---|---|
| AIL, TNG, pool price, and SMP | Hourly or source-native | Balance, dispatch, and price validation |
| Per-generator TNG/metered volume | Hourly | Dispatch and renewable capture/curtailment validation |
| Per-generator MC/available capability and outages/derates | Hourly where available | Time-varying availability |
| BC, SK, and MATL scheduled/actual flow | Hourly | Historical boundary conditions |
| Directional ATC/TTC/TRM and intertie outages | Hourly | Boundary limits and QA |
| Asset registry and fuel/technology | Effective-dated | Unit characteristics and joins |
| Generator coordinates and connection substations | Asset level | Correct bus mapping |
| Transmission connectivity, voltage, circuit IDs, and in-service dates | Facility level | Network construction |
| Regional/substation/POD load allocation | Hourly or scalable profiles | Spatial demand |

### Priority 1 — required for credible dispatch and curtailment analysis

- normal and emergency line/transformer ratings;
- reactance/resistance or defensible reduced-corridor equivalents;
- transmission outages and derates;
- energy merit order/offers where licensed and appropriate;
- unit-commitment directives and operational constraints;
- generator heat rates, minimum output, ramps, start-up/shut-down costs, and must-run/cogeneration constraints;
- wind/solar available-energy or weather-derived availability;
- constrained-down generation/dispatch-down records or a documented curtailment proxy;
- hydro inflow, reservoir/energy budgets, and operating constraints;
- storage power/energy capacity, efficiency, state of charge, and operating mode;
- operating-reserve requirements, awards, and prices;
- hourly AECO gas, carbon price, and unit emissions intensity.

### Priority 2 — required for forward planning

- effective-dated generation/load/storage queue;
- data-centre and other large-load probabilities and profiles;
- transmission projects, outage schedules, and alternative upgrade cases;
- external BC/SK/Montana price scenarios;
- weather years and load-growth scenarios;
- policy/market-design scenarios;
- capital cost, fixed/variable O&M, financing, and construction lead time;
- N-1 contingency definitions and emergency ratings;
- uncertainty distributions and correlations.

## PyPSA and PyPSA-Canada applicability

[PyPSA](https://github.com/pypsa/pypsa) supports the required building blocks, including linear optimal power flow, unit commitment, storage, rolling horizon, security-constrained linear OPF, capacity expansion, transmission expansion, stochastic optimization, and near-optimal alternatives. The relevant [PyPSA examples](https://docs.pypsa.org/latest/examples/examples/) should be adapted with Alberta data and validation; examples are not themselves evidence that an Alberta implementation is correct.

[NRCan PyPSA-Canada](https://github.com/NRCan/pypsa-canada) is useful as a Canadian, scenario-driven, reproducible workflow reference. Its current public README describes multi-temporal modelling, representative days, flexible spatial scales, generation/storage/load/transmission components, custom constraints, cost scenarios, and a Snakemake pipeline. Its public example directory currently contains a minimal model, so it should not be treated as a ready-made, validated AESO market model.

| Use case | Alberta applicability | Recommendation |
|---|---|---|
| Market/economic dispatch | High | Implement chronologically, but distinguish AESO pool price/dispatch rules from hypothetical nodal LMPs |
| DC power flow / LOPF | High | Core of the reduced-network congestion model |
| AC power flow | Medium, later | Use for selected stressed snapshots after voltage/reactive parameters are available; not the first MVP |
| Unit commitment | High for thermal realism | Add start-up, minimum output, ramps, and rolling horizon; validate runtime and solver formulation |
| Storage dispatch | High | Requires chronological snapshots and state-of-charge boundary treatment |
| Generation investment | High for scenarios | Use for resource-mix and queue scenarios, not as a prediction of what will be built |
| Transmission expansion | High for alternatives | Compare named upgrade cases first; continuous optimization only with defensible cost/candidate data |
| Representative days | High for long-term planning | Do not use for a historical 8,760-hour congestion validation because rare stress hours matter |
| Security-constrained LOPF | High, advanced | Add credible N-1 contingencies after base topology and emergency ratings are validated |
| Stochastic optimization | Medium/high, later | Use for wind, load, outage, hydro, external-price, and data-centre uncertainty after the deterministic model passes |
| Near-optimal/MGA analysis | Useful, later | Show robust alternatives when several plans have similar costs |

## Implementation plan for Claude

### Phase 0 — make the current feature truthful and testable

**Target:** 1–3 engineering days

1. Rename the current mode in UI/API to `Alberta 3-Bus Illustrative`.
2. Remove any statement that the output is historical nodal pricing, an AESO forecast, or a validated REM result.
3. Replace the hidden slack generator with explicit per-bus load shedding at a documented value of lost load.
4. Return solver status, termination condition, objective value, load shed, energy balance residual, and dependency versions.
5. Calculate load-weighted average model price.
6. Report line loading and the applicable constraint dual separately.
7. Include imports/exports and emergency supply in energy and cost reconciliation.
8. Add deterministic tests for uncongested, binding-line, renewable-curtailment, bidirectional-intertie, islanding/infeasible, and load-shedding cases.
9. Pin PyPSA/Linopy/HiGHS versions and export a reproducible environment lock.

**Gate:** The three-bus model is internally consistent, never silently uses balancing supply, and is labelled illustrative everywhere.

### Phase 1 — trailing-12-month data foundation

**Target:** 1–2 weeks, depending on data access

1. Define the dynamic window as the previous 12 completed Alberta calendar months/days through yesterday.
2. Run coverage audits for pool price, SMP, AIL, TNG, per-asset generation, MC/capability, outages, interties, ATC/TTC, and asset registry.
3. Complete the intertie investigation described above; obtain missing official actual-flow history.
4. Create a common hourly key with source date, hour ending, UTC instant, local offset, and DST flag.
5. Preserve raw payloads or hashes and populate provenance metadata.
6. Produce a machine-readable coverage report and a human-readable data-quality report.
7. Make all ingestion idempotent at the row level; never skip a month merely because one row exists.
8. Schedule no expensive continuous collection. Once the data foundation is stable, ingest the previous completed day once daily; keep CSD snapshots only if they fill a source gap and the cost is acceptable.

**Gate:** Required Priority-0 series meet documented completeness thresholds, with no unexplained gaps or sign/balance failures.

### Phase 2 — geospatial and reduced-network assembly

**Target:** 1–2 weeks for an initial reduced network

1. Acquire permitted AESO/AUC/open-data line, substation, generator, queue, and large-load geometry.
2. Create normalized `network_bus`, `network_branch`, `asset_bus_mapping`, and `project_bus_mapping` datasets with source and confidence.
3. Define candidate 8–12-bus boundaries from actual cutsets and planning areas.
4. Map all generators, interties, regional load, storage, queue projects, and data centres to the candidate buses.
5. Derive equivalent corridor limits/reactances; mark reported versus derived versus estimated values.
6. Compare the reduced topology visually with AESO SLDs and maps, and numerically with known transfer capability.
7. Record unresolved/multiple bus mappings instead of automatically choosing the nearest line.

**Gate:** Every model component maps to a source asset and bus; every branch has traceable connectivity and parameters; major Alberta corridors and interties are preserved.

### Phase 3 — chronological historical replay

**Target:** 2–3 weeks

1. Build all trailing-12-month hourly snapshots.
2. Use actual AIL distributed to buses by the best available regional profiles.
3. Use hourly renewable availability, unit outages/derates, and MC as availability inputs.
4. Add thermal operating constraints, cogeneration/must-run assumptions, hydro energy limits, storage state of charge, and reserve requirements in documented increments.
5. Fix interties to observed actual flow for the replay model.
6. Run dispatch chronologically or with an overlapping rolling horizon; carry unit and storage state across windows.
7. Store inputs, outputs, model version, data vintage, solver status, and run ID.

**Gate:** No unexplained load shedding or infeasible hours; hourly balances reconcile; results are repeatable from a clean environment.

### Phase 4 — calibration and holdout validation

**Target:** 1–2 weeks

Use a rolling holdout or, initially, nine months for calibration and three untouched months for validation. Do not tune on all 12 months and report in-sample error as validation.

Report:

- generator and fuel-level dispatch MAE/bias/correlation;
- renewable hourly and monthly energy error;
- BC/SK/MATL flow MAE and direction accuracy only in an endogenous-flow experiment;
- AIL/TNG/net-interchange balance residual;
- pool-price/system-marginal-price MAE, median error, correlation, spike recall, and duration-curve error;
- line/interface utilization and binding-hour frequency where an authoritative comparison exists;
- curtailment energy/rate by plant, bus, month, and cause;
- load-shed MWh and affected hours;
- storage energy balance and terminal-state sensitivity;
- results by season, hour, scarcity period, and high-renewable period.

Because AESO does not publish observed nodal prices, do not validate simulated nodal spreads against pool price. Validate the model's system price and dispatch against observed system outcomes and compare spatial congestion only with defensible proxies such as known transfer limits, constrained-down generation, published congestion studies, or permitted Congestion Portal observations.

**Gate:** Acceptance thresholds are agreed before calibration, holdout results are published, and material residuals have documented causes.

### Phase 5 — forward scenarios and application features

1. Switch interties from fixed historical flows to endogenous bidirectional links with hourly capability and external-price scenarios.
2. Add generation, storage, transmission, retirement, and large-load/data-centre projects by scenario and in-service date.
3. Support named transmission-upgrade cases and contingencies.
4. Produce plant-level curtailment, capture price, capture rate, congestion exposure, storage value, and scenario distributions.
5. Add market-design scenarios without presenting any one design as settled policy.
6. Expose every run's assumptions, data vintage, model tier, and validation score in the UI.

### Phase 6 — advanced studies

- N-1 security-constrained LOPF with credible contingencies and emergency ratings
- AC power-flow checks for selected stressed/representative snapshots
- stochastic load, weather, outage, hydro, and boundary-price scenarios
- capacity/transmission expansion and near-optimal alternatives
- probabilistic queue/data-centre buildout

## Recommended data model additions

Use effective-dated tables or equivalent versioned files:

- `aeso_model_bus`
- `aeso_model_branch`
- `aeso_model_transformer`
- `aeso_asset_bus_mapping`
- `aeso_regional_load_hourly`
- `aeso_generator_availability_hourly`
- `aeso_intertie_hourly`
- `aeso_intertie_capability_hourly`
- `aeso_transmission_outage`
- `aeso_model_project`
- `aeso_project_bus_mapping`
- `aeso_model_run`
- `aeso_model_run_metric`
- `aeso_data_provenance`
- `aeso_data_coverage`

Keep raw observations, derived fields, assumptions, scenarios, and model outputs separable. Every derived row should retain the input/source version and derivation method.

## Definition of done for the first credible release

The release is ready to be labelled **Calibrated Reduced Alberta Network** only when:

- an 8–12-bus internal network and three intertie boundary buses have traceable sources and parameters;
- the trailing 12 months contain complete or explicitly qualified hourly AIL, generator, availability/outage, pool-price, and interchange inputs;
- all material generators and large loads are mapped to a bus with confidence metadata;
- interties reproduce import and export directions and respect hourly capability/outage limits;
- the model runs chronologically with storage and operational state carried correctly;
- every hour balances within tolerance and load shedding is zero or explained;
- solver status and dependency versions are retained;
- holdout validation metrics and known limitations are visible;
- nodal prices are labelled simulated and not represented as historical AESO prices;
- restricted data has not been scraped or republished without permission.

## Instructions to give Claude

> Implement `AESO_PYPSA_VALIDATION.md` in phases. Begin with Phase 0 and the Phase 1 data audit; do not expand the network until the data audit and source register are complete. Treat the current three-bus network as illustrative. Verify the existing `itc/v1/interchange` source and the full `aeso_interchange` trailing-12-month coverage before using it. We require hourly actual and scheduled BC, Saskatchewan, and Montana/MATL flow; hourly directional ATC/TTC and outages are separate capability inputs. If actual historical flow is unavailable, request it from AESO and report the gap—do not synthesize it. Audit and use our trailing-12-month per-generator hourly data, but use it as a validation target rather than forcing the OPF to reproduce it. Build an evidence-based 8–12-bus Alberta network plus external intertie buses from permitted AESO/AUC/open sources, with every generator, load, queue project, and data centre mapped to a connected substation or reduced bus and assigned a confidence/source. Add changes on a separate Git branch. Submit each phase with tests, coverage/validation metrics, migrations, source links, assumptions, and a list of unresolved data gaps before moving to the next phase.

## Source index

### AESO and Alberta

- [AESO API catalogue](https://www.aeso.ca/market/market-and-system-reporting/aeso-application-programming-interface-api/)
- [AESO Current Supply Demand report](https://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=html)
- [AESO ATC public report](https://itc-integ.aeso.ca/itc/public/atc)
- [AESO Historical Generation Data](https://www.aeso.ca/market/market-and-system-reporting/data-requests/historical-generation-data/)
- [AESO historical BC and MATL intertie flows](https://www.aeso.ca/market/market-and-system-reporting/data-requests/bc-and-matl-intertie-flows/)
- [AESO Long-term Transmission Plan and SLDs](https://www.aeso.ca/grid/grid-planning/long-term-transmission-plan/)
- [AESO AIES map](https://www.aeso.ca/assets/AIES_Map.pdf)
- [AESO Transmission Capability Map](https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/)
- [AESO Transmission Projects](https://www.aeso.ca/grid/transmission-projects/)
- [AESO Large Load Projects](https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects/)
- [AESO data-centre connection requirements](https://aesoengage.aeso.ca/connection-requirements-for-transmission-connected-data-centres)
- [AESO Congestion Portal](https://congestion.aeso.ca/)
- [AUC featured applications](https://www.auc.ab.ca/featured-applications/)
- [Alberta Powerlines open data](https://open.canada.ca/data/en/dataset/03dbd872-5b9d-4513-86e5-39a14cc2dfee)

### Modelling frameworks

- [PyPSA](https://github.com/pypsa/pypsa)
- [PyPSA documentation](https://docs.pypsa.org/latest/)
- [PyPSA examples](https://docs.pypsa.org/latest/examples/examples/)
- [NRCan PyPSA-Canada](https://github.com/NRCan/pypsa-canada)

## Related project documents

- `AESO_AZURE_CLAUDE_HANDOFF.md` — broader AESO feature and deployment handoff
- `TECHNICAL_NOTES.md` — project-wide technical decisions
- `modelling-aeso-prompt.md` — earlier modelling prompt; treat any unsupported topology or market claims in it as hypotheses to verify

