#!/usr/bin/env python3
"""
calibrate-aeso-opf.py — does the AESO 9-bus OPF reproduce observed prices?

Nobody has ever checked. The model has been shipped, debugged and extended
without once being compared against reality. Every genuine defect found in this
platform surfaced from exactly this kind of comparison, so this runs the
regional OPF over historical hours with OBSERVED load and wind, and scores the
modelled price against the actual Alberta pool price.

WHAT CALIBRATION CAN AND CANNOT TELL US
---------------------------------------------------------------------------
Alberta is a SINGLE-PRICE POOL MARKET. Every generator settles at one
provincial pool price; there are no nodal prices in the real market. So:

  CAN validate  — the system price. Load-weighted average LMP vs pool price.
                  If the model is systematically high or low, that is real and
                  actionable.
  CANNOT validate — the per-bus LMP spread. There is no observed nodal price in
                  Alberta to compare against. Nodal separation here is a
                  congestion INDICATOR, not a price forecast, and must never be
                  presented as a predicted settlement price.

KNOWN BIASES GOING IN — three, in expected order of size
---------------------------------------------------------------------------
1. CHEAP HOURS: model runs HIGH.
   76% of Alberta hours settle under $30, averaging $13.26 — overnight wind
   normally holds prices under $20. If aeso_merit_order is empty, every unit
   falls back to CARRIER_MC whose cheapest dispatchable price is gas at ~$48.
   The model then has no way to price a cheap hour at all. Check the
   `supply stack used` line before reading anything else.

2. SPIKE HOURS: model runs LOW.
   Alberta spikes are COINCIDENT-EVENT driven, not load driven — two or more
   gas units out, plus solar drop-off, plus wind under-delivering, plus a steep
   ramp, plus the BC-AB tie on outage. A deterministic OPF at average
   availability cannot produce any of that, so it will under-predict the tail.
   Fixing this needs historical replay with real outages from
   aeso_generation_outage / aeso_intertie_outage — NOT marginal-cost tuning.

3. HIGH LOAD: model runs HIGH.
   The three boundary buses (BC/MT/SK) have no generator and no load attached,
   so all three ties carry exactly zero flow and Alberta is modelled as an
   island. ~1,260 MW of mostly cheap BC hydro is unavailable to the model.

STRUCTURAL LIMIT — do not expect calibration to fix this
---------------------------------------------------------------------------
Alberta's volatility now lives in the MORNING RAMP (before sunrise, solar not
yet up) and the EVENING RAMP (sunset, solar dropping as wind picks up); the
summer midday peak has been flattened by the solar buildout. A single-snapshot
OPF — set_snapshots(RangeIndex(1)) — has no ramp rates and no intertemporal
coupling, so it cannot represent ramp-driven volatility at all. Multi-period
with ramp constraints is a structural change, not a tuning exercise.

Calibration measures the price LEVEL. It cannot measure ramp behaviour, and a
good bias figure here should not be read as the model being fit for purpose.

Output goes to aeso_opf_calibration so the UI can show the model's accuracy
alongside its predictions, rather than presenting unvalidated numbers.

Run:
  cd ~/grid-intelligence && set -a; source .env; set +a
  artifacts/pypsa-engine/.venv/bin/python3 scripts/src/calibrate-aeso-opf.py --hours 400
  artifacts/pypsa-engine/.venv/bin/python3 scripts/src/calibrate-aeso-opf.py --hours 400 --apply
"""

import argparse
import os
import sys
from datetime import date

import polars as pl
import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "../../artifacts/pypsa-engine"))

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    sys.exit("DATABASE_URL not set")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--hours", type=int, default=300,
                   help="how many historical hours to sample (stratified by load)")
    p.add_argument("--start", default="2025-01-01")
    p.add_argument("--end", default=None, help="default: today")
    p.add_argument("--apply", action="store_true",
                   help="write results to aeso_opf_calibration")
    p.add_argument("--gas-price", type=float, default=2.20,
                   help="AECO-C $/MMBtu used for units priced by assumption")
    return p.parse_args()


