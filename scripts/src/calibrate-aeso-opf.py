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

KNOWN BIAS GOING IN
---------------------------------------------------------------------------
The three boundary buses (BC/MT/SK) have no generator and no load attached, so
all three intertie lines carry exactly zero flow — Alberta is currently modelled
as an island. Real Alberta imports up to ~1,260 MW, disproportionately cheap BC
hydro. The model should therefore run HIGH at high load, dispatching Alberta gas
where reality imports. If the measured bias shows that shape, it corroborates
the diagnosis; if it does not, something else dominates and the intertie fix is
second-order.

That is the point of measuring before building.

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


def load_observed(args) -> pl.DataFrame:
    """
    Observed hourly load, pool price and wind output.

    TIMEZONE: aeso_hourly_pool_price is date + hour_ending 1..24 in Mountain
    time; aeso_hourly_gen_output is the AESO API's own hourly series, also
    Mountain. Both local, so they join directly — but this is asserted from
    iso_table_metadata, not assumed. Do NOT join either to an EIA-930 table
    without converting; those are UTC.
    """
    end = args.end or date.today().isoformat()
    conn = psycopg2.connect(DB_URL)

    price = pl.read_database(
        """
        SELECT date, hour_ending, pool_price::float8 AS pool_price,
               ail_mw::float8 AS ail_mw
        FROM aeso_hourly_pool_price
        WHERE date >= %(s)s AND date <= %(e)s
          AND pool_price IS NOT NULL AND ail_mw IS NOT NULL AND ail_mw > 0
        """,
        connection=conn, execute_options={"parameters": {"s": args.start, "e": end}},
    )

    try:
        wind = pl.read_database(
            """
            SELECT date, hour_ending,
                   SUM(gen_mw) FILTER (WHERE fuel_type = 'wind')::float8  AS wind_mw,
                   SUM(gen_mw) FILTER (WHERE fuel_type = 'solar')::float8 AS solar_mw
            FROM aeso_hourly_gen_output
            WHERE date >= %(s)s AND date <= %(e)s
            GROUP BY date, hour_ending
            """,
            connection=conn, execute_options={"parameters": {"s": args.start, "e": end}},
        )
    except Exception as exc:                                     # noqa: BLE001
        print(f"  ⚠  wind/solar unavailable ({exc}) — falling back to a fixed "
              f"capacity factor, which weakens the test materially")
        wind = pl.DataFrame({"date": [], "hour_ending": [], "wind_mw": [], "solar_mw": []})

    conn.close()

    df = price.join(wind, on=["date", "hour_ending"], how="left") if wind.height else price
    return df.drop_nulls(subset=["pool_price", "ail_mw"])


def stratified_sample(df: pl.DataFrame, n: int) -> pl.DataFrame:
    """
    Sample evenly across the LOAD range, not at random.

    A random sample is dominated by ordinary mid-load hours, which is where any
    model looks fine. The hours that matter for a PPA tool are the scarcity
    tails — and those are exactly where an islanded model (no imports) should
    break. Stratifying guarantees they are represented.
    """
    df = df.with_columns(
        pl.col("ail_mw").qcut(10, labels=[str(i) for i in range(10)]).alias("load_bin")
    )
    per_bin = max(1, n // 10)
    return (df.group_by("load_bin", maintain_order=True)
              .map_groups(lambda g: g.sample(min(per_bin, g.height), shuffle=True, seed=42)))


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
    print(f"  sampling {sample.height:,} hours, stratified across 10 load deciles\n")

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
