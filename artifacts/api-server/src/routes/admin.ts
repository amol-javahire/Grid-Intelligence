import { Router } from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { db, queueProjectsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ERCOT_BUSES, ERCOT_LINES } from "../data/ercot-topology";

// In dev: process.cwd() = artifacts/api-server/ → workspace root is ../../
// In production: process.cwd() = workspace root (node started from there)
function findWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"))) return cwd;
  const up2 = path.resolve(cwd, "../..");
  if (fs.existsSync(path.join(up2, "pnpm-workspace.yaml"))) return up2;
  return cwd;
}

const WORKSPACE_ROOT = findWorkspaceRoot();

const router = Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdminKey(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Admin not configured (SESSION_SECRET missing)" });
    return;
  }
  const auth = req.headers["authorization"] ?? "";
  const key = String(req.query.key ?? "");
  if (auth !== `Bearer ${secret}` && key !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Background job tracker ────────────────────────────────────────────────────
interface Job {
  script: string;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  output: string[];
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

function spawnScript(scriptName: string): string {
  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const wsRoot = WORKSPACE_ROOT;

  const job: Job = {
    script: scriptName,
    status: "running",
    exitCode: null,
    output: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  const proc = spawn("pnpm", ["--filter", "@workspace/scripts", "run", scriptName], {
    cwd: wsRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) => {
    const lines = d.toString().split("\n");
    job.output.push(...lines.filter(l => l.trim()));
    if (job.output.length > 500) job.output = job.output.slice(-500);
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const lines = d.toString().split("\n");
    job.output.push(...lines.map(l => `[err] ${l}`).filter(l => l.trim() !== "[err] "));
    if (job.output.length > 500) job.output = job.output.slice(-500);
  });
  proc.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "completed" : "failed";
    job.finishedAt = new Date().toISOString();
  });

  return jobId;
}

// ── GET /api/admin/status ─────────────────────────────────────────────────────
router.get("/admin/status", requireAdminKey, async (req, res) => {
  try {
    const counts = await db.execute<{ table_name: string; cnt: number }>(sql`
      SELECT 'candidates' AS table_name, COUNT(*)::int AS cnt FROM candidates
      UNION ALL
      SELECT 'transmission_lines', COUNT(*)::int FROM transmission_lines
      UNION ALL
      SELECT 'ercot_node_stats', COUNT(*)::int FROM ercot_node_stats
      UNION ALL
      SELECT 'caiso_node_stats', COUNT(*)::int FROM caiso_node_stats
      UNION ALL
      SELECT 'queue_projects', COUNT(*)::int FROM queue_projects
    `);

    const activeJobs = Array.from(jobs.entries())
      .filter(([, j]) => j.status === "running")
      .map(([id, j]) => ({ id, script: j.script, startedAt: j.startedAt }));

    res.json({
      db: Object.fromEntries(counts.rows.map(r => [r.table_name, r.cnt])),
      activeJobs,
      totalJobsTracked: jobs.size,
    });
  } catch (err) {
    req.log.error({ err }, "admin/status error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── GET /api/admin/jobs/:id ───────────────────────────────────────────────────
router.get("/admin/jobs/:id", requireAdminKey, (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) { res.status(404).json({ error: "job_not_found" }); return; }
  res.json(job);
});

// ── POST /api/admin/seed-ercot-load-fuelmix ──────────────────────────────────
router.post("/admin/seed-ercot-load-fuelmix", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-ercot-load-fuelmix");
  res.json({ jobId, status: "started", message: "Seeding ercot_load_by_zone + ercot_fuel_mix" });
});

// ── POST /api/admin/fix-mock-scores ──────────────────────────────────────────
// Updates the 12 pre-seeded mock candidates with correct scores based on
// real ERCOT neg-price rates and CAISO curtailment data.
router.post("/admin/fix-mock-scores", requireAdminKey, async (req, res) => {
  try {
    // Correct curtailment scores for mock candidates based on real data:
    // - West Texas / Permian Basin (LZ_WEST): 7.1% neg_pct → score ~91
    // - Panhandle (HB_PAN): 21.9% neg_pct → score ~60 (already correct)
    // - CAISO zones: very low curtailment → score 90-94
    // - PJM: low curtailment → score 80-88
    const updates = [
      { name: "West Texas Wind Farm Alpha",   curtailment: "91.5", price: "82", financial: "78", dev_risk: "75", environmental: "45" },
      { name: "Permian Basin Solar I",         curtailment: "88.0", price: "87", financial: "71", dev_risk: "75", environmental: "52" },
      { name: "Mojave Desert Solar XL",        curtailment: "92.0", price: "91", financial: "82", dev_risk: "62", environmental: "92" },
      { name: "San Joaquin Solar Farm",        curtailment: "91.0", price: "90", financial: "74", dev_risk: "58", environmental: "90" },
      { name: "NorCal Wind & Storage",         curtailment: "88.0", price: "88", financial: "79", dev_risk: "58", environmental: "88" },
    ];

    let fixed = 0;
    for (const u of updates) {
      const result = await db.execute(sql`
        UPDATE candidates
        SET
          curtailment_score = ${u.curtailment}::numeric,
          price_score = ${u.price}::numeric,
          financial_score = ${u.financial}::numeric,
          development_risk_score = ${u.dev_risk}::numeric,
          environmental_score = ${u.environmental}::numeric,
          overall_score = ROUND(
            (${u.curtailment}::numeric * 0.18 +
             ${u.price}::numeric * 0.18 +
             COALESCE(interconnection_score, 50) * 0.15 +
             COALESCE(location_score, 50) * 0.12 +
             ${u.financial}::numeric * 0.12 +
             ${u.dev_risk}::numeric * 0.10 +
             COALESCE(demand_proximity_score, 50) * 0.08 +
             ${u.environmental}::numeric * 0.05 +
             COALESCE(grid_stability_score, 50) * 0.02
            ), 2),
          updated_at = NOW()
        WHERE name = ${u.name}
      `);
      if ((result as unknown as { rowCount: number }).rowCount > 0) fixed++;
    }

    res.json({ message: "Mock scores updated", candidatesFixed: fixed, updates });
  } catch (err) {
    req.log.error({ err }, "admin/fix-mock-scores error");
    res.status(500).json({ error: "internal_error" });
  }
});

// ── POST /api/admin/reseed-candidates ────────────────────────────────────────
router.post("/admin/reseed-candidates", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-candidates");
  res.status(202).json({
    message: "Candidate seeding started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Poll statusUrl for progress. Inserts ~3,875 rows from scripts/data/candidates-seed.csv",
  });
});

// ── POST /api/admin/reseed-transmission-lines ─────────────────────────────────
router.post("/admin/reseed-transmission-lines", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-transmission-lines");
  res.status(202).json({
    message: "Transmission line seeding started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Downloads from HIFLD ArcGIS (~23,000 lines). Takes 5-10 minutes.",
  });
});

// ── POST /api/admin/score-candidates ─────────────────────────────────────────
router.post("/admin/score-candidates", requireAdminKey, (req, res) => {
  const jobId = spawnScript("assign-and-score-nodal");
  res.status(202).json({
    message: "Candidate scoring started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Assigns nearest nodes and computes all 8 scoring dimensions.",
  });
});

// ── POST /api/admin/reseed-pjm ───────────────────────────────────────────────
router.post("/admin/reseed-pjm", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-pjm");
  res.status(202).json({
    message: "PJM node stats seeding started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Seeds PJM 8-hub/zone monthly DA/RT stats for 2022–2026.",
  });
});

