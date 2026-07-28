# AESO Azure Implementation Handoff for Claude Cowork

**Project:** Grid Origination Intelligence Platform  
**Repository:** <https://github.com/amol-javahire/Grid-Intelligence>  
**Production target:** Azure VM, Azure PostgreSQL/TimescaleDB  
**Prepared:** July 27, 2026  
**Status:** Implementation brief; no schedule should be activated without explicit approval

## 1. Purpose and decision

The GitHub/Azure implementation is now the only production source of truth. The
Replit version is being stopped because ongoing Replit Agent work and scheduled
deployments consume credits and would create a second, diverging codebase.

Claude Cowork should implement the recommendations in this document directly in
the Azure-hosted monorepo. Preserve all existing non-AESO features and the
existing product design unless a change is required for correctness,
transparency, security, accessibility, or operational reliability.

Read these files before changing code:

1. `AGENTS.md`
2. `TECHNICAL_NOTES.md`
3. `README.md`
4. `modelling-aeso-prompt.md`
5. This handoff

Where these documents disagree, use the following precedence:

1. Current official source data and tested application behaviour
2. `AGENTS.md`
3. `TECHNICAL_NOTES.md`
4. This handoff
5. The original `modelling-aeso-prompt.md`

The original modelling prompt contains unverified claims, including an
"official Alberta example network" and a public 15-bus topology. Do not rely on
those claims without locating and documenting the authoritative source.

## 2. Copy/paste starting instruction for Claude Cowork

> Work in the Grid Intelligence Azure/GitHub repository and follow `AGENTS.md`,
> `TECHNICAL_NOTES.md`, and `AESO_AZURE_CLAUDE_HANDOFF.md`. First inspect the
> existing implementation and produce a file-by-file plan. Then implement the
> AESO recommendations in the phases and priority order in the handoff. The
> urgent deliverables are security remediation, truthful PyPSA error handling,
> accurate data provenance, current MSA/AUC/REM content, an updated Platform
> Guide, a manual "update through yesterday" operation, and one efficient daily
> ingestion capability that remains disabled until explicitly approved. Do not
> fabricate Alberta topology, line ratings, queue records, congestion history,
> publication dates, source timestamps, or schedules. Do not label synthetic,
> modelled, cached, estimated, or manually curated information as live or
> historical observations. Validate every ingestion and model result, deploy
> changes to Azure in safe phases, and provide evidence for every completed
> acceptance criterion.

## 3. Non-negotiable requirements

1. GitHub/Azure is canonical; do not implement or deploy further work to Replit.
2. Do not activate any paid or recurring schedule without explicit approval.
3. At most one consolidated persisted-data update should run per day.
4. Daily persisted ingestion must stop at the end of the previous Alberta
   calendar day, using `America/Edmonton`.
5. Browser polling is not a persisted ingestion schedule and must not be
   presented as one.
6. All ingestion must be idempotent, gap-aware, restartable, and validated.
7. Never turn an external-source failure, timeout, parsing failure, solver
   failure, or infeasible optimization into a successful empty result.
8. Do not invent network topology or claim a model is validated without
   calibration evidence.
9. Do not expose API keys, passwords, connection strings, admin keys, or tokens
   in source control, logs, job output, responses, or the user interface.
10. Use Polars for Python data processing unless a dependency forces Pandas.
11. Use 2025/2026 data vintages where available.
12. Preserve user data and unrelated work already present in the repository.

## 4. Existing Azure architecture and relevant code

The repository already contains the required deployment architecture:

- React/Vite AESO frontend:
  `artifacts/aeso-platform`
- Express API:
  `artifacts/api-server`
- FastAPI/PyPSA service:
  `artifacts/pypsa-engine`
- PostgreSQL/TimescaleDB schemas:
  `lib/db/src/schema`
- Seeders:
  `scripts/src`
- Azure deployment and PM2 configuration:
  `infra`

Important AESO implementation areas:

