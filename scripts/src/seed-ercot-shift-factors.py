#!/usr/bin/env python3
"""
Compute ERCOT bus-level shift factors using DC PTDF (Power Transfer Distribution Factors).

Method:
  1. Load ercot_buses (340 buses w/ lat/lon, LZ zone) + ercot_lines (1,807 lines w/ x_pu)
  2. Assign each bus to EIA sub-BA zone (8 zones) via haversine nearest-centroid
  3. Build PyPSA DC network and compute the PTDF matrix (lines × buses)
  4. Electrical participation: EP[bus] = Σ_l(|PTDF[l,b]| × s_nom[l])
  5. Shift factor: SF[bus] = EP[bus] / Σ_{b in EIA zone} EP[b]
  6. Upsert into ercot_bus_shift_factors

Usage:
  cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/seed-ercot-shift-factors.py

Bus-level load approximation:
  bus_load_mw[t] ≈ shift_factor[bus] × zone_total_load_mw[t]
  where zone_total_load_mw comes from ercot_load_by_zone (EIA-930, real data)
"""
import os
import sys
import psycopg2
import pandas as pd
import numpy as np

# ── EIA sub-BA zone geographic centroids (approximate) ────────────────────────
# These represent the load-weighted center of each ERCOT sub-BA as defined by EIA-930.
# Source: ERCOT load zone geography + EIA Form 930 respondent documentation.
EIA_ZONE_CENTROIDS = {
    "NCEN": (32.8,  -97.3),   # North Central – DFW metro
    "COAS": (29.8,  -95.4),   # Coast         – Houston / Gulf coast
    "NRTH": (33.7,  -98.0),   # North         – Wichita Falls area
    "EAST": (31.8,  -95.0),   # East          – East Texas
    "SCEN": (29.5,  -97.8),   # South Central – San Antonio / Austin
    "SOUT": (27.5,  -98.5),   # South         – McAllen / Laredo
    "FWES": (31.2, -103.0),   # Far West      – Permian / Pecos
    "WEST": (32.2, -101.3),   # West          – Abilene / Midland
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return R * 2 * np.arcsin(np.sqrt(a))


def nearest_eia_zone(lat: float, lon: float) -> str:
    return min(EIA_ZONE_CENTROIDS, key=lambda z: haversine_km(lat, lon, *EIA_ZONE_CENTROIDS[z]))


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    # ── 1. Load buses ──────────────────────────────────────────────────────────
    print("Loading buses …")
    cur.execute("""
        SELECT bus_name, load_zone, hub,
               lat::float, lon::float, voltage_kv::float
        FROM ercot_buses
        WHERE lat IS NOT NULL
    """)
    buses = pd.DataFrame(
        cur.fetchall(),
        columns=["bus_name", "ercot_zone", "hub", "lat", "lon", "voltage_kv"],
    )
    print(f"  {len(buses)} buses loaded")

    # ── 2. Load lines ──────────────────────────────────────────────────────────
    print("Loading lines …")
    cur.execute("SELECT from_bus, to_bus, x_pu::float, s_nom_mw::float FROM ercot_lines")
    lines = pd.DataFrame(cur.fetchall(), columns=["from_bus", "to_bus", "x_pu", "s_nom_mw"])
    print(f"  {len(lines)} lines loaded")

    # ── 3. Assign EIA sub-BA zones via haversine nearest-centroid ─────────────
    print("Assigning EIA sub-BA zones …")
    buses["eia_zone"] = buses.apply(lambda r: nearest_eia_zone(r.lat, r.lon), axis=1)
    zone_counts = buses.groupby("eia_zone").size()
    print("  Zone distribution:")
    for zone, count in zone_counts.items():
        print(f"    {zone}: {count} buses")

    # ── 4. Build PyPSA DC network ──────────────────────────────────────────────
    print("\nBuilding PyPSA network …")
    try:
        import pypsa  # type: ignore
    except ImportError:
        sys.exit("pypsa not installed – run from artifacts/pypsa-engine venv")

    n = pypsa.Network()
    bus_set = set(buses["bus_name"])

    for _, b in buses.iterrows():
        kv = b["voltage_kv"] if b["voltage_kv"] > 0 else 345.0
        n.add("Bus", b["bus_name"], v_nom=kv)

    valid_lines = lines[
        lines["from_bus"].isin(bus_set) & lines["to_bus"].isin(bus_set)
    ].copy()
    print(f"  {len(valid_lines)} valid lines (both endpoints in bus set)")

    for i, row in valid_lines.iterrows():
        x = max(row["x_pu"], 1e-4)
        n.add("Line", f"L{i}", bus0=row["from_bus"], bus1=row["to_bus"],
              x=x, s_nom=row["s_nom_mw"])

    print(f"  Network: {len(n.buses)} buses, {len(n.lines)} lines")

    # ── 5. Compute PTDF matrix via DC B-matrix decomposition ─────────────────
    # Classic DC PTDF: PTDF[l,b] = b_l * (K_red @ B_bus_red^{-1})[l, b]
    # where b_l = susceptance of line l, K = incidence matrix, B_bus = K^T diag(b) K
    print("\nComputing PTDF matrix (DC B-matrix method) …")
    method = "ptdf"
    try:
        import scipy.sparse as sp
        import scipy.sparse.linalg as spla

        bus_names_list = list(buses["bus_name"])
        bus_idx = {b: i for i, b in enumerate(bus_names_list)}
        n_buses = len(bus_names_list)
        n_lines = len(valid_lines)

        from_idx = np.array([bus_idx[f] for f in valid_lines["from_bus"]])
        to_idx   = np.array([bus_idx[t] for t in valid_lines["to_bus"]])

        # Incidence matrix K[line, bus]: +1 at from_bus, -1 at to_bus
        row = np.concatenate([np.arange(n_lines), np.arange(n_lines)])
        col = np.concatenate([from_idx, to_idx])
        dat = np.concatenate([np.ones(n_lines), -np.ones(n_lines)])
        K = sp.csr_matrix((dat, (row, col)), shape=(n_lines, n_buses))

        b_vec = 1.0 / np.maximum(valid_lines["x_pu"].values, 1e-6)   # susceptance
        B_diag = sp.diags(b_vec)
        B_bus  = K.T @ B_diag @ K   # (n_buses × n_buses)

        # Remove reference bus (index 0 = slack) for reduced system
        ref = 0
        keep = [i for i in range(n_buses) if i != ref]
        B_bus_red = B_bus[keep, :][:, keep].toarray()   # (n-1) × (n-1)
        K_red     = K[:, keep].toarray()                # n_lines × (n-1)

        B_inv = np.linalg.inv(B_bus_red)   # (n-1) × (n-1)

        # PTDF[l, b] = b_l × Σ_k K[l,k] × B_inv[k, b]  (for reduced bus set)
        ptdf_red = b_vec[:, np.newaxis] * (K_red @ B_inv)  # n_lines × (n-1)

        # Electrical participation: Σ_l |PTDF[l,b]| × s_nom[l]
        s_nom = valid_lines["s_nom_mw"].values
        ep_red = (np.abs(ptdf_red) * s_nom[:, np.newaxis]).sum(axis=0)  # (n-1,)

        ep_all = np.zeros(n_buses)
        for j, orig_idx in enumerate(keep):
            ep_all[orig_idx] = ep_red[j]
        ep_all[ref] = ep_red.min() * 0.5  # reference bus gets small weight

        bus_ep_series = pd.Series(ep_all, index=bus_names_list)
        buses["ep"] = buses["bus_name"].map(bus_ep_series).fillna(0.0)

        zero_mask = buses["ep"] == 0.0
        if zero_mask.any():
            buses.loc[zero_mask, "ep"] = buses.loc[~zero_mask, "ep"].min() * 0.1
            print(f"  {zero_mask.sum()} buses had ep=0; assigned minimum proxy")

        print(f"  PTDF shape: {ptdf_red.shape} (reduced, ref bus removed)")
        print(f"  EP range: {ep_all.min():.1f} – {ep_all.max():.1f}")

    except Exception as exc:
        print(f"  PTDF failed ({exc}); falling back to uniform weighting")
        buses["ep"] = 1.0
        method = "uniform"

    # ── 6. Normalize shift factors within each EIA zone ───────────────────────
    zone_ep_total = buses.groupby("eia_zone")["ep"].transform("sum")
    buses["shift_factor"] = buses["ep"] / zone_ep_total

    print("\nShift factor summary (should sum to 1.0 per zone):")
    summary = buses.groupby("eia_zone").agg(
        n_buses=("bus_name", "count"),
        sf_sum=("shift_factor", "sum"),
        sf_max=("shift_factor", "max"),
    )
    print(summary.to_string())

    # ── 7. Upsert into DB ──────────────────────────────────────────────────────
    print(f"\nUpserting {len(buses)} rows into ercot_bus_shift_factors …")
    cur.execute("TRUNCATE ercot_bus_shift_factors")

    rows = [
        (
            row["bus_name"],
            row["ercot_zone"],
            row["eia_zone"],
            float(row["shift_factor"]),
            float(row["ep"]),
            float(row["lat"]),
            float(row["lon"]),
            method,
        )
        for _, row in buses.iterrows()
    ]
    cur.executemany(
        """
        INSERT INTO ercot_bus_shift_factors
            (bus_name, ercot_zone, eia_zone, shift_factor,
             electrical_participation, bus_lat, bus_lon, method)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        rows,
    )
    conn.commit()

    # ── 8. Verify ──────────────────────────────────────────────────────────────
    cur.execute("""
        SELECT eia_zone, COUNT(*),
               ROUND(SUM(shift_factor::float)::numeric, 4) AS sf_total
        FROM ercot_bus_shift_factors
        GROUP BY eia_zone
        ORDER BY eia_zone
    """)
    print("\nVerification:")
    for r in cur.fetchall():
        print(f"  {r[0]}: {r[1]} buses, Σ sf = {r[2]}")

    cur.close()
    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