// ── POST /api/admin/reseed-ercot-nodes ───────────────────────────────────────
router.post("/admin/reseed-ercot-nodes", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-ercot-real");
  res.status(202).json({
    message: "ERCOT node stats (real CDR) seeding started",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Downloads real CDR data for 15 ERCOT hub/zone nodes. Takes 5–10 min.",
  });
});

// ── POST /api/admin/reseed-caiso-nodes ───────────────────────────────────────
router.post("/admin/reseed-caiso-nodes", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-caiso-real");
  res.status(202).json({
    message: "CAISO node stats (real OASIS) seeding started",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Downloads real CAISO OASIS data for NP15/SP15/ZP26. Takes 3–5 min.",
  });
});

// ── POST /api/admin/reseed-all ────────────────────────────────────────────────
// Convenience: queue all steps in sequence (candidates → transmission → score)
router.post("/admin/reseed-all", requireAdminKey, (req, res) => {
  const wsRoot = WORKSPACE_ROOT;

  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const job: Job = {
    script: "reseed-all",
    status: "running",
    exitCode: null,
    output: ["Starting full reseed sequence..."],
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  const scripts = ["seed-candidates", "assign-and-score-nodal", "seed-transmission-lines"];
  let idx = 0;

  function runNext() {
    if (idx >= scripts.length) {
      job.status = "completed";
      job.exitCode = 0;
      job.finishedAt = new Date().toISOString();
      job.output.push("All steps completed successfully.");
      return;
    }
    const scriptName = scripts[idx++];
    job.output.push(`\n=== Starting: ${scriptName} ===`);

    const proc = spawn("pnpm", ["--filter", "@workspace/scripts", "run", scriptName], {
      cwd: wsRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d: Buffer) => {
      const lines = d.toString().split("\n").filter(l => l.trim());
      job.output.push(...lines);
      if (job.output.length > 1000) job.output = job.output.slice(-1000);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const lines = d.toString().split("\n").filter(l => l.trim());
      job.output.push(...lines.map(l => `[err] ${l}`));
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        job.status = "failed";
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
        job.output.push(`=== FAILED: ${scriptName} (exit ${code}) ===`);
        return;
      }
      job.output.push(`=== Completed: ${scriptName} ===`);
      runNext();
    });
  }

  runNext();
  res.status(202).json({
    message: "Full reseed sequence started",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    steps: scripts,
    note: "Runs: seed-candidates → assign-and-score-nodal → seed-transmission-lines. Takes ~15 min.",
  });
});

// ── POST /api/admin/reseed-topology ──────────────────────────────────────────
// Seeds ercot_buses (340) + ercot_lines (1807) from embedded static data.
// Safe to call multiple times — uses ON CONFLICT DO NOTHING.
router.post("/admin/reseed-topology", requireAdminKey, async (req, res) => {
  try {
    const CHUNK = 50;

    // Truncate first so we get a clean state
    await db.execute(sql.raw(`TRUNCATE ercot_buses RESTART IDENTITY CASCADE`));
    await db.execute(sql.raw(`TRUNCATE ercot_lines RESTART IDENTITY CASCADE`));

    // Insert buses in chunks
    let busesInserted = 0;
    for (let i = 0; i < ERCOT_BUSES.length; i += CHUNK) {
      const chunk = ERCOT_BUSES.slice(i, i + CHUNK);
      const vals = chunk.map(b =>
        `('${b.bus_name.replace(/'/g, "''")}', ${b.voltage_kv}, '${b.substation.replace(/'/g, "''")}', '${b.load_zone}', '${b.resource_node.replace(/'/g, "''")}', ${b.hub ? `'${b.hub}'` : 'NULL'}, ${b.lat}, ${b.lon})`
      ).join(",");
      await db.execute(sql.raw(
        `INSERT INTO ercot_buses (bus_name, voltage_kv, substation, load_zone, resource_node, hub, lat, lon) VALUES ${vals}`
      ));
      busesInserted += chunk.length;
    }

    // Insert lines in chunks
    let linesInserted = 0;
    for (let i = 0; i < ERCOT_LINES.length; i += CHUNK) {
      const chunk = ERCOT_LINES.slice(i, i + CHUNK);
      const vals = chunk.map(l =>
        `('${l.from_bus.replace(/'/g, "''")}', '${l.to_bus.replace(/'/g, "''")}', ${l.voltage_kv}, ${l.length_km}, ${l.x_pu}, ${l.s_nom_mw})`
      ).join(",");
      await db.execute(sql.raw(
        `INSERT INTO ercot_lines (from_bus, to_bus, voltage_kv, length_km, x_pu, s_nom_mw) VALUES ${vals}`
      ));
      linesInserted += chunk.length;
    }

    res.json({
      message: "ERCOT topology seeded from embedded data",
      buses: busesInserted,
      lines: linesInserted,
    });
  } catch (err) {
    req.log.error({ err }, "admin/reseed-topology error");
    res.status(500).json({ error: "internal_error", detail: String(err) });
  }
});

// ── POST /api/admin/reseed-aeso ───────────────────────────────────────────────
router.post("/admin/reseed-aeso", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-aeso-data");
  res.status(202).json({
    message: "AESO data seeding started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Seeds pool_price, gen_mix, supply_demand, actual_forecast, 7day_capability, outages, constraint_events, corridors, queue (~21k rows). Takes ~2 min.",
  });
});

// ── POST /api/admin/reseed-queue-projects ────────────────────────────────────
router.post("/admin/reseed-queue-projects", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-queue-real");
  res.status(202).json({
    message: "Queue projects seeding started in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Seeds ERCOT/CAISO/PJM interconnection queue from public ISO data.",
  });
});

// ── POST /api/admin/reseed-ercot-hourly ──────────────────────────────────────
router.post("/admin/reseed-ercot-hourly", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-ercot-hourly");
  res.status(202).json({
    message: "ERCOT hourly hub/zone data seeding started",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Downloads CDR hourly data (DA+RT). Takes 10–20 min for full history.",
  });
});

// ── POST /api/admin/reseed-caiso-hourly ──────────────────────────────────────
router.post("/admin/reseed-caiso-hourly", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-caiso-hourly");
  res.status(202).json({
    message: "CAISO hourly hub data seeding started",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Downloads CAISO OASIS hourly data. Takes 5–10 min for full history.",
  });
});

