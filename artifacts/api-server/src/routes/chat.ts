import { Router } from "express";
import { db } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { sql } from "drizzle-orm";
import { getAucFeed, getMsaDocs } from "./auc_msa";

const router = Router();

const TABLE_DISPLAY_LIMIT = 100;

function isTimeSeries(columns: string[]): boolean {
  return columns.includes("year") && columns.includes("month");
}

async function runSafeQuery(query: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const trimmed = query.trim();
  if (!/^select\b/i.test(trimmed)) throw new Error("Only SELECT queries are permitted.");
  const semi = trimmed.indexOf(";");
  if (semi !== -1 && semi < trimmed.length - 1) throw new Error("Multiple statements not allowed.");
  const withLimit = /\bLIMIT\s+\d+/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 300`;
  const result = await db.execute(sql.raw(withLimit));
  return {
    columns: result.rows.length > 0 ? Object.keys(result.rows[0] as object) : [],
    rows: result.rows as Record<string, unknown>[],
  };
}

router.post("/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      sendEvent({ error: "messages array required" });
      res.end();
      return;
    }

    const [ercotHubs, caisoZones, pjmNodes, queueSummary, topCandidates, pipelineSummary] = await Promise.all([
      db.execute<{ node: string; node_type: string; avg_da: number; avg_rt: number; avg_vol: number; neg_pct: number; months: number }>(sql`
        SELECT node, node_type,
          ROUND(AVG(avg_da_price)::numeric, 2) AS avg_da,
          ROUND(AVG(avg_rt_price)::numeric, 2)  AS avg_rt,
          ROUND(AVG(volatility)::numeric, 2)     AS avg_vol,
          ROUND(AVG(neg_price_percent)::numeric, 2) AS neg_pct,
          COUNT(*)::int AS months
        FROM ercot_node_stats
        WHERE node_type IN ('hub', 'load_zone')
        GROUP BY node, node_type
        ORDER BY avg_da DESC
      `),
      db.execute<{ node: string; avg_da: number; avg_vol: number; neg_pct: number; months: number }>(sql`
        SELECT node,
          ROUND(AVG(avg_da_price)::numeric, 2)      AS avg_da,
          ROUND(AVG(volatility)::numeric, 2)         AS avg_vol,
          ROUND(AVG(neg_price_percent)::numeric, 2)  AS neg_pct,
          COUNT(*)::int AS months
        FROM caiso_node_stats
        GROUP BY node ORDER BY avg_da DESC
      `),
      db.execute<{ node: string; avg_da: number; avg_rt: number; months: number }>(sql`
        SELECT node,
          ROUND(AVG(avg_da_price)::numeric, 2) AS avg_da,
          ROUND(AVG(avg_rt_price)::numeric, 2)  AS avg_rt,
          COUNT(*)::int AS months
        FROM pjm_node_stats
        GROUP BY node ORDER BY avg_da DESC
      `),
      db.execute<{ market: string; fuel_type: string; projects: number; total_mw: number; active: number }>(sql`
        SELECT market, fuel_type,
          COUNT(*)::int AS projects,
          ROUND(SUM(capacity_mw::float)::numeric, 0)::int AS total_mw,
          COUNT(CASE WHEN status ILIKE ANY(ARRAY['%active%','%study%','%queue%']) THEN 1 END)::int AS active
        FROM queue_projects
        WHERE capacity_mw IS NOT NULL
        GROUP BY market, fuel_type
        ORDER BY market, total_mw DESC
        LIMIT 30
      `),
      db.execute<{ name: string; market: string; asset_type: string; capacity_mw: number; overall_score: number; curtailment_score: number; interconnection_score: number; price_score: number; interconnection_node: string }>(sql`
        SELECT name, market, asset_type, capacity_mw::float AS capacity_mw,
          overall_score::float, curtailment_score::float,
          interconnection_score::float, price_score::float, interconnection_node
        FROM candidates
        ORDER BY overall_score DESC NULLS LAST
        LIMIT 20
      `),
      db.execute<{ market: string; asset_type: string; count: number; avg_score: number; avg_mw: number }>(sql`
        SELECT market, asset_type, COUNT(*)::int AS count,
          ROUND(AVG(overall_score::float)::numeric, 1) AS avg_score,
          ROUND(AVG(capacity_mw::float)::numeric, 0)::int AS avg_mw
        FROM candidates
        GROUP BY market, asset_type
        ORDER BY market, count DESC
      `),
    ]);

    const fmt = (rows: { node: string; node_type?: string; avg_da: number; avg_rt?: number; avg_vol: number; neg_pct: number; months: number }[]) =>
      rows.map(r =>
        `  ${r.node.padEnd(16)}${r.node_type ? r.node_type.padEnd(12) : ""}DA=$${String(r.avg_da).padStart(6)}  ${r.avg_rt !== undefined ? `RT=$${String(r.avg_rt).padStart(6)}  ` : ""}vol=${String(r.avg_vol).padStart(6)}  neg%=${String(r.neg_pct).padStart(5)}%  (${r.months}mo)`
      ).join("\n");

    const systemPrompt = `You are the Grid Origination Copilot — an expert AI assistant for power market siting, PPA origination, and energy procurement across ERCOT, CAISO, and PJM.

You have a live PostgreSQL database with real market data. Use the run_sql tool when you need specific data not already shown below. Always be quantitative and cite data sources.

━━━ DATABASE SCHEMA ━━━
TABLE candidates  (3,875 rows — EIA 860 operable generators >1 MW)
  id, name, market (ERCOT/CAISO/PJM), asset_type (wind/solar/storage/natural_gas/nuclear/hydro/coal),
  capacity_mw, latitude, longitude, status, operating_year,
  interconnection_node, pricing_hub_node,
  overall_score (0-100), curtailment_score, interconnection_score, location_score,
  price_score, financial_score, development_risk_score, environmental_score, demand_proximity_score

TABLE ercot_node_stats  (28,785 rows — ERCOT monthly pricing, Jan 2024–Jun 2026)
  node TEXT, node_type (hub/load_zone/resource_node), year INT, month INT,
  avg_da_price NUMERIC, avg_rt_price NUMERIC, volatility NUMERIC, neg_price_percent NUMERIC, data_points INT
  -- 15 hub/zone nodes + 1,108 resource nodes

TABLE caiso_node_stats  (real OASIS data — NP15, SP15, ZP26)
  node TEXT, year INT, month INT,
  avg_da_price NUMERIC, volatility NUMERIC, neg_price_percent NUMERIC

TABLE pjm_node_stats  (8 hubs/zones, calibrated monthly averages)
  node TEXT, year INT, month INT, avg_da_price NUMERIC, avg_rt_price NUMERIC

TABLE queue_projects  (interconnection queue — ERCOT/CAISO/PJM)
  id, project_name, market, fuel_type, capacity_mw, status, queue_date,
  interconnection_node, county, state, latitude, longitude

TABLE ercot_hub_hourly  (263,130 rows — hourly DA+RT for 15 ERCOT hub/zone nodes)
  node, node_type, year, month, day, hour, da_price, rt_price

━━━ LIVE ERCOT HUB/ZONE STATS (real CDR data, 28-month avg) ━━━
${fmt(ercotHubs.rows)}

━━━ LIVE CAISO ZONE STATS (real OASIS data) ━━━
${caisoZones.rows.map(r => `  ${r.node.padEnd(16)}DA=$${String(r.avg_da).padStart(6)}  vol=${String(r.avg_vol).padStart(6)}  neg%=${String(r.neg_pct).padStart(5)}%  (${r.months}mo)`).join("\n")}

━━━ PJM HUB/ZONE STATS ━━━
${pjmNodes.rows.map(r => `  ${r.node.padEnd(20)}DA=$${r.avg_da}  RT=$${r.avg_rt}  (${r.months}mo)`).join("\n")}

━━━ INTERCONNECTION QUEUE BY MARKET + FUEL ━━━
${queueSummary.rows.map(r => `  ${r.market.padEnd(7)} ${r.fuel_type.padEnd(14)} ${String(r.projects).padStart(5)} projects  ${String(r.total_mw).padStart(8)} MW  ${r.active} active`).join("\n")}

━━━ TOP 20 CANDIDATES BY SCORE ━━━
${topCandidates.rows.map(r => `  ${r.name.substring(0,35).padEnd(36)} ${r.market.padEnd(6)} ${r.asset_type.padEnd(12)} ${String(r.capacity_mw).padStart(6)}MW  score=${r.overall_score}  curt=${r.curtailment_score}  cong=${r.interconnection_score}  node=${r.interconnection_node}`).join("\n")}

━━━ PIPELINE SUMMARY (market × technology) ━━━
${pipelineSummary.rows.map(r => `  ${r.market.padEnd(7)} ${r.asset_type.padEnd(14)} n=${String(r.count).padStart(5)}  avg_score=${r.avg_score}  avg_mw=${r.avg_mw}`).join("\n")}

━━━ GUIDANCE ━━━
- run_sql for: filtering candidates by criteria, node price history, congestion event counts, DA-RT spread analysis, queue depth by zone, within-zone resource node comparisons, time-series trends, battery arbitrage value (DA-RT spread capture)
- run_simulation for: ALL "what if" scenario questions that require running power flow — new generation additions, wind/solar CF changes, thermal derates, load shedding, transmission upgrades, battery dispatch. Prefer run_simulation over run_sql for any forward-looking scenario.
  • opf — base OPF: params { system_load_mw, wind_cf, solar_cf, gas_price_mmbtu }. Returns nodal LMPs, line flows, congestion rent, curtailment. Use for "what happens to HB_PAN if wind CF goes to 65%?"
  • curtailment — vary CF, see curtailment MW + negative-price risk per zone: params { system_load_mw, wind_cf, solar_cf, gas_price_mmbtu, west_wind_bonus_pct }
  • tx_relief — upgrade one transmission line, compare before/after: params { system_load_mw, wind_cf, solar_cf, gas_price_mmbtu, upgrade_line (one of NORTH-HOUSTON/NORTH-WEST/NORTH-SOUTH/WEST-PAN/WEST-SOUTH/SOUTH-HOUSTON), extra_capacity_pct }
  • scarcity — thermal derate + high load → load shedding + price spikes: params { system_load_mw (keep ≤65000 for ERCOT; 55000 is a realistic peak), wind_cf, solar_cf, gas_derate_pct (0-50), nuclear_derate_pct (optional, 0-100) }
  • battery — 24-hr multi-period OPF with StorageUnit: params { system_load_mw, battery_mw, battery_mwh, price_delta_factor }
- All prices in $/MWh. neg_price_percent = % of monthly intervals with price < $0.
- Congestion risk ↑ when volatility is high and DA-RT spreads are wide.
- Curtailment risk ↑ when neg_price_percent is high (ERCOT wind LZ_WEST ~7-22%, solar worse).
- Basis risk = DA-RT settlement spread + volatility at the project's delivery node.
- Be quantitative and cite the data source (CDR 13060/13061 for ERCOT, OASIS for CAISO).
- Format responses with clear headers, bullet points, and tables where appropriate.
- After run_simulation: always explain what the LMP changes mean economically and compare to baseline. For battery, state the annual arbitrage value and best charge/discharge hours.`;

    const tools: Parameters<typeof openai.chat.completions.create>[0]["tools"] = [
      {
        type: "function",
        function: {
          name: "run_sql",
          description:
            "Execute a read-only SELECT query against the platform PostgreSQL database. Use for specific node histories, filtered candidate lists, congestion event counts, DA-RT spread analysis, queue depth breakdowns, or any data not already in the system prompt.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "A valid PostgreSQL SELECT statement. Always include LIMIT ≤300. Use exact table and column names from the schema.",
              },
              rationale: {
                type: "string",
                description: "One-line reason for the query (shown to user as loading indicator)",
              },
            },
            required: ["query", "rationale"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_simulation",
          description:
            "Run a live PyPSA DC-OPF power system simulation to answer what-if scenario questions about ERCOT. Use this for ANY forward-looking scenario: adding new generation, changing wind/solar capacity factors, thermal outages, transmission upgrades, battery dispatch, or load growth. Returns nodal LMPs, line flows, curtailment, and dispatch by carrier.",
          parameters: {
            type: "object",
            properties: {
              simulation_type: {
                type: "string",
                enum: ["opf", "curtailment", "tx_relief", "scarcity", "battery"],
                description:
                  "Type of simulation: opf=base dispatch+LMPs, curtailment=renewable curtailment analysis, tx_relief=transmission upgrade comparison, scarcity=thermal derate+load shedding, battery=24hr storage arbitrage OPF",
              },
              params: {
                type: "object",
                description:
                  "Simulation parameters. opf: {system_load_mw, wind_cf, solar_cf, gas_price_mmbtu}. curtailment: adds west_wind_bonus_pct. tx_relief: adds upgrade_line (NORTH-HOUSTON|NORTH-WEST|NORTH-SOUTH|WEST-PAN|WEST-SOUTH|SOUTH-HOUSTON), extra_capacity_pct. scarcity: {system_load_mw (≤65000), wind_cf, solar_cf, gas_derate_pct, nuclear_derate_pct?}. battery: {system_load_mw, battery_mw, battery_mwh, price_delta_factor}",
              },
              rationale: {
                type: "string",
                description: "One-line explanation shown to the user while the simulation runs.",
              },
            },
            required: ["simulation_type", "params", "rationale"],
          },
        },
      },
    ];

    const apiMessages: Parameters<typeof openai.chat.completions.create>[0]["messages"] = [
      { role: "system", content: systemPrompt },
      ...(messages as Parameters<typeof openai.chat.completions.create>[0]["messages"]),
    ];

    const MAX_TOOL_ROUNDS = 4;
    let toolRounds = 0;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        messages: apiMessages,
        tools,
        tool_choice: "auto",
      });

      const choice = response.choices[0];

      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        apiMessages.push(choice.message);
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.function.name === "run_sql") {
            let toolResult: string;
            let rationale = "Querying database...";
            try {
              const args = JSON.parse(toolCall.function.arguments) as { query: string; rationale: string };
              rationale = args.rationale ?? rationale;
              req.log.info({ query: args.query }, "copilot sql query");
              sendEvent({ type: "sql_query", rationale });
              const result = await runSafeQuery(args.query);
              sendEvent({ type: "sql_done", rows: result.rows.length });

              const displayRows = result.rows.slice(0, TABLE_DISPLAY_LIMIT);

              sendEvent({
                type: "table",
                columns: result.columns,
                rows: displayRows,
                totalRows: result.rows.length,
              });

              if (result.columns.length >= 2 && isTimeSeries(result.columns)) {
                sendEvent({
                  type: "chart",
                  chartType: "timeseries",
                  columns: result.columns,
                  rows: displayRows,
                });
              }

              toolResult = JSON.stringify({ rows: result.rows, count: result.rows.length });
            } catch (err) {
              toolResult = JSON.stringify({ error: String(err) });
              sendEvent({ type: "sql_error", error: String(err) });
            }
            apiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          } else if (toolCall.function.name === "run_simulation") {
            let toolResult: string;
            try {
              const args = JSON.parse(toolCall.function.arguments) as {
                simulation_type: string;
                params: Record<string, unknown>;
                rationale: string;
              };
              req.log.info({ simulation_type: args.simulation_type, params: args.params }, "copilot simulation");
              sendEvent({ type: "simulation_start", simulation_type: args.simulation_type, rationale: args.rationale ?? "Running OPF simulation..." });
              const path = args.simulation_type.replace(/_/g, "-");
              const resp = await fetch(`http://localhost:8083/${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(args.params),
                signal: AbortSignal.timeout(60_000),
              });
              if (!resp.ok) {
                const txt = await resp.text();
                throw new Error(`PyPSA engine returned ${resp.status}: ${txt.slice(0, 200)}`);
              }
              const data = await resp.json() as Record<string, unknown>;
              sendEvent({ type: "simulation_done", simulation_type: args.simulation_type, result: data });
              toolResult = JSON.stringify(data);
            } catch (err) {
              toolResult = JSON.stringify({ error: String(err) });
              sendEvent({ type: "simulation_error", error: String(err) });
            }
            apiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          }
        }
        toolRounds++;
      } else {
        break;
      }
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: apiMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) sendEvent({ content });
    }

    sendEvent({ done: true });
    res.end();
  } catch (err) {
    req.log.error({ err }, "chat error");
    sendEvent({ error: "Failed to generate response. Please try again." });
    res.end();
  }
});

