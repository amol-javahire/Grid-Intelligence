/**
 * Seed REAL AESO data from apimgw.aeso.ca public API gateway
 * Requires: AESO_API_KEY environment variable
 *
 * Pulls (Jan 2024 → today unless noted):
 *   1. Pool Price            — actual + forecast + rolling 30d avg
 *   2. Actual/Forecast AIL   — actual + DA/RT forecasts + price forecasts
 *   3. AIES Gen Capacity     — unit-level capacity & outage reporting
 *   4. Operating Reserve     — FFR, contingency, spinning, supplemental
 *   5. Load Outage Forecast  — last 90 days
 *   6. Metered Volume        — last 30 days (generator-level, large dataset)
 *   7. Asset List            — one-time registry pull
 *   8. Pool Participants     — one-time registry pull
 *
 * Usage:
 *   AESO_API_KEY=<key> pnpm --filter @workspace/scripts run seed-aeso-real
 *
 * Gap-fill: skips months already fully populated in pool_price.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const _rawKey = process.env.AESO_API_KEY;
if (!_rawKey) {
  console.error("❌  AESO_API_KEY not set. Register free at https://developer-apim.aeso.ca");
  process.exit(1);
}
const API_KEY: string = _rawKey;

const BASE = "https://apimgw.aeso.ca/public";
const HEADERS: Record<string, string> = { "API-KEY": API_KEY };
const DELAY_MS = 400;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Date utilities ─────────────────────────────────────────────────────────

/**
 * Parse AESO datetime strings. Two formats are in use across the endpoints:
 *
 *   "01/01/2024 HE01" / "2024-01-01 HE01"   — explicit hour-ending marker
 *   "2026-06-01 00:00"                      — MPT clock time, NO HE marker
 *
 * The second form is what actualforecast-api returns. Previously the HE regex
 * simply failed to match it and hourEnding silently DEFAULTED TO 1, so every
 * row of a 24-hour day collapsed onto hour_ending = 1 and the ON CONFLICT
 * upsert kept overwriting the same row. That is a silent 24:1 data loss, not a
 * parse error — the run reported success.
 *
 * Clock time to hour-ending: MPT 00:00 begins the interval ENDING at 01:00, so
 * HE = hour + 1, and 23:00 -> HE 24. Throwing on an unrecognised format is
 * deliberate: defaulting is what caused the bug.
 */
function parseAesoDatetime(dt: string): { date: string; hourEnding: number } {
  const heMatch = dt.match(/HE(\d+)/i);
  const clockMatch = dt.match(/\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/);

  let hourEnding: number;
  if (heMatch) {
    hourEnding = parseInt(heMatch[1], 10);
  } else if (clockMatch) {
    hourEnding = parseInt(clockMatch[1], 10) + 1;   // 00:00 -> HE1, 23:00 -> HE24
  } else {
    throw new Error(
      `Cannot determine hour-ending from AESO datetime: "${dt}". ` +
      `Expected an HE## marker or an HH:MM clock time. Refusing to default ` +
      `to HE1 — that silently collapsed every day onto one hour.`,
    );
  }

  if (hourEnding < 1 || hourEnding > 24) {
    throw new Error(`Hour-ending ${hourEnding} out of range from "${dt}"`);
  }

  // MM/DD/YYYY
  const mdyMatch = dt.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return { date: `${y}-${m}-${d}`, hourEnding };
  }
  // YYYY-MM-DD
  const ymdMatch = dt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const [, y, m, d] = ymdMatch;
    return { date: `${y}-${m}-${d}`, hourEnding };
  }
  throw new Error(`Cannot parse AESO datetime: "${dt}"`);
}

/** Generate month windows from startYear/startMonth to today */
function* monthRange(startYear: number, startMonth: number): Generator<{ startDate: string; endDate: string; label: string }> {
  const today = new Date();
  let year = startYear;
  let month = startMonth;
  while (year < today.getFullYear() || (year === today.getFullYear() && month <= today.getMonth() + 1)) {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    const endCapped = end > today ? today : end;
    yield {
      startDate: start.toISOString().slice(0, 10),
      endDate: endCapped.toISOString().slice(0, 10),
      label: `${year}-${String(month).padStart(2, "0")}`,
    };
    month++;
    if (month > 12) { month = 1; year++; }
  }
}

/** Offset a date by N days */
function offsetDate(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function aFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers: HEADERS });
      if (res.status === 429) {
        console.warn(`    ⏳ Rate limited — waiting 5s (attempt ${attempt})`);
        await sleep(5000 * attempt);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status} from ${path}: ${body.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e as Error;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastErr!;
}

function safeFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

// ─── 1. Pool Price ───────────────────────────────────────────────────────────

async function seedPoolPrice(): Promise<void> {
  console.log("\n📈 Seeding pool price (Jan 2024 → today)...");
  let total = 0;

  // Check existing months to skip already-complete months
  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y,
           EXTRACT(MONTH FROM date)::int AS m,
           COUNT(*) AS cnt
    FROM aeso_hourly_pool_price
    GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ Pool price ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("poolprice-api/v1.1/price/poolPrice", { startDate, endDate }) as Record<string, unknown>;
      const rows = (data as Record<string, Record<string, unknown[]>>)?.return?.["Pool Price Report"] ?? [];

      if (!Array.isArray(rows) || rows.length === 0) {
        console.log(`  ⚠️  Pool price ${label}: empty response`);
        await sleep(DELAY_MS);
        continue;
      }

      const values = rows.map((r: Record<string, unknown>) => {
        const dt = parseAesoDatetime(String(r["begin_datetime_mpt"] ?? ""));
        return `(
          '${dt.date}', ${dt.hourEnding},
          ${safeFloat(r["pool_price"]) ?? "NULL"},
          ${safeFloat(r["forecast_pool_price"]) ?? "NULL"},
          ${safeFloat(r["rolling_30day_avg"]) ?? "NULL"}
        )`;
      }).join(",\n");

      await db.execute(sql.raw(`
        INSERT INTO aeso_hourly_pool_price (date, hour_ending, pool_price, forecast_pool_price, rolling_30d_avg)
        VALUES ${values}
        ON CONFLICT (date, hour_ending) DO UPDATE SET
          pool_price             = EXCLUDED.pool_price,
          forecast_pool_price    = EXCLUDED.forecast_pool_price,
          rolling_30d_avg        = EXCLUDED.rolling_30d_avg
      `));
      total += rows.length;
      console.log(`  ✓ Pool price ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ Pool price ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  Pool price total: ${total} rows`);
}

