import { Router } from "express";
import { db } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { sql } from "drizzle-orm";

const router = Router();

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
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages array required" });
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

You have a live PostgreSQL database with real market data. Use the run_sql tool when you need specific data not already shown below.

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
- run_sql for: filtering candidates by criteria, node price history, congestion event counts, DA-RT spread analysis, queue depth by zone, within-zone resource node comparisons, time-series trends
- All prices in $/MWh. neg_price_percent = % of monthly intervals with price < $0.
- Congestion risk ↑ when volatility is high and DA-RT spreads are wide.
- Curtailment risk ↑ when neg_price_percent is high (ERCOT wind LZ_WEST ~7-22%, solar worse).
- Basis risk = DA-RT settlement spread + volatility at the project's delivery node.
- Be quantitative and cite the data source (CDR 13060/13061 for ERCOT, OASIS for CAISO).`;

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
                description: "One-line reason for the query",
              },
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

    const MAX_TOOL_ROUNDS = 3;
    let toolRounds = 0;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 2048,
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
              req.log.info({ query: args.query }, "copilot sql query");
              const result = await runSafeQuery(args.query);
              toolResult = JSON.stringify({ rows: result.rows, count: result.rows.length });
            } catch (err) {
              toolResult = JSON.stringify({ error: String(err) });
            }
            apiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult });
          }
        }
        toolRounds++;
      } else {
        break;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2048,
      messages: apiMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "chat error");
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ error: "Failed to generate response" })}\n\n`);
    res.end();
  }
});

export default router;