| Area | Current location |
|---|---|
| AESO Platform Guide | `artifacts/aeso-platform/src/pages/guide.tsx` |
| Congestion UI | `artifacts/aeso-platform/src/pages/congestion.tsx` |
| MSA UI | `artifacts/aeso-platform/src/pages/msa.tsx` |
| AUC UI | `artifacts/aeso-platform/src/pages/auc.tsx` |
| REM UI | `artifacts/aeso-platform/src/pages/rem.tsx` |
| Supply and Demand UI | `artifacts/aeso-platform/src/pages/supply-demand.tsx` |
| Outages UI | `artifacts/aeso-platform/src/pages/outages.tsx` |
| Seven-Day Capacity UI | `artifacts/aeso-platform/src/pages/7day-capacity.tsx` |
| LTA UI | `artifacts/aeso-platform/src/pages/lta.tsx` |
| AESO statistics and live scrapers | `artifacts/api-server/src/routes/aeso_stats.ts` |
| AUC/MSA retrieval and caching | `artifacts/api-server/src/routes/auc_msa.ts` |
| Administrative seed operations | `artifacts/api-server/src/routes/admin.ts` |
| Alberta PyPSA model | `artifacts/pypsa-engine/aeso_network.py` |
| PyPSA API | `artifacts/pypsa-engine/main.py` |
| Real AESO API seeder | `scripts/src/seed-aeso-real.ts` |
| Synthetic/calibrated AESO seeder | `scripts/src/seed-aeso-data.ts` |
| AESO database schemas | `lib/db/src/schema/aeso_*.ts` |

There is already an uncommitted Platform Guide edit in
`artifacts/aeso-platform/src/pages/guide.tsx` that adds an initial provenance and
refresh table. Preserve and improve it; do not overwrite it.

## 5. Audit findings: current data behaviour

### 5.1 Scheduling

- No dependable AESO cron, Azure timer, or Replit Scheduled Deployment is
  configured in the audited implementation.
- Historical tables are populated by manually running `seed-aeso-real`.
- `seed-aeso-data` creates calibrated synthetic/modelled records.
- The words "Live" and "refreshed daily" are used in parts of the UI even when
  no daily persisted ingestion exists.
- The application must distinguish feature availability from data freshness.

### 5.2 Current live/on-demand behaviour

- Current Supply and Demand calls the AESO CSD report and refreshes
  approximately every five minutes while the page is open.
- Seven-Day Available Capability refreshes approximately every ten minutes while
  the page is open.
- Outages are scraped when the page loads or is revisited after the client cache
  expires; there is no continuous background poll.
- MSA is retrieved on demand, with a 24-hour frontend cache and a server disk
  cache that can be reused for up to seven days.
- AUC is retrieved on demand, with a one-hour frontend/in-memory cache and a
  server disk cache that can be reused for up to seven days.
- LTA PDFs are parsed on demand from a manually maintained URL list.
- PyPSA OPF executes on user input if the Python service is available.

### 5.3 Real, synthetic, modelled, and curated data

| Dataset/tab | Audited classification | Current refresh behaviour | Required treatment |
|---|---|---|---|
| Pool Price | Real AESO API observations | Manual real seeder | Daily/manual gap-fill through yesterday |
| SMP | Real AESO API observations | Manual real seeder | Daily/manual gap-fill through yesterday |
| Interchange | Real AESO API observations | Manual real seeder | Daily/manual gap-fill through yesterday |
| Other real API tables | Real or mixed; verify each | Manual real seeder | Audit table-by-table and expose coverage |
| Generation Mix history | Calibrated synthetic | Manual synthetic seeder | Label synthetic or replace with official observations |
| Stored Supply/Demand history | Mixed; verify | No schedule | Label row provenance; replace synthetic rows where possible |
| Current Supply/Demand panel | Real on-demand AESO ETS scrape | Five-minute browser polling while open | Keep, cache responsibly, label as page-active live data |
| Outages | Real on-demand AESO ETS scrape | Page load/revisit after cache | Keep on demand; optionally snapshot in daily job |
| Seven-Day Capacity | Real forward report | Ten-minute browser polling while open | Keep; do not persist as historical without a stated purpose |
| Queue projects | Synthetic in current seed | Manual synthetic seeder | Label synthetic or replace with authoritative source |
| Transmission corridors | Synthetic in current seed | Manual synthetic seeder | Label model assumption, not historical |
| Historical congestion tables | SMP/interchange are real; corridor metrics may be synthetic | Manual | Separate observed proxies from model results |
| PyPSA congestion | Modelled | On demand | Label model scope and validation level |
| LTA | Real AESO quarterly PDFs | Parsed on demand; URL list manual | Quarterly discovery and verified parsing |
| AUC | Curated rules plus partial WordPress RSS | On demand; cache can be seven days | Expand official-source coverage |
| MSA | Real document listings and portal information | On demand; cache can be seven days | Preserve, expose source check and coverage |
| REM | Curated/static official-source summary | Manual | Build maintained official-source tracker |
| Market Copilot | Generated response over underlying data | On demand | Inherit and disclose source freshness |