// ─── 2. Actual / Forecast AIL ────────────────────────────────────────────────

async function seedActualForecast(): Promise<void> {
  console.log("\n📊 Seeding actual/forecast AIL (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_actual_forecast
    GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ ActualForecast ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("actualforecast-api/v1/load/albertaInternalLoad", { startDate, endDate }) as Record<string, unknown>;
      const rows = (data as Record<string, Record<string, unknown[]>>)?.return?.["Actual Forecast Report"] ?? [];

      if (!Array.isArray(rows) || rows.length === 0) {
        console.log(`  ⚠️  ActualForecast ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      // FIELD NAMES CORRECTED 2026-08-04. The seeder was reading actual_ail,
      // forecast_ail, actual_posted_pool_price and friends — none of which this
      // endpoint returns. Verified response shape:
      //   begin_datetime_mpt              "2026-06-01 00:00"
      //   begin_datetime_utc              "2026-06-01 06:00"
      //   alberta_internal_load           "9115"   (string)
      //   forecast_alberta_internal_load  "9179"   (string)
      // It carries LOAD ONLY — no pool prices. Those come from the pool-price
      // endpoint, so the three price columns are NULL here by design.
      //
      // Every row previously parsed to all-NULL and the ON CONFLICT DO UPDATE
      // would have happily written them; the run reported "total: 0 rows" while
      // attempting to insert ~22k junk records. Guarded below.
      let parsed = 0;
      const values = rows.map((r: Record<string, unknown>) => {
        const dt = parseAesoDatetime(String(r["begin_datetime_mpt"] ?? ""));
        const actual = safeFloat(r["alberta_internal_load"]);
        const forecast = safeFloat(r["forecast_alberta_internal_load"]);
        if (actual !== null || forecast !== null) parsed++;
        const err = (actual !== null && forecast !== null)
          ? (forecast - actual).toFixed(2) : "NULL";
        return `(
          '${dt.date}', ${dt.hourEnding},
          NULL, NULL, NULL,
          ${forecast ?? "NULL"},
          ${actual ?? "NULL"},
          ${err}
        )`;
      }).join(",\n");

      // Abort rather than write a batch that parsed to nothing. An upstream
      // schema change is a recurring event and must not look like success.
      if (parsed === 0) {
        console.error(`  ❌ ActualForecast ${label}: ${rows.length} rows returned but `
          + `NONE parsed — the API field names have changed. Response keys: `
          + `${Object.keys(rows[0] ?? {}).join(", ")}`);
        process.exit(1);
      }

      await db.execute(sql.raw(`
        INSERT INTO aeso_actual_forecast
          (date, hour_ending, actual_pool_price, day_ahead_forecast_pool_price,
           rt_forecast_pool_price, forecast_ail_mw, actual_ail_mw, ail_forecast_error_mw)
        VALUES ${values}
        ON CONFLICT (date, hour_ending) DO UPDATE SET
          actual_pool_price              = EXCLUDED.actual_pool_price,
          day_ahead_forecast_pool_price  = EXCLUDED.day_ahead_forecast_pool_price,
          rt_forecast_pool_price         = EXCLUDED.rt_forecast_pool_price,
          forecast_ail_mw                = EXCLUDED.forecast_ail_mw,
          actual_ail_mw                  = EXCLUDED.actual_ail_mw,
          ail_forecast_error_mw          = EXCLUDED.ail_forecast_error_mw
      `));
      total += rows.length;
      console.log(`  ✓ ActualForecast ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ ActualForecast ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  ActualForecast total: ${total} rows`);
}

// ─── 3. AIES Generation Capacity (unit-level outage/capacity) ────────────────

async function seedGenCapacity(): Promise<void> {
  console.log("\n⚡ Seeding AIES gen capacity / outages (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_generation_outage
    GROUP BY y, m LIMIT 200
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ GenCapacity ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("aiesgencapacity-api/v1/AIESGenCapacity", { startDate, endDate }) as Record<string, unknown>;
      const rows = (data as Record<string, Record<string, unknown[]>>)?.return?.["AIES Gen Capacity Report"] ?? [];

      if (!Array.isArray(rows) || rows.length === 0) {
        console.log(`  ⚠️  GenCapacity ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      // Batch in chunks of 500
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
        const values = chunk.map((r: Record<string, unknown>) => {
          const dt = parseAesoDatetime(String(r["begin_datetime_mpt"] ?? ""));
          const assetId = String(r["asset_ID"] ?? r["asset_id"] ?? "").replace(/'/g, "''");
          const assetName = String(r["asset_name"] ?? r["assetName"] ?? "").replace(/'/g, "''");
          const ppId = String(r["pool_participant_ID"] ?? r["pool_participant_id"] ?? "").replace(/'/g, "''");
          const fuelType = String(r["fuel_type"] ?? r["fuelType"] ?? "").replace(/'/g, "''");
          return `(
            '${dt.date}', ${dt.hourEnding},
            '${assetId}', '${assetName}', '${ppId}', '${fuelType}',
            ${safeFloat(r["max_capability_mw"] ?? r["maxCapabilityMw"]) ?? "NULL"},
            ${safeFloat(r["available_capability_mw"] ?? r["availableCapabilityMw"]) ?? "NULL"},
            ${safeFloat(r["approved_outage_mw"] ?? r["approvedOutageMw"]) ?? "NULL"},
            ${safeFloat(r["outage_mw"] ?? r["outageMw"]) ?? "NULL"},
            ${r["outage_type"] ? `'${String(r["outage_type"]).replace(/'/g, "''")}'` : "NULL"},
            ${r["outage_reason"] ? `'${String(r["outage_reason"]).replace(/'/g, "''")}'` : "NULL"}
          )`;
        }).join(",\n");

        await db.execute(sql.raw(`
          INSERT INTO aeso_generation_outage
            (date, hour_ending, asset_id, asset_name, pool_participant_id, fuel_type,
             max_capability_mw, available_capability_mw, approved_outage_mw,
             outage_mw, outage_type, outage_reason)
          VALUES ${values}
          ON CONFLICT (date, hour_ending, asset_id) DO UPDATE SET
            max_capability_mw       = EXCLUDED.max_capability_mw,
            available_capability_mw = EXCLUDED.available_capability_mw,
            approved_outage_mw      = EXCLUDED.approved_outage_mw,
            outage_mw               = EXCLUDED.outage_mw,
            outage_type             = EXCLUDED.outage_type
        `));
      }
      total += rows.length;
      console.log(`  ✓ GenCapacity ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ GenCapacity ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  GenCapacity total: ${total} rows`);
}

// ─── 4. Operating Reserve Offer Control (FFR, contingency) ──────────────────

async function seedOperatingReserve(): Promise<void> {
  console.log("\n🔋 Seeding operating reserve (FFR, contingency) (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_operating_reserve
    GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ OpReserve ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("operatingreserveoffercontrol-api/v1/operatingReserveOfferControl", { startDate }) as Record<string, unknown>;
      // Response structure may vary — try common keys
      const raw = data as Record<string, unknown>;
      const ret = raw?.["return"] as Record<string, unknown> | undefined;
      const rows: Record<string, unknown>[] = [];

      // Flatten whatever the API returns into row objects
      if (ret) {
        for (const v of Object.values(ret)) {
          if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
        }
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  OpReserve ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const values = rows.map((r: Record<string, unknown>) => {
        const dtStr = String(
          r["begin_datetime_mpt"] ?? r["datetime_mpt"] ?? r["date"] ?? ""
        );
        let dt: { date: string; hourEnding: number };
        try { dt = parseAesoDatetime(dtStr); }
        catch { return null; }

        return `(
          '${dt.date}', ${dt.hourEnding},
          ${safeFloat(r["contingency_reserve_required_mw"] ?? r["contingency_reserve"]) ?? "NULL"},
          ${safeFloat(r["spinning_reserve_mw"] ?? r["spinning_reserve"]) ?? "NULL"},
          ${safeFloat(r["supplemental_reserve_mw"] ?? r["supplemental_reserve"]) ?? "NULL"},
          ${safeFloat(r["ffr_mw"] ?? r["fast_frequency_response_mw"] ?? r["ffr"]) ?? "NULL"},
          ${safeFloat(r["reg_up_mw"] ?? r["regulation_up_mw"]) ?? "NULL"},
          ${safeFloat(r["reg_down_mw"] ?? r["regulation_down_mw"]) ?? "NULL"},
          ${safeFloat(r["total_operating_reserve_mw"] ?? r["total_reserve_mw"]) ?? "NULL"}
        )`;
      }).filter(Boolean).join(",\n");

      if (!values) {
        console.log(`  ⚠️  OpReserve ${label}: no parseable rows`);
        await sleep(DELAY_MS);
        continue;
      }

      await db.execute(sql.raw(`
        INSERT INTO aeso_operating_reserve
          (date, hour_ending, contingency_reserve_required_mw, spinning_reserve_mw,
           supplemental_reserve_mw, ffr_mw, reg_up_mw, reg_down_mw, total_operating_reserve_mw)
        VALUES ${values}
        ON CONFLICT (date, hour_ending) DO UPDATE SET
          contingency_reserve_required_mw = EXCLUDED.contingency_reserve_required_mw,
          spinning_reserve_mw             = EXCLUDED.spinning_reserve_mw,
          supplemental_reserve_mw         = EXCLUDED.supplemental_reserve_mw,
          ffr_mw                          = EXCLUDED.ffr_mw,
          reg_up_mw                       = EXCLUDED.reg_up_mw,
          reg_down_mw                     = EXCLUDED.reg_down_mw,
          total_operating_reserve_mw      = EXCLUDED.total_operating_reserve_mw
      `));
      total += rows.length;
      console.log(`  ✓ OpReserve ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ OpReserve ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  OpReserve total: ${total} rows`);
}

// ─── 5. Load Outage Forecast (last 90 days) ──────────────────────────────────
// NOTE: aeso_outages table stores generation facility outages (different schema).
// Load outage forecast data is stored in aeso_supply_demand.load_outage_mw column.

async function seedLoadOutage(): Promise<void> {
  console.log("\n🚧 Seeding load outage forecast (last 90 days)...");
  const today = new Date();
  const start = offsetDate(today, -90);

  try {
    const data = await aFetch("loadoutageforecast-api/v1/loadOutageReport", {
      startDate: start.toISOString().slice(0, 10),
      endDate: today.toISOString().slice(0, 10),
    }) as Record<string, unknown>;

    const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
    const rows: Record<string, unknown>[] = [];
    for (const v of Object.values(ret)) {
      if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
    }

    if (rows.length === 0) {
      console.log("  ⚠️  Load outage: empty response");
      return;
    }

    // Store in aeso_supply_demand.load_outage_mw (add column if not exists)
    await db.execute(sql`
      ALTER TABLE aeso_supply_demand ADD COLUMN IF NOT EXISTS load_outage_mw numeric(10,2)
    `);

    const values = rows.map((r: Record<string, unknown>) => {
      const dtStr = String(r["begin_datetime_mpt"] ?? r["date"] ?? "");
      let dt: { date: string; hourEnding: number };
      try { dt = parseAesoDatetime(dtStr); }
      catch { return null; }
      const outage = safeFloat(r["load_outage_mw"] ?? r["outage_mw"] ?? r["forecast_load_outage_mw"]);
      return `('${dt.date}', ${dt.hourEnding}, ${outage ?? "NULL"})`;
    }).filter(Boolean).join(",\n");

    if (values) {
      await db.execute(sql.raw(`
        INSERT INTO aeso_supply_demand (date, hour_ending, load_outage_mw)
        VALUES ${values}
        ON CONFLICT (date, hour_ending) DO UPDATE SET
          load_outage_mw = EXCLUDED.load_outage_mw
      `));
      console.log(`  ✓ Load outage: ${rows.length} rows upserted into aeso_supply_demand`);
    }
  } catch (e: unknown) {
    console.error(`  ❌ Load outage: ${(e as Error).message}`);
  }
}

// ─── 6. Metered Volume — last 30 days, generator-level ──────────────────────

async function seedMeteredVolume(): Promise<void> {
  console.log("\n🏭 Seeding metered volumes (generator-level, last 30 days)...");
  const today = new Date();
  const start = offsetDate(today, -30);

  // Pull in 7-day chunks to avoid timeout
  const chunks: Array<{ s: string; e: string }> = [];
  let cur = new Date(start);
  while (cur < today) {
    const next = offsetDate(cur, 7);
    const e = next > today ? today : next;
    chunks.push({ s: cur.toISOString().slice(0, 10), e: e.toISOString().slice(0, 10) });
    cur = next;
  }

  let total = 0;
  for (const { s, e } of chunks) {
    try {
      const data = await aFetch("meteredvolume-api/v1/meteredvolume/details", {
        startDate: s, endDate: e,
      }) as Record<string, unknown>;

      const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(ret)) {
        if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  MeteredVol ${s}→${e}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
        const values = chunk.map((r: Record<string, unknown>) => {
          const dtStr = String(r["begin_datetime_mpt"] ?? r["datetime_mpt"] ?? "");
          let dt: { date: string; hourEnding: number };
          try { dt = parseAesoDatetime(dtStr); }
          catch { return null; }
          const assetId = String(r["asset_ID"] ?? r["asset_id"] ?? "").replace(/'/g, "''");
          const assetName = String(r["asset_name"] ?? "").replace(/'/g, "''");
          const ppId = String(r["pool_participant_ID"] ?? r["pool_participant_id"] ?? "").replace(/'/g, "''");
          const fuelType = String(r["fuel_type"] ?? r["fuelType"] ?? "").replace(/'/g, "''");
          return `(
            '${dt.date}', ${dt.hourEnding},
            '${assetId}', '${assetName}', '${ppId}', '${fuelType}',
            ${safeFloat(r["metered_volume_mw"] ?? r["metered_mw"] ?? r["metered_volume"]) ?? "NULL"}
          )`;
        }).filter(Boolean).join(",\n");

        if (values) {
          await db.execute(sql.raw(`
            INSERT INTO aeso_metered_volume
              (date, hour_ending, asset_id, asset_name, pool_participant_id, fuel_type, metered_mw)
            VALUES ${values}
            ON CONFLICT (date, hour_ending, asset_id) DO UPDATE SET
              metered_mw = EXCLUDED.metered_mw
          `));
        }
      }
      total += rows.length;
      console.log(`  ✓ MeteredVol ${s}→${e}: ${rows.length} rows`);
    } catch (e2: unknown) {
      console.error(`  ❌ MeteredVol ${s}→${e}: ${(e2 as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  MeteredVol total: ${total} rows`);
}

// ─── 7. Asset List (one-time registry) ──────────────────────────────────────

async function seedAssetList(): Promise<void> {
  console.log("\n🏗️  Seeding asset registry...");

  // Check if already seeded
  const existing = await db.execute(sql`SELECT COUNT(*) as cnt FROM aeso_asset_registry`);
  const cnt = parseInt(String(existing.rows[0]?.["cnt"] ?? "0"), 10);
  if (cnt > 100) {
    console.log(`  ✓ Asset registry already has ${cnt} records — skipping`);
    return;
  }

  try {
    const data = await aFetch("assetlist-api/v1/assetlist") as Record<string, unknown>;
    const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
    const rows: Record<string, unknown>[] = [];
    for (const v of Object.values(ret)) {
      if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
    }

    if (rows.length === 0) {
      console.log("  ⚠️  Asset list: empty response");
      return;
    }

    const CHUNK = 200;
    let total = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
      const values = chunk.map((r: Record<string, unknown>) => {
        const assetId = String(r["asset_ID"] ?? r["asset_id"] ?? "").replace(/'/g, "''");
        const assetName = String(r["asset_name"] ?? r["assetName"] ?? "").replace(/'/g, "''");
        const ppId = String(r["pool_participant_ID"] ?? r["pool_participant_id"] ?? "").replace(/'/g, "''");
        const ppName = String(r["pool_participant_name"] ?? "").replace(/'/g, "''");
        const fuelType = String(r["fuel_type"] ?? r["fuelType"] ?? "").replace(/'/g, "''");
        const subFuel = String(r["sub_fuel_type"] ?? r["subFuelType"] ?? "").replace(/'/g, "''");
        const location = String(r["location"] ?? r["region"] ?? "").replace(/'/g, "''");
        const status = String(r["operating_status"] ?? r["status"] ?? "active").replace(/'/g, "''");
        return `(
          '${assetId}', '${assetName}', '${ppId}', '${ppName}',
          '${fuelType}', '${subFuel}',
          ${safeFloat(r["max_capability_mw"] ?? r["maxCapabilityMw"]) ?? "NULL"},
          '${location}', '${status}'
        )`;
      }).join(",\n");

      if (values) {
        await db.execute(sql.raw(`
          INSERT INTO aeso_asset_registry
            (asset_id, asset_name, pool_participant_id, pool_participant_name,
             fuel_type, sub_fuel_type, max_capability_mw, location, status)
          VALUES ${values}
          ON CONFLICT (asset_id) DO UPDATE SET
            asset_name            = EXCLUDED.asset_name,
            max_capability_mw     = EXCLUDED.max_capability_mw,
            status                = EXCLUDED.status
        `));
        total += chunk.length;
      }
    }
    console.log(`  ✓ Asset registry: ${total} assets`);
  } catch (e: unknown) {
    console.error(`  ❌ Asset registry: ${(e as Error).message}`);
  }
}

// ─── 8. Pool Participants (one-time registry) ─────────────────────────────────

async function seedPoolParticipants(): Promise<void> {
  console.log("\n🏢 Seeding pool participants...");

  const existing = await db.execute(sql`SELECT COUNT(*) as cnt FROM aeso_pool_participants`);
  const cnt = parseInt(String(existing.rows[0]?.["cnt"] ?? "0"), 10);
  if (cnt > 50) {
    console.log(`  ✓ Pool participants already has ${cnt} records — skipping`);
    return;
  }

  try {
    const data = await aFetch("PoolParticipant-api/v1/poolparticipantlist") as Record<string, unknown>;
    const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
    const rows: Record<string, unknown>[] = [];
    for (const v of Object.values(ret)) {
      if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
    }

    if (rows.length === 0) {
      console.log("  ⚠️  Pool participants: empty response");
      return;
    }

    const values = rows.map((r: Record<string, unknown>) => {
      const id = String(r["pool_participant_ID"] ?? r["pool_participant_id"] ?? "").replace(/'/g, "''");
      const name = String(r["pool_participant_name"] ?? r["name"] ?? "").replace(/'/g, "''");
      const type = String(r["pool_participant_type"] ?? r["type"] ?? "").replace(/'/g, "''");
      const status = String(r["status"] ?? "active").replace(/'/g, "''");
      return `('${id}', '${name}', '${type}', '${status}')`;
    }).join(",\n");

    if (values) {
      await db.execute(sql.raw(`
        INSERT INTO aeso_pool_participants (participant_id, participant_name, participant_type, status)
        VALUES ${values}
        ON CONFLICT (participant_id) DO UPDATE SET
          participant_name = EXCLUDED.participant_name,
          status           = EXCLUDED.status
      `));
      console.log(`  ✓ Pool participants: ${rows.length} records`);
    }
  } catch (e: unknown) {
    console.error(`  ❌ Pool participants: ${(e as Error).message}`);
  }
}

// ─── 9. Energy Merit Order (supply stack) ────────────────────────────────────
//
// REWRITTEN 2026-08-04 against the ACTUAL response. The previous version never
// wrote a row and reported success, for two compounding reasons:
//
//  1. THE RESPONSE IS NESTED. It flattened `Object.values(return)` and got the
//     `data` array — one object PER HOUR — then looked for block fields on
//     those hour objects. The offers live one level deeper, in `energy_blocks`:
//
//       return.data[]            { begin_dateTime_mpt, energy_blocks[] }
//         └ energy_blocks[]      { asset_ID, block_price, block_size, ... }
//
//  2. NEARLY EVERY FIELD NAME WAS WRONG, including the capitalisation:
//       begin_datetime_mpt -> begin_dateTime_mpt   (capital T)
//       offer_price        -> block_price
//       block_mw           -> block_size / available_MW
//       dispatched_mw      -> dispatched_MW
//       merit_order_rank   -> block_number  (per-ASSET index, not a merit rank)
//
//     Those fallback chains (`offer_price ?? price ?? energy_price`) were three
//     guesses, and none was right. Verified shape from a live call, not assumed.
//
// PUBLICATION LAG: offers appear ~60 days after the fact. Confirmed by probe —
// 2026-06-01 returns data, 2026-06-20 returns "No Data available for this day".
// The old window ran to TODAY, so a third of its requests could only ever 400.
//
// NO fuel_type in this response, and no global merit rank. Fuel comes from
// aeso_asset_registry on asset_id. Stack position comes from from_MW/to_MW,
// which are already cumulative — better than a rank because they give the MW
// coordinate of each block directly.
const MERIT_ORDER_LAG_DAYS = 62;   // 60 + margin; the API is the authority

// How far back to pull, ending at the lag boundary. Default 90 days.
//
// SIZE: ~7,000 blocks/day, so 90 days is ~630k rows (~100-150 MB with indexes)
// and a full year would be ~2.5M rows (~400-600 MB). Capped at 365 — offers
// older than that describe a fleet that no longer exists (Alberta finished its
// coal phase-out in 2024), so they would make the supply stack less
// representative, not more.
//
// Override:  MERIT_ORDER_DAYS=180 pnpm --filter @workspace/scripts seed-aeso-real merit-order
const MERIT_ORDER_DAYS = Math.min(
  365,
  Math.max(1, parseInt(process.env.MERIT_ORDER_DAYS ?? "90", 10) || 90),
);

async function seedMeritOrder(): Promise<void> {
  const today = new Date();
  const latest = offsetDate(today, -MERIT_ORDER_LAG_DAYS);
  const start = offsetDate(latest, -MERIT_ORDER_DAYS);
  console.log(`\n📋 Seeding energy merit order / supply stack ` +
              `(${start.toISOString().slice(0, 10)} → ${latest.toISOString().slice(0, 10)}, ` +
              `${MERIT_ORDER_DAYS} days, ${MERIT_ORDER_LAG_DAYS}-day publication lag)...`);

  // One request per DAY — the endpoint takes a single startDate and returns
  // that day only (~1.6 MB, 24 hours of blocks).
  const days: string[] = [];
  let cur = new Date(start);
  while (cur <= latest) {
    days.push(cur.toISOString().slice(0, 10));
    cur = offsetDate(cur, 1);
  }

  // Skip days already seeded so this is a resumable gap-fill.
  const existingRes = await db.execute(sql`SELECT DISTINCT date::text AS d FROM aeso_merit_order`);
  const seeded = new Set<string>(existingRes.rows.map((r: Record<string, unknown>) => String(r["d"])));

  let total = 0;
  let skippedNoData = 0;
  for (const s of days) {
    if (seeded.has(s)) continue;
    try {
      const data = await aFetch("energymeritorder-api/v1/meritOrder/energy", {
        startDate: s,
      }) as Record<string, unknown>;

      // return.data[] — one entry per hour, each holding energy_blocks[]
      const hours = ((data as Record<string, Record<string, unknown>>)?.return?.["data"] ?? []) as Record<string, unknown>[];
      if (!Array.isArray(hours) || hours.length === 0) {
        console.log(`  ⚠️  MeritOrder ${s}: no hours in response`);
        await sleep(DELAY_MS);
        continue;
      }

      // Flatten to (hour, block) pairs.
      const rows: Array<{ dt: { date: string; hourEnding: number }; b: Record<string, unknown> }> = [];
      for (const h of hours) {
        const dtStr = String(h["begin_dateTime_mpt"] ?? h["begin_datetime_mpt"] ?? "");
        let dt: { date: string; hourEnding: number };
        try { dt = parseAesoDatetime(dtStr); }
        catch { continue; }
        const blocks = (h["energy_blocks"] ?? []) as Record<string, unknown>[];
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) rows.push({ dt, b });
      }

      if (rows.length === 0) {
        console.error(`  ❌ MeritOrder ${s}: ${hours.length} hours returned but ZERO blocks ` +
          `parsed — response shape has changed. Hour keys: ${Object.keys(hours[0] ?? {}).join(", ")}`);
        process.exit(1);
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values = chunk.map(({ dt, b }) => {
          // block_size is the MW width of this block; available_MW is what the
          // asset could actually deliver from it. Prefer block_size for the
          // supply curve, fall back to available_MW.
          const blockMw = safeFloat(b["block_size"] ?? b["available_MW"]) ?? 0;
          // from_MW is ALREADY the cumulative stack position where this block
          // starts, so no running total is needed — and unlike a hand-rolled
          // accumulator it stays correct regardless of the order rows arrive in.
          const cumMw = safeFloat(b["to_MW"] ?? b["from_MW"]) ?? 0;
          const rank = parseInt(String(b["block_number"] ?? "0"), 10) || null;
          const assetId = String(b["asset_ID"] ?? "").replace(/'/g, "''");
          const assetName = String(b["offer_control"] ?? "").replace(/'/g, "''");
          const ppId = String(b["import_or_export"] ?? "").replace(/'/g, "''");
          const fuelType = "";   // not in this response — join aeso_asset_registry
          const offerPrice = safeFloat(b["block_price"]);
          const dispatchedMw = safeFloat(b["dispatched_MW"]);
          const isMarginal = String(b["dispatched?"] ?? "N").toUpperCase() === "Y" ? "true" : "false";

          if (!assetId) return null;
          return `(
            '${dt.date}', ${dt.hourEnding},
            ${rank ?? "NULL"},
            '${assetId}', '${assetName}', '${ppId}', '${fuelType}',
            ${blockMw || "NULL"},
            ${offerPrice ?? "NULL"},
            ${dispatchedMw ?? "NULL"},
            ${cumMw},
            ${isMarginal}
          )`;
        }).filter(Boolean).join(",\n");

        if (values) {
          await db.execute(sql.raw(`
            INSERT INTO aeso_merit_order
              (date, hour_ending, merit_order_rank, asset_id, asset_name,
               pool_participant_id, fuel_type, block_mw, offer_price,
               dispatched_mw, cumulative_mw, is_marginal)
            VALUES ${values}
            ON CONFLICT (date, hour_ending, asset_id, merit_order_rank) DO UPDATE SET
              block_mw      = EXCLUDED.block_mw,
              offer_price   = EXCLUDED.offer_price,
              dispatched_mw = EXCLUDED.dispatched_mw,
              cumulative_mw = EXCLUDED.cumulative_mw,
              is_marginal   = EXCLUDED.is_marginal
          `));
        }
      }
      total += rows.length;
      console.log(`  ✓ MeritOrder ${s}: ${rows.length} blocks`);
    } catch (e2: unknown) {
      const msg = (e2 as Error).message;
      // "No Data available for this day" is AESO stating the obvious for dates
      // inside the publication lag or before coverage — not a failure.
      if (msg.includes("No Data available")) {
        skippedNoData++;
      } else {
        console.error(`  ❌ MeritOrder ${s}: ${msg}`);
      }
    }
    await sleep(DELAY_MS);
  }
  console.log(`  MeritOrder total: ${total.toLocaleString()} blocks` +
              (skippedNoData ? `  (${skippedNoData} days had no data published)` : ""));
}

// ─── 10. Intertie Outages (BC/SK flowgate outages) ───────────────────────────

async function seedIntertiOutage(): Promise<void> {
  console.log("\n🔌 Seeding intertie/flowgate outages (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_intertie_outage GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ IntertieOutage ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("itc/v1/outage", { startDate, endDate }) as Record<string, unknown>;
      const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(ret)) {
        if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  IntertieOutage ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const values = rows.map((r: Record<string, unknown>) => {
        const dtStr = String(r["begin_datetime_mpt"] ?? r["date"] ?? "");
        let dt: { date: string; hourEnding: number };
        try { dt = parseAesoDatetime(dtStr); }
        catch { return null; }
        const itc = String(r["intertie_or_flowgate"] ?? r["intertie"] ?? r["flowgate"] ?? "").replace(/'/g, "''");
        const affected = String(r["affected_intertie"] ?? r["affected_intertie_or_flowgate"] ?? itc).replace(/'/g, "''");
        const outageType = String(r["outage_type"] ?? "").replace(/'/g, "''");
        const reason = String(r["outage_reason"] ?? r["reason"] ?? "").replace(/'/g, "''");
        return `(
          '${dt.date}', ${dt.hourEnding},
          '${itc}', '${affected}',
          ${safeFloat(r["outage_mw"] ?? r["outage_capability_mw"]) ?? "NULL"},
          ${safeFloat(r["available_transfer_mw"] ?? r["available_capability_mw"]) ?? "NULL"},
          ${outageType ? `'${outageType}'` : "NULL"},
          ${reason ? `'${reason}'` : "NULL"}
        )`;
      }).filter(Boolean).join(",\n");

      if (values) {
        await db.execute(sql.raw(`
          INSERT INTO aeso_intertie_outage
            (date, hour_ending, intertie_or_flowgate, affected_intertie,
             outage_mw, available_transfer_mw, outage_type, outage_reason)
          VALUES ${values}
          ON CONFLICT (date, hour_ending, intertie_or_flowgate) DO UPDATE SET
            outage_mw             = EXCLUDED.outage_mw,
            available_transfer_mw = EXCLUDED.available_transfer_mw,
            outage_type           = EXCLUDED.outage_type
        `));
        total += rows.length;
        console.log(`  ✓ IntertieOutage ${label}: ${rows.length} rows`);
      }
    } catch (e: unknown) {
      console.error(`  ❌ IntertieOutage ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  IntertieOutage total: ${total} rows`);
}

// ─── 11. Interchange (actual + scheduled BC/SK flows) ─────────────────────────

async function seedInterchange(): Promise<void> {
  console.log("\n↔️  Seeding interchange actual/scheduled (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_interchange GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ Interchange ${label} already seeded`);
      continue;
    }
    try {
      // version=1 = preliminary settlement data; HE range 1-24 for full day
      const data = await aFetch("itc/v1/interchange", {
        startDate,
        endDate,
        startHE: "1",
        endHE: "24",
        version: "1",
      }) as Record<string, unknown>;

      const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(ret)) {
        if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  Interchange ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
        const values = chunk.map((r: Record<string, unknown>) => {
          const dtStr = String(r["begin_datetime_mpt"] ?? r["datetime_mpt"] ?? r["date"] ?? "");
          let dt: { date: string; hourEnding: number };
          try { dt = parseAesoDatetime(dtStr); }
          catch { return null; }
          const itc = String(r["intertie_or_flowgate"] ?? r["intertie"] ?? "").replace(/'/g, "''");
          const transferType = String(r["transfer_type"] ?? r["transferType"] ?? "").replace(/'/g, "''");
          const dataType = String(r["data_type"] ?? r["dataType"] ?? "actual").replace(/'/g, "''");
          const ver = parseInt(String(r["version"] ?? "1"), 10);
          const scheduled = safeFloat(r["scheduled_mw"] ?? r["schedule_mw"]);
          const actual = safeFloat(r["actual_mw"] ?? r["actual"]);
          const net = safeFloat(r["net_mw"] ?? (actual !== null ? actual : null));
          return `(
            '${dt.date}', ${dt.hourEnding},
            '${itc}', '${transferType}', '${dataType}',
            ${scheduled ?? "NULL"}, ${actual ?? "NULL"}, ${net ?? "NULL"}, ${ver}
          )`;
        }).filter(Boolean).join(",\n");

        if (values) {
          await db.execute(sql.raw(`
            INSERT INTO aeso_interchange
              (date, hour_ending, intertie_or_flowgate, transfer_type, data_type,
               scheduled_mw, actual_mw, net_mw, version)
            VALUES ${values}
            ON CONFLICT (date, hour_ending, intertie_or_flowgate, data_type) DO UPDATE SET
              scheduled_mw  = EXCLUDED.scheduled_mw,
              actual_mw     = EXCLUDED.actual_mw,
              net_mw        = EXCLUDED.net_mw,
              version       = EXCLUDED.version
          `));
        }
      }
      total += rows.length;
      console.log(`  ✓ Interchange ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ Interchange ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  Interchange total: ${total} rows`);
}

// ─── 12. System Marginal Price ────────────────────────────────────────────────

async function seedSMP(): Promise<void> {
  console.log("\n💲 Seeding system marginal price (Jan 2024 → today)...");
  let total = 0;

  const existingRes = await db.execute(sql`
    SELECT EXTRACT(YEAR FROM date)::int AS y, EXTRACT(MONTH FROM date)::int AS m
    FROM aeso_smp GROUP BY y, m
  `);
  const existing = new Set<string>(
    existingRes.rows.map((r: Record<string, unknown>) => `${r["y"]}-${String(r["m"]).padStart(2, "0")}`)
  );

  for (const { startDate, endDate, label } of monthRange(2024, 1)) {
    if (existing.has(label)) {
      console.log(`  ✓ SMP ${label} already seeded`);
      continue;
    }
    try {
      const data = await aFetch("systemmarginalprice-api/v1.1/price/systemMarginalPrice", {
        startDate,
        endDate,
      }) as Record<string, unknown>;

      const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(ret)) {
        if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  SMP ${label}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
        const values = chunk.map((r: Record<string, unknown>) => {
          const dtStr = String(r["begin_datetime_mpt"] ?? r["datetime_mpt"] ?? "");
          let dt: { date: string; hourEnding: number };
          try { dt = parseAesoDatetime(dtStr); }
          catch { return null; }

          const constrained   = safeFloat(r["constrained_price"] ?? r["system_marginal_price"] ?? r["smp"]);
          const unconstrained = safeFloat(r["unconstrained_price"] ?? r["unconstrained_system_marginal_price"]);
          const spread        = constrained !== null && unconstrained !== null ? constrained - unconstrained : null;
          const volume        = safeFloat(r["volume_mw"] ?? r["dispatched_mw"] ?? r["mw"]);

          return `(
            '${dt.date}', ${dt.hourEnding},
            ${constrained ?? "NULL"},
            ${unconstrained ?? "NULL"},
            ${spread ?? "NULL"},
            ${volume ?? "NULL"}
          )`;
        }).filter(Boolean).join(",\n");

        if (values) {
          await db.execute(sql.raw(`
            INSERT INTO aeso_smp (date, hour_ending, constrained_price, unconstrained_price, spread, volume_mw)
            VALUES ${values}
            ON CONFLICT (date, hour_ending) DO UPDATE SET
              constrained_price   = EXCLUDED.constrained_price,
              unconstrained_price = EXCLUDED.unconstrained_price,
              spread              = EXCLUDED.spread,
              volume_mw           = EXCLUDED.volume_mw
          `));
        }
      }
      total += rows.length;
      console.log(`  ✓ SMP ${label}: ${rows.length} rows`);
    } catch (e: unknown) {
      console.error(`  ❌ SMP ${label}: ${(e as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  SMP total: ${total} rows`);
}

// ─── 13. Unit Commitment Data ─────────────────────────────────────────────────

async function seedUnitCommitment(): Promise<void> {
  console.log("\n⚙️  Seeding unit commitment data (last 90 days)...");
  const today = new Date();
  const start = offsetDate(today, -90);
  let total = 0;

  const chunks: Array<{ s: string; e: string }> = [];
  let cur = new Date(start);
  while (cur < today) {
    const next = offsetDate(cur, 7);
    const e = next > today ? today : next;
    chunks.push({ s: cur.toISOString().slice(0, 10), e: e.toISOString().slice(0, 10) });
    cur = next;
  }

  for (const { s, e } of chunks) {
    try {
      const data = await aFetch("unitcommitmentdata-api/v2/unitCommitment", {
        startDate: s,
        endDate:   e,
      }) as Record<string, unknown>;

      const ret = (data as Record<string, Record<string, unknown[]>>)?.return ?? {};
      const rows: Record<string, unknown>[] = [];
      for (const v of Object.values(ret)) {
        if (Array.isArray(v)) rows.push(...v as Record<string, unknown>[]);
      }

      if (rows.length === 0) {
        console.log(`  ⚠️  UnitCommitment ${s}: empty`);
        await sleep(DELAY_MS);
        continue;
      }

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK) as Record<string, unknown>[];
        const values = chunk.map((r: Record<string, unknown>) => {
          const dtStr = String(r["begin_datetime_mpt"] ?? r["datetime_mpt"] ?? "");
          let dt: { date: string; hourEnding: number };
          try { dt = parseAesoDatetime(dtStr); }
          catch { return null; }

          const assetId   = String(r["asset_ID"] ?? r["asset_id"] ?? "").replace(/'/g, "''");
          const assetName = String(r["asset_name"] ?? "").replace(/'/g, "''");
          const fuelType  = String(r["fuel_type"] ?? r["fuelType"] ?? "").replace(/'/g, "''");
          const committed = safeFloat(r["committed_mw"] ?? r["commitment_mw"]);
          const dispatched = safeFloat(r["dispatched_mw"] ?? r["dispatch_mw"]);
          const available  = safeFloat(r["available_mw"] ?? r["max_mw"]);
          const mustRun    = String(r["must_run_ind"] ?? r["must_run"] ?? "0") === "1" ? "true" : "false";
          const status     = String(r["commitment_status"] ?? r["status"] ?? "").replace(/'/g, "''");

          return `(
            '${dt.date}', ${dt.hourEnding},
            '${assetId}', ${assetName ? `'${assetName}'` : "NULL"},
            ${fuelType ? `'${fuelType}'` : "NULL"},
            ${committed ?? "NULL"}, ${dispatched ?? "NULL"}, ${available ?? "NULL"},
            ${mustRun}, ${status ? `'${status}'` : "NULL"}
          )`;
        }).filter(Boolean).join(",\n");

        if (values) {
          await db.execute(sql.raw(`
            INSERT INTO aeso_unit_commitment
              (date, hour_ending, asset_id, asset_name, fuel_type,
               committed_mw, dispatched_mw, available_mw, must_run, commitment_status)
            VALUES ${values}
            ON CONFLICT (date, hour_ending, asset_id) DO UPDATE SET
              committed_mw      = EXCLUDED.committed_mw,
              dispatched_mw     = EXCLUDED.dispatched_mw,
              available_mw      = EXCLUDED.available_mw,
              must_run          = EXCLUDED.must_run,
              commitment_status = EXCLUDED.commitment_status
          `));
        }
      }
      total += rows.length;
      console.log(`  ✓ UnitCommitment ${s}→${e}: ${rows.length} rows`);
    } catch (e2: unknown) {
      console.error(`  ❌ UnitCommitment ${s}: ${(e2 as Error).message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`  UnitCommitment total: ${total} rows`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

// Named sections so one can be run without the others. Added 2026-08-04:
// an audit found aeso_merit_order and aeso_actual_forecast EMPTY while
// aeso_metered_volume held 14.9M rows, and the only way to fill the two empty
// ones was a full re-run that would re-walk metered volume for no reason.
//
// The merit_order gap was the expensive one. aeso_generators.py builds the
// per-unit supply stack from real offer prices in that table, which is what
// fixes the flat-LMP problem in the regional OPF. With the table empty every
// unit silently fell back to CARRIER_MC — six flat prices — so the fix was
// present in code, wired in, and completely inert. Nothing reported this
// because the fallback is deliberate and logs only a warning.
const SECTIONS: Record<string, () => Promise<void>> = {
  "pool-price":       seedPoolPrice,
  "actual-forecast":  seedActualForecast,   // AIL — actual_ail_mw / forecast_ail_mw
  "gen-capacity":     seedGenCapacity,
  "operating-reserve": seedOperatingReserve,
  "load-outage":      seedLoadOutage,
  "metered-volume":   seedMeteredVolume,    // per-generator hourly output (large)
  "asset-list":       seedAssetList,
  "pool-participants": seedPoolParticipants,
  "merit-order":      seedMeritOrder,       // per-asset offer prices
  "intertie-outage":  seedIntertiOutage,
  "interchange":      seedInterchange,
  // NOT in DEFAULT_SECTIONS — opt-in only. See note below.
  "smp":              seedSMP,
  "unit-commitment":  seedUnitCommitment,
};

// Sections run when no arguments are given.
//
// EXCLUDED and why:
//   smp — AESO's System Marginal Price re-prices whenever the marginal offer
//     changes, i.e. sub-minute. Storing it HOURLY discards the intra-hour
//     variation that is the only reason to want it, and storing it natively
//     would be very large. The hourly pool price already IS its time-weighted
//     average, and nothing in the platform reads aeso_smp. It has also failed
//     with a schema mismatch on every month since 2024-01, so it has never
//     worked. Run explicitly if intra-hour volatility work ever starts.
//   unit-commitment — the v2 endpoint returns an empty array for historical
//     dates; nothing to seed.
const DEFAULT_SECTIONS = Object.keys(SECTIONS)
  .filter(s => s !== "smp" && s !== "unit-commitment");

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter(a => !a.startsWith("-"));
  const invalid = requested.filter(s => !(s in SECTIONS));
  if (invalid.length) {
    console.error(`Unknown section(s): ${invalid.join(", ")}`);
    console.error(`Available: ${Object.keys(SECTIONS).join(", ")}`);
    process.exit(1);
  }
  const toRun = requested.length ? requested : DEFAULT_SECTIONS;

  console.log("🍁 AESO Real Data Seeder");
  console.log("   Base URL:", BASE);
  // Never log any portion of the key — a prefix still narrows a brute-force
  // search and can leak into shared CI/PM2 logs. Confirm presence only.
  console.log("   API key:", API_KEY ? "configured" : "MISSING");
  console.log("   Date range: Jan 2024 → today");
  console.log("   Sections:", toRun.join(", "));
  console.log("");

  // Sequential by design — the gateway rate-limits, and each section already
  // skips months it has fully seeded, so re-running is a safe gap-fill.
  for (const name of toRun) {
    await SECTIONS[name]!();
  }

  console.log("\n✅ AESO real data seeding complete!");
  process.exit(0);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