// ─── AESO Copilot ─────────────────────────────────────────────────────────────

router.post("/aeso/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: Record<string, unknown>) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      sendEvent({ error: "messages array required" });
      res.end();
      return;
    }

    const [poolPriceStats, genMix, smpStats, supplyDemand, queueStats, assetList, aucFeedResult, msaDocsResult] = await Promise.all([
      db.execute<{ year: number; month: number; avg_price: string; max_price: string; spikes: string }>(sql`
        SELECT EXTRACT(YEAR FROM date)::int AS year, EXTRACT(MONTH FROM date)::int AS month,
               ROUND(AVG(pool_price)::numeric, 2)::text AS avg_price,
               ROUND(MAX(pool_price)::numeric, 2)::text AS max_price,
               COUNT(CASE WHEN pool_price >= 999 THEN 1 END)::text AS spikes
        FROM aeso_pool_price
        WHERE date >= NOW() - INTERVAL '12 months'
        GROUP BY year, month ORDER BY year, month
        LIMIT 24
      `),
      db.execute<{ gas_mw: string; coal_mw: string; wind_mw: string; solar_mw: string; hydro_mw: string; storage_mw: string; other_mw: string; total_mw: string }>(sql`
        SELECT
          ROUND(AVG(gas_mw)::numeric, 1)::text     AS gas_mw,
          ROUND(AVG(coal_mw)::numeric, 1)::text    AS coal_mw,
          ROUND(AVG(wind_mw)::numeric, 1)::text    AS wind_mw,
          ROUND(AVG(solar_mw)::numeric, 1)::text   AS solar_mw,
          ROUND(AVG(hydro_mw)::numeric, 1)::text   AS hydro_mw,
          ROUND(AVG(storage_mw)::numeric, 1)::text AS storage_mw,
          ROUND(AVG(other_mw)::numeric, 1)::text   AS other_mw,
          ROUND(AVG(total_mw)::numeric, 1)::text   AS total_mw
        FROM aeso_generation_mix
        WHERE date >= NOW() - INTERVAL '6 months'
      `),
      db.execute<{ year: number; month: number; avg_constrained: string; avg_unconstrained: string; avg_spread: string }>(sql`
        SELECT EXTRACT(YEAR FROM date)::int AS year, EXTRACT(MONTH FROM date)::int AS month,
               ROUND(AVG(constrained_price)::numeric, 2)::text AS avg_constrained,
               ROUND(AVG(unconstrained_price)::numeric, 2)::text AS avg_unconstrained,
               ROUND(AVG(spread)::numeric, 2)::text AS avg_spread
        FROM aeso_smp
        WHERE date >= NOW() - INTERVAL '6 months'
        GROUP BY year, month ORDER BY year, month LIMIT 12
      `),
      db.execute<{ avg_ail: string; min_ail: string; max_ail: string; avg_reserve: string; avg_available: string }>(sql`
        SELECT ROUND(AVG(ail_mw)::numeric, 0)::text             AS avg_ail,
               ROUND(MIN(ail_mw)::numeric, 0)::text             AS min_ail,
               ROUND(MAX(ail_mw)::numeric, 0)::text             AS max_ail,
               ROUND(AVG(reserve_margin_pct)::numeric, 1)::text AS avg_reserve,
               ROUND(AVG(available_capacity_mw)::numeric, 0)::text AS avg_available
        FROM aeso_supply_demand
        WHERE date >= NOW() - INTERVAL '3 months'
      `),
      db.execute<{ fuel_type: string; projects: string; total_mw: string }>(sql`
        SELECT fuel_type, COUNT(*)::text AS projects,
               ROUND(SUM(capacity_mw::float)::numeric, 0)::text AS total_mw
        FROM aeso_queue_projects WHERE capacity_mw IS NOT NULL
        GROUP BY fuel_type ORDER BY SUM(capacity_mw::float) DESC LIMIT 10
      `),
      db.execute<{ fuel_type: string; count: string; total_mw: string }>(sql`
        SELECT fuel_type, COUNT(*)::text AS count,
               ROUND(SUM(max_capability_mw::float)::numeric, 0)::text AS total_mw
        FROM aeso_asset_registry
        WHERE fuel_type IS NOT NULL
        GROUP BY fuel_type ORDER BY SUM(max_capability_mw::float) DESC LIMIT 10
      `),
      getAucFeed().catch(() => ({ items: [] as { title: string; pubDate: string; link: string; excerpt: string; categories: string[] }[], fetchedAt: new Date().toISOString(), source: "" })),
      getMsaDocs("all").catch(() => ({ docs: [] as { title: string; category: string; date: string; url: string; type: string }[], category: "all", fetchedAt: new Date().toISOString(), source: "" })),
    ]);

    const aucNewsLines = aucFeedResult.items.slice(0, 8).map(
      (it) => `  [${it.pubDate.slice(0, 16)}] ${it.title}${it.excerpt ? " — " + it.excerpt.slice(0, 120) : ""}`
    ).join("\n");

    const msaDocLines = msaDocsResult.docs.slice(0, 15).map(
      (d) => `  [${d.date.padEnd(15)}] [${d.category.slice(0, 35).padEnd(35)}] ${d.title}`
    ).join("\n");

    const systemPrompt = `You are the AESO Market Copilot — an expert AI assistant for Alberta's electricity market. You help analysts, traders, and energy professionals understand Alberta's power system, pool prices, generation mix, transmission constraints, regulatory landscape, and market dynamics.

You have full knowledge of every tab on this platform: Pool Price, Generation Mix, Supply & Demand, Outages, 7-Day Capacity, Queue, Congestion, LTA Metrics, REM, AUC, MSA, and Market Copilot. Use the run_sql tool to retrieve specific live data when needed. Always be quantitative and cite your source.

━━━ ALBERTA MARKET CONTEXT ━━━
Alberta runs an energy-only deregulated electricity market. Pool price is set hourly by the system marginal unit (merit order). Prices can spike to $999.99/MWh (price cap) during scarcity. There are no capacity payments.
Key players: AltaLink (transmission), ATCO Electric (transmission), ENMAX, Capital Power, TransAlta, Heartland Generation, Cenovus, Shell, EDF, etc.
BC intertie: ~1,200 MW import / 1,800 MW export rated capacity. SK intertie: ~153 MW each way.
SMP (System Marginal Price) = unconstrained market clearing price. Pool Price > SMP = congestion rent.

━━━ DATABASE SCHEMA ━━━
TABLE aeso_pool_price  — hourly Alberta pool price
  date DATE, hour_ending INT, pool_price NUMERIC,
  rolling_30d_avg NUMERIC, day_ahead_forecast_price NUMERIC

TABLE aeso_actual_forecast  — AIL + price forecasts vs actuals
  date DATE, hour_ending INT, actual_pool_price NUMERIC, forecast_pool_price NUMERIC,
  actual_ail_mw NUMERIC, forecast_ail_mw NUMERIC,
  actual_wind_mw NUMERIC, forecast_wind_mw NUMERIC,
  actual_solar_mw NUMERIC, forecast_solar_mw NUMERIC

TABLE aeso_generation_mix  — hourly generation by fuel (wide format, one row per hour)
  date DATE, hour_ending INT,
  gas_mw NUMERIC, coal_mw NUMERIC, wind_mw NUMERIC, solar_mw NUMERIC,
  hydro_mw NUMERIC, storage_mw NUMERIC, other_mw NUMERIC, total_mw NUMERIC

TABLE aeso_supply_demand  — system-wide supply/demand snapshot
  date DATE, hour_ending INT, ail_mw NUMERIC, available_capacity_mw NUMERIC,
  reserve_margin_pct NUMERIC, net_interchange_mw NUMERIC,
  bc_interchange_mw NUMERIC, sk_interchange_mw NUMERIC

TABLE aeso_smp  — system marginal price (congestion indicator)
  date DATE, hour_ending INT, constrained_price NUMERIC, unconstrained_price NUMERIC,
  spread NUMERIC, volume_mw NUMERIC
  -- spread > 0 means congestion rent; negative spread is unusual/rare

TABLE aeso_merit_order  — hourly supply stack (offer blocks per generator)
  date DATE, hour_ending INT, merit_order_rank INT,
  asset_id TEXT, asset_name TEXT, pool_participant_id TEXT, fuel_type TEXT,
  block_mw NUMERIC, offer_price NUMERIC, dispatched_mw NUMERIC,
  cumulative_mw NUMERIC, is_marginal BOOLEAN

TABLE aeso_interchange  — BC/SK actual + scheduled flows
  date DATE, hour_ending INT, intertie_or_flowgate TEXT,
  transfer_type TEXT, data_type TEXT,
  scheduled_mw NUMERIC, actual_mw NUMERIC, net_mw NUMERIC

TABLE aeso_intertie_outage  — BC/SK flowgate outages
  date DATE, hour_ending INT, intertie_or_flowgate TEXT,
  outage_mw NUMERIC, available_transfer_mw NUMERIC, outage_type TEXT

TABLE aeso_unit_commitment  — generator commitment schedules
  date DATE, hour_ending INT, asset_id TEXT, fuel_type TEXT,
  committed_mw NUMERIC, dispatched_mw NUMERIC, available_mw NUMERIC, must_run BOOLEAN

TABLE aeso_operating_reserve  — FFR, spinning, contingency reserve offers
  date DATE, hour_ending INT, reserve_type TEXT, offered_mw NUMERIC,
  clearing_price NUMERIC, required_mw NUMERIC, shortfall_mw NUMERIC

TABLE aeso_metered_volume  — actual generator output (metered)
  date DATE, hour_ending INT, asset_id TEXT, pool_participant_id TEXT,
  fuel_type TEXT, metered_volume_mwh NUMERIC

TABLE aeso_asset_registry  — AIES registered generation assets
  asset_id TEXT, asset_name TEXT, pool_participant_id TEXT, pool_participant_name TEXT,
  fuel_type TEXT, sub_fuel_type TEXT, max_capability_mw NUMERIC,
  location TEXT, region TEXT, status TEXT, online_date DATE

TABLE aeso_pool_participants  — registered market participants
  pool_participant_id TEXT, pool_participant_name TEXT

TABLE aeso_queue_projects  — Alberta interconnection queue
  project_name TEXT, fuel_type TEXT, capacity_mw NUMERIC, status TEXT,
  region TEXT, queue_date DATE

TABLE aeso_generation_outage  — AIES unit outage tracking
  date DATE, hour_ending INT, asset_type TEXT, outage_mw NUMERIC,
  available_mw NUMERIC, planned_outage_mw NUMERIC, forced_outage_mw NUMERIC

TABLE aeso_7day_capability  — 7-day ahead generation capability forecast
  date DATE, hour_ending INT, fuel_type TEXT, capability_mw NUMERIC

TABLE aeso_transmission_corridors  — key AB transmission corridors
  corridor_name TEXT, from_region TEXT, to_region TEXT, rating_mw NUMERIC,
  congestion_frequency_pct NUMERIC

━━━ LIVE POOL PRICE (last 12 months, monthly) ━━━
${poolPriceStats.rows.map(r => `  ${r.year}-${String(r.month).padStart(2, "0")}  avg=$${r.avg_price}  max=$${r.max_price}  spikes=${r.spikes}`).join("\n")}

━━━ GENERATION MIX (last 6 months avg) ━━━
${(() => {
  const g = genMix.rows[0];
  if (!g) return "  (no data)";
  const tot = parseFloat(g.total_mw) || 1;
  return [
    ["gas",     g.gas_mw],
    ["coal",    g.coal_mw],
    ["wind",    g.wind_mw],
    ["solar",   g.solar_mw],
    ["hydro",   g.hydro_mw],
    ["storage", g.storage_mw],
    ["other",   g.other_mw],
  ].map(([name, mw]) => `  ${String(name).padEnd(10)} ${String(mw).padStart(7)} MW  ${(parseFloat(String(mw)) * 100 / tot).toFixed(1)}%`).join("\n");
})()}

━━━ SMP CONGESTION RENT (last 6 months) ━━━
${smpStats.rows.map(r => `  ${r.year}-${String(r.month).padStart(2, "0")}  constrained=$${r.avg_constrained}  SMP=$${r.avg_unconstrained}  spread=$${r.avg_spread}`).join("\n")}

━━━ SUPPLY/DEMAND (last 90 days) ━━━
  Avg AIL: ${supplyDemand.rows[0]?.avg_ail ?? "—"} MW  |  Range: ${supplyDemand.rows[0]?.min_ail ?? "—"}–${supplyDemand.rows[0]?.max_ail ?? "—"} MW  |  Avg Available Capacity: ${supplyDemand.rows[0]?.avg_available ?? "—"} MW  |  Avg Reserve Margin: ${supplyDemand.rows[0]?.avg_reserve ?? "—"}%

━━━ INTERCONNECTION QUEUE (by fuel type) ━━━
${queueStats.rows.map(r => `  ${r.fuel_type.padEnd(14)} ${r.projects.padStart(4)} projects  ${r.total_mw.padStart(8)} MW`).join("\n")}

━━━ AIES ASSET REGISTRY (by fuel type) ━━━
${assetList.rows.map(r => `  ${r.fuel_type.padEnd(16)} ${r.count.padStart(4)} assets  ${r.total_mw.padStart(8)} MW`).join("\n")}

━━━ RENEWABLE ELECTRICITY MARKET (REM TAB) ━━━
What it is: AESO-run competitive auction program procuring long-term renewable electricity under 20-year Contracts for Difference (CFDs) with the Balancing Pool. No capacity payments — purely energy-based settlements.

How it works: Developers bid their levelized cost; lowest bids win. CFD mechanics: if pool price < strike price, Balancing Pool tops up to the developer; if pool price > strike price, developer pays back the surplus. Net effect: developer earns a stable, fixed real price regardless of pool volatility.

Auction history:
  - REM 1 (Feb 2019): 12 projects, ~597 MW solar+wind, avg strike ~$37/MWh. All projects now fully online.
  - REM 2 (Dec 2021): 19 projects, ~1,313 MW (solar dominant), avg ~$38–42/MWh. Mostly online 2023–2024.
  - REM 3 (2023): planned but delayed by the government moratorium; status ongoing.
  - Government direction shift (2024 Electricity Statutes Amendment Act): removed Balancing Pool from future REMs. Policy direction under review by UCP government.

Moratorium: Alberta govt paused all new wind + solar AUC approvals Jun 2023 – Mar 2024 for regional planning and visual impact reviews. Lifted Mar 2024 with new REA (Renewable Energy Act) setback and visual assessment requirements. Pipeline resumed but large backlog exists.

Key buyer mechanics for large C&I customers:
  - VPPA (Virtual PPA): fixed strike agreed with a developer; developer sells at pool price and the two parties cash-settle the difference. No physical delivery, no market participation licence required.
  - CPPA (Corporate PPA): physical delivery requires AESO market participant registration and scheduling agent. Higher complexity.
  - Slice-of-plant arrangement: buyer takes a percentage of project output under a long-term agreement; project developer retains pool price exposure for the rest.
  - 20-year contracts carry significant credit and collateral requirements (typically parent guarantee or LC).

Project characteristics:
  - Solar: dominant in southern Alberta (Lethbridge, Vulcan, Forty Mile counties). ~2,200 kWh/m²/yr irradiance. Peak output mid-day conflicts with peak pool price window → basis risk.
  - Wind: southern foothills (Pincher Creek, Crowsnest Pass, Cardston) and central AB. Strong capacity factors 35–45%.
  - Basis risk: at high renewable output, pool price in southern AB depresses below AECO hub price → negative basis vs strike.
  - Typical project size: 100–400 MW solar, 100–300 MW wind.

Current government target: 30% renewable energy by 2030. Longer-term clean electricity roadmap under review.

━━━ ALBERTA UTILITIES COMMISSION (AUC TAB) ━━━
Role: Quasi-judicial independent regulator for Alberta electricity, natural gas, and water utilities. Regulates wires, pipes, rates, and project approvals — does NOT set pool prices or dispatch (that is AESO's role).

Key mandates:
  - Approve all generation projects ≥1 MW (Rule 007): typical timeline 6–18 months; may hold oral hearing if public opposition or complexity warrants.
  - Approve all transmission and distribution infrastructure (Rule 007, 012).
  - Set regulated utility rates via Performance-Based Regulation (PBR) or cost-of-service hearings.
  - Approve gas distribution rates (ATCO Gas, FortisBC, etc.).
  - Enforce compliance with AUC Rules and Orders; can impose penalties.

Key AUC Rules (select):
  - Rule 001: Rules of Practice (procedural rules for AUC proceedings)
  - Rule 007: Applications for Power Plants and Substations (generation ≥1 MW, transmission)
  - Rule 012: Noise Control (wind turbines, industrial facilities)
  - Rule 021: Settlement System Code Rules (billing, metering)
  - Rule 028: Micro-Generation — ≤5 MW renewable or cogen connected at distribution level; simplified process, no oral hearing, 4–8 weeks, net metering credits at distribution tariff rate. Cannot participate in wholesale market; for wholesale pool participation ≥1 MW full Rule 007 approval required.
  - Rule 033: Formula Rate Adjustment (FRA) for pipeline tolls

Regulated entities: AltaLink (transmission, ~$1.7B/yr), ATCO Electric (transmission), ENMAX Distribution (Edmonton), EPCOR (other AB distribution), FortisAlberta (rural distribution), ATCO Gas (gas distribution).

Rate setting: Utility files application → AUC review (written or full hearing) → Decision + Order → rates effective on approval date. Major general rate applications take 12–24 months. PBR utilities file annual efficiency carry-over and X-factor filings. Default Rate of Gas (DRG): quarterly commodity rate set by AUC based on AECO C spot price + utility margin.

eFiling: all AUC filings are public and searchable at www2.auc.ab.ca. Decisions, Orders, and hearing transcripts are publicly available.

Micro-generation facts: ≤5 MW, must be renewable or cogeneration, connected behind distribution meter. Net metering credits roll over month-to-month. No wholesale market participation allowed. Approved in 4–8 weeks vs 6–18 months for Rule 007.

${aucNewsLines ? `━━━ AUC RECENT NEWS (live from auc.ab.ca, cached ${new Date(aucFeedResult.fetchedAt).toLocaleDateString()}) ━━━\n${aucNewsLines}` : ""}

━━━ MARKET SURVEILLANCE ADMINISTRATOR (MSA TAB) ━━━
Role: Independent agency (not part of AESO or government) that monitors Alberta's electricity and retail natural gas markets for fair, efficient, and openly competitive operation. Investigates market power abuse, ISO rule violations, and anti-competitive behaviour.

Key activities:
  - Publishes Quarterly Wholesale Market Reports: pool price analysis, pivotality index, Lerner Index, curtailment, congestion patterns.
  - Issues Non-Specified Penalty (NSP) notices for ISO Rule and Reliability Standards violations. Recent example: MSA RS2025-169 (Reliability Standards, June 2026).
  - Annual Report to the Minister of Affordability and Utilities (most recent: 2025 Annual Report, published Apr 30, 2026).
  - Q1 2026 Wholesale Market Report published May 14, 2026.

Market power concepts (key MSA metrics):
  - Pivotality: a generator is "pivotal" when the market cannot clear without it → signals market power risk in tight conditions.
  - Lerner Index: (Price − SRMC) / Price — measures how much the clearing price exceeds competitive marginal cost.
  - SRMC counterfactual: MSA's modelled estimate of what the pool price would be without market power exercise.
  - Static Inefficiency: estimated dead-weight welfare loss from market power, expressed in $/MWh-equivalent.
  - HHI (Herfindahl-Hirschman Index): measures market concentration by fuel type and region.

MSA Data Portal (data.albertamsa.ca) — free, no authentication:
  - Market Power Data: pivotality, Lerner Index, SRMC counterfactual, Static Inefficiency (hourly + monthly)
  - Enforcement Data: ISO Outcomes, ARS Outcomes, NSP records
  - Retail Data: Fixed Rates, Risk-Free Expected Cost, monthly Retail Statistics XLSX
  - Carbon Emissions: HAEI (Hourly Alberta Emissions Intensity) and HMEI (Hourly Marginal Emissions Intensity) datasets

Retail market: MSA monitors ~3.2M retail electricity consumers. Publishes monthly Retail Statistics XLSX with fixed vs floating rates, default regulated rate (DRR), and retailer market share. Oversees Rate of Last Resort (RoLR) and Deferral Account Statements (DAS) for municipal utilities. Monitors retail natural gas under ERCB/MSA mandate.

Relationship to AUC: MSA monitors competitive market behaviour; AUC regulates regulated utilities and project approvals. They are separate, independent bodies. AESO is the independent system operator (neither MSA nor AUC).

${msaDocLines ? `━━━ MSA RECENT DOCUMENTS (live from albertamsa.ca, cached ${new Date(msaDocsResult.fetchedAt).toLocaleDateString()}) ━━━\n${msaDocLines}` : ""}

━━━ GUIDANCE ━━━
- run_sql for: pool price time-series, merit order stack at a specific hour, SMP spread trends, operating reserve shortfalls, generator commitment patterns, intertie utilization, specific asset performance, queue breakdowns.
- Answer REM questions from the REM section above — no SQL needed (no REM data in DB; it is policy/auction content).
- Answer AUC questions from the AUC section + live news items above. Direct users to www2.auc.ab.ca for filing searches.
- Answer MSA questions from the MSA section + live document list above. Direct users to data.albertamsa.ca for the Data Portal.
- Prices in $/MWh. Pool price is hourly. $999.99 = price cap (scarcity event).
- When asked about congestion: check aeso_smp.spread and aeso_intertie_outage tables.
- For supply stack analysis: use aeso_merit_order (offer_price, cumulative_mw, is_marginal).
- Format responses with clear headers and bullet points. Always cite the data source (AESO API, AUC, MSA, or DB table name).`;

    const tools: Parameters<typeof openai.chat.completions.create>[0]["tools"] = [
      {
        type: "function",
        function: {
          name: "run_sql",
          description: "Execute a read-only SELECT query against the AESO PostgreSQL database.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "A valid PostgreSQL SELECT statement with LIMIT ≤300." },
              rationale: { type: "string", description: "One-line reason shown to the user while querying." },
            },
            required: ["query", "rationale"],
          },
        },
      },
    ];

    const apiMessages: Parameters<typeof openai.chat.completions.create>[0]["messages"] = [
      { role: "system", content: systemPrompt },
      ...(messages as Parameters<typeof openai.chat.completions.create>[0]["messages"]),
    ];

    const MAX_TOOL_ROUNDS = 4;
    let toolRounds = 0;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      const response = await openai.chat.completions.create({
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        messages: apiMessages,
        tools,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        apiMessages.push(choice.message);
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.function.name === "run_sql") {
            let toolResult: string;
            try {
              const args = JSON.parse(toolCall.function.arguments) as { query: string; rationale: string };
              req.log.info({ query: args.query }, "aeso copilot sql");
              sendEvent({ type: "sql_query", rationale: args.rationale ?? "Querying AESO data..." });
              const result = await runSafeQuery(args.query);
              sendEvent({ type: "sql_done", rows: result.rows.length });
              const displayRows = result.rows.slice(0, TABLE_DISPLAY_LIMIT);
              sendEvent({ type: "table", columns: result.columns, rows: displayRows, totalRows: result.rows.length });
              if (result.columns.length >= 2 && isTimeSeries(result.columns)) {
                sendEvent({ type: "chart", chartType: "timeseries", columns: result.columns, rows: displayRows });
              }
              toolResult = JSON.stringify({ rows: result.rows, count: result.rows.length });
            } catch (err) {
              toolResult = JSON.stringify({ error: String(err) });
              sendEvent({ type: "sql_error", error: String(err) });
            }
            apiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          }
        }
        toolRounds++;
      } else {
        break;
      }
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: apiMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) sendEvent({ content });
    }

    sendEvent({ done: true });
    res.end();
  } catch (err) {
    req.log.error({ err }, "aeso chat error");
    sendEvent({ error: "Failed to generate response. Please try again." });
    res.end();
  }
});

export default router;