### 5.4 Seeder completeness bug

The real seeder commonly builds a set of existing year/month values and skips a
month as soon as any record exists in that month. This can leave the current
month permanently incomplete. The pattern appears in multiple data functions,
including SMP and interchange.

Required correction:

- Do not use "month exists" as "month is complete."
- Determine expected keys and actual coverage at the dataset's natural
  granularity.
- Re-fetch the rolling recent completed-day window.
- Upsert revised observations.
- Detect missing hours, duplicated keys, unexpected row-count changes, and nulls
  in required fields.
- Do not ingest partial current-day records into the daily historical process.
- Record source coverage and job outcomes separately from the data rows.

## 6. Agreed low-cost update design

### 6.1 Operating policy

All recurring schedules remain disabled initially. Claude should implement and
test the capability, document how it is enabled, and leave activation to the
user.

When approved, use one consolidated daily execution at an off-peak Alberta time.
The exact time can be selected during deployment, but the job must calculate its
cutoff as the end of yesterday in `America/Edmonton`, including daylight-saving
transitions.

Do not create:

- Hourly backend jobs
- Per-tab recurring jobs
- Always-running scraper loops
- Multiple overlapping schedules
- Replit Scheduled Deployments
- A full-history reload every day

### 6.2 Daily coordinator behaviour

The single coordinator should:

1. Acquire a database-backed or operating-system lock.
2. Refuse or safely exit if another run is active.
3. Calculate the last completed Alberta calendar day.
4. Inspect dataset coverage before calling each source.
5. Fetch missing completed days plus a small recent revision window.
6. Upsert source corrections idempotently.
7. Run dataset-specific validation.
8. Record rows read, inserted, updated, unchanged, rejected, and deleted, if
   deletion is explicitly supported.
9. Record source timestamp, covered date range, job start/end, duration, status,
   error summary, and application version.
10. Preserve the last validated snapshot if a source fails.
11. Exit cleanly when no work is required.

### 6.3 Due-frequency rules inside the one daily coordinator

The daily process may decide that a source is not due and skip it:

| Source group | Maximum persisted cadence |
|---|---|
| Pool Price, SMP, interchange, eligible AESO history | Once daily through yesterday |
| Outage snapshots, if retained historically | Once daily |
| MSA source-change check | Once daily |
| AUC source-change check | Once daily |
| REM official-source change check | Daily or weekly; prefer cheap conditional requests |
| Connection queue | Weekly or monthly, only with an authoritative permitted source |
| LTA report discovery | Quarterly, around expected Feb/May/Aug/Nov releases |
| Synthetic/calibrated seed data | Never scheduled as live ingestion |

### 6.4 Manual administrator operation

Add an authenticated administrator operation named clearly, such as:
"Update data through yesterday."

Before execution it should show:

- Alberta cutoff date
- Datasets due
- Missing/revision date window
- Whether a job is already active
- Estimated scope based on coverage, without promising exact cost

After execution it should show:

- Overall status
- Per-dataset status
- Rows inserted, updated, unchanged, and rejected
- Coverage before and after
- Validation result
- Duration
- Safe error message and correlation/job identifier

The manual operation and daily operation must call the same update logic.

### 6.5 Azure scheduling recommendation

The existing application runs on an Azure VM with PM2. Prefer a single
operating-system-level daily timer or another existing Azure-native mechanism
that does not keep a paid worker continuously active. Do not add a second
always-on service solely to wait for the daily time.

Requirements:

- Schedule disabled by default
- Explicit enable/disable instructions
- Non-overlapping execution
- Limited CPU/memory use
- Structured logs with retention
- Failure exit code and alerting hook
- No secrets embedded in the timer definition
- Easy manual execution for testing
- Documented rollback

## 7. MSA, AUC, and REM content recommendations

### 7.1 MSA

Audit result:

- The MSA tab was the most current of the three regulatory tabs.
- It uses real MSA document-category pages.
- Its copy says "refreshed daily," but the underlying implementation is
  request-driven and can reuse a seven-day disk cache.
- The MSA Data Portal is a separate important official source and reported May
  2026 data updates through March 2026.

Required changes:

1. Keep official MSA document pages and the Data Portal separate.
2. Show the last source check, source publication date, and cache age.
3. Do not label the tab daily-refreshed unless the daily coordinator is enabled.
4. Cover reports, notices, consultations, compliance, enforcement, retail/rate
   cap, and available market-power datasets.
5. Link to canonical documents and avoid republishing full copyrighted reports.
6. Deduplicate by canonical URL plus publication date or a stable source ID.
7. Preserve the last successful snapshot with a stale warning on failure.

Official starting points:

- <https://www.albertamsa.ca/>
- <https://data.albertamsa.ca/>
- <https://www.albertamsa.ca/documents/consultations/enforcement-process-review-2026>

### 7.2 AUC

Audit result:

- The tab's newest visible feed item was January 5, 2026.
- The official AUC Engage site had active consultations dated July 20 and July
  22, 2026.
- The backend reads only a partial AUC WordPress RSS feed.
- The one-hour client/in-memory cache is reasonable, but the server may reuse a
  seven-day disk snapshot.
- Curated rules and acts are not a complete feed of proceedings, decisions,
  bulletins, engagements, or filings.

Required changes:

1. Expand discovery across official AUC sources for consultations, bulletins,
   decisions, proceedings/hearings, rules, and material power-market or
   transmission updates.
2. Use permitted official feeds/APIs where available; respect access terms and
   rate limits.
3. Do not imply the WordPress RSS feed is complete.
4. Deduplicate records from overlapping AUC sources.
5. Retain canonical links, source category, publication date, discovered date,
   and last verified date.
6. Display source coverage and limitations.
7. Reduce stale-cache risk by allowing the daily source check to refresh the
   persisted index; continue to preserve the last validated snapshot on failure.

Official starting points:

- <https://www.auc.ab.ca/>
- <https://engage.auc.ab.ca/>
- <https://www.auc.ab.ca/hearing-and-events-calendar/>

Current items that the implementation must be capable of discovering include:

- July 22, 2026: Rule 021 and Rule 028 engagement
- July 20, 2026: Rule 024 Micro-Generation engagement

### 7.3 REM

Terminology:

- REM means **Restructured Energy Market**.
- Replace every incorrect use of "Renewable Electricity Market."

Audit result:

- The current tab is mostly accurate but manually curated/static.
- It omitted or underrepresented June-July 2026 work on market-power mitigation
  for storage/hydro, the Cost of New Entry study, implementation technology,
  participant readiness, and the integrated transition with Optimal
  Transmission Planning and Transmission Regulation Policy.

Required changes:

1. Maintain a dated official-source tracker rather than a static narrative.
2. Include event date, publication date, category, status, source URL, last
   verified date, and a concise original summary.
3. Cover REM design and rules, market-power mitigation, storage/hydro treatment,
   CONE work, implementation technology, participant readiness, and interactions
   with transmission policy.
4. Never infer approval or implementation status from a consultation.
5. Use a clear status vocabulary such as proposed, consultation open,
   consultation closed, submitted, approved, implementation/readiness, and
   effective.
6. Preserve historical milestones instead of overwriting them.

Official starting points:

- <https://aesoengage.aeso.ca/restructured-energy-market-rem-iso-rules>
- <https://aesoengage.aeso.ca/restructured-energy-market-rem-iso-rules/widgets/208515/key_dates>

The tracker should include, where officially supported:

- June 22-July 15, 2026 feedback on market-power mitigation for storage/hydro
- June 22-July 15, 2026 CONE Study feedback
- May 20, 2026 Market Participant Readiness material
- March 24, 2026 REM Implementation and Market Readiness kickoff
- March 12, 2026 rule-approval confirmation and published rule material

