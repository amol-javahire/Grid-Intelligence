-- ═══════════════════════════════════════════════════════════════════════════
-- create-aeso-generation-stack.sql
--
-- Capacity factor / capture price / capture rate for the AESO Generation Stack.
--
-- WEIGHTING RULES (these are the whole point — get them wrong and every number
-- is plausible and false):
--     capacity factor  → capacity-hour weighted
--     capture price    → generation weighted
--     pool price       → hour weighted
--     capture rate     → computed AFTER aggregating the two prices
--
-- The trailing-12-month figures are NOT averages of the twelve monthly figures.
-- Monthly rows store raw COMPONENTS (generation, pool revenue, capacity-hours,
-- hours). TTM sums the components and divides once. Summing numerators and
-- denominators is algebraically identical to recomputing from hourly data, and
-- it is what makes AVG(monthly_capture_rate) unnecessary — that average
-- overweights months where the asset barely ran.
--
-- HOUR SPINE: hours come from aeso_pool_price, never from aeso_metered_volume.
-- Assets have gaps (~17% of hours missing fleet-wide). Counting only metered
-- hours would drop an asset's offline hours out of the denominator and inflate
-- its capacity factor. On the price spine a missing hour is zero generation,
-- which is what an offline hour actually means.
--
-- CAPACITY IS A SNAPSHOT. max_capability_mw comes from the ETS CSD report as of
-- the last seeder run. Capacity-hours accrue only between an asset's first and
-- last metered hour, which handles commissioning and retirement correctly. It
-- does NOT handle mid-window repowering or expansion: such an asset gets
-- today's larger MC applied to its earlier smaller output and reads low. Those
-- assets are flagged in aeso_asset_ttm.capacity_caveat rather than silently
-- averaged into fleet numbers.
--
-- UNITS: aeso_metered_volume.metered_mw is MWh delivered in the hour (AESO's
-- field is metered_volume). Interval is one hour, so MW and MWh are numerically
-- identical here and no interval multiplier is applied.
--
-- Run:  psql "$DATABASE_URL" -f infra/create-aeso-generation-stack.sql
-- ═══════════════════════════════════════════════════════════════════════════

DROP MATERIALIZED VIEW IF EXISTS aeso_asset_monthly CASCADE;
DROP MATERIALIZED VIEW IF EXISTS aeso_pool_monthly  CASCADE;

-- ── 1. Hour-weighted pool price per month ──────────────────────────────────
-- Computed from the COMPLETE price series, independent of any generator's
-- production. Restricting this to hours a generator ran would compare the
-- generator against itself and force every capture rate toward 100%.
CREATE MATERIALIZED VIEW aeso_pool_monthly AS
SELECT
    date_trunc('month', date)::date       AS month,
    COUNT(*)                              AS hours,
    SUM(pool_price)                       AS sum_price,
    AVG(pool_price)                       AS avg_pool_price,
    COUNT(*) FILTER (WHERE pool_price <= 0) AS zero_or_neg_hours
FROM aeso_pool_price
WHERE pool_price IS NOT NULL
GROUP BY 1;

CREATE UNIQUE INDEX aeso_pool_monthly_pk ON aeso_pool_monthly (month);

-- ── 2. Per-asset operating window ──────────────────────────────────────────
-- First/last metered hour is our commissioning and retirement proxy. Capacity
-- only accrues inside this window.
CREATE OR REPLACE VIEW aeso_asset_window AS
SELECT asset_id,
       MIN(date) AS first_metered,
       MAX(date) AS last_metered
FROM aeso_metered_volume
WHERE metered_mw IS NOT NULL
GROUP BY 1;

