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
| `/nodal` | ERCOT/CAISO Nodal Analysis — settlement point spread calculator |
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
| `ercot_node_stats` | 15 hub/zone nodes: monthly DA+RT stats (real Jun2024+, synthetic rest) |
| `ercot_nodal_stats` | 17 ERCOT settlement point nodes (SUN_*, WTG_*, etc.) monthly stats |
| `caiso_node_stats` | CAISO NP15/SP15/ZP26 monthly DA/RT stats |
| `pjm_node_stats` | PJM 8 hubs/zones monthly DA/RT stats |
| `queue_projects` | Interconnection queue records (ERCOT, CAISO, PJM) |

## Data Status

| Dataset | Status | Notes |
|---------|--------|-------|
| ERCOT Hub/Zone prices | Partial real | Real CDR Jun2024–Apr2025; synthetic rest. 15 nodes. |
| ERCOT Resource nodes | Synthetic | 17 settlement points with modeled RT basis. Need ERCOT API client_id for real data. |
| CAISO prices | Synthetic | Modeled from EIA benchmarks 2022–2026 |
| PJM prices | Synthetic | Modeled from published benchmarks 2022–2026 |
| Interconnection Queue | Seeded | Seeded from ISO queue reports |
| EIA 860 projects | Planned | Need bulk import of Form 860 for ERCOT/CAISO/PJM operating+planned plants |
| Candidate scoring | Partial | Mock candidates seeded; real scoring from EIA 860 + nodal planned |

## ERCOT API Credentials

- `ERCOT_SUBSCRIPTION_KEY` — set in env
- `ERCOT_USERNAME` — set in env  
- `ERCOT_PASSWORD` — set in secrets
- **Missing**: `client_id` from user's developer.ercot.com registered application (needed for Bearer token via B2C ROPC flow to access resource node pricing endpoints np4-190-cd and np6-785-er)

## Architecture Notes

- OpenAPI spec in `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- Generated React Query hooks in `lib/api-client-react/src/generated/`
- Generated Zod schemas in `lib/api-zod/src/generated/`
- Express routes in `artifacts/api-server/src/routes/`
- Frontend pages in `artifacts/grid-platform/src/pages/`

## Design Language

Dark navy/teal aesthetic: primary teal `#14b8a6`, amber `#f59e0b`, purple `#8b5cf6`