## 8. PyPSA audit: what is currently implemented

The current Alberta implementation in
`artifacts/pypsa-engine/aeso_network.py` is:

- Three buses: South, Central, North
- Two radial AC lines: South-Central and Central-North
- One optimization snapshot
- Simplified zonal load allocation
- Simplified generator fleet and costs
- Simplified BC/SK imports modelled as generators
- Large emergency peakers
- An additional 25,000 MW central slack generator at a high marginal cost
- DC linear optimal power flow with HiGHS
- Bus marginal prices reported as indicative LMPs
- User-adjustable demand, renewable capacity factors, gas price, imports, and
  corridor limits

This is acceptable only as an illustrative conceptual price-separation demo. It
is not:

- A real AESO network model
- A nodal REM forecast
- A historical congestion dataset
- An AESO SCED replica
- A security-constrained operational model
- A calibrated or backtested planning model

### 8.1 Current correctness defects

1. The live congestion UI can show blank OPF values and still report
   "Uncongested" and "No binding constraints" when the request fails.
2. Request errors are swallowed or converted into empty/default data.
3. "Renewable Electricity Market" appears in model documentation and must be
   corrected.
4. UI methodology/capacity descriptions do not consistently match the Python
   model.
5. Synthetic corridor congestion frequencies are presented too much like
   historical observations.
6. The high-cost slack generator and emergency peakers can conceal scarcity.
7. Slack generation is omitted from the reported dispatch and therefore may be
   omitted from the reported total cost.
8. The dependency currently uses an open-ended PyPSA minimum version.
9. Solver exceptions are handled, but solver status, termination condition, NaN
   prices, implausible values, and slack use require stronger validation.

### 8.2 Immediate PyPSA corrections: Phase 0

Complete these before expanding the model:

1. Repair the service, proxy, timeout, and request path.
2. Add health and readiness endpoints for the PyPSA service.
3. Return a typed model-run envelope containing:
   - Request/run identifier
   - Model name and version
   - PyPSA version
   - Solver and solver version
   - Solver status and termination condition
   - Input data vintage
   - Run timestamp
   - Validation level
   - Success, degraded, or error state
   - Warnings
4. Make the frontend display distinct loading, success, degraded, stale, and
   error states.
5. Never show "uncongested" unless a valid optimal solution was returned and
   evaluated.
6. Provide a retry action and non-sensitive error explanation.
7. Reconcile all frontend methodology values with the actual model inputs.
8. Label the model "Alberta 3-Zone Illustrative DC OPF" or equivalent.
9. Label corridor limits, load allocation, capacity, costs, and import values as
   assumptions with documented sources or explicit modelling judgments.
10. Include all balancing and peaker dispatch and cost in the result.
11. Replace the unlimited slack concept with explicit finite load shedding at a
    documented Value of Lost Load, or expose and cap any retained balancing
    resource.
12. Add tests for:
    - Healthy optimal result
    - Service unavailable
    - Timeout
    - Invalid response
    - Infeasible/failed solve
    - NaN or empty marginal prices
    - Load shedding
    - Binding and non-binding line cases
    - Frontend status mapping
13. Pin and test a current PyPSA release. PyPSA 1.2.4 was released June 27,
    2026; confirm Python 3.13 and the rest of the environment before pinning.

### 8.3 Reduced Alberta network: Phase 1

Goal: a defensible screening network of approximately 15-30 buses.

Proceed only when buses, substations/planning areas, connectivity, voltage
levels, line/corridor ratings, generation, load allocation, and interties can be
supported by authoritative public data or user-supplied licensed data.

If authoritative topology is unavailable:

- Do not manufacture a 15-bus network.
- Keep the explicit three-zone fallback.
- Add an import/validation workflow for user-supplied network data.
- Clearly state which required fields are missing.
- Treat corridor studies as sensitivity cases, not real constraints.

If sufficient data is available:

1. Create documented network-data provenance.
2. Validate connectivity, islands, units, voltage, impedances, ratings, duplicate
   equipment, and missing coordinates.
3. Add hourly chronological snapshots.
4. Build demand, wind, solar, hydro, thermal, storage, outage, and intertie
   profiles from verified data.