-- ── 3. Monthly components per asset ────────────────────────────────────────
CREATE MATERIALIZED VIEW aeso_asset_monthly AS
WITH gen AS (
    SELECT
        date_trunc('month', mv.date)::date              AS month,
        mv.asset_id,
        -- Net of any charging/station-service; the economically real figure.
        SUM(mv.metered_mw)                              AS gen_mwh_net,
        -- Discharge/production only — the meaningful numerator for storage.
        SUM(GREATEST(mv.metered_mw, 0))                 AS gen_mwh_pos,
        -- Pool revenue. Zero and negative prices are PRESERVED: a wind farm
        -- earning a negative price is the entire point of capture analysis.
        SUM(mv.metered_mw * pp.pool_price)              AS pool_revenue,
        SUM(GREATEST(mv.metered_mw, 0) * pp.pool_price) AS pool_revenue_pos,
        COUNT(*)                                        AS metered_hours,
        COUNT(*) FILTER (WHERE pp.pool_price < 0
                           AND mv.metered_mw > 0)       AS neg_price_gen_hours
    FROM aeso_metered_volume mv
    JOIN aeso_pool_price pp
      ON pp.date = mv.date AND pp.hour_ending = mv.hour_ending
    WHERE pp.pool_price IS NOT NULL
    GROUP BY 1, 2
),
-- Capacity-hours on the PRICE spine, clipped to the asset's operating window.
cap AS (
    SELECT
        pm.month,
        w.asset_id,
        COUNT(*) AS capacity_hours_raw     -- hours in month inside the window
    FROM aeso_pool_price pp
    JOIN LATERAL (SELECT date_trunc('month', pp.date)::date AS month) pm ON TRUE
    JOIN aeso_asset_window w
      ON pp.date >= w.first_metered AND pp.date <= w.last_metered
    WHERE pp.pool_price IS NOT NULL
    GROUP BY 1, 2
)
SELECT
    g.month,
    g.asset_id,
    ar.asset_name,
    ar.fuel_type,
    ar.max_capability_mw                                        AS mc_mw,

    -- raw components (TTM sums THESE, never the ratios below)
    g.gen_mwh_net,
    g.gen_mwh_pos,
    g.pool_revenue,
    g.pool_revenue_pos,
    c.capacity_hours_raw                                        AS operating_hours,
    (c.capacity_hours_raw * ar.max_capability_mw)               AS capacity_mwh,
    pm.hours                                                    AS month_hours,
    g.metered_hours,
    g.neg_price_gen_hours,

    -- derived monthly ratios (for the trend chart only)
    CASE WHEN ar.max_capability_mw > 0 AND c.capacity_hours_raw > 0
         THEN g.gen_mwh_pos / (c.capacity_hours_raw * ar.max_capability_mw)
    END                                                         AS capacity_factor,
    CASE WHEN g.gen_mwh_pos > 0
         THEN g.pool_revenue_pos / g.gen_mwh_pos
    END                                                         AS capture_price,
    pm.avg_pool_price,
    CASE WHEN g.gen_mwh_pos > 0 AND pm.avg_pool_price <> 0
         THEN (g.pool_revenue_pos / g.gen_mwh_pos) / pm.avg_pool_price
    END                                                         AS capture_rate,
    -- Stays meaningful when avg_pool_price approaches zero and the rate blows up.
    CASE WHEN g.gen_mwh_pos > 0
         THEN (g.pool_revenue_pos / g.gen_mwh_pos) - pm.avg_pool_price
    END                                                         AS capture_spread
FROM gen g
JOIN cap c              ON c.month = g.month AND c.asset_id = g.asset_id
JOIN aeso_pool_monthly pm ON pm.month = g.month
JOIN aeso_asset_registry ar ON ar.asset_id = g.asset_id
-- The 230 CSD generators. Load, retail, intertie and financial assets are
-- excluded here rather than downstream so no tab can accidentally include them.
WHERE ar.max_capability_mw > 0;

CREATE UNIQUE INDEX aeso_asset_monthly_pk  ON aeso_asset_monthly (asset_id, month);
CREATE INDEX        aeso_asset_monthly_fuel ON aeso_asset_monthly (fuel_type, month);

