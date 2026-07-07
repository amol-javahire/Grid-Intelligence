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

// ── spawnPython: runs a Python script from scripts/src/ via pypsa venv ────────
function spawnPython(scriptName: string): string {
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

  const pyBin = path.join(wsRoot, "artifacts/pypsa-engine/.venv/bin/python3");
  const scriptPath = path.join(wsRoot, "scripts/src", `${scriptName}.py`);
  const pyCwd = path.join(wsRoot, "artifacts/pypsa-engine");

  const proc = spawn(pyBin, [scriptPath], {
    cwd: pyCwd,
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
      UNION ALL SELECT 'transmission_lines', COUNT(*)::int FROM transmission_lines
      UNION ALL SELECT 'ercot_node_stats', COUNT(*)::int FROM ercot_node_stats
      UNION ALL SELECT 'ercot_nodal_stats', COUNT(*)::int FROM ercot_nodal_stats
      UNION ALL SELECT 'ercot_hub_hourly', COUNT(*)::int FROM ercot_hub_hourly
      UNION ALL SELECT 'ercot_load_by_zone', COUNT(*)::int FROM ercot_load_by_zone
      UNION ALL SELECT 'ercot_fuel_mix', COUNT(*)::int FROM ercot_fuel_mix
      UNION ALL SELECT 'caiso_node_stats', COUNT(*)::int FROM caiso_node_stats
      UNION ALL SELECT 'caiso_hub_hourly', COUNT(*)::int FROM caiso_hub_hourly
      UNION ALL SELECT 'pjm_node_stats', COUNT(*)::int FROM pjm_node_stats
      UNION ALL SELECT 'queue_projects', COUNT(*)::int FROM queue_projects
      UNION ALL SELECT 'gas_prices', COUNT(*)::int FROM gas_prices
      UNION ALL SELECT 'generators', COUNT(*)::int FROM generators
      UNION ALL SELECT 'thermal_params', COUNT(*)::int FROM thermal_params
      UNION ALL SELECT 'hourly_temperatures', COUNT(*)::int FROM hourly_temperatures
      UNION ALL SELECT 'regulatory_items', COUNT(*)::int FROM regulatory_items
      UNION ALL SELECT 'load_forecasts', COUNT(*)::int FROM load_forecasts
      UNION ALL SELECT 'datacenters', COUNT(*)::int FROM datacenters
      UNION ALL SELECT 'temperature_forecasts', COUNT(*)::int FROM temperature_forecasts
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

// ── POST /api/admin/reseed-gas-prices ────────────────────────────────────────
// Spawns the seed-gas-prices script which pulls Henry Hub daily prices from FRED.
router.post("/admin/reseed-gas-prices", requireAdminKey, (req, res) => {
  const jobId = spawnScript("seed-gas-prices");
  res.status(202).json({
    message: "Gas price seeding started (Henry Hub daily from FRED)",
    jobId,
    statusUrl: `/api/admin/jobs/${jobId}`,
    note: "Pulls DHHNGSP series from FRED API. Takes ~30 sec.",
  });
});

// ── POST /api/admin/reseed-generators ────────────────────────────────────────
// Inline seed of 31 ERCOT thermal generators + thermal_params (static reference data).
// Safe to call multiple times — uses ON CONFLICT DO NOTHING.
router.post("/admin/reseed-generators", requireAdminKey, async (req, res) => {
  try {
    const generators = [
      { id: 1,  plant_name: "Midlothian Energy Center",     operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1080, summer_capacity_mw: 1035, commissioning_year: 2001, lat: 32.447, lng: -97.012, county: "Ellis",      state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 2,  plant_name: "Wolf Hollow Energy Center",     operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 735,  summer_capacity_mw: 708,  commissioning_year: 2002, lat: 32.471, lng: -97.577, county: "Hood",       state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 3,  plant_name: "Bosque Energy Center",          operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 420,  summer_capacity_mw: 404,  commissioning_year: 2001, lat: 31.952, lng: -97.563, county: "Bosque",     state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 4,  plant_name: "Forney Energy Center",          operator: "NRG Energy",            asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1734, summer_capacity_mw: 1661, commissioning_year: 2002, lat: 32.737, lng: -96.459, county: "Kaufman",    state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 5,  plant_name: "Freestone Energy Center",       operator: "Calpine Corp",          asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1084, summer_capacity_mw: 1040, commissioning_year: 2002, lat: 31.743, lng: -96.139, county: "Freestone",  state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 6,  plant_name: "Lamar Power Partners",          operator: "EthosEnergy Group",     asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 570,  summer_capacity_mw: 547,  commissioning_year: 2002, lat: 33.641, lng: -95.567, county: "Lamar",      state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 7,  plant_name: "Lost Pines Power Park",         operator: "LCRA",                  asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 505,  summer_capacity_mw: 484,  commissioning_year: 2003, lat: 30.196, lng: -97.238, county: "Bastrop",    state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 8,  plant_name: "Guadalupe Power Partners",      operator: "Calpine Corp",          asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1000, summer_capacity_mw: 960,  commissioning_year: 2000, lat: 29.687, lng: -98.082, county: "Guadalupe",  state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 9,  plant_name: "Three Oaks Energy Center",      operator: "EDF Renewables",        asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 786,  summer_capacity_mw: 754,  commissioning_year: 2002, lat: 29.413, lng: -99.003, county: "Medina",     state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 10, plant_name: "CPS Braunig Combined Cycle",    operator: "CPS Energy",            asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 825,  summer_capacity_mw: 792,  commissioning_year: 2003, lat: 29.312, lng: -98.353, county: "Bexar",      state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 11, plant_name: "Corpus Christi Energy Center",  operator: "AEP Texas",             asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1195, summer_capacity_mw: 1147, commissioning_year: 2001, lat: 27.857, lng: -97.556, county: "Nueces",     state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 12, plant_name: "Frontera Power Plant",          operator: "InterGen Services",     asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 550,  summer_capacity_mw: 528,  commissioning_year: 2002, lat: 26.140, lng: -97.718, county: "Hidalgo",    state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 13, plant_name: "Channel Energy Center",         operator: "NRG Energy",            asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 811,  summer_capacity_mw: 779,  commissioning_year: 2002, lat: 29.754, lng: -95.267, county: "Harris",     state: "TX", iso: "ERCOT", load_zone: "LZ_HOUSTON" },
      { id: 14, plant_name: "WA Parish Combined Cycle",      operator: "NRG Energy",            asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 1200, summer_capacity_mw: 1152, commissioning_year: 2002, lat: 29.499, lng: -95.669, county: "Fort Bend",  state: "TX", iso: "ERCOT", load_zone: "LZ_HOUSTON" },
      { id: 15, plant_name: "Colorado Bend Energy Center",   operator: "Calpine Corp",          asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 450,  summer_capacity_mw: 432,  commissioning_year: 2002, lat: 29.006, lng: -96.419, county: "Wharton",    state: "TX", iso: "ERCOT", load_zone: "LZ_HOUSTON" },
      { id: 16, plant_name: "Quail Run Energy Center",       operator: "EDP Renewables",        asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 617,  summer_capacity_mw: 592,  commissioning_year: 2002, lat: 31.866, lng: -101.958, county: "Midland",  state: "TX", iso: "ERCOT", load_zone: "LZ_WEST" },
      { id: 17, plant_name: "Odessa-Ector Power Partners",   operator: "J-W Power Company",    asset_class: "THERMAL", technology: "CCGT",  fuel_primary: "NG",    nameplate_mw: 560,  summer_capacity_mw: 538,  commissioning_year: 2003, lat: 31.841, lng: -102.368, county: "Ector",    state: "TX", iso: "ERCOT", load_zone: "LZ_WEST" },
      { id: 18, plant_name: "Handley Energy Center",         operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 1190, summer_capacity_mw: 1142, commissioning_year: 1958, lat: 32.742, lng: -97.196, county: "Tarrant",    state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 19, plant_name: "Mountain Creek Energy Center",  operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 884,  summer_capacity_mw: 848,  commissioning_year: 1955, lat: 32.756, lng: -97.063, county: "Dallas",     state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 20, plant_name: "Graham Power Plant",            operator: "Luminant Energy",       asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 571,  summer_capacity_mw: 548,  commissioning_year: 1959, lat: 33.077, lng: -98.536, county: "Young",      state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 21, plant_name: "DFW Power Partners",            operator: "Multiple Operators",    asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 350,  summer_capacity_mw: 336,  commissioning_year: 2003, lat: 32.903, lng: -97.038, county: "Tarrant",    state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 22, plant_name: "Barney M Davis Power Plant",    operator: "AEP Texas",             asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 640,  summer_capacity_mw: 614,  commissioning_year: 1974, lat: 27.836, lng: -97.411, county: "Nueces",     state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 23, plant_name: "JT Deely Power Plant",          operator: "CPS Energy",            asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 440,  summer_capacity_mw: 422,  commissioning_year: 1977, lat: 29.518, lng: -98.758, county: "Bexar",      state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 24, plant_name: "Texas Cedar Port Power",        operator: "NRG Energy",            asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 420,  summer_capacity_mw: 403,  commissioning_year: 2006, lat: 29.733, lng: -95.029, county: "Harris",     state: "TX", iso: "ERCOT", load_zone: "LZ_HOUSTON" },
      { id: 25, plant_name: "Permian Basin Energy Center",   operator: "Multiple Operators",    asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 400,  summer_capacity_mw: 384,  commissioning_year: 2005, lat: 31.985, lng: -102.077, county: "Ector",    state: "TX", iso: "ERCOT", load_zone: "LZ_WEST" },
      { id: 26, plant_name: "West Texas Peaker",             operator: "Sharyland Utilities",   asset_class: "THERMAL", technology: "CT",    fuel_primary: "NG",    nameplate_mw: 300,  summer_capacity_mw: 288,  commissioning_year: 2004, lat: 32.458, lng: -100.408, county: "Nolan",    state: "TX", iso: "ERCOT", load_zone: "LZ_WEST" },
      { id: 27, plant_name: "Limestone Electric Station",    operator: "NRG Energy",            asset_class: "THERMAL", technology: "STEAM", fuel_primary: "COAL",  nameplate_mw: 1650, summer_capacity_mw: 1584, commissioning_year: 1985, lat: 31.448, lng: -96.375, county: "Leon",       state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 28, plant_name: "Oak Grove Power Plant",         operator: "Luminant Energy",       asset_class: "THERMAL", technology: "STEAM", fuel_primary: "LIGNITE", nameplate_mw: 1600, summer_capacity_mw: 1536, commissioning_year: 2010, lat: 31.378, lng: -96.599, county: "Robertson", state: "TX", iso: "ERCOT", load_zone: "LZ_NORTH" },
      { id: 29, plant_name: "Fayette Power Project",         operator: "LCRA",                  asset_class: "THERMAL", technology: "STEAM", fuel_primary: "COAL",  nameplate_mw: 1240, summer_capacity_mw: 1190, commissioning_year: 1979, lat: 29.800, lng: -97.081, county: "Fayette",    state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 30, plant_name: "San Miguel Electric Station",   operator: "SMEC",                  asset_class: "THERMAL", technology: "STEAM", fuel_primary: "LIGNITE", nameplate_mw: 410, summer_capacity_mw: 394,  commissioning_year: 1982, lat: 29.025, lng: -98.476, county: "Atascosa",   state: "TX", iso: "ERCOT", load_zone: "LZ_SOUTH" },
      { id: 31, plant_name: "WA Parish Steam Units",         operator: "NRG Energy",            asset_class: "THERMAL", technology: "STEAM", fuel_primary: "COAL",  nameplate_mw: 1274, summer_capacity_mw: 1223, commissioning_year: 1958, lat: 29.499, lng: -95.669, county: "Fort Bend",  state: "TX", iso: "ERCOT", load_zone: "LZ_HOUSTON" },
    ] as const;

    const thermalParams = [
      { id: 1,  gen_id: 1,  heat_rate: 6.800, min_mw: 324,  max_mw: 1028, ramp: 9.0,  ramp_e: 12.0, sc_cold: 102600, sc_warm: 61560, sc_hot: 30780, st_cold: 8.0,  vom: 4.50, hub: "WAHA",                co2: 0.3950, for_rate: 0.0480, po_days: 25, ifc: null },
      { id: 2,  gen_id: 2,  heat_rate: 7.100, min_mw: 221,  max_mw: 699,  ramp: 6.0,  ramp_e: 8.5,  sc_cold: 66150,  sc_warm: 39690, sc_hot: 19845, st_cold: 8.5,  vom: 4.75, hub: "WAHA",                co2: 0.4120, for_rate: 0.0510, po_days: 22, ifc: null },
      { id: 3,  gen_id: 3,  heat_rate: 7.200, min_mw: 126,  max_mw: 399,  ramp: 3.5,  ramp_e: 5.0,  sc_cold: 37800,  sc_warm: 22680, sc_hot: 11340, st_cold: 9.0,  vom: 4.60, hub: "WAHA",                co2: 0.4180, for_rate: 0.0530, po_days: 20, ifc: null },
      { id: 4,  gen_id: 4,  heat_rate: 6.650, min_mw: 520,  max_mw: 1648, ramp: 14.0, ramp_e: 19.0, sc_cold: 156060, sc_warm: 93636, sc_hot: 46818, st_cold: 7.5,  vom: 4.25, hub: "WAHA",                co2: 0.3860, for_rate: 0.0450, po_days: 28, ifc: null },
      { id: 5,  gen_id: 5,  heat_rate: 6.900, min_mw: 325,  max_mw: 1030, ramp: 8.7,  ramp_e: 12.0, sc_cold: 97560,  sc_warm: 58536, sc_hot: 29268, st_cold: 8.2,  vom: 4.40, hub: "WAHA",                co2: 0.4005, for_rate: 0.0490, po_days: 24, ifc: null },
      { id: 6,  gen_id: 6,  heat_rate: 7.300, min_mw: 171,  max_mw: 542,  ramp: 4.8,  ramp_e: 6.5,  sc_cold: 51300,  sc_warm: 30780, sc_hot: 15390, st_cold: 9.0,  vom: 4.80, hub: "WAHA",                co2: 0.4240, for_rate: 0.0550, po_days: 21, ifc: null },
      { id: 7,  gen_id: 7,  heat_rate: 7.150, min_mw: 152,  max_mw: 480,  ramp: 4.2,  ramp_e: 5.5,  sc_cold: 45450,  sc_warm: 27270, sc_hot: 13635, st_cold: 8.8,  vom: 4.65, hub: "WAHA",                co2: 0.4150, for_rate: 0.0520, po_days: 22, ifc: null },
      { id: 8,  gen_id: 8,  heat_rate: 6.950, min_mw: 300,  max_mw: 950,  ramp: 8.0,  ramp_e: 11.0, sc_cold: 90000,  sc_warm: 54000, sc_hot: 27000, st_cold: 8.0,  vom: 4.50, hub: "WAHA",                co2: 0.4035, for_rate: 0.0470, po_days: 25, ifc: null },
      { id: 9,  gen_id: 9,  heat_rate: 7.050, min_mw: 236,  max_mw: 747,  ramp: 6.3,  ramp_e: 8.8,  sc_cold: 70740,  sc_warm: 42444, sc_hot: 21222, st_cold: 8.5,  vom: 4.65, hub: "WAHA",                co2: 0.4095, for_rate: 0.0500, po_days: 22, ifc: null },
      { id: 10, gen_id: 10, heat_rate: 7.150, min_mw: 248,  max_mw: 784,  ramp: 6.9,  ramp_e: 9.5,  sc_cold: 74250,  sc_warm: 44550, sc_hot: 22275, st_cold: 8.5,  vom: 4.70, hub: "WAHA",                co2: 0.4150, for_rate: 0.0510, po_days: 23, ifc: null },
      { id: 11, gen_id: 11, heat_rate: 6.850, min_mw: 359,  max_mw: 1136, ramp: 9.6,  ramp_e: 13.0, sc_cold: 107550, sc_warm: 64530, sc_hot: 32265, st_cold: 8.0,  vom: 4.35, hub: "WAHA",                co2: 0.3975, for_rate: 0.0470, po_days: 26, ifc: null },
      { id: 12, gen_id: 12, heat_rate: 7.200, min_mw: 165,  max_mw: 523,  ramp: 4.6,  ramp_e: 6.2,  sc_cold: 49500,  sc_warm: 29700, sc_hot: 14850, st_cold: 9.0,  vom: 4.70, hub: "WAHA",                co2: 0.4180, for_rate: 0.0520, po_days: 21, ifc: null },
      { id: 13, gen_id: 13, heat_rate: 7.000, min_mw: 243,  max_mw: 771,  ramp: 6.7,  ramp_e: 9.3,  sc_cold: 72990,  sc_warm: 43794, sc_hot: 21897, st_cold: 8.2,  vom: 4.55, hub: "HSC",                 co2: 0.4065, for_rate: 0.0490, po_days: 24, ifc: null },
      { id: 14, gen_id: 14, heat_rate: 7.250, min_mw: 360,  max_mw: 1140, ramp: 9.0,  ramp_e: 12.5, sc_cold: 108000, sc_warm: 64800, sc_hot: 32400, st_cold: 9.0,  vom: 4.80, hub: "HSC",                 co2: 0.4210, for_rate: 0.0520, po_days: 26, ifc: null },
      { id: 15, gen_id: 15, heat_rate: 7.100, min_mw: 135,  max_mw: 428,  ramp: 3.8,  ramp_e: 5.2,  sc_cold: 40500,  sc_warm: 24300, sc_hot: 12150, st_cold: 8.5,  vom: 4.55, hub: "HSC",                 co2: 0.4120, for_rate: 0.0500, po_days: 21, ifc: null },
      { id: 16, gen_id: 16, heat_rate: 7.400, min_mw: 185,  max_mw: 586,  ramp: 5.1,  ramp_e: 7.0,  sc_cold: 55530,  sc_warm: 33318, sc_hot: 16659, st_cold: 9.5,  vom: 4.90, hub: "WAHA",                co2: 0.4295, for_rate: 0.0550, po_days: 20, ifc: null },
      { id: 17, gen_id: 17, heat_rate: 7.500, min_mw: 168,  max_mw: 532,  ramp: 4.7,  ramp_e: 6.5,  sc_cold: 50400,  sc_warm: 30240, sc_hot: 15120, st_cold: 9.5,  vom: 5.00, hub: "WAHA",                co2: 0.4355, for_rate: 0.0560, po_days: 20, ifc: null },
      { id: 18, gen_id: 18, heat_rate: 10.800, min_mw: 238, max_mw: 1131, ramp: 14.0, ramp_e: 20.0, sc_cold: 35700,  sc_warm: 21420, sc_hot: 10710, st_cold: 3.0,  vom: 7.00, hub: "WAHA",                co2: 0.6270, for_rate: 0.0680, po_days: 14, ifc: null },
      { id: 19, gen_id: 19, heat_rate: 11.200, min_mw: 177, max_mw: 840,  ramp: 11.6, ramp_e: 16.5, sc_cold: 26520,  sc_warm: 15912, sc_hot: 7956,  st_cold: 3.5,  vom: 7.50, hub: "WAHA",                co2: 0.6500, for_rate: 0.0710, po_days: 13, ifc: null },
      { id: 20, gen_id: 20, heat_rate: 11.500, min_mw: 114, max_mw: 543,  ramp: 7.4,  ramp_e: 10.8, sc_cold: 17130,  sc_warm: 10278, sc_hot: 5139,  st_cold: 4.0,  vom: 7.20, hub: "WAHA",                co2: 0.6675, for_rate: 0.0690, po_days: 12, ifc: null },
      { id: 21, gen_id: 21, heat_rate: 9.800,  min_mw: 70,  max_mw: 333,  ramp: 8.8,  ramp_e: 13.5, sc_cold: 10500,  sc_warm: 6300,  sc_hot: 3150,  st_cold: 2.5,  vom: 5.80, hub: "WAHA",                co2: 0.5690, for_rate: 0.0620, po_days: 10, ifc: null },
      { id: 22, gen_id: 22, heat_rate: 10.800, min_mw: 128, max_mw: 608,  ramp: 8.0,  ramp_e: 12.0, sc_cold: 19200,  sc_warm: 11520, sc_hot: 5760,  st_cold: 3.5,  vom: 6.80, hub: "WAHA",                co2: 0.6270, for_rate: 0.0670, po_days: 12, ifc: null },
      { id: 23, gen_id: 23, heat_rate: 10.500, min_mw: 88,  max_mw: 418,  ramp: 5.8,  ramp_e: 8.5,  sc_cold: 13200,  sc_warm: 7920,  sc_hot: 3960,  st_cold: 3.5,  vom: 6.50, hub: "WAHA",                co2: 0.6095, for_rate: 0.0650, po_days: 11, ifc: null },
      { id: 24, gen_id: 24, heat_rate: 10.200, min_mw: 84,  max_mw: 399,  ramp: 12.0, ramp_e: 18.0, sc_cold: 12600,  sc_warm: 7560,  sc_hot: 3780,  st_cold: 2.0,  vom: 6.20, hub: "HSC",                 co2: 0.5920, for_rate: 0.0600, po_days: 11, ifc: null },
      { id: 25, gen_id: 25, heat_rate: 10.000, min_mw: 80,  max_mw: 380,  ramp: 12.0, ramp_e: 18.0, sc_cold: 12000,  sc_warm: 7200,  sc_hot: 3600,  st_cold: 2.0,  vom: 6.00, hub: "WAHA",                co2: 0.5805, for_rate: 0.0630, po_days: 10, ifc: null },
      { id: 26, gen_id: 26, heat_rate: 10.500, min_mw: 60,  max_mw: 285,  ramp: 9.0,  ramp_e: 14.0, sc_cold: 9000,   sc_warm: 5400,  sc_hot: 2700,  st_cold: 2.5,  vom: 6.50, hub: "WAHA",                co2: 0.6095, for_rate: 0.0650, po_days: 10, ifc: null },
      { id: 27, gen_id: 27, heat_rate: 10.800, min_mw: 743, max_mw: 1568, ramp: 3.0,  ramp_e: 4.5,  sc_cold: 297000, sc_warm: 148500, sc_hot: 74250, st_cold: 24.0, vom: 2.50, hub: "COAL_POWDER_RIVER",  co2: 1.0850, for_rate: 0.0950, po_days: 38, ifc: 2.20 },
      { id: 28, gen_id: 28, heat_rate: 11.500, min_mw: 720, max_mw: 1520, ramp: 2.5,  ramp_e: 3.5,  sc_cold: 288000, sc_warm: 144000, sc_hot: 72000, st_cold: 36.0, vom: 2.20, hub: "COAL_LIGNITE_TX",    co2: 1.0500, for_rate: 0.0820, po_days: 32, ifc: 1.80 },
      { id: 29, gen_id: 29, heat_rate: 11.200, min_mw: 558, max_mw: 1178, ramp: 2.5,  ramp_e: 3.5,  sc_cold: 223200, sc_warm: 111600, sc_hot: 55800, st_cold: 28.0, vom: 2.40, hub: "COAL_POWDER_RIVER",  co2: 1.0640, for_rate: 0.0910, po_days: 40, ifc: 2.10 },
      { id: 30, gen_id: 30, heat_rate: 13.200, min_mw: 185, max_mw: 390,  ramp: 1.8,  ramp_e: 2.5,  sc_cold: 73800,  sc_warm: 36900, sc_hot: 18450, st_cold: 48.0, vom: 1.80, hub: "COAL_LIGNITE_TX",    co2: 1.0150, for_rate: 0.0880, po_days: 35, ifc: 1.50 },
      { id: 31, gen_id: 31, heat_rate: 11.800, min_mw: 573, max_mw: 1211, ramp: 2.8,  ramp_e: 4.0,  sc_cold: 229320, sc_warm: 114660, sc_hot: 57330, st_cold: 30.0, vom: 2.30, hub: "COAL_POWDER_RIVER",  co2: 1.0950, for_rate: 0.0980, po_days: 42, ifc: 2.15 },
    ] as const;

    // Seed generators (TRUNCATE + re-insert for clean state)
    await db.execute(sql.raw(`TRUNCATE generators RESTART IDENTITY CASCADE`));

    for (const g of generators) {
      await db.execute(sql`
        INSERT INTO generators
          (id, plant_name, operator, asset_class, technology, fuel_primary,
           nameplate_mw, summer_capacity_mw, commissioning_year, lat, lng,
           county, state, iso, load_zone, status)
        VALUES (
          ${g.id}, ${g.plant_name}, ${g.operator}, ${g.asset_class}, ${g.technology},
          ${g.fuel_primary}, ${g.nameplate_mw}, ${g.summer_capacity_mw},
          ${g.commissioning_year}, ${g.lat}, ${g.lng}, ${g.county},
          ${g.state}, ${g.iso}, ${g.load_zone}, 'OPERATING'
        )
        ON CONFLICT (id) DO UPDATE SET
          plant_name = EXCLUDED.plant_name, operator = EXCLUDED.operator,
          technology = EXCLUDED.technology, nameplate_mw = EXCLUDED.nameplate_mw,
          summer_capacity_mw = EXCLUDED.summer_capacity_mw, lat = EXCLUDED.lat, lng = EXCLUDED.lng
      `);
    }

    // Seed thermal_params
    await db.execute(sql.raw(`TRUNCATE thermal_params RESTART IDENTITY CASCADE`));

    for (const t of thermalParams) {
      await db.execute(sql`
        INSERT INTO thermal_params
          (id, generator_id, design_heat_rate, min_load_mw, max_load_mw,
           ramp_rate_mw_min, ramp_rate_emergency_mw_min,
           startup_cost_cold, startup_cost_warm, startup_cost_hot,
           startup_time_cold_h, vom_per_mwh, fuel_hub, co2_rate_tons_mwh,
           forced_outage_rate, planned_outage_days, implied_fuel_cost_per_mmb)
        VALUES (
          ${t.id}, ${t.gen_id}, ${t.heat_rate}, ${t.min_mw}, ${t.max_mw},
          ${t.ramp}, ${t.ramp_e}, ${t.sc_cold}, ${t.sc_warm}, ${t.sc_hot},
          ${t.st_cold}, ${t.vom}, ${t.hub}, ${t.co2}, ${t.for_rate},
          ${t.po_days}, ${t.ifc}
        )
        ON CONFLICT (id) DO UPDATE SET
          design_heat_rate = EXCLUDED.design_heat_rate,
          vom_per_mwh = EXCLUDED.vom_per_mwh,
          fuel_hub = EXCLUDED.fuel_hub,
          co2_rate_tons_mwh = EXCLUDED.co2_rate_tons_mwh
      `);
    }

    res.json({
      message: "Generators and thermal_params seeded",
      generators: generators.length,
      thermalParams: thermalParams.length,
    });
  } catch (err) {
    req.log.error({ err }, "admin/reseed-generators error");
    res.status(500).json({ error: "internal_error", detail: String(err) });
  }
});

// ── POST /api/admin/reseed-regulatory ────────────────────────────────────────
// Spawns seed-regulatory.py — seeds 30 curated PPA-relevant regulatory items.
router.post("/admin/reseed-regulatory", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-regulatory");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding 30 regulatory_items rows via seed-regulatory.py" });
});

