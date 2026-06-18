"""
seed_topology.py — Assemble 163-bus ERCOT Tier 2 network topology.

Sources:
  1. CDR 10008 (gridstatus): 345kV buses with resource nodes
  2. ercot_node_locations (our DB): lat/lon via resource_node match
  3. K-nearest-neighbor graph: connect each bus to its 6 closest geographic neighbors
     within the same or adjacent load zones, matching ERCOT corridor capacities.

Run:  .venv/bin/python seed_topology.py
"""

import os, math, psycopg2, gridstatus
from typing import Any

DATABASE_URL = os.environ["DATABASE_URL"]

# ── Zone centroid fallback coordinates ────────────────────────────────────────
ZONE_COORDS: dict[str, tuple[float, float]] = {
    "LZ_HOUSTON": (29.75, -95.37),
    "LZ_NORTH":   (32.78, -97.12),
    "LZ_SOUTH":   (29.42, -98.49),
    "LZ_WEST":    (31.85, -102.40),
    "LZ_AEN":     (30.27, -97.88),
    "LZ_CPS":     (29.42, -98.49),
    "LZ_LCRA":    (30.00, -97.50),
}

# ERCOT CREZ-corridor max TTC (MW) — used to set s_nom for lines bridging zones
CREZ_CORRIDORS: dict[frozenset, float] = {
    frozenset({"LZ_WEST",    "LZ_NORTH"}):   3200,  # CREZ backbone
    frozenset({"LZ_WEST",    "LZ_SOUTH"}):    600,
    frozenset({"LZ_NORTH",   "LZ_HOUSTON"}): 4200,
    frozenset({"LZ_SOUTH",   "LZ_HOUSTON"}): 2800,
    frozenset({"LZ_NORTH",   "LZ_SOUTH"}):   1400,
    frozenset({"LZ_AEN",     "LZ_HOUSTON"}):  600,
    frozenset({"LZ_CPS",     "LZ_NORTH"}):    500,
    frozenset({"LZ_LCRA",    "LZ_NORTH"}):    400,
}

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R * 2 * math.asin(min(1.0, math.sqrt(a)))