5. Calibrate against real AESO observations.
6. Backtest prices, dispatch, interchange, scarcity, and observed constraint
   proxies for held-out periods.
7. Publish calibration metrics and date coverage.
8. Version input datasets and model assumptions.

Suggested model hierarchy:

- Tier A: Three-zone illustrative screening model
- Tier B: Validated reduced Alberta network
- Tier C: Detailed licensed/user-supplied network, if later available

The UI and API must always state which tier ran.

### 8.4 Operational market model: Phase 2

Use PyPSA's supported functionality where it is appropriate and tested:

- Hourly or sub-hourly chronological dispatch
- Unit commitment for applicable units
- Minimum stable generation
- Ramp-up and ramp-down limits
- Startup and shutdown costs
- Minimum up/down times
- Operating reserve requirements
- Storage charge/discharge efficiencies and state of charge
- Hydro energy constraints/inflows where data supports them
- Directional and capacity-limited interties
- Explicit load shedding at documented VOLL
- Variable O&M, heat rates, fuel, emissions, and carbon costs
- Offer assumptions distinct from engineering marginal costs
- Rolling-horizon operation

Important cautions:

- A market simulation based on estimated marginal costs is not an offer-curve
  recreation.
- A perfect-foresight run must be labelled as such.
- Unit commitment increases compute requirements; benchmark before using it in
  synchronous user requests.
- Prefer queued/asynchronous long runs with status reporting.

### 8.5 Security, uncertainty, and planning: Phase 3

Subject to validated inputs and acceptable compute:

- N-1 Security-Constrained Linear Optimal Power Flow
- Loss approximations
- Non-linear AC power-flow validation of selected stressed cases
- Hybrid validation with pandapower if useful
- Demand, renewable, outage, fuel, and intertie scenarios
- Stochastic or weighted-scenario planning
- Transmission expansion
- Generation and storage capacity expansion
- Queue and greenfield sensitivity analysis
- REM, Optimal Transmission Planning, and transmission-policy scenarios

Use PyPSA for chronological market/dispatch, scenarios, and expansion. Use a
detailed AC package for selected electrical validation if needed. Do not market a
hybrid screening study as an AESO-approved reliability study.

### 8.6 Relevant official PyPSA functionality

Claude should review and cite the version-matched official documentation:

- Project: <https://github.com/pypsa/pypsa>
- Documentation: <https://pypsa.org/>
- Features: <https://docs.pypsa.org/stable/home/features/>
- Optimization overview:
  <https://docs.pypsa.org/stable/user-guide/optimization/>
- Unit commitment:
  <https://docs.pypsa.org/stable/examples/unit-commitment/>
- Rolling horizon:
  <https://docs.pypsa.org/stable/examples/rolling-horizon/>
- Release notes:
  <https://docs.pypsa.org/stable/release-notes/>

Applicable features include economic dispatch, unit commitment, storage,
linearized network constraints, load shedding, rolling horizon,
security-constrained optimization, stochastic optimization, and capacity or
transmission expansion. Availability in PyPSA does not make an Alberta model
valid; input data, formulation, calibration, and validation determine that.

## 9. Data provenance and health requirements

### 9.1 Standard classification vocabulary

Every tab/dataset must use one of:

- Real observation
- Real forecast
- Modelled
- Synthetic
- Estimated
- Curated/static
- Mixed

Do not use "live" as the data classification.

### 9.2 Required metadata per dataset

Store or derive:

- Dataset identifier
- Display name
- Source organization
- Canonical source URL
- Source method/API/report
- Classification
- Coverage start and end
- Latest complete timestamp
- Source publication/update timestamp, if supplied
- Last attempted refresh
- Last successful refresh
- Current cache age
- Expected cadence
- Actual active schedule state
- Validation status
- Known limitations
- Record count
- Application/model version that produced derived data

### 9.3 Data-health view

Add a compact AESO data-health and model-health view showing:

- Fresh, stale, incomplete, unavailable, synthetic, modelled, or unknown
- Coverage dates
- Last success and last failure
- Manual/daily/on-demand refresh mode
- Whether the optional daily schedule is active
- Source link
- Validation result
- Model service health and last valid run