// ── POST /api/admin/reseed-datacenters ────────────────────────────────────────
// Spawns seed-datacenters.py — seeds ~55 hyperscale datacenter facilities.
router.post("/admin/reseed-datacenters", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-datacenters");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding ~55 datacenter rows via seed-datacenters.py" });
});

// ── POST /api/admin/reseed-temperatures ──────────────────────────────────────
// Spawns seed-temperatures.py — seeds hourly_temperatures for 8 ERCOT zones.
router.post("/admin/reseed-temperatures", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-temperatures");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding hourly_temperatures (8 ERCOT zones) via seed-temperatures.py" });
});

// ── POST /api/admin/reseed-temperatures-completion ───────────────────────────
// Spawns seed-temperatures-completion.py — adds ERCOT WEST + 3 CAISO zones.
router.post("/admin/reseed-temperatures-completion", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-temperatures-completion");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding hourly_temperatures completion (ERCOT WEST + NP15/SP15/ZP26) via seed-temperatures-completion.py" });
});

// ── POST /api/admin/reseed-temperature-forecasts ──────────────────────────────
// Spawns seed-temperature-forecast.py — seeds temperature_forecasts (12k rows).
router.post("/admin/reseed-temperature-forecasts", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-temperature-forecast");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding temperature_forecasts via seed-temperature-forecast.py" });
});