def _query(conn, sql: str, params: tuple) -> list[tuple]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def load_observed(args) -> pl.DataFrame:
    """
    Observed hourly load, pool price and wind/solar output, joined on
    (date, hour_ending).

    Sources, all verified 2026-08-04 by row count rather than by schema:
      pool price  aeso_hourly_pool_price      (22.5k hrs, Jan 2024+)
      LOAD        aeso_actual_forecast        (NOT pool_price.ail_mw, 100% NULL)
      generation  aeso_hourly_gen_output_by_fuel_agg, long (fuel_type, gen_mw)
                  — NOT aeso_hourly_gen_output, an orphan with no writer.

    TIMEZONE: both tables are date + hour_ending 1..24 in MOUNTAIN time, so they
    join directly. Do NOT join either to an EIA-930 table on these columns —
    those are UTC hour-beginning. See iso_table_metadata.

    Uses psycopg2 directly rather than pl.read_database: the latter's
    execute_options parameter passing silently returned zero rows here rather
    than erroring, which is the worst possible failure mode for a calibration
    script — it would have reported "no data" for a query that was actually fine.
    """
    end = args.end or date.today().isoformat()
    conn = psycopg2.connect(DB_URL)

    # LOAD COMES FROM aeso_actual_forecast, NOT aeso_hourly_pool_price.
    # That table has an ail_mw column but it is 100% NULL — the pool-price
    # endpoint does not return load. AIL is published separately by
    # actualforecast-api and lands in aeso_actual_forecast.actual_ail_mw.
    # An earlier version of this script filtered on the NULL column and
    # reported "no observed hours", which read as missing price data.
    price_rows = _query(conn, """
        SELECT p.date::text, p.hour_ending, p.pool_price::float8, af.actual_ail_mw::float8
        FROM aeso_hourly_pool_price p
        JOIN aeso_actual_forecast af
          ON af.date = p.date AND af.hour_ending = p.hour_ending
        WHERE p.date >= %s AND p.date <= %s
          AND p.pool_price IS NOT NULL
          AND af.actual_ail_mw IS NOT NULL AND af.actual_ail_mw > 0
        ORDER BY p.date, p.hour_ending
    """, (args.start, end))
    price = pl.DataFrame(
        {"date": [r[0] for r in price_rows],
         "hour_ending": [int(r[1]) for r in price_rows],
         "pool_price": [float(r[2]) for r in price_rows],
         "ail_mw": [float(r[3]) for r in price_rows]},
    ) if price_rows else pl.DataFrame(
        schema={"date": pl.Utf8, "hour_ending": pl.Int64,
                "pool_price": pl.Float64, "ail_mw": pl.Float64})
    print(f"  pool price rows: {price.height:,}")

    try:
        # aeso_hourly_gen_output is an ORPHAN — wide shape, no writer, never had
        # a row. The real series is aeso_hourly_gen_output_by_fuel_agg, built
        # from aeso_metered_volume joined to the asset registry, in LONG form
        # (fuel_type, gen_mw) matching ERCOT/CAISO/PJM.
        gen_rows = _query(conn, """
            SELECT date::text, hour_ending,
                   COALESCE(SUM(gen_mw) FILTER (WHERE fuel_type = 'wind'), 0)::float8,
                   COALESCE(SUM(gen_mw) FILTER (WHERE fuel_type = 'solar'), 0)::float8
            FROM aeso_hourly_gen_output_by_fuel_agg
            WHERE date >= %s AND date <= %s
            GROUP BY date, hour_ending
            ORDER BY date, hour_ending
        """, (args.start, end))
        gen = pl.DataFrame(
            {"date": [r[0] for r in gen_rows],
             "hour_ending": [int(r[1]) for r in gen_rows],
             "wind_mw": [float(r[2]) for r in gen_rows],
             "solar_mw": [float(r[3]) for r in gen_rows]},
        ) if gen_rows else pl.DataFrame(
            schema={"date": pl.Utf8, "hour_ending": pl.Int64,
                    "wind_mw": pl.Float64, "solar_mw": pl.Float64})
        print(f"  generation rows: {gen.height:,}")
    except Exception as exc:                                     # noqa: BLE001
        print(f"  ⚠  wind/solar unavailable ({exc})\n"
              f"     Falling back to FIXED capacity factors, which weakens the "
              f"test materially — a wrong wind assumption produces a price error "
              f"that looks like a model defect. Fix the source before trusting "
              f"any bias figure below.")
        gen = pl.DataFrame(schema={"date": pl.Utf8, "hour_ending": pl.Int64,
                                   "wind_mw": pl.Float64, "solar_mw": pl.Float64})

    conn.close()

    df = price.join(gen, on=["date", "hour_ending"], how="left") if gen.height else price
    matched = df["wind_mw"].drop_nulls().len() if "wind_mw" in df.columns else 0
    print(f"  hours with observed wind: {matched:,} / {df.height:,}")
    return df