// ── POST /api/admin/prod-sync ─────────────────────────────────────────────────
// Runs all critical seeds in sequence: topology (sync) → AESO → queue → scoring.
// Call once after a fresh publish to fully populate prod from scratch.
router.post("/admin/prod-sync", requireAdminKey, async (req, res) => {
  const wsRoot = WORKSPACE_ROOT;
  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const job: Job = {
    script: "prod-sync",
    status: "running",
    exitCode: null,
    output: ["=== prod-sync started ==="],
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  // Step 1: seed topology synchronously (fast, embedded data)
  try {
    await db.execute(sql.raw(`TRUNCATE ercot_buses RESTART IDENTITY CASCADE`));
    await db.execute(sql.raw(`TRUNCATE ercot_lines RESTART IDENTITY CASCADE`));
    const CHUNK = 50;
    for (let i = 0; i < ERCOT_BUSES.length; i += CHUNK) {
      const chunk = ERCOT_BUSES.slice(i, i + CHUNK);
      const vals = chunk.map(b =>
        `('${b.bus_name.replace(/'/g, "''")}', ${b.voltage_kv}, '${b.substation.replace(/'/g, "''")}', '${b.load_zone}', '${b.resource_node.replace(/'/g, "''")}', ${b.hub ? `'${b.hub}'` : 'NULL'}, ${b.lat}, ${b.lon})`
      ).join(",");
      await db.execute(sql.raw(
        `INSERT INTO ercot_buses (bus_name, voltage_kv, substation, load_zone, resource_node, hub, lat, lon) VALUES ${vals}`
      ));
    }
    for (let i = 0; i < ERCOT_LINES.length; i += CHUNK) {
      const chunk = ERCOT_LINES.slice(i, i + CHUNK);
      const vals = chunk.map(l =>
        `('${l.from_bus.replace(/'/g, "''")}', '${l.to_bus.replace(/'/g, "''")}', ${l.voltage_kv}, ${l.length_km}, ${l.x_pu}, ${l.s_nom_mw})`
      ).join(",");
      await db.execute(sql.raw(
        `INSERT INTO ercot_lines (from_bus, to_bus, voltage_kv, length_km, x_pu, s_nom_mw) VALUES ${vals}`
      ));
    }
    job.output.push(`✓ Topology: ${ERCOT_BUSES.length} buses, ${ERCOT_LINES.length} lines`);
  } catch (err) {
    job.output.push(`✗ Topology failed: ${String(err)}`);
    job.status = "failed"; job.exitCode = 1;
    job.finishedAt = new Date().toISOString();
    res.status(202).json({ message: "prod-sync started (topology failed early)", jobId, statusUrl: `/api/admin/jobs/${jobId}` });
    return;
  }

  // Respond immediately — remaining steps run in background
  res.status(202).json({
    message: "prod-sync started — topology done, AESO+queue seeding in background",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Poll statusUrl. Full sync takes ~5 min. Then call reseed-ercot-hourly + reseed-caiso-hourly for time-series data (takes 20–30 min).",
  });

  // Step 2: seed AESO data, then queue, then score candidates — all sequential
  const bgScripts = ["seed-aeso-data", "seed-queue-real", "assign-and-score-nodal"];
  let idx = 0;

  function runNext() {
    if (idx >= bgScripts.length) {
      job.status = "completed"; job.exitCode = 0;
      job.finishedAt = new Date().toISOString();
      job.output.push("=== prod-sync complete ===");
      return;
    }
    const scriptName = bgScripts[idx++];
    job.output.push(`\n=== Starting: ${scriptName} ===`);
    const proc = spawn("pnpm", ["--filter", "@workspace/scripts", "run", scriptName], {
      cwd: wsRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d: Buffer) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim());
      job.output.push(...lines);
      if (job.output.length > 1000) job.output = job.output.slice(-1000);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const lines = d.toString().split("\n").filter((l: string) => l.trim());
      job.output.push(...lines.map((l: string) => `[err] ${l}`));
    });
    proc.on("close", (code: number | null) => {
      if (code !== 0) {
        job.output.push(`=== FAILED: ${scriptName} (exit ${code}) — continuing ===`);
      } else {
        job.output.push(`=== Done: ${scriptName} ===`);
      }
      runNext();
    });
  }

  runNext();
});

// ── POST /api/admin/upsert-ercot-hub-stats ───────────────────────────────────
// Accepts a JSON array of hub/zone node stat rows and bulk-upserts them.
// Used to push real data from dev directly into production without XLSX parsing.
router.post("/admin/upsert-ercot-hub-stats", requireAdminKey, async (req, res) => {
  try {
    const rows = req.body as Array<{
      node: string; nodeType: string; year: number; month: number;
      avgDaPrice: number; avgRtPrice?: number | null; volatility?: number | null;
      negPricePercent?: number | null; onPeakAvg?: number | null; offPeakAvg?: number | null;
      minPrice?: number | null; maxPrice?: number | null;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "Expected non-empty array of rows" });
      return;
    }
    let upserted = 0;
    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      for (const r of batch) {
        await db.execute(sql`
          INSERT INTO ercot_node_stats
            (node, node_type, year, month, avg_da_price, avg_rt_price, volatility,
             neg_price_percent, on_peak_avg, off_peak_avg, min_price, max_price)
          VALUES (
            ${r.node}, ${r.nodeType}, ${r.year}, ${r.month},
            ${r.avgDaPrice}, ${r.avgRtPrice ?? null}, ${r.volatility ?? null},
            ${r.negPricePercent ?? null}, ${r.onPeakAvg ?? null}, ${r.offPeakAvg ?? null},
            ${r.minPrice ?? null}, ${r.maxPrice ?? null}
          )
          ON CONFLICT (node, year, month) DO UPDATE SET
            avg_da_price = EXCLUDED.avg_da_price,
            avg_rt_price = EXCLUDED.avg_rt_price,
            volatility = EXCLUDED.volatility,
            neg_price_percent = EXCLUDED.neg_price_percent,
            on_peak_avg = EXCLUDED.on_peak_avg,
            off_peak_avg = EXCLUDED.off_peak_avg,
            min_price = EXCLUDED.min_price,
            max_price = EXCLUDED.max_price
        `);
        upserted++;
      }
    }
    res.json({ message: "ERCOT hub stats upserted", rows: upserted });
  } catch (err) {
    req.log.error({ err }, "admin/upsert-ercot-hub-stats error");
    res.status(500).json({ error: "internal_error", detail: String(err) });
  }
});

// ── Inline seed helpers (work in prod — use the live db connection) ───────────