// ── POST /api/admin/reseed-load-forecasts ────────────────────────────────────
// Spawns compute-load-forecast.py — seeds load_forecasts (8k rows).
router.post("/admin/reseed-load-forecasts", requireAdminKey, (req, res) => {
  const jobId = spawnPython("compute-load-forecast");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding load_forecasts via compute-load-forecast.py" });
});

// ── POST /api/admin/reseed-temperatures-fast ──────────────────────────────────
// Spawns seed-temperatures-fast.py — seeds all 11 zones via synthetic
// climatological data + execute_values bulk inserts (~2-3 min, no API calls).
router.post("/admin/reseed-temperatures-fast", requireAdminKey, (req, res) => {
  const jobId = spawnPython("seed-temperatures-fast");
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding hourly_temperatures (all 11 zones, synthetic, fast) via seed-temperatures-fast.py" });
});

// ── Node.js async job runner ───────────────────────────────────────────────────
function runNodeJob(name: string, fn: (job: Job) => Promise<void>): string {
  const jobId = `job-${++jobCounter}-${Date.now()}`;
  const job: Job = { script: name, status: "running", exitCode: null, output: [], startedAt: new Date().toISOString() };
  jobs.set(jobId, job);
  setImmediate(async () => {
    try {
      await fn(job);
      job.status = "completed"; job.exitCode = 0; job.finishedAt = new Date().toISOString();
    } catch (e: any) {
      job.status = "failed"; job.exitCode = 1; job.output.push(`ERROR: ${e?.message ?? e}`); job.finishedAt = new Date().toISOString();
    }
  });
  return jobId;
}