def create_tables(cur: Any) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ercot_buses (
            id               SERIAL PRIMARY KEY,
            bus_name         TEXT NOT NULL,
            psse_bus_name    TEXT,
            psse_bus_number  INTEGER,
            voltage_kv       NUMERIC(8,2) NOT NULL,
            substation       TEXT,
            load_zone        TEXT,
            resource_node    TEXT,
            hub              TEXT,
            lat              NUMERIC(10,6),
            lon              NUMERIC(10,6),
            location_source  TEXT,
            created_at       TIMESTAMP DEFAULT NOW()
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ercot_lines (
            id          SERIAL PRIMARY KEY,
            from_bus    TEXT NOT NULL,
            to_bus      TEXT NOT NULL,
            voltage_kv  NUMERIC(8,2) NOT NULL,
            length_km   NUMERIC(10,3),
            x_pu        NUMERIC(12,8) NOT NULL,
            s_nom_mw    NUMERIC(10,2) NOT NULL,
            hifld_id    INTEGER,
            created_at  TIMESTAMP DEFAULT NOW()
        )
    """)


def s_nom_for_pair(zone_a: str | None, zone_b: str | None, dist_km: float) -> float:
    """Thermal limit for a 345kV line between two zones."""
    if zone_a and zone_b:
        key = frozenset({zone_a, zone_b})
        if key in CREZ_CORRIDORS:
            # Per-line share of the corridor capacity (assuming ~6 parallel circuits)
            return round(CREZ_CORRIDORS[key] / 6, 0)
    # Default: 800 MW for within-zone 345kV, 600 for inter-zone
    return 800.0 if zone_a == zone_b else 600.0


def x_pu_for_dist(dist_km: float) -> float:
    """Reactance in per-unit (100 MVA base, 345kV) from line length.
    345kV typ reactance ≈ 0.031 Ω/km; Zbase = 345²/100 ≈ 1190 Ω
    → X_pu/km ≈ 0.031/1190 ≈ 0.000026 pu/km.
    Scale by 10 for numerical stability in HiGHS: 0.00026 pu/km.
    """
    return max(0.001, round(0.00026 * max(dist_km, 1.0), 8))


def seed():
    print("── Step 1: Pull CDR 10008 (345kV buses) ─────────────────────────────")
    ercot = gridstatus.Ercot()
    df_map = ercot.get_settlement_points_electrical_bus_mapping(date="2024-01-15")

    df_345 = df_map[
        (df_map["Voltage Level"] == 345.0) & df_map["Resource Node"].notna()
    ].copy()

    df_345 = df_345.rename(columns={
        "Electrical Bus":      "bus_name",
        "PSSE Bus Name":       "psse_bus_name",
        "PSSE Bus Number":     "psse_bus_number",
        "Voltage Level":       "voltage_kv",
        "Substation":          "substation",
        "Settlement Load Zone":"load_zone",
        "Resource Node":       "resource_node",
        "Hub":                 "hub",
    })

    print(f"  → {len(df_345)} buses at 345kV with resource nodes")

    print("── Step 2: Add lat/lon from ercot_node_locations ────────────────────")
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    create_tables(cur)
    conn.commit()

    cur.execute("SELECT node_name, latitude, longitude FROM ercot_node_locations")
    loc_map: dict[str, tuple[float, float]] = {
        r[0]: (float(r[1]), float(r[2])) for r in cur.fetchall()
    }

    def get_coords(row) -> tuple[float, float]:
        if row["resource_node"] in loc_map:
            return loc_map[row["resource_node"]]
        zone = row["load_zone"]
        if zone in ZONE_COORDS:
            # Jitter zone centroid slightly so buses don't stack
            import random
            random.seed(hash(row["bus_name"]))
            dlat = random.uniform(-0.8, 0.8)
            dlon = random.uniform(-1.2, 1.2)
            zc = ZONE_COORDS[zone]
            return (zc[0] + dlat, zc[1] + dlon)
        return (31.0, -99.0)

    def location_source(row) -> str:
        if row["resource_node"] in loc_map:
            return "resource_node_match"
        return "zone_centroid"

    rows_data = []
    for _, row in df_345.iterrows():
        lat, lon = get_coords(row)
        src = location_source(row)
        rows_data.append({
            "bus_name":      row["bus_name"],
            "psse_bus_name": row["psse_bus_name"],
            "psse_bus_number": int(row["psse_bus_number"]) if not str(row.get("psse_bus_number","")).lower() in ("nan","none","") else None,
            "voltage_kv":    345.0,
            "substation":    row["substation"],
            "load_zone":     row["load_zone"],
            "resource_node": row["resource_node"],
            "hub":           row.get("hub") if str(row.get("hub","")).lower() not in ("nan","none","") else None,
            "lat":           round(lat, 6),
            "lon":           round(lon, 6),
            "location_source": src,
        })

    geo_count = sum(1 for r in rows_data if r["location_source"] == "resource_node_match")
    print(f"  → {geo_count}/{len(rows_data)} buses have real coordinates from ercot_node_locations")

    print("── Step 3: Seed ercot_buses ──────────────────────────────────────────")
    cur.execute("TRUNCATE ercot_buses CASCADE")
    for r in rows_data:
        cur.execute("""
            INSERT INTO ercot_buses
              (bus_name, psse_bus_name, psse_bus_number, voltage_kv,
               substation, load_zone, resource_node, hub, lat, lon, location_source)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            r["bus_name"], r["psse_bus_name"], r["psse_bus_number"],
            r["voltage_kv"], r["substation"], r["load_zone"],
            r["resource_node"], r["hub"], r["lat"], r["lon"], r["location_source"],
        ))
    conn.commit()
    print(f"  → {len(rows_data)} buses inserted into ercot_buses")

    print("── Step 4: Build kNN transmission graph ──────────────────────────────")
    # Connect each bus to its K nearest geographic neighbors.
    # Use 6 nearest within 350km; weight cross-zone connections by CREZ corridors.
    K = 6
    MAX_DIST_KM = 350.0

    inserted_pairs: set[frozenset] = set()
    lines_to_insert = []

    for bus in rows_data:
        candidates = []
        for other in rows_data:
            if other["bus_name"] == bus["bus_name"]:
                continue
            dist = haversine(bus["lat"], bus["lon"], other["lat"], other["lon"])
            if dist <= MAX_DIST_KM:
                candidates.append((dist, other))
        candidates.sort(key=lambda x: x[0])

        for dist, other in candidates[:K]:
            pair = frozenset({bus["bus_name"], other["bus_name"]})
            if pair in inserted_pairs:
                continue
            inserted_pairs.add(pair)

            zone_a = bus.get("load_zone")
            zone_b = other.get("load_zone")
            s_nom = s_nom_for_pair(zone_a, zone_b, dist)
            x_pu  = x_pu_for_dist(dist)

            lines_to_insert.append((
                bus["bus_name"], other["bus_name"],
                345.0, round(dist, 3), x_pu, s_nom, None,
            ))

    cur.execute("TRUNCATE ercot_lines")
    for row in lines_to_insert:
        cur.execute("""
            INSERT INTO ercot_lines (from_bus, to_bus, voltage_kv, length_km, x_pu, s_nom_mw, hifld_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
        """, row)

    conn.commit()
    print(f"  → {len(lines_to_insert)} lines inserted into ercot_lines")

    # Verify
    cur.execute("SELECT COUNT(*) FROM ercot_buses")
    nb = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM ercot_lines")
    nl = cur.fetchone()[0]
    print(f"\n✓ Done — {nb} buses, {nl} lines ready for PyPSA Tier 2 OPF")

    conn.close()


if __name__ == "__main__":
    seed()