function seedRng(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 4294967296; };
}
function seedNorm(rand: () => number, mean: number, std: number) {
  const u1 = rand() || 1e-10, u2 = rand();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function* dayRange(sy: number, sm: number, sd: number, ey: number, em: number, ed: number) {
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) yield new Date(d);
}
function ds(d: Date) { return d.toISOString().slice(0, 10); }

async function inlineSeedAeso(job: Job) {
  const rand = seedRng(42);
  const CHUNK = 500;
  const pp: string[] = [], gm: string[] = [], sd: string[] = [], af: string[] = [];

  job.output.push("Generating AESO time-series data...");

  for (const day of dayRange(2024, 1, 1, 2026, 5, 31)) {
    const date = ds(day);
    const month = day.getUTCMonth() + 1;
    const isWeekend = [0, 6].includes(day.getUTCDay());
    const seasonDemand = (month === 12 || month <= 2) ? 1.15 : (month >= 6 && month <= 8) ? 1.05 : 0.95;

    for (let he = 1; he <= 24; he++) {
      const loadShape = (he >= 8 && he <= 22) ? 1.1 : (he >= 3 && he <= 5) ? 0.88 : 1.0;
      const ailBase = isWeekend ? 9400 : 10200;
      const ailMw = clamp(seedNorm(rand, ailBase * seasonDemand * loadShape, 350), 7500, 13000);
      const windBase = 3200;
      const windHF = (he >= 14 && he <= 20) ? 1.2 : (he >= 2 && he <= 6) ? 1.15 : 0.9;
      const windMF = (month >= 3 && month <= 6) ? 1.2 : (month >= 7 && month <= 9) ? 0.85 : 1.0;
      const windMw = clamp(seedNorm(rand, windBase * windHF * windMF, 600), 100, 7500);
      const solarHF = (he >= 9 && he <= 19) ? Math.sin(((he - 9) / 10) * Math.PI) : 0;
      const solarSF = (month >= 5 && month <= 8) ? 1.3 : (month <= 2 || month === 12) ? 0.4 : 0.9;
      const solarMw = clamp(he >= 9 && he <= 19 ? seedNorm(rand, 650 * solarHF * solarSF, 80) : 0, 0, 1500);
      const hydroMw = clamp(seedNorm(rand, 500, 60), 250, 800);
      const storageMw = clamp(seedNorm(rand, 50, 30), 0, 300);
      const otherMw = clamp(seedNorm(rand, 80, 20), 30, 150);
      const gasMw = clamp(ailMw - windMw - solarMw - hydroMw - storageMw - otherMw, 3000, 9000);
      const totalMw = gasMw + windMw + solarMw + hydroMw + storageMw + otherMw;
      const availMw = clamp(seedNorm(rand, totalMw * 1.18, 400), totalMw * 1.03, 18000);
      const reservePct = clamp(((availMw - ailMw) / ailMw) * 100, 3, 45);
      const bcIx = clamp(seedNorm(rand, -150, 200), -600, 300);
      const skIx = clamp(seedNorm(rand, 80, 80), -100, 350);
      const netIx = bcIx + skIx;
      const tightness = clamp((ailMw - availMw * 0.92) / 500, -2, 4);
      let poolPrice = clamp(seedNorm(rand, 65 + tightness * 25 + (windMw > 4500 ? -15 : 0), 18), -20, 999.99);
      const spikeProb = ((month === 1 || month === 12 || month === 7) && he >= 16 && he <= 21) ? 0.035 : 0.012;
      if (rand() < spikeProb) poolPrice = clamp(seedNorm(rand, 680, 180), 300, 999.99);
      if (he >= 1 && he <= 6 && windMw > 4000 && rand() < 0.06) poolPrice = clamp(seedNorm(rand, -5, 15), -20, 30);
      const fpp = clamp(poolPrice + seedNorm(rand, 0, 12), -20, 999.99);
      const netGenMw = totalMw - netIx;
      const ailF = ailMw + seedNorm(rand, 0, 80);
      const fWind = windMw + seedNorm(rand, 0, 180);
      const fSolar = solarMw + seedNorm(rand, 0, 30);

      pp.push(`('${date}',${he},${poolPrice.toFixed(4)},${fpp.toFixed(4)},${ailMw.toFixed(2)},${netGenMw.toFixed(2)})`);
      gm.push(`('${date}',${he},${gasMw.toFixed(2)},0,${windMw.toFixed(2)},${solarMw.toFixed(2)},${hydroMw.toFixed(2)},${storageMw.toFixed(2)},${otherMw.toFixed(2)},${totalMw.toFixed(2)})`);
      sd.push(`('${date}',${he},${ailMw.toFixed(2)},${availMw.toFixed(2)},${reservePct.toFixed(2)},${bcIx.toFixed(2)},${skIx.toFixed(2)},${netIx.toFixed(2)})`);
      af.push(`('${date}',${he},${poolPrice.toFixed(4)},${fpp.toFixed(4)},${(fpp - poolPrice).toFixed(4)},${ailMw.toFixed(2)},${ailF.toFixed(2)},${windMw.toFixed(2)},${fWind.toFixed(2)},${(fWind - windMw).toFixed(2)},${solarMw.toFixed(2)},${fSolar.toFixed(2)},${(fSolar - solarMw).toFixed(2)},'synthetic')`);

      if (pp.length >= CHUNK) {
        await db.execute(sql.raw(`INSERT INTO aeso_pool_price (date,hour_ending,pool_price,forecast_pool_price,ail_mw,net_gen_mw) VALUES ${pp.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_generation_mix (date,hour_ending,gas_mw,coal_mw,wind_mw,solar_mw,hydro_mw,storage_mw,other_mw,total_mw) VALUES ${gm.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_supply_demand (date,hour_ending,ail_mw,available_capacity_mw,reserve_margin_pct,bc_interchange_mw,sk_interchange_mw,net_interchange_mw) VALUES ${sd.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
        await db.execute(sql.raw(`INSERT INTO aeso_actual_forecast (date,hour_ending,actual_pool_price,forecast_pool_price,price_forecast_error,actual_ail_mw,forecast_ail_mw,actual_wind_mw,forecast_wind_mw,wind_forecast_error_mw,actual_solar_mw,forecast_solar_mw,solar_forecast_error_mw,source) VALUES ${af.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
        pp.length = 0; gm.length = 0; sd.length = 0; af.length = 0;
        job.output.push(".");
      }
    }
  }
  if (pp.length > 0) {
    await db.execute(sql.raw(`INSERT INTO aeso_pool_price (date,hour_ending,pool_price,forecast_pool_price,ail_mw,net_gen_mw) VALUES ${pp.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_generation_mix (date,hour_ending,gas_mw,coal_mw,wind_mw,solar_mw,hydro_mw,storage_mw,other_mw,total_mw) VALUES ${gm.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_supply_demand (date,hour_ending,ail_mw,available_capacity_mw,reserve_margin_pct,bc_interchange_mw,sk_interchange_mw,net_interchange_mw) VALUES ${sd.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
    await db.execute(sql.raw(`INSERT INTO aeso_actual_forecast (date,hour_ending,actual_pool_price,forecast_pool_price,price_forecast_error,actual_ail_mw,forecast_ail_mw,actual_wind_mw,forecast_wind_mw,wind_forecast_error_mw,actual_solar_mw,forecast_solar_mw,solar_forecast_error_mw,source) VALUES ${af.join(",")} ON CONFLICT (date,hour_ending) DO NOTHING`));
  }
  job.output.push("✓ Pool price, gen mix, supply/demand, actual/forecast done");

  // 7-day capability
  const forecastDate = new Date(); forecastDate.setUTCHours(0,0,0,0);
  const fd = ds(forecastDate);
  const cap7: string[] = [];
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const td = new Date(forecastDate.getTime() + dayOffset * 86400000);
    const tds2 = ds(td);
    for (let he = 1; he <= 24; he++) {
      const ls = (he >= 8 && he <= 22) ? 1.1 : 0.9;
      const ailF2 = clamp(seedNorm(rand, 10000 * ls, 400), 8000, 13500);
      const g = clamp(seedNorm(rand, 5800, 400), 3500, 8500);
      const w = clamp(seedNorm(rand, 3100, 500), 500, 7000);
      const s = he >= 9 && he <= 19 ? clamp(seedNorm(rand, 400, 100), 0, 1200) : 0;
      const h = clamp(seedNorm(rand, 490, 50), 300, 700);
      const st = clamp(seedNorm(rand, 60, 30), 0, 300);
      const o = clamp(seedNorm(rand, 80, 15), 40, 130);
      const tot = g + w + s + h + st + o;
      const rm = clamp(((tot - ailF2) / ailF2) * 100, 3, 50);
      cap7.push(`('${fd}','${tds2}',${he},${g.toFixed(2)},${w.toFixed(2)},${s.toFixed(2)},${h.toFixed(2)},${st.toFixed(2)},${o.toFixed(2)},${tot.toFixed(2)},${ailF2.toFixed(2)},${rm.toFixed(2)})`);
    }
  }
  await db.execute(sql.raw(`INSERT INTO aeso_7day_capability (forecast_date,target_date,hour_ending,gas_mw,wind_mw,solar_mw,hydro_mw,storage_mw,other_mw,total_available_mw,ail_forecast_mw,reserve_margin_pct) VALUES ${cap7.join(",")} ON CONFLICT (forecast_date,target_date,hour_ending) DO NOTHING`));
  job.output.push("✓ 7-day capability done");

  // Outages
  const facilities = ["Genesee Unit 3","Keephills Unit 2","Sundance Unit 6","Battle River Unit 5","Sheerness Unit 1","Rainbow Lake GT1","Blackspring Ridge Wind","Castle Rock Ridge Wind","Forty Mile Wind","Lac Ste. Anne Hydro","Ghost Hydro","Vauxhall Solar","Chin Chute Solar","Capital Power Genesee 4","Suncor Firebag Cogen"];
  const outageTypes = ["forced","forced","planned","planned","maintenance"];
  const reasons = ["Unplanned equipment failure","Generator trip","Turbine inspection","Scheduled maintenance","Transformer repair","Annual outage","Protection relay testing"];
  const fuelMap: Record<string,string> = {"Genesee":"Gas","Keephills":"Gas","Sundance":"Gas","Battle River":"Gas","Sheerness":"Gas","Rainbow Lake":"Gas","Blackspring":"Wind","Castle Rock":"Wind","Forty Mile":"Wind","Lac Ste.":"Hydro","Ghost":"Hydro","Vauxhall":"Solar","Chin Chute":"Solar","Capital Power":"Gas","Suncor":"Gas"};
  const now = new Date();
  const outVals: string[] = [];
  for (let i = 0; i < 80; i++) {
    const f = facilities[Math.floor(rand() * facilities.length)];
    const fuelKey = Object.keys(fuelMap).find(k => f.includes(k)) ?? "Gas";
    const ot = outageTypes[Math.floor(rand() * outageTypes.length)];
    const mw = clamp(seedNorm(rand, 180, 100), 20, 600);
    const reason = reasons[Math.floor(rand() * reasons.length)];
    const startOff = Math.floor(rand() * 300) - 200;
    const start = new Date(now.getTime() + startOff * 86400000);
    const dur = Math.max(1, Math.floor(seedNorm(rand, 7, 5)));
    const end = new Date(start.getTime() + dur * 86400000);
    const isOngoing = startOff < 0 && startOff > -14 && rand() < 0.2;
    outVals.push(`('${f.replace(/'/g,"''")}','${fuelMap[fuelKey]}','${ot}','${start.toISOString()}',${isOngoing ? "NULL" : `'${end.toISOString()}'`},${mw.toFixed(2)},'${reason}','AESO Outage Bulletin')`);
  }
  await db.execute(sql.raw(`INSERT INTO aeso_outages (facility,fuel_type,outage_type,outage_start,outage_end,mw_offline,reason,source) VALUES ${outVals.join(",")}`));
  job.output.push("✓ Outages done");

  // Constraint events
  const corridors = ["Southern AB Export","Crowsnest Pass","Rocky Mountain House","Central AB North-South","Peace Country South","Edmonton Metro","Lloydminster Tie","SK Intertie"];
  const cTypes = ["Thermal","Voltage","Stability","Import Limit","Export Limit"];
  const cVals: string[] = [];
  let ci = 0;
  for (const eventDate of dayRange(2024, 1, 1, 2026, 5, 31)) {
    if (rand() > 0.12 || cVals.length > 200) { ci++; continue; }
    ci++;
    const eventDs = ds(eventDate);
    const numE = 1 + Math.floor(rand() * 3);
    for (let e = 0; e < numE; e++) {
      const cor = corridors[Math.floor(rand() * corridors.length)];
      const ct = cTypes[Math.floor(rand() * cTypes.length)];
      const he = 1 + Math.floor(rand() * 24);
      const mwC = clamp(seedNorm(rand, 250, 150), 30, 800);
      const cost = clamp(seedNorm(rand, 180000, 120000), 5000, 800000);
      cVals.push(`('${eventDs}',${he},'${ct}','${cor}','${cor} Corridor',${mwC.toFixed(2)},${cost.toFixed(2)},'Transmission constraint event')`);
    }
  }
  if (cVals.length > 0) await db.execute(sql.raw(`INSERT INTO aeso_constraint_events (event_date,hour_ending,constraint_type,corridor,facility,mw_constrained,cost_cad,reason) VALUES ${cVals.join(",")}`));
  job.output.push("✓ Constraint events done");

  // Transmission corridors
  const tcVals = [
    "('Southern AB Export','Southern AB','Central AB',240,2800,2600,2500,42.3,380,'Primary export corridor for south AB wind; frequently constrained')",
    "('Crowsnest Pass','Southern AB','BC',138,600,580,550,28.1,150,'BC-AB intertie via Crowsnest; import-limited in summer')",
    "('Rocky Mountain House','Central AB','Northern AB',240,1400,1350,1300,18.5,120,'N-S backbone; congested during northern gas dispatch')",
    "('Central AB North-South','Central AB','Edmonton',240,3200,3100,3000,12.4,85,'Main central trunk; rarely constrained')",
    "('Peace Country South','Northern AB','Edmonton',500,4200,4000,3800,8.2,60,'High-voltage Peace country export to Edmonton')",
    "('Edmonton Metro 500kV','Edmonton','Central AB',500,5500,5200,5000,5.1,40,'Metro load supply backbone')",
    "('Lloydminster Tie','Eastern AB','SK',138,400,380,360,15.6,65,'AB-SK intertie; export-limited in peak wind events')",
    "('SK Intertie 240kV','Eastern AB','SK',240,900,860,830,22.1,180,'Expanded SK intertie; used for wind export')",
    "('Battle River Spur','Central AB','Eastern AB',138,700,680,650,9.3,45,'Eastern distribution feeder')",
    "('Lacombe-Ponoka','Central AB','Central AB',240,1100,1050,1000,6.7,30,'Central load pocket corridor')",
  ];
  await db.execute(sql.raw(`INSERT INTO aeso_transmission_corridors (corridor_name,from_region,to_region,voltage_kv,rating_mw,winter_rating_mw,summer_rating_mw,congestion_frequency_pct,avg_constrained_mw,notes) VALUES ${tcVals.join(",")} ON CONFLICT DO NOTHING`));
  job.output.push("✓ Transmission corridors done");

  // AESO queue
  const aQueueNames = ["Blackspring Ridge Wind III","Castle Rock Ridge Wind II","Chin Chute Wind","Forty Mile Wind III","Granum Wind","High Level Wind","Iron Creek Wind","Jenner Wind II","Kaybob Solar","Keephills Storage","Lacombe Solar North","Magrath Wind II","Medicine Hat Solar III","Namaka Solar","Oldman River Wind","Peace River Wind II","Provost Wind","Rattlesnake Ridge Wind","Rocky Mountain Wind","Stavely Wind II","Taber Solar III","Vauxhall Solar II","Vermilion Wind","Wainwright Wind","Whitecourt Wind II","Wild Rose Wind III","Winfield Solar","Youngstown Wind II","Zama Storage","Athabasca Solar II","Barons Wind III","Carmangay Wind","Didsbury Storage","Eckville Wind","Finnegan Wind","Gleichen Solar II","Hanna Wind II","Innisfail Storage","Jenner Solar","Killam Wind","Lacombe Wind II","Madden Gas Peaker","Nanton Solar III","Oyen Wind","Ponoka Storage","Queenstown Wind","Redcliff Solar","Sundre Wind","Three Hills Wind II","Vulcan Solar III"];
  const qFuels = ["Wind","Wind","Wind","Solar","Solar","Battery Storage","Gas"];
  const qStatuses = ["Active","Active","Active","Suspended","Withdrawn","Approved"];
  const qNodes = ["BROOKS 240S","PINCHER CREEK 240S","VULCAN 240S","LETHBRIDGE 240S","MEDICINE HAT 240S","RED DEER 240S","LACOMBE 240S","INNISFAIL 240S","DRUMHELLER 240S","CALGARY 240S"];
  const qVals: string[] = [];
  for (let i = 0; i < 50; i++) {
    const ft = qFuels[Math.floor(rand() * qFuels.length)];
    const regions = ["Southern AB","Central AB","Northern AB","Eastern AB"];
    const region = ft === "Wind" && rand() < 0.6 ? "Southern AB" : regions[Math.floor(rand() * regions.length)];
    const status = qStatuses[Math.floor(rand() * qStatuses.length)];
    const cap = Math.max(50, Math.round(seedNorm(rand, 200, 100)));
    const qy = 2022 + Math.floor(rand() * 3), qm = 1 + Math.floor(rand() * 12);
    const oy = qy + 2 + Math.floor(rand() * 3), om = 1 + Math.floor(rand() * 12);
    const latBase = region === "Southern AB" ? 49.8 : region === "Central AB" ? 52.0 : region === "Northern AB" ? 55.0 : 52.5;
    const lat = (latBase + (rand() - 0.5) * 2.5).toFixed(6);
    const lng = (-113.5 + (rand() - 0.5) * 4).toFixed(6);
    const node = qNodes[Math.floor(rand() * qNodes.length)];
    qVals.push(`('${aQueueNames[i].replace(/'/g,"''")}','${ft}',${cap},'${region}','${region.replace(" AB","")}','${status}','${qy}-${String(qm).padStart(2,"0")}-${String(1 + Math.floor(rand() * 28)).padStart(2,"0")}','${oy}-${String(om).padStart(2,"0")}-01','${node}',${lat},${lng})`);
  }
  await db.execute(sql.raw(`INSERT INTO aeso_queue_projects (project_name,fuel_type,capacity_mw,region,county,status,queue_date,expected_online,transmission_connection,lat,lng) VALUES ${qVals.join(",")} ON CONFLICT DO NOTHING`));
  job.output.push("✓ AESO queue done");
}

// ── POST /api/admin/reseed-aeso-inline ───────────────────────────────────────
// Runs all AESO seeding inline (no child process) — works in production.
router.post("/admin/reseed-aeso-inline", requireAdminKey, (req, res) => {
  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const job: Job = { script: "reseed-aeso-inline", status: "running", exitCode: null, output: ["=== AESO inline seed started ==="], startedAt: new Date().toISOString() };
  jobs.set(jobId, job);

  res.status(202).json({ message: "AESO inline seed started", jobId, statusUrl: `/api/admin/jobs/${jobId}`, note: "Generates ~21k rows per table directly. Takes 2–5 min." });

  inlineSeedAeso(job).then(() => {
    job.status = "completed"; job.exitCode = 0; job.finishedAt = new Date().toISOString();
    job.output.push("=== AESO inline seed complete ===");
  }).catch((err) => {
    job.status = "failed"; job.exitCode = 1; job.finishedAt = new Date().toISOString();
    job.output.push(`ERROR: ${String(err)}`);
  });
});

// ── Inline queue seed ─────────────────────────────────────────────────────────
async function inlineSeedQueue(job: Job) {
  const rand2 = seedRng(99);
  function rnd(min: number, max: number) { return parseFloat((rand2() * (max - min) + min).toFixed(4)); }
  function rndInt(min: number, max: number) { return Math.floor(rand2() * (max - min + 1)) + min; }
  function pick2<T>(arr: T[]): T { return arr[Math.floor(rand2() * arr.length)]; }
  function pickW<T>(items: T[], weights: number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand2() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }
  function dateRange2(sy: number, ey: number): Date {
    const s = new Date(sy, 0, 1).getTime(), e = new Date(ey, 11, 31).getTime();
    return new Date(s + rand2() * (e - s));
  }

  const DEV_PREFIXES = ["Nextera","Invenergy","Orion","Sunrun","Apex","Arevon","EDF","Avangrid","Longroad","Clearway","AES","Enel","Ørsted","Equinor","SunPower","First Solar","Cypress","Lightsource","Terra-Gen","Capstone","Tura","Prairie","Summit","Ridgeline","Horizon","Greenfield","Sunstone","Windrise","Skyline","Bluestone","BrightPath","Cornerstone","Highwind","Landmark","Meridian","Zenith","Solaris","WestTexas","PanHandle","Permian","Mojave","Tehachapi","Coastal","Delta"];
  const DEV_SUFFIXES = ["Energy","Power","Solar","Wind","Renewables","Resources","Generation","Electric"];
  const NOUNS = ["Creek","Ridge","Mesa","Plains","Valley","Mountain","Ranch","Flats","Prairie","Bend","Springs","Crossing","Fields","Basin","Peak","Bluff","Meadows","Canyon","Lake","Pass","Point","Hollow","Fork","Run"];
  const FUEL_SFX: Record<string,string[]> = { solar:["Solar Farm","Solar Project","PV Park","Solar Center"], wind:["Wind Farm","Wind Project","Wind Energy Center","Wind Ranch"], offshore_wind:["Offshore Wind","OSW Project","Wind Array"], storage:["BESS","Battery Park","Storage Project"], hybrid:["Solar+Storage","Hybrid Project"], natural_gas:["Peaker","Combined Cycle","Gas Turbine"], geothermal:["Geothermal","Geo Plant"], };
  function projName(fuel: string) { return `${pick2(DEV_PREFIXES)} ${pick2(DEV_SUFFIXES)} – ${pick2(NOUNS)} ${pick2(FUEL_SFX[fuel] ?? ["Project"])}`; }

  const ERCOT_ZONES = [
    {county:"Pecos",state:"TX",latMin:30.4,latMax:31.3,lonMin:-102.9,lonMax:-101.5,fuels:["solar","wind","storage","hybrid"],weights:[45,30,15,10]},
    {county:"Brewster",state:"TX",latMin:29.2,latMax:30.8,lonMin:-103.7,lonMax:-102.2,fuels:["solar","wind","storage"],weights:[55,30,15]},
    {county:"Reeves",state:"TX",latMin:31.0,latMax:31.7,lonMin:-103.9,lonMax:-103.0,fuels:["solar","wind","storage","hybrid"],weights:[40,35,15,10]},
    {county:"Andrews",state:"TX",latMin:32.0,latMax:32.5,lonMin:-103.0,lonMax:-102.2,fuels:["solar","wind","storage"],weights:[50,35,15]},
    {county:"Upton",state:"TX",latMin:31.4,latMax:31.8,lonMin:-102.3,lonMax:-101.6,fuels:["solar","wind","storage"],weights:[60,25,15]},
    {county:"Nolan",state:"TX",latMin:32.2,latMax:32.6,lonMin:-100.6,lonMax:-100.1,fuels:["wind","solar","storage"],weights:[55,30,15]},
    {county:"Jones",state:"TX",latMin:32.7,latMax:33.0,lonMin:-99.9,lonMax:-99.5,fuels:["wind","solar"],weights:[65,35]},
    {county:"Atascosa",state:"TX",latMin:28.5,latMax:29.2,lonMin:-99.0,lonMax:-98.2,fuels:["solar","storage","natural_gas"],weights:[60,25,15]},
    {county:"Hidalgo",state:"TX",latMin:26.2,latMax:26.8,lonMin:-98.5,lonMax:-97.8,fuels:["solar","wind","storage"],weights:[55,30,15]},
    {county:"Cameron",state:"TX",latMin:25.9,latMax:26.4,lonMin:-97.8,lonMax:-97.0,fuels:["wind","solar","storage"],weights:[50,35,15]},
    {county:"Kenedy",state:"TX",latMin:26.7,latMax:27.3,lonMin:-98.0,lonMax:-97.5,fuels:["wind","solar"],weights:[65,35]},
    {county:"Freestone",state:"TX",latMin:31.5,latMax:31.9,lonMin:-96.4,lonMax:-95.9,fuels:["solar","wind"],weights:[65,35]},
    {county:"Eastland",state:"TX",latMin:32.1,latMax:32.5,lonMin:-99.0,lonMax:-98.4,fuels:["wind","solar"],weights:[55,45]},
    {county:"Foard",state:"TX",latMin:33.8,latMax:34.1,lonMin:-99.8,lonMax:-99.4,fuels:["wind","solar"],weights:[65,35]},
  ];
  const CAISO_ZONES = [
    {county:"Kern",state:"CA",latMin:35.0,latMax:35.8,lonMin:-119.8,lonMax:-118.2,fuels:["solar","wind","storage"],weights:[50,35,15]},
    {county:"San Bernardino",state:"CA",latMin:34.5,latMax:35.4,lonMin:-117.5,lonMax:-115.5,fuels:["solar","storage"],weights:[70,30]},
    {county:"Riverside",state:"CA",latMin:33.5,latMax:34.2,lonMin:-116.8,lonMax:-115.6,fuels:["solar","storage","geothermal"],weights:[60,25,15]},
    {county:"Imperial",state:"CA",latMin:32.6,latMax:33.2,lonMin:-115.5,lonMax:-114.6,fuels:["solar","storage","geothermal"],weights:[55,25,20]},
    {county:"Fresno",state:"CA",latMin:36.5,latMax:37.1,lonMin:-120.4,lonMax:-119.4,fuels:["solar","storage"],weights:[75,25]},
    {county:"Humboldt",state:"CA",latMin:40.4,latMax:40.8,lonMin:-124.4,lonMax:-123.8,fuels:["offshore_wind","wind"],weights:[70,30]},
    {county:"Solano",state:"CA",latMin:38.0,latMax:38.5,lonMin:-122.2,lonMax:-121.5,fuels:["wind","solar"],weights:[70,30]},
    {county:"San Luis Obispo",state:"CA",latMin:35.1,latMax:35.6,lonMin:-121.0,lonMax:-120.2,fuels:["solar","offshore_wind","wind"],weights:[40,35,25]},
    {county:"Clark",state:"NV",latMin:35.5,latMax:36.2,lonMin:-115.7,lonMax:-114.5,fuels:["solar","storage"],weights:[75,25]},
    {county:"Maricopa",state:"AZ",latMin:33.0,latMax:33.8,lonMin:-112.8,lonMax:-111.5,fuels:["solar","storage"],weights:[75,25]},
  ];
  const PJM_ZONES = [
    {county:"Somerset",state:"PA",latMin:39.8,latMax:40.1,lonMin:-79.3,lonMax:-78.8,fuels:["wind","solar"],weights:[55,45]},
    {county:"Blair",state:"PA",latMin:40.4,latMax:40.7,lonMin:-78.5,lonMax:-78.0,fuels:["solar","wind"],weights:[55,45]},
    {county:"Ocean",state:"NJ",latMin:39.7,latMax:40.1,lonMin:-74.3,lonMax:-73.9,fuels:["offshore_wind","solar","storage"],weights:[50,30,20]},
    {county:"Macon",state:"IL",latMin:39.8,latMax:40.0,lonMin:-89.0,lonMax:-88.6,fuels:["solar","wind","storage"],weights:[50,35,15]},
    {county:"Livingston",state:"IL",latMin:40.8,latMax:41.1,lonMin:-88.5,lonMax:-88.1,fuels:["wind","solar"],weights:[60,40]},
    {county:"Pendleton",state:"WV",latMin:38.6,latMax:39.0,lonMin:-79.6,lonMax:-79.1,fuels:["wind","solar"],weights:[70,30]},
    {county:"Berkshire",state:"VA",latMin:37.2,latMax:37.6,lonMin:-79.7,lonMax:-79.3,fuels:["solar","wind"],weights:[55,45]},
    {county:"Louisa",state:"VA",latMin:37.9,latMax:38.2,lonMin:-78.1,lonMax:-77.7,fuels:["solar","storage"],weights:[75,25]},
    {county:"Carroll",state:"MD",latMin:39.5,latMax:39.8,lonMin:-77.2,lonMax:-76.8,fuels:["solar","storage"],weights:[70,30]},
    {county:"Coshocton",state:"OH",latMin:40.3,latMax:40.6,lonMin:-82.1,lonMax:-81.7,fuels:["wind","solar"],weights:[55,45]},
    {county:"Seneca",state:"OH",latMin:41.0,latMax:41.3,lonMin:-83.2,lonMax:-82.8,fuels:["wind","solar","storage"],weights:[50,35,15]},
  ];
  const ERCOT_NODES = ["LZ_HOUSTON","LZ_WEST","LZ_NORTH","LZ_SOUTH","LZ_AEN","LZ_CPS","LZ_RAYBN","LZ_LCRA","HB_BUSAVG","HB_NORTH","HB_SOUTH","HB_WEST","HB_HOUSTON"];
  const CAISO_NODES = ["SP15","NP15","ZP26","DLAP_SDGE-APND","DLAP_PGAE-APND","DLAP_SCE-APND","CAISO_NORTH","CAISO_SOUTH","MIECO","SCEC"];
  const PJM_NODES  = ["WESTERN HUB","EASTERN HUB","AEP-DAYTON HUB","NI HUB","PSEG","PPL","DOM","BGE","JCPL","METED","PENELEC","APS","EKPC"];

  const ERCOT_PHASES = ["Scoping","Phase 1","Phase 2","Phase 3","NRIS","ERIS","GIA"];
  const CAISO_PHASES = ["Phase I","Phase II","Phase III","BPM","Conditional","Approved"];
  const PJM_PHASES   = ["Scoping","Feasibility","System Impact","Facilities","IA Exec","Queue 1","Queue 2"];

  function genProjects(market: string, zones: typeof ERCOT_ZONES, nodes: string[], count: number, prefix: string, startId: number) {
    const rows: (typeof queueProjectsTable.$inferInsert)[] = [];
    for (let i = 0; i < count; i++) {
      const zone = pick2(zones);
      const fuel = pickW(zone.fuels, zone.weights);
      const status = pickW(["active","withdrawn","completed"], [55,30,15]);
      const reqDate = dateRange2(2018, 2025);
      const wd = status === "withdrawn" ? new Date(reqDate.getTime() + rnd(30, 730) * 86400000) : null;
      let cap: number;
      if (fuel === "offshore_wind") cap = rndInt(200, 1500);
      else if (fuel === "wind") cap = rndInt(50, 800);
      else if (fuel === "storage") cap = rndInt(50, 400);
      else if (fuel === "hybrid") cap = rndInt(100, 600);
      else cap = rndInt(20, 500);
      const phases = market === "ERCOT" ? ERCOT_PHASES : market === "CAISO" ? CAISO_PHASES : PJM_PHASES;
      rows.push({
        projectName: projName(fuel),
        market,
        queueId: `${prefix}-${reqDate.getFullYear()}-${String(startId + i).padStart(4, "0")}`,
        fuelType: fuel,
        capacityMw: String(cap),
        status,
        latitude:  String(rnd(zone.latMin, zone.latMax)),
        longitude: String(rnd(zone.lonMin, zone.lonMax)),
        county: zone.county,
        state: zone.state,
        interconnectionNode: pick2(nodes),
        requestDate: reqDate,
        studyGroupPhase: status === "active" ? pick2(phases) : null,
        withdrawalDate: wd,
      });
    }
    return rows;
  }

  job.output.push("Clearing and regenerating queue_projects...");
  // Use TRUNCATE for speed, then re-insert
  await db.execute(sql.raw("TRUNCATE TABLE queue_projects RESTART IDENTITY CASCADE"));

  const ercot = genProjects("ERCOT", ERCOT_ZONES, ERCOT_NODES, 480, "ERC", 1000);
  const caiso = genProjects("CAISO", CAISO_ZONES, CAISO_NODES, 440, "CAI", 2000);
  const pjm   = genProjects("PJM",   PJM_ZONES,   PJM_NODES,   580, "PJM", 3000);
  const all = [...ercot, ...caiso, ...pjm];

  for (let i = 0; i < all.length; i += 200) {
    await db.insert(queueProjectsTable).values(all.slice(i, i + 200));
    if (i % 600 === 0) job.output.push(`  inserted ${Math.min(i + 200, all.length)}/${all.length} queue projects`);
  }
  job.output.push(`✓ queue_projects: ${all.length} rows (ERCOT: ${ercot.length}, CAISO: ${caiso.length}, PJM: ${pjm.length})`);
}

// ── POST /api/admin/reseed-queue-inline ──────────────────────────────────────
router.post("/admin/reseed-queue-inline", requireAdminKey, (req, res) => {
  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const job: Job = { script: "reseed-queue-inline", status: "running", exitCode: null, output: ["=== Queue inline seed started ==="], startedAt: new Date().toISOString() };
  jobs.set(jobId, job);

  res.status(202).json({ message: "Queue inline seed started", jobId, statusUrl: `/api/admin/jobs/${jobId}` });

  inlineSeedQueue(job).then(() => {
    job.status = "completed"; job.exitCode = 0; job.finishedAt = new Date().toISOString();
    job.output.push("=== Queue inline seed complete ===");
  }).catch((err) => {
    job.status = "failed"; job.exitCode = 1; job.finishedAt = new Date().toISOString();
    job.output.push(`ERROR: ${String(err)}`);
  });
});

export default router;