def stratified_sample(df: pl.DataFrame, n: int) -> pl.DataFrame:
    """
    Sample evenly across the LOAD range, not at random.

    A random sample is dominated by ordinary mid-load hours, which is where any
    model looks fine. The hours that matter for a PPA tool are the scarcity
    tails — and those are exactly where an islanded model (no imports) should
    break. Stratifying guarantees they are represented.
    """
    if df.height <= n:
        return df

    # Stratify on PRICE, not load.
    #
    # Measured 2025-07 onward, the Alberta price distribution is extreme:
    #   <$30      6,869 hrs (76%)  avg $13.26
    #   $30-80    1,967 hrs (22%)
    #   $80-300     367 hrs ( 4%)
    #   $300-999    187 hrs ( 2%)
    #   >=$999       12 hrs
    #
    # Price is the variable being predicted and it is what a PPA valuation is
    # sensitive to. A load-stratified or random sample would be ~76% cheap
    # hours and would barely touch the ~199 hours above $300 — precisely where
    # an islanded model (no imports) should fail hardest. Equal allocation per
    # band buys real statistical power in the tail at the cost of a sample that
    # is not representative of frequency, which is why the report weights
    # bands separately rather than quoting one pooled average.
    bands = [(-1e9, 30.0), (30.0, 80.0), (80.0, 300.0), (300.0, 999.0), (999.0, 1e9)]
    per_band = max(1, n // len(bands))
    parts = []
    for lo, hi in bands:
        sub = df.filter((pl.col("pool_price") >= lo) & (pl.col("pool_price") < hi))
        if sub.height == 0:
            continue
        take = min(per_band, sub.height)
        # Even stride through the band rather than a random draw, so the run is
        # reproducible and covers the whole band rather than clustering.
        k = sub.height / take
        parts.append(sub.sort("pool_price")[[int(i * k) for i in range(take)]])
    return pl.concat(parts) if parts else df.head(n)


def main() -> None:
    args = parse_args()
    from aeso_network_regional import run_opf, REGION_GENERATION, TOTAL_BASE_LOAD

    wind_cap = sum(f.get("wind", 0) for f in REGION_GENERATION.values())
    solar_cap = sum(f.get("solar", 0) for f in REGION_GENERATION.values())
    print(f"=== AESO OPF calibration ===")
    print(f"  model base load {TOTAL_BASE_LOAD:,.0f} MW | "
          f"wind capacity {wind_cap:,.0f} MW | solar {solar_cap:,.0f} MW\n")

    obs = load_observed(args)
    if obs.height == 0:
        sys.exit("No observed hours found — check aeso_hourly_pool_price coverage.")
    print(f"  {obs.height:,} observed hours available "
          f"({obs['date'].min()} → {obs['date'].max()})")

    sample = stratified_sample(obs, args.hours)
    print(f"  sampling {sample.height:,} hours, stratified across 5 PRICE bands")
    print(f"  (equal allocation per band — deliberately over-weights the "
          f"scarcity tail, so bands are reported separately below and the "
          f"pooled average is NOT frequency-representative)\n")

    rows = []
    for i, r in enumerate(sample.iter_rows(named=True), 1):
        load = float(r["ail_mw"])
        scale = load / TOTAL_BASE_LOAD
        wind_cf = (float(r["wind_mw"]) / wind_cap
                   if r.get("wind_mw") and wind_cap else 0.35)
        solar_cf = (float(r["solar_mw"]) / solar_cap
                    if r.get("solar_mw") and solar_cap else 0.22)
        wind_cf = min(max(wind_cf, 0.0), 1.0)
        solar_cf = min(max(solar_cf, 0.0), 1.0)

        try:
            res = run_opf(system_load_scale=scale, wind_cf=wind_cf,
                          solar_cf=solar_cf, gas_price_mmbtu=args.gas_price)
        except Exception as exc:                                 # noqa: BLE001
            print(f"  [{i}/{sample.height}] OPF failed: {exc}")
            continue
        if res.get("status") != "optimal":
            # Load shed means the model could not serve demand — usually the
            # islanded-supply problem. Recorded, not silently dropped.
            pass

        rows.append({
            "date": r["date"], "hour_ending": int(r["hour_ending"]),
            "observed_pool_price": float(r["pool_price"]),
            "modelled_price": float(res["avg_lmp_load_weighted"]),
            "observed_load_mw": load,
            "wind_cf": round(wind_cf, 4), "solar_cf": round(solar_cf, 4),
            "lmp_spread": float(res.get("lmp_spread", 0.0)),
            "unserved_mw": float(res.get("unserved_load_mw", 0.0)),
            "congestion_active": bool(res.get("congestion_active", False)),
            "supply_stack_source": res.get("supply_stack_source", "unknown"),
            "status": res.get("status", "unknown"),
        })
        if i % 25 == 0:
            print(f"  [{i}/{sample.height}] ...")

    if not rows:
        sys.exit("No successful OPF runs.")

    df = pl.DataFrame(rows).with_columns(
        (pl.col("modelled_price") - pl.col("observed_pool_price")).alias("error"),
    ).with_columns(pl.col("error").abs().alias("abs_error"))

    stack = df["supply_stack_source"].mode()[0]
    print(f"\n  supply stack used: {stack}")
    if stack != "asset_registry":
        print("  ⚠  NOT the real per-unit stack — results below reflect the coarse "
              "LTP blocks and cannot show meaningful nodal separation.")

    n = df.height
    bias = df["error"].mean()
    mae = df["abs_error"].mean()
    rmse = (df["error"] ** 2).mean() ** 0.5
    corr = df.select(pl.corr("modelled_price", "observed_pool_price")).item()
    obs_mean = df["observed_pool_price"].mean()

    print(f"\n  ── Overall ({n} hours) ──")
    print(f"  observed mean   ${obs_mean:8.2f}/MWh")
    print(f"  modelled mean   ${df['modelled_price'].mean():8.2f}/MWh")
    print(f"  bias            ${bias:+8.2f}/MWh  ({100*bias/obs_mean:+.1f}%)")
    print(f"  MAE             ${mae:8.2f}/MWh")
    print(f"  RMSE            ${rmse:8.2f}/MWh")
    print(f"  correlation      {corr:8.3f}")
    print(f"  load-shed hours  {df.filter(pl.col('unserved_mw') > 1).height}")

    print(f"\n  ── Bias by load decile — the key diagnostic ──")
    print(f"  An islanded model (no imports) should run HIGH at high load.")
    by_bin = (df.with_columns(
                pl.col("observed_load_mw").qcut(5, labels=["1 low","2","3","4","5 high"])
                  .alias("bin"))
              .group_by("bin").agg([
                  pl.len().alias("n"),
                  pl.col("observed_load_mw").mean().round(0).alias("avg_load"),
                  pl.col("observed_pool_price").mean().round(2).alias("obs_price"),
                  pl.col("modelled_price").mean().round(2).alias("mod_price"),
                  pl.col("error").mean().round(2).alias("bias"),
              ]).sort("bin"))
    print(by_bin)

    print(f"\n  ── Bias by observed price level ──")
    print(f"  Scarcity hours are where a PPA valuation is most sensitive.")
    by_price = (df.with_columns(
                  pl.when(pl.col("observed_pool_price") < 30).then(pl.lit("a <$30"))
                    .when(pl.col("observed_pool_price") < 80).then(pl.lit("b $30-80"))
                    .when(pl.col("observed_pool_price") < 300).then(pl.lit("c $80-300"))
                    .otherwise(pl.lit("d >$300")).alias("band"))
                .group_by("band").agg([
                    pl.len().alias("n"),
                    pl.col("observed_pool_price").mean().round(2).alias("obs"),
                    pl.col("modelled_price").mean().round(2).alias("mod"),
                    pl.col("error").mean().round(2).alias("bias"),
                ]).sort("band"))
    print(by_price)

    if not args.apply:
        print("\n  DRY RUN — nothing written. Re-run with --apply.")
        return

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS aeso_opf_calibration (
          id                  BIGSERIAL PRIMARY KEY,
          run_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          date                DATE NOT NULL,
          hour_ending         SMALLINT NOT NULL,
          observed_pool_price NUMERIC(12,4) NOT NULL,
          modelled_price      NUMERIC(12,4) NOT NULL,
          error               NUMERIC(12,4) NOT NULL,
          observed_load_mw    NUMERIC(10,2),
          wind_cf             NUMERIC(6,4),
          solar_cf            NUMERIC(6,4),
          lmp_spread          NUMERIC(12,4),
          unserved_mw         NUMERIC(10,2),
          congestion_active   BOOLEAN,
          supply_stack_source TEXT,
          status              TEXT,
          UNIQUE (date, hour_ending, run_at)
        )
    """)
    psycopg2.extras.execute_values(cur, """
        INSERT INTO aeso_opf_calibration
          (date, hour_ending, observed_pool_price, modelled_price, error,
           observed_load_mw, wind_cf, solar_cf, lmp_spread, unserved_mw,
           congestion_active, supply_stack_source, status)
        VALUES %s
    """, [(r["date"], r["hour_ending"], r["observed_pool_price"], r["modelled_price"],
           r["modelled_price"] - r["observed_pool_price"], r["observed_load_mw"],
           r["wind_cf"], r["solar_cf"], r["lmp_spread"], r["unserved_mw"],
           r["congestion_active"], r["supply_stack_source"], r["status"])
          for r in rows], page_size=500)
    conn.commit()
    cur.close(); conn.close()
    print(f"\n  ✓ wrote {len(rows):,} rows to aeso_opf_calibration")


if __name__ == "__main__":
    main()
