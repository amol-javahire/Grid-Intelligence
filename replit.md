# Grid Origination Intelligence Platform

## Platform Purpose & Business Context

This is a **power market siting and PPA origination intelligence tool** built for Walmart's energy procurement team. It serves two primary use cases:

### Use Case 1 — PPA / Offtake Origination
Identify renewable energy projects (wind, solar, storage) from the EIA 860 database that can enter into Power Purchase Agreements or offtake contracts with Walmart to hedge a portion of their electricity portfolio across ERCOT, CAISO, and PJM.

Workflow: Pull EIA 860 projects → Show on Map → Screen by filters → Score on 10 risk dimensions → Rank → Export for deal team.

**10 scoring dimensions:** congestion risk, curtailment risk, basis risk, tax credit eligibility, sponsor quality, contract structure, market type, capacity available, delivery profile, confidence score.

### Use Case 2 — New Project Siting via Queue Analysis
Analyze the interconnection queue to find regions where a new greenfield project could be sited with acceptable queue position, limited congestion/curtailment competition, and favorable basis. Some areas already have heavy pipeline; others represent opportunity.

Workflow: Review queue depth by region → Overlay congestion analysis → Cross-reference existing project density → Assess basis risk via nodal history → Rank candidate zones.

### Q&A Copilot
The Q&A Copilot should eventually answer natural-language questions about the platform data. It needs to be connected to the full DB and OpenAI for structured SQL + RAG responses. Questions like "Which ERCOT wind projects have the lowest congestion risk?" or "What is the queue depth in LZ_WEST for 2025?"

---

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React 18 + Vite + Tailwind CSS + shadcn/ui
- **Charts**: Recharts
- **Maps**: React Leaflet + OpenStreetMap
- **Routing**: Wouter
- **Data fetching**: TanStack Query (generated hooks via Orval)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

## Pages

| Path | Purpose |
|------|---------|
| `/` | Dashboard — stats overview, market breakdown, screening launcher |
| `/rankings` | Candidate rankings table with all 10 dimension scores |
| `/map` | Leaflet map — EIA 860 project pins + queue project markers |
| `/ercot` | ERCOT Historical — DA/RT price trends for hubs and load zones |
| `/caiso` | CAISO Historical — NP15/SP15/ZP26 price analysis |
| `/pjm` | PJM Historical — 8 hubs/zones, on/off-peak, YoY comparison |
| `/nodal` | ERCOT/CAISO Nodal Analysis — settlement point spread calculator (PJM removed; ERCOT/CAISO only) |
| `/congestion` | ERCOT Congestion Analysis — DA-RT spread heatmap and ranking |
| `/queue` | Interconnection Queue — ERCOT/CAISO/PJM queue project tracker |
| `/qa` | Q&A Copilot — LLM chat interface (planned: OpenAI + DB RAG) |
| `/export` | Export Center — top candidate cards + CSV export |
| `/screenings` | Saved Screenings — saved filter sessions |
| `/guide` | Platform Guide — explains every tab and both use cases |

## Database Entities

| Table | Purpose |
|-------|---------|
| `candidates` | Core project records with all 10 dimension scores |
| `screenings` | Saved screening sessions with filters and candidate IDs |
| `ercot_node_stats` | 15 hub/zone nodes (real) + 1,108 resource nodes (real ERCOT API bundles, Jan 2024–Apr 2026): monthly DA+RT stats |
| `ercot_nodal_stats` | 17 ERCOT settlement point nodes (SUN_*, WTG_*, etc.) monthly stats |
| `caiso_node_stats` | CAISO NP15/SP15/ZP26 monthly DA/RT stats (all real from OASIS) |
| `pjm_node_stats` | PJM 8 hubs/zones monthly DA/RT stats |
| `queue_projects` | Interconnection queue records (ERCOT, CAISO, PJM) |

## Data Status