// ── POST /api/admin/seed-temperatures-node ────────────────────────────────────
// Pure Node.js synthetic temperature seeder — all 11 zones, ~30s, no Python.
// Uses TRUNCATE + 3000-row batch inserts via Drizzle raw SQL.
router.post("/admin/seed-temperatures-node", requireAdminKey, (req, res) => {
  const jobId = runNodeJob("seed-temperatures-node", async (job) => {
    const CLIMATES: Array<{ iso: string; zone: string; mean: number; seasonal: number; diurnal: number }> = [
      { iso: "ERCOT", zone: "COAS", mean: 68, seasonal: 18, diurnal: 12 },
      { iso: "ERCOT", zone: "NCEN", mean: 65, seasonal: 22, diurnal: 14 },
      { iso: "ERCOT", zone: "NRTH", mean: 63, seasonal: 22, diurnal: 14 },
      { iso: "ERCOT", zone: "EAST", mean: 67, seasonal: 20, diurnal: 13 },
      { iso: "ERCOT", zone: "SCEN", mean: 69, seasonal: 19, diurnal: 12 },
      { iso: "ERCOT", zone: "SOUT", mean: 71, seasonal: 16, diurnal: 11 },
      { iso: "ERCOT", zone: "FWES", mean: 67, seasonal: 21, diurnal: 14 },
      { iso: "ERCOT", zone: "WEST", mean: 62, seasonal: 20, diurnal: 14 },
      { iso: "CAISO", zone: "NP15", mean: 58, seasonal: 14, diurnal: 10 },
      { iso: "CAISO", zone: "SP15", mean: 64, seasonal: 12, diurnal: 11 },
      { iso: "CAISO", zone: "ZP26", mean: 68, seasonal: 14, diurnal: 12 },
    ];
    const MONTHS: Array<[number, number]> = [];
    for (let y = 2024; y <= 2026; y++)
      for (let m = 1; m <= (y === 2026 ? 5 : 12); m++)
        MONTHS.push([y, m]);

    function daysInMonth(y: number, m: number) { return new Date(y, m, 0).getDate(); }

    await db.execute(sql.raw("TRUNCATE TABLE hourly_temperatures"));
    job.output.push("Truncated hourly_temperatures — generating synthetic data...");

    let totalInserted = 0;
    const BATCH = 3000;

    for (const c of CLIMATES) {
      job.output.push(`Seeding ${c.zone} (${c.iso})...`);
      let rows: string[] = [];

      for (const [year, month] of MONTHS) {
        const days = daysInMonth(year, month);
        for (let day = 1; day <= days; day++) {
          for (let hour = 0; hour <= 23; hour++) {
            const seasonal = c.seasonal * Math.sin(2 * Math.PI * (month - 1) / 12);
            const diurnal  = c.diurnal  * Math.sin(2 * Math.PI * (hour - 4)  / 24);
            const tf = Math.round((c.mean + seasonal + diurnal) * 10) / 10;
            const tc = Math.round(((tf - 32) * 5 / 9) * 100) / 100;
            rows.push(`('${c.iso}','${c.zone}',${year},${month},${day},${hour},${tf},${tc})`);
            if (rows.length >= BATCH) {
              await db.execute(sql.raw(
                `INSERT INTO hourly_temperatures (iso,zone,year,month,day,hour,temp_f,temp_c) VALUES ${rows.join(",")} ON CONFLICT (iso,zone,year,month,day,hour) DO NOTHING`
              ));
              totalInserted += rows.length; rows = [];
            }
          }
        }
      }
      if (rows.length > 0) {
        await db.execute(sql.raw(
          `INSERT INTO hourly_temperatures (iso,zone,year,month,day,hour,temp_f,temp_c) VALUES ${rows.join(",")} ON CONFLICT (iso,zone,year,month,day,hour) DO NOTHING`
        ));
        totalInserted += rows.length;
      }
      job.output.push(`  ${c.zone}: done`);
    }
    job.output.push(`✅ Done — ${totalInserted} rows inserted across 11 zones`);
  });
  res.json({ jobId, statusUrl: `/api/admin/jobs/${jobId}`, message: "Seeding hourly_temperatures via Node.js (11 zones, no Python, ~30s)" });
});

export default router;