-- ── 4. Trailing 12 months ──────────────────────────────────────────────────
-- Components summed, then divided ONCE. Not an average of monthly ratios.
CREATE OR REPLACE VIEW aeso_asset_ttm AS
WITH bounds AS (
    -- Anchor on the data, not CURRENT_DATE: metered volume lags settlement by
    -- a few days, so "last 12 months" from today would include an empty tail.
    SELECT date_trunc('month', MAX(month))::date AS end_month
    FROM aeso_asset_monthly
),
win AS (
    SELECT m.*
    FROM aeso_asset_monthly m, bounds b
    WHERE m.month > (b.end_month - INTERVAL '12 months')
      AND m.month <= b.end_month
),
agg AS (
    SELECT
        asset_id,
        MAX(asset_name)                 AS asset_name,
        MAX(fuel_type)                  AS fuel_type,
        MAX(mc_mw)                      AS mc_mw,
        COUNT(*)                        AS months_present,
        SUM(gen_mwh_pos)                AS ttm_gen_mwh,
        SUM(pool_revenue_pos)           AS ttm_pool_revenue,
        SUM(capacity_mwh)               AS ttm_capacity_mwh,
        SUM(operating_hours)            AS ttm_operating_hours,
        SUM(neg_price_gen_hours)        AS ttm_neg_price_gen_hours
    FROM win GROUP BY asset_id
),
-- Hour-weighted pool price across the same window.
pool AS (
    SELECT SUM(pm.sum_price) / NULLIF(SUM(pm.hours), 0) AS ttm_pool_price,
           SUM(pm.hours)                                AS ttm_hours
    FROM aeso_pool_monthly pm, bounds b
    WHERE pm.month > (b.end_month - INTERVAL '12 months')
      AND pm.month <= b.end_month
)
SELECT
    a.asset_id,
    a.asset_name,
    a.fuel_type,
    a.mc_mw,
    a.months_present,
    a.ttm_gen_mwh,
    a.ttm_capacity_mwh,
    a.ttm_neg_price_gen_hours,
    p.ttm_pool_price,

    a.ttm_gen_mwh / NULLIF(a.ttm_capacity_mwh, 0)          AS capacity_factor,
    a.ttm_pool_revenue / NULLIF(a.ttm_gen_mwh, 0)          AS capture_price,
    (a.ttm_pool_revenue / NULLIF(a.ttm_gen_mwh, 0))
        / NULLIF(p.ttm_pool_price, 0)                      AS capture_rate,
    (a.ttm_pool_revenue / NULLIF(a.ttm_gen_mwh, 0))
        - p.ttm_pool_price                                 AS capture_spread,

    -- Honest labelling instead of a quietly wrong denominator.
    CASE
      WHEN a.months_present < 12 THEN 'PARTIAL: only '
           || a.months_present || ' of 12 months metered — commissioned or '
           || 'retired mid-window; capacity factor covers operating months only'
      ELSE NULL
    END                                                    AS capacity_caveat
FROM agg a CROSS JOIN pool p;

-- ── 5. Fleet rollup by fuel ────────────────────────────────────────────────
-- Same rule: sum components across assets, divide once. Never AVG() a ratio.
CREATE OR REPLACE VIEW aeso_fuel_ttm AS
SELECT
    t.fuel_type,
    COUNT(*)                                                   AS assets,
    SUM(t.mc_mw)                                               AS mc_mw,
    SUM(t.ttm_gen_mwh)                                         AS ttm_gen_mwh,
    SUM(t.ttm_gen_mwh) / NULLIF(SUM(t.ttm_capacity_mwh), 0)    AS capacity_factor,
    SUM(t.ttm_gen_mwh * t.capture_price)
        / NULLIF(SUM(t.ttm_gen_mwh), 0)                        AS capture_price,
    MAX(t.ttm_pool_price)                                      AS ttm_pool_price,
    (SUM(t.ttm_gen_mwh * t.capture_price) / NULLIF(SUM(t.ttm_gen_mwh), 0))
        / NULLIF(MAX(t.ttm_pool_price), 0)                     AS capture_rate,
    (SUM(t.ttm_gen_mwh * t.capture_price) / NULLIF(SUM(t.ttm_gen_mwh), 0))
        - MAX(t.ttm_pool_price)                                AS capture_spread,
    COUNT(*) FILTER (WHERE t.capacity_caveat IS NOT NULL)       AS partial_assets
FROM aeso_asset_ttm t
GROUP BY t.fuel_type;

ANALYZE aeso_pool_monthly;
ANALYZE aeso_asset_monthly;
