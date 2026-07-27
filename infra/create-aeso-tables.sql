-- ============================================================
-- Create the nine aeso_* tables that seed-aeso-real.ts writes to but which
-- have no Drizzle schema and do not exist on Azure.
--
-- The seeder contains no CREATE TABLE statements — it assumes these exist —
-- so without this migration those nine datasets fail with "relation does not
-- exist" while the three that do exist (pool_price, outages, actual_forecast)
-- seed normally.
--
-- Column names and ON CONFLICT keys are taken verbatim from the seeder's
-- INSERT statements so the upserts match exactly.
-- Idempotent: safe to re-run.
-- ============================================================

-- ── System Marginal Price ────────────────────────────────────────────────
-- Alberta's SMP is a SYSTEM-WIDE minute-level price set by the merit order;
-- pool price is its time-weighted hourly average. Not per-generator.
-- constrained vs unconstrained spread is Alberta's congestion-rent proxy.
CREATE TABLE IF NOT EXISTS aeso_smp (
    date                DATE    NOT NULL,
    hour_ending         INTEGER NOT NULL,
    constrained_price   NUMERIC(12,4),
    unconstrained_price NUMERIC(12,4),
    spread              NUMERIC(12,4),
    volume_mw           NUMERIC(12,2),
    created_at          TIMESTAMP DEFAULT now(),
    PRIMARY KEY (date, hour_ending)
);

-- ── Intertie flows (BC / SK / MATL) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS aeso_interchange (
    date                 DATE    NOT NULL,
    hour_ending          INTEGER NOT NULL,
    intertie_or_flowgate TEXT    NOT NULL,
    transfer_type        TEXT,
    data_type            TEXT    NOT NULL,
    scheduled_mw         NUMERIC(12,2),
    actual_mw            NUMERIC(12,2),
    net_mw               NUMERIC(12,2),
    version              TEXT,
    created_at           TIMESTAMP DEFAULT now(),
    PRIMARY KEY (date, hour_ending, intertie_or_flowgate, data_type)
);

-- ── Generator-level metered volumes (settlement quality) ─────────────────
-- This is the table the Generation Stack tab needs: hourly output per asset.
-- Source note: AESO's meteredvolume API is settlement-grade. The separate
-- published historical file stops at Jul 2025; CSD "Historical Generation
-- Data" continues but is unit generation, NOT settlement quality. If the two
-- are ever spliced, record which source each row came from.
CREATE TABLE IF NOT EXISTS aeso_metered_volume (
    date                 DATE    NOT NULL,
    hour_ending          INTEGER NOT NULL,
    asset_id             TEXT    NOT NULL,
    asset_name           TEXT,
    pool_participant_id  TEXT,
    fuel_type            TEXT,
    metered_mw           NUMERIC(12,2),
    created_at           TIMESTAMP DEFAULT now(),
    PRIMARY KEY (date, hour_ending, asset_id)
);
CREATE INDEX IF NOT EXISTS aeso_metered_volume_asset_idx ON aeso_metered_volume (asset_id);
CREATE INDEX IF NOT EXISTS aeso_metered_volume_date_idx  ON aeso_metered_volume (date);
CREATE INDEX IF NOT EXISTS aeso_metered_volume_fuel_idx  ON aeso_metered_volume (fuel_type);

-- ── Asset registry: the generator → fuel → owner → capability mapping ────
CREATE TABLE IF NOT EXISTS aeso_asset_registry (
    asset_id              TEXT PRIMARY KEY,
    asset_name            TEXT,
    pool_participant_id   TEXT,
    pool_participant_name TEXT,
    fuel_type             TEXT,
    sub_fuel_type         TEXT,
    max_capability_mw     NUMERIC(12,2),
    location              TEXT,
    status                TEXT,
    created_at            TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeso_asset_registry_fuel_idx ON aeso_asset_registry (fuel_type);

-- ── Merit order (offer stack) ────────────────────────────────────────────
-- No ON CONFLICT in the seeder — it appends. Surrogate key.
CREATE TABLE IF NOT EXISTS aeso_merit_order (
    id                  BIGSERIAL PRIMARY KEY,
    date                DATE    NOT NULL,
    hour_ending         INTEGER NOT NULL,
    merit_order_rank    INTEGER,
    asset_id            TEXT,
    asset_name          TEXT,
    pool_participant_id TEXT,
    fuel_type           TEXT,
    block_mw            NUMERIC(12,2),
    offer_price         NUMERIC(12,4),
    dispatched_mw       NUMERIC(12,2),
    cumulative_mw       NUMERIC(12,2),
    is_marginal         BOOLEAN,
    created_at          TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeso_merit_order_dt_idx ON aeso_merit_order (date, hour_ending);

-- ── Operating reserve ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aeso_operating_reserve (
    date                            DATE    NOT NULL,
    hour_ending                     INTEGER NOT NULL,
    contingency_reserve_required_mw NUMERIC(12,2),
    spinning_reserve_mw             NUMERIC(12,2),
    supplemental_reserve_mw         NUMERIC(12,2),
    ffr_mw                          NUMERIC(12,2),
    reg_up_mw                       NUMERIC(12,2),
    reg_down_mw                     NUMERIC(12,2),
    total_operating_reserve_mw      NUMERIC(12,2),
    created_at                      TIMESTAMP DEFAULT now(),
    PRIMARY KEY (date, hour_ending)
);

-- ── Pool participants ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aeso_pool_participants (
    participant_id   TEXT PRIMARY KEY,
    participant_name TEXT,
    participant_type TEXT,
    status           TEXT,
    created_at       TIMESTAMP DEFAULT now()
);

-- ── Generation outages ───────────────────────────────────────────────────
-- No ON CONFLICT in the seeder — surrogate key.
CREATE TABLE IF NOT EXISTS aeso_generation_outage (
    id                      BIGSERIAL PRIMARY KEY,
    date                    DATE    NOT NULL,
    hour_ending             INTEGER NOT NULL,
    asset_id                TEXT,
    asset_name              TEXT,
    pool_participant_id     TEXT,
    fuel_type               TEXT,
    max_capability_mw       NUMERIC(12,2),
    available_capability_mw NUMERIC(12,2),
    approved_outage_mw      NUMERIC(12,2),
    outage_mw               NUMERIC(12,2),
    outage_type             TEXT,
    outage_reason           TEXT,
    created_at              TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aeso_generation_outage_dt_idx ON aeso_generation_outage (date, hour_ending);

-- ── Intertie outages ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aeso_intertie_outage (
    date                 DATE    NOT NULL,
    hour_ending          INTEGER NOT NULL,
    intertie_or_flowgate TEXT    NOT NULL,
    affected_intertie    TEXT,
    outage_mw            NUMERIC(12,2),
    available_transfer_mw NUMERIC(12,2),
    outage_type          TEXT,
    outage_reason        TEXT,
    created_at           TIMESTAMP DEFAULT now(),
    PRIMARY KEY (date, hour_ending, intertie_or_flowgate)
);

-- ── Verify ───────────────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'aeso%'
ORDER BY table_name;
