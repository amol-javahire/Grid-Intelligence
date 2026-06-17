# Grid Origination Intelligence Platform

A power market siting and PPA origination intelligence tool built for energy procurement teams. Identifies renewable energy projects and greenfield siting opportunities across **ERCOT**, **CAISO**, and **PJM** using real market data, PyPSA optimal power flow, and an 8-dimension scoring engine.

---

![Grid Origination Dashboard](docs/screenshots/dashboard.jpg)

> **Dashboard** — 3,875 EIA 860 projects screened in real time across three ISO markets, 407 GW total capacity tracked.

---

## What It Does

### Use Case 1 — PPA / Offtake Origination
Screen the full EIA 860 operable fleet to find wind, solar, and storage projects ready to enter Power Purchase Agreements. Each project is scored on 8 risk dimensions, ranked, and exportable for deal teams.

**Scoring dimensions:** Capture Price · Market Revenue · Interconnect Risk · RECs/Yr · Congestion Risk · Curtailment Risk · Basis Risk · Confidence Score

### Use Case 2 — New Project Siting via Queue Analysis
Analyze the interconnection queue across all three ISOs to find regions where a greenfield project can be sited with acceptable queue position, limited congestion competition, and favorable nodal basis — before committing capital to development.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **EIA 860 Fleet** | 3,875 operable generators >1 MW — real 2024 data, ISO-mapped via BA codes |
| **Interconnection Queue** | 3,493 queue projects tracked across ERCOT, CAISO, and PJM |
| **PyPSA OPF Engine** | Optimal power flow simulation; LMP spread and congestion heatmaps |
| **Congestion Intelligence** | 7-screen analysis suite: overview, heat map, node detail, basis analyzer, backtest, data quality, methodology |
| **Nodal Analysis** | Settlement point spread calculator with real 28-month DA/RT price history |
| **Real Price Data** | ERCOT CDR Reports 13060/13061 · CAISO OASIS PRC_LMP · 1,108 resource nodes |
| **Historical Markets** | ERCOT (15 hubs/zones), CAISO (NP15/SP15/ZP26), PJM (8 hubs/zones) |
| **Candidate Rankings** | Ranked table with all 8 scoring dimensions, sortable and filterable |
| **Map Workspace** | Leaflet map — EIA 860 project pins, queue markers, transmission lines overlay |
| **Export Center** | Top candidate cards + CSV export for deal teams |
| **Saved Screenings** | Persist filter sessions for repeatable analysis workflows |
| **Q&A Copilot** | Natural-language query interface (planned: OpenAI + DB RAG) |

---

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Dashboard — stats, market breakdown, screening launcher |
| `/rankings` | Candidate rankings with all 8 dimension scores |
| `/map` | Leaflet map — project pins, queue markers, transmission lines |
| `/ercot` | ERCOT Historical — DA/RT hub and load zone price trends |
| `/caiso` | CAISO Historical — NP15/SP15/ZP26 price analysis |
| `/pjm` | PJM Historical — 8 hubs/zones, on/off-peak, YoY comparison |
| `/nodal` | ERCOT/CAISO Nodal — settlement point spread calculator |
| `/congestion` | ERCOT Congestion — DA-RT spread heatmap and node ranking |
| `/queue` | Interconnection Queue — ERCOT/CAISO/PJM project tracker |
| `/qa` | Q&A Copilot — LLM chat interface |
| `/export` | Export Center — top candidates + CSV |
| `/screenings` | Saved Screenings — saved filter sessions |
| `/guide` | Platform Guide — explains every tab and both use cases |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18 · Vite · Tailwind CSS · shadcn/ui |
| **Charts** | Recharts |
| **Maps** | React Leaflet · OpenStreetMap |
| **Routing** | Wouter |
| **Data Fetching** | TanStack Query (generated hooks via Orval) |
| **API** | Express 5 · OpenAPI-first (Orval codegen) |
| **Database** | PostgreSQL · Drizzle ORM |
| **Validation** | Zod v4 · drizzle-zod |
| **Power Flow** | PyPSA · HiGHS LP solver (Python microservice) |
| **Build** | esbuild (CJS bundle) · pnpm workspaces |
| **Language** | TypeScript 5.9 · Node.js 24 |

---

## Data Sources

| Dataset | Source | Status |
|---------|--------|--------|
| ERCOT Hub/Zone prices (DA + RT) | CDR Reports 13061 + 13060 (public) | **Real** — 15 nodes × 28 months |
| ERCOT Resource nodes | ERCOT API monthly bundles (np6-905-cd RT + np4-190-cd DA) | **Real** — 1,108 nodes, 27,193 rows |
| CAISO prices (DA) | CAISO OASIS PRC_LMP (public) | **Real** — SP15/NP15/ZP26, 28 months |
| PJM prices | Calibrated to published monthly hub averages | Calibrated model |
| Interconnection Queue | CAISO ISO data (2,433 real) + ERCOT/PJM synthetic | Seeded |
| EIA 860 Projects | EIA Form 860 2024 "Operable" sheet | **Live** — 3,875 generators |
| Transmission Lines | HIFLD (115 kV+ ERCOT/CAISO/PJM, 345 kV+ national) | Seeded — 23,674 lines |

---

## Architecture

```
pnpm monorepo
├── artifacts/
│   ├── grid-platform/      # React + Vite frontend
│   ├── api-server/         # Express 5 API (OpenAPI-first)
│   └── pypsa-engine/       # Python PyPSA microservice (port 8083)
├── lib/
│   ├── api-spec/           # OpenAPI YAML → codegen source of truth
│   ├── api-client-react/   # Generated TanStack Query hooks
│   ├── api-zod/            # Generated Zod schemas
│   └── db/                 # Drizzle ORM schema + migrations
└── scripts/                # Data seeding scripts (ERCOT, CAISO, EIA 860)
```

---

## Design Language

Dark navy/teal — primary `#14b8a6` teal · `#f59e0b` amber · `#8b5cf6` purple