Warnings must be visible when:

- A source is stale
- Coverage is incomplete
- A parser returns no rows unexpectedly
- A cache is older than the stated cadence
- The schedule is disabled
- Data is synthetic or modelled
- Model service is unavailable
- A result used load shedding or a balancing resource

## 10. Platform Guide update

The live Platform Guide must match actual application behaviour. It should
include a source and refresh matrix with:

- Tab/dataset
- Source and canonical link
- Real/modelled/synthetic/etc. classification
- Ingestion method
- Actual refresh trigger
- Intended cadence
- Cache behaviour
- Coverage dates
- Latest complete record
- Last successful refresh
- Schedule active/inactive
- Known limitation

Required wording principles:

- "Live while page is open" is different from "persisted daily."
- "Available tab" is different from "fresh data."
- "Latest complete record" is different from "last page load."
- "Modelled congestion" is different from "observed congestion."
- "Partial official feed" is different from "complete filings coverage."
- "Manual curated content" is different from "automatically maintained."

Also document:

- The optional daily schedule is disabled by default.
- The manual "update through yesterday" operation.
- Alberta time-zone cutoff behaviour.
- The PyPSA model tier, data vintage, assumptions, and validation level.
- The phased PyPSA roadmap.
- The source and meaning of each health status.

## 11. Security remediation

The Replit audit found tracked configuration containing live-looking
credentials. Treat this as a potential exposure even if the values are old.

Required work:

1. Search the full Git history and current tree for credentials and connection
   strings without printing values into shared logs.
2. Inventory affected secret names and systems.
3. Remove secrets from tracked configuration.
4. Store production secrets in the approved Azure secret/environment mechanism.
5. Rotate every potentially exposed credential.
6. Confirm services restart successfully with rotated secrets.
7. Ensure logs mask keys and tokens; the current AESO seeder logs a prefix of the
   API key and should stop doing so.
8. Confirm admin endpoints require authentication and are not exposed through a
   guessable key or public route.
9. Add secret scanning to CI or the pre-deployment checklist.
10. Do not rewrite Git history without explicit approval and a coordinated plan.

## 12. Implementation phases and gates

### Phase A: Baseline and security

Deliver:

- Repository/data inventory
- Baseline screenshots or API samples
- Current coverage report for every `aeso_*` table
- Secret inventory without values
- Secret removal/rotation plan
- Test baseline

Gate:

- No production mutation until the baseline is recorded.

### Phase B: Truthful behaviour and documentation

Deliver:

- Correct PyPSA error/status handling
- Correct REM terminology
- Consistent model metadata
- Synthetic/modelled labels
- Updated Platform Guide
- Initial data/model health view
- Tests for failure states

Gate:

- A failed PyPSA request cannot produce an uncongested result.
- No page claims an inactive schedule is active.

### Phase C: Data ingestion and regulatory sources

Deliver:

- Gap-aware/idempotent daily coordinator
- Manual "through yesterday" administrator operation
- Per-dataset validation and job history
- AUC official-source coverage expansion
- MSA freshness/source improvements
- REM official-source tracker
- LTA quarterly discovery

Gate:

- Manual run completes twice without duplicates.
- A forced source failure preserves the last validated data and shows stale.
- Current and recent completed periods are complete.

### Phase D: Azure operationalization

Deliver:

- Production-safe command/job
- Timer/schedule definition
- Logging and failure behaviour
- Enable/disable/runbook/rollback instructions
- Deployment verification

Gate:

- The schedule remains disabled until explicit approval.
- A manual production run through yesterday is validated first.

### Phase E: PyPSA reduced-network model

Deliver only with validated source data:

- Network-data provenance
- Validated reduced topology or explicit three-zone fallback
- Chronological model
- Calibration and backtest report
- Versioned model/data metadata

Gate:

- No real-network claim without authoritative data and passed validation.

### Phase F: Advanced operational and planning studies

Deliver selectively:

- Unit commitment and rolling horizon
- Reserves and storage
- Directional interties and load shedding
- N-1 screening
- AC validation
- Uncertainty and expansion scenarios

Gate:

- Benchmark compute and move long jobs out of synchronous request paths.
- Publish limitations and validation level for every study type.

## 13. Testing and verification