| Dataset | Status | Notes |
|---------|--------|-------|
| ERCOT Hub/Zone prices (RT+DA) | **REAL** | 100% real from ERCOT CDR reports 13061+13060 (public, no auth). 15 LZ/HB nodes × 28 months (Jan 2024–Apr 2026). 420 rows. Script: `seed-ercot-real`. |
| ERCOT Resource nodes | **REAL (full history)** | 1,108 real resource nodes from ERCOT API monthly bundles (np6-905-cd RT + np4-190-cd DA). 27,193 rows covering Jan 2024–Apr 2026 (28 months RT, 20 months DA). Python bundle seeder in `scripts/src/`. |
| CAISO prices (DA) | **REAL** | 100% real from CAISO OASIS PRC_LMP (public API). SP15 + NP15 (28 months each) + ZP26 (14 months). 70 rows. Script: `seed-caiso-real`. |
| PJM prices | Calibrated model | No publicly accessible real-time PJM node prices (requires PJM account). Values calibrated to published monthly hub averages. 14,336 rows. |
| ERCOT load by zone | **REAL** | 174,282 rows Jan 2024–Jun 2026. 8 zones (COAS/EAST/FWES/NCEN/NRTH/SCEN/SOUT/WEST) from EIA-930 region-sub-ba-data. Script: `seed-ercot-real-data.py` (pypsa venv). |
| ERCOT fuel mix | **REAL** | 167,190 rows Jan 2024–Jun 2026. 8 fuel types from EIA-930 fuel-type-data (ERCO respondent). Gas ~22 GW avg, wind ~13 GW, solar ~7 GW, hydro ~52 MW (accurate — ERCOT has almost no hydro). |
| Interconnection Queue | Seeded | CAISO queue from public ISO data (2,433 real projects); ERCOT/PJM synthetic. |
| EIA 860 projects | **Live (2024)** | 3,875 operable generators >1 MW from EIA Form 860 2024 "Operable" sheet. ISO mapped via BA codes (ERCO/CISO/PJM). |
| Candidate scoring | Partial | Scoring engine live on all 3,875 EIA 860 plants. Real signal scoring from nodal+queue data planned. |

## Real Data Sources

### ERCOT (seed-ercot-real)
- **RTM prices**: CDR Report 13061 — `RTMLZHBSPP_{YYYY}.xlsx` annual files
  - doclookupId: 2024=1065471230, 2025=1177737535, 2026=1220061372
- **DAM prices**: CDR Report 13060 — `DAMLZHBSPP_{YYYY}.xlsx` annual files
  - doclookupId: 2024=1065468714, 2025=1177667469, 2026=1219858972
- **Base URL**: `https://www.ercot.com/misdownload/servlets/mirDownload?mimic_duns=000000000&doclookupId=`
- ZIP64 format — uses custom Node.js ZIP64 extractor (central directory parsing)
- 15-min interval data (RTM) / hourly (DAM), 12-sheet annual XLSX

### CAISO (seed-caiso-real)
- **DA LMP**: CAISO OASIS PRC_LMP query, market_run_id=DAM
- **URL**: `https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP&version=1&market_run_id=DAM&...`
- **Valid nodes**: `TH_SP15_GEN-APND` (SP15), `TH_NP15_GEN-APND` (NP15), `TH_ZP26_GEN-APND` (ZP26) — some months return 114-byte empty response (skipped)
- Streaming ZIP (compSize=0 in local header) — uses central directory for actual compSize
- Gap-fill mode: skips already-populated months, retries rate-limited months

### EIA-930 (seed-ercot-real-data.py)
- **Load by zone**: `https://api.eia.gov/v2/electricity/rto/region-sub-ba-data/data/` — `facets[parent][]=ERCO`
  - 8 sub-BAs: COAS, EAST, FWES, NCEN, NRTH, SCEN, SOUT, WEST (EIA zone codes, stored directly in DB)
- **Fuel mix**: `https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/` — `facets[respondent][]=ERCO`
  - Fuel codes: COL→coal, NG→natural_gas, NUC→nuclear, SUN→solar, WAT→hydro, WND→wind, BAT→storage, OTH→other
- Key: `EIA_API_KEY` environment variable
- Script: `cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-ercot-real-data.py`

## ERCOT API Credentials

- `ERCOT_SUBSCRIPTION_KEY` — set in env
- `ERCOT_USERNAME` — set in env  
- `ERCOT_PASSWORD` — set in secrets
- `ERCOT_CLIENT_ID` — set in secrets (needed for Bearer token via B2C_1_PUBAPI-ROPC-FLOW policy)
- Note: NP6-345-CD (load by weather zone) returns 404 even with valid Bearer token — use EIA-930 instead

## Architecture Notes

- OpenAPI spec in `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- Generated React Query hooks in `lib/api-client-react/src/generated/`
- Generated Zod schemas in `lib/api-zod/src/generated/`
- Express routes in `artifacts/api-server/src/routes/`
- Frontend pages in `artifacts/grid-platform/src/pages/`

## Design Language

Dark navy/teal aesthetic: primary teal `#14b8a6`, amber `#f59e0b`, purple `#8b5cf6`