### 13.1 Ingestion tests

- DST spring-forward and fall-back in `America/Edmonton`
- Hour Ending 1-24 conversion
- Previous-day cutoff
- Empty source response
- HTTP success with invalid/empty payload
- Timeout/retry behaviour
- Duplicate source rows
- Source corrections
- Partial month and partial day
- Restart after interrupted job
- Concurrent-run lock
- Idempotent second run
- Rate-limit response
- Schema drift
- Validation failure and rollback/quarantine

### 13.2 Data verification

For every dataset:

- Expected keys and row counts
- Unique-key duplicates
- Null critical fields
- Continuous time coverage
- Minimum/maximum plausibility
- Source spot checks
- Coverage recorded in health metadata
- Classification recorded and displayed

### 13.3 PyPSA tests

- Network consistency
- Connected components/islands
- Unit and sign conventions
- Power balance
- Line loading
- Optimal, infeasible, timeout, and error cases
- No silent NaN/zero substitution
- Load-shedding dispatch and cost
- Slack/balancing resource disclosure
- Reproducible model version
- Binding/non-binding constraint classification
- Calibration and held-out backtest metrics

### 13.4 Frontend tests

- Loading, success, stale, degraded, and failure states
- No empty value interpreted as zero
- No error interpreted as "uncongested"
- Source links and dates
- Synthetic/modelled warnings
- Disabled-schedule status
- Manual-update permission checks
- Accessible status indicators not dependent on colour alone
- Existing routes and non-AESO pages remain functional

## 14. Deployment and rollback expectations

Before deployment:

1. Review working tree and preserve unrelated user changes.
2. Run relevant unit, integration, type, and build checks.
3. Back up affected database tables or confirm recoverable migrations.
4. Verify environment variables without logging values.
5. Apply database changes from `lib/db`.
6. Deploy API, frontend, and PyPSA changes in a controlled order.

After deployment:

1. Verify PM2 processes.
2. Verify API and PyPSA health.
3. Exercise MSA, AUC, REM, congestion, data-health, and admin update paths.
4. Run a manual update through yesterday.
5. Compare database coverage and source spot checks.
6. Verify the schedule is still disabled.
7. Verify no credentials are exposed.
8. Record the deployed commit and model/data versions.

Rollback must cover:

- Application release
- Database migration
- Ingestion job
- Schedule/timer
- Secret/environment change

## 15. Definition of done for the first production milestone

The first milestone is complete only when:

1. Replit is no longer being used for active implementation or scheduling.
2. Potentially exposed credentials are rotated and removed from tracked files.
3. The AESO congestion page never reports success after a failed model run.
4. REM terminology is correct everywhere.
5. The three-zone model is clearly labelled illustrative.
6. UI/model capacities and descriptions agree.
7. Every AESO tab states its data classification and actual freshness.
8. AUC includes current official consultation discovery beyond the partial RSS
   feed.
9. MSA exposes actual source-check/cache timing.
10. REM includes current 2026 implementation/readiness/CONE/storage-hydro work.
11. The Platform Guide contains the complete source/refresh matrix.
12. The manual update through yesterday is idempotent and validated.
13. The single daily job is implemented but remains disabled.
14. No synthetic dataset is scheduled or described as real observations.
15. Data and model health are visible to administrators/users as appropriate.
16. Azure deployment verification passes.

## 16. Items requiring an explicit user decision

Claude must stop and ask before:

- Activating the daily schedule
- Purchasing or enabling a new paid Azure service
- Rotating a credential that affects an external integration without a tested
  cutover plan
- Rewriting Git history
- Deleting historical data
- Replacing synthetic queue/corridor data with a paid or licensed source
- Publishing a topology supplied under restrictive terms
- Claiming production-grade nodal or reliability-study capability
- Changing the public product positioning materially

## 17. Expected Claude Cowork completion report

For each phase, report:

1. Outcome first
2. Files changed
3. Database changes
4. Tests run and results
5. Data source and coverage evidence
6. Model assumptions and validation evidence
7. Azure deployment status
8. Schedule active/inactive status
9. Remaining limitations
10. Rollback procedure

Do not report a recommendation as implemented until it has been tested in the
Azure target environment.
