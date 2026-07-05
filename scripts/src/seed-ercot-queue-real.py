"""
Seed real ERCOT interconnection queue data using gridstatus.
Source: ERCOT GIS Report pg7-200-er (public EMIL portal, no auth required).
Replaces synthetic ERCOT queue entries with 1,793 real projects.
"""
import os
import sys
import logging
from datetime import datetime
import psycopg2
from gridstatus import Ercot

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    log.error("DATABASE_URL not set")
    sys.exit(1)

# ── Texas county centroids (lat/lng) for geocoding queue projects ──────────────
TEXAS_COUNTY_CENTROIDS = {
    "Anderson": (31.8307, -95.6540), "Andrews": (32.3045, -102.6388),
    "Angelina": (31.2504, -94.6105), "Aransas": (28.0945, -97.0601),
    "Archer": (33.6181, -98.6874), "Armstrong": (34.9644, -101.3568),
    "Atascosa": (28.8928, -98.5273), "Austin": (29.8895, -96.2776),
    "Bailey": (34.0685, -102.8298), "Bandera": (29.7361, -99.2461),
    "Bastrop": (30.1033, -97.3124), "Baylor": (33.6165, -99.2132),
    "Bee": (28.4133, -97.7401), "Bell": (31.0375, -97.4786),
    "Bexar": (29.4492, -98.5201), "Blanco": (30.2618, -98.4165),
    "Borden": (32.7442, -101.4309), "Bosque": (31.8975, -97.6334),
    "Bowie": (33.4466, -94.1635), "Brazoria": (29.1671, -95.4376),
    "Brazos": (30.6609, -96.3345), "Brewster": (29.8041, -103.2519),
    "Briscoe": (34.5286, -101.2076), "Brooks": (27.0291, -98.2218),
    "Brown": (31.7715, -99.0063), "Burleson": (30.4871, -96.6208),
    "Burnet": (30.7891, -98.2316), "Caldwell": (29.8376, -97.6304),
    "Calhoun": (28.4426, -96.5948), "Callahan": (32.2990, -99.3736),
    "Cameron": (26.1456, -97.5268), "Camp": (32.9788, -94.9784),
    "Carson": (35.4040, -101.3568), "Cass": (33.0776, -94.3445),
    "Castro": (34.5289, -102.2643), "Chambers": (29.7060, -94.7009),
    "Cherokee": (31.8445, -95.1633), "Childress": (34.5289, -100.2072),
    "Clay": (33.7856, -98.2106), "Cochran": (33.6011, -102.8298),
    "Coke": (31.8895, -100.5276), "Coleman": (31.7758, -99.4557),
    "Collin": (33.1893, -96.5729), "Collingsworth": (34.9644, -100.2700),
    "Colorado": (29.6215, -96.5265), "Comal": (29.8059, -98.2677),
    "Comanche": (31.9360, -98.5956), "Concho": (31.3222, -99.8672),
    "Cooke": (33.6422, -97.2105), "Coryell": (31.3924, -97.7960),
    "Cottle": (34.0766, -100.2700), "Crane": (31.4265, -102.3484),
    "Crockett": (30.7250, -101.3823), "Crosby": (33.6011, -101.3036),
    "Culberson": (31.4404, -104.5192), "Dallam": (36.2779, -102.6018),
    "Dallas": (32.7668, -96.7836), "Dawson": (32.7472, -101.9486),
    "Deaf Smith": (34.9644, -102.6018), "Delta": (33.3865, -95.6731),
    "Denton": (33.2148, -97.1331), "DeWitt": (29.0868, -97.3597),
    "Dickens": (33.6011, -100.7896), "Dimmit": (28.4238, -99.7528),
    "Donley": (34.9644, -100.8143), "Duval": (27.6803, -98.4912),
    "Eastland": (32.3013, -98.8271), "Ector": (31.8695, -102.5373),
    "Edwards": (29.9820, -100.3045), "Ellis": (32.3487, -96.7919),
    "El Paso": (31.7594, -106.4850), "Erath": (32.2337, -98.2151),
    "Falls": (31.2533, -96.9302), "Fannin": (33.5939, -96.1056),
    "Fayette": (29.8785, -96.9204), "Fisher": (32.7472, -100.4016),
    "Floyd": (33.9739, -101.3036), "Foard": (33.9779, -99.7748),
    "Fort Bend": (29.5260, -95.7701), "Franklin": (33.1754, -95.2236),
    "Freestone": (31.7044, -96.1489), "Frio": (28.8676, -99.1097),
    "Gaines": (32.7472, -102.6388), "Galveston": (29.2423, -94.8637),
    "Garza": (33.1798, -101.3036), "Gillespie": (30.3195, -98.9451),
    "Glasscock": (31.8694, -101.5212), "Goliad": (28.6563, -97.3938),
    "Gonzales": (29.4531, -97.4907), "Gray": (35.4011, -100.8143),
    "Grayson": (33.6422, -96.6808), "Gregg": (32.4754, -94.8206),
    "Grimes": (30.5445, -95.9853), "Guadalupe": (29.5780, -97.9563),
    "Hale": (33.9739, -101.8245), "Hall": (34.5289, -100.6826),
    "Hamilton": (31.7002, -98.1153), "Hansford": (36.2779, -101.3568),
    "Hardeman": (34.2898, -99.7748), "Hardin": (30.3341, -94.3763),
    "Harris": (29.8468, -95.3981), "Harrison": (32.5466, -94.3726),
    "Hartley": (35.8395, -102.6018), "Haskell": (33.1798, -99.7301),
    "Hays": (30.0613, -98.0294), "Hemphill": (35.8395, -100.2700),
    "Henderson": (32.2093, -95.8533), "Hidalgo": (26.3869, -98.1861),
    "Hill": (31.9879, -97.1364), "Hockley": (33.6011, -102.3432),
    "Hood": (32.4346, -97.8050), "Hopkins": (33.1459, -95.5645),
    "Houston": (31.3193, -95.4144), "Howard": (32.3074, -101.4489),
    "Hudspeth": (31.4500, -105.3837), "Hunt": (33.1196, -96.0856),
    "Hutchinson": (35.8395, -101.3568), "Irion": (31.2904, -100.9873),
    "Jack": (33.2328, -98.1699), "Jackson": (28.9605, -96.5771),
    "Jasper": (30.7341, -94.0099), "Jeff Davis": (30.7112, -104.1339),
    "Jefferson": (30.0400, -94.1566), "Jim Hogg": (27.0480, -98.7063),
    "Jim Wells": (27.7318, -98.1100), "Johnson": (32.3812, -97.3660),
    "Jones": (32.7364, -99.8832), "Karnes": (28.9041, -97.8541),
    "Kaufman": (32.5953, -96.2879), "Kendall": (29.9454, -98.7004),
    "Kenedy": (26.9296, -97.6594), "Kent": (33.1798, -100.7896),
    "Kerr": (30.0629, -99.3490), "Kimble": (30.4884, -99.7491),
    "King": (33.6172, -100.2700), "Kinney": (29.3529, -100.4254),
    "Kleberg": (27.4267, -97.8075), "Knox": (33.6011, -99.7301),
    "Lamar": (33.6675, -95.5739), "Lamb": (33.9739, -102.3432),
    "Lampasas": (31.1969, -98.2427), "La Salle": (28.3478, -99.0920),
    "Lavaca": (29.3804, -96.9370), "Lee": (30.3135, -96.9697),
    "Leon": (31.2984, -95.9851), "Liberty": (30.1541, -94.8198),
    "Limestone": (31.5481, -96.5874), "Lipscomb": (36.2779, -100.2700),
    "Live Oak": (28.3534, -98.1220), "Llano": (30.7096, -98.6818),
    "Loving": (31.8553, -103.5981), "Lubbock": (33.5779, -101.8481),
    "Lynn": (33.1798, -101.8245), "McCulloch": (31.1961, -99.3490),
    "McLennan": (31.5493, -97.1962), "McMullen": (28.3527, -99.5924),
    "Madison": (30.9595, -95.9167), "Marion": (32.7972, -94.3575),
    "Martin": (32.3074, -101.9486), "Mason": (30.7096, -99.2202),
    "Matagorda": (28.7893, -96.0157), "Maverick": (28.7380, -100.3045),
    "Medina": (29.3526, -99.1003), "Menard": (30.8970, -99.8239),
    "Midland": (31.8724, -102.0337), "Milam": (30.7915, -96.9699),
    "Mills": (31.4902, -98.5956), "Mitchell": (32.3074, -100.9186),
    "Montague": (33.6738, -97.7248), "Montgomery": (30.3002, -95.5001),
    "Moore": (35.8395, -101.8921), "Morris": (33.1052, -94.7337),
    "Motley": (34.0766, -100.7896), "Nacogdoches": (31.6187, -94.6517),
    "Navarro": (31.9042, -96.4727), "Newton": (30.7840, -93.7289),
    "Nolan": (32.3074, -100.4016), "Nueces": (27.7261, -97.7323),
    "Ochiltree": (36.2779, -100.8143), "Oldham": (35.4011, -102.6018),
    "Orange": (30.1213, -93.9249), "Palo Pinto": (32.7467, -98.3227),
    "Panola": (32.1563, -94.3164), "Parker": (32.7765, -97.8050),
    "Parmer": (34.5289, -102.8298), "Pecos": (30.7791, -102.7218),
    "Polk": (30.7909, -94.8297), "Potter": (35.4011, -101.8921),
    "Presidio": (29.8937, -104.3555), "Rains": (32.8709, -95.7873),
    "Randall": (34.5289, -101.8921), "Reagan": (31.3687, -101.5212),
    "Real": (29.8342, -99.8239), "Red River": (33.6183, -94.9450),
    "Reeves": (31.3270, -103.6975), "Refugio": (28.3267, -97.1560),
    "Roberts": (35.8395, -100.8143), "Robertson": (31.0268, -96.5096),
    "Rockwall": (32.8990, -96.4181), "Runnels": (31.8313, -99.9763),
    "Rusk": (32.1127, -94.7650), "Sabine": (31.3371, -93.8504),
    "San Augustine": (31.3927, -94.1626), "San Jacinto": (30.5876, -95.1546),
    "San Patricio": (27.9866, -97.5227), "San Saba": (31.1969, -98.7340),
    "Schleicher": (30.8970, -100.5276), "Scurry": (32.7472, -100.9186),
    "Shackelford": (32.7364, -99.3490), "Shelby": (31.7936, -94.1433),
    "Sherman": (36.2779, -101.8921), "Smith": (32.3751, -95.2688),
    "Somervell": (32.2267, -97.7725), "Starr": (26.5573, -98.7536),
    "Stephens": (32.7364, -98.8271), "Sterling": (31.8313, -101.0435),
    "Stonewall": (33.1798, -100.0386), "Sutton": (30.4979, -100.5276),
    "Swisher": (34.5289, -101.7296), "Tarrant": (32.7714, -97.2910),
    "Taylor": (32.2990, -99.8832), "Terrell": (30.2255, -102.0898),
    "Terry": (33.1798, -102.3432), "Throckmorton": (33.1789, -99.2132),
    "Titus": (33.2173, -94.9742), "Tom Green": (31.4040, -100.4622),
    "Travis": (30.3340, -97.7957), "Trinity": (31.0924, -95.1294),
    "Tyler": (30.7746, -94.3705), "Upshur": (32.7352, -94.9362),
    "Upton": (31.3687, -102.0337), "Uvalde": (29.3611, -99.7491),
    "Val Verde": (29.8791, -101.1510), "Van Zandt": (32.5595, -95.8447),
    "Victoria": (28.8015, -96.9852), "Walker": (30.7458, -95.5684),
    "Waller": (30.0157, -95.9966), "Ward": (31.5085, -103.1019),
    "Washington": (30.2159, -96.4096), "Webb": (27.7620, -99.4448),
    "Wharton": (29.2792, -96.2116), "Wheeler": (35.4011, -100.2700),
    "Wichita": (33.9039, -98.7033), "Wilbarger": (34.0766, -99.2132),
    "Willacy": (26.4779, -97.7491), "Williamson": (30.6480, -97.6022),
    "Wilson": (29.1726, -98.0839), "Winkler": (31.8553, -103.0600),
    "Wise": (33.2148, -97.6594), "Wood": (32.7757, -95.3844),
    "Yoakum": (33.1798, -102.8298), "Young": (33.1789, -98.6874),
    "Zapata": (26.9987, -99.1700), "Zavala": (28.8740, -99.7491),
}

# CDR zone → LZ_ mapping
CDR_ZONE_MAP = {
    "WEST": "LZ_WEST",
    "NORTH": "LZ_NORTH",
    "SOUTH": "LZ_SOUTH",
    "COASTAL": "LZ_HOUSTON",
    "HOUSTON": "LZ_HOUSTON",
    "PANHANDLE": "LZ_WEST",
    "AEN": "LZ_AEN",
    "CPS": "LZ_CPS",
    "LCRA": "LZ_LCRA",
    "RAYBN": "LZ_RAYBN",
}

# Fuel type normalization
def normalize_fuel(fuel: str, technology: str) -> str:
    if not fuel:
        return "other"
    fuel = str(fuel).strip().lower()
    tech = str(technology).strip().lower() if technology else ""
    if "solar" in fuel or "photovoltaic" in tech:
        return "solar"
    if "wind" in fuel or "wind turbine" in tech:
        return "wind"
    if fuel in ("gas", "natural gas") or "gas" in tech:
        return "natural_gas"
    if "battery" in tech or "storage" in tech or "bess" in tech:
        return "storage"
    if "nuclear" in fuel or "nuclear" in tech:
        return "nuclear"
    if "water" in fuel or "hydro" in tech:
        return "hydro"
    if "hydrogen" in fuel:
        return "other"
    if fuel == "other":
        if "battery" in tech:
            return "storage"
        if "solar" in tech:
            return "solar"
        if "wind" in tech:
            return "wind"
    return "other"

def normalize_status(status: str) -> str:
    if not status:
        return "active"
    s = str(status).strip().lower()
    if "active" in s:
        return "active"
    if "completed" in s or "operational" in s:
        return "completed"
    if "withdrawn" in s or "suspended" in s or "cancelled" in s:
        return "withdrawn"
    return "active"

def get_lat_lng(county: str, state: str) -> tuple:
    if county and state and str(state).strip().upper() in ("TX", "TEXAS"):
        county_clean = str(county).strip().rstrip(" County").rstrip(" county")
        if county_clean in TEXAS_COUNTY_CENTROIDS:
            return TEXAS_COUNTY_CENTROIDS[county_clean]
    return (None, None)

def parse_ts(val):
    if val is None:
        return None
    try:
        import pandas as pd
        if pd.isna(val):
            return None
        ts = pd.Timestamp(val)
        return ts.to_pydatetime()
    except Exception:
        return None

def main():
    log.info("Fetching real ERCOT interconnection queue from ERCOT EMIL (gridstatus)...")
    ercot = Ercot()
    df = ercot.get_interconnection_queue()
    log.info(f"Fetched {len(df)} ERCOT queue projects")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Remove existing synthetic ERCOT queue entries
    cur.execute("DELETE FROM queue_projects WHERE market = 'ERCOT'")
    deleted = cur.rowcount
    log.info(f"Removed {deleted} synthetic ERCOT queue entries")

    inserted = 0
    skipped = 0

    for _, row in df.iterrows():
        try:
            capacity = row.get("Capacity (MW)")
            if capacity is None or (hasattr(capacity, '__float__') and __import__('math').isnan(float(capacity))):
                capacity = 0

            fuel = normalize_fuel(str(row.get("Fuel", "")), str(row.get("Technology", "")))
            status = normalize_status(str(row.get("Status", "")))
            county = str(row.get("County", "")) if row.get("County") else None
            state = str(row.get("State", "")) if row.get("State") else None
            lat, lng = get_lat_lng(county, state)

            cdr_zone = row.get("CDR Reporting Zone")
            if cdr_zone and str(cdr_zone).strip().upper() in CDR_ZONE_MAP:
                zone_label = CDR_ZONE_MAP[str(cdr_zone).strip().upper()]
            else:
                zone_label = str(cdr_zone).strip() if cdr_zone else None

            gim_phase = str(row.get("GIM Study Phase", "")) if row.get("GIM Study Phase") else None

            cur.execute("""
                INSERT INTO queue_projects
                  (project_name, market, queue_id, fuel_type, capacity_mw, status,
                   latitude, longitude, county, state, interconnection_node,
                   request_date, study_group_phase, withdrawal_date)
                VALUES (%s, 'ERCOT', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                str(row.get("Project Name", "Unknown"))[:500],
                str(row.get("Queue ID", ""))[:100] if row.get("Queue ID") else None,
                fuel,
                float(capacity),
                status,
                lat, lng,
                county[:200] if county else None,
                state[:100] if state else None,
                str(row.get("Interconnection Location", ""))[:500] if row.get("Interconnection Location") else None,
                parse_ts(row.get("Queue Date")),
                zone_label[:100] if zone_label else None,
                parse_ts(row.get("Withdrawn Date")),
            ))
            inserted += 1
        except Exception as e:
            log.warning(f"Skipped row {row.get('Queue ID', '?')}: {e}")
            skipped += 1

    conn.commit()
    cur.close()
    conn.close()

    log.info(f"Done — inserted {inserted} real ERCOT projects, skipped {skipped}")

    # Summary
    log.info("\n=== Summary ===")
    conn2 = psycopg2.connect(DATABASE_URL)
    cur2 = conn2.cursor()
    cur2.execute("""
        SELECT fuel_type, status, COUNT(*)
        FROM queue_projects WHERE market='ERCOT'
        GROUP BY fuel_type, status ORDER BY fuel_type, status
    """)
    for r in cur2.fetchall():
        log.info(f"  {r[0]:15s} {r[1]:12s}  {r[2]} projects")
    cur2.execute("SELECT COUNT(*), ROUND(AVG(capacity_mw)::numeric,1), SUM(capacity_mw) FROM queue_projects WHERE market='ERCOT'")
    r = cur2.fetchone()
    log.info(f"  TOTAL: {r[0]} projects, avg {r[1]} MW, total {r[2]:,.0f} MW")
    cur2.close()
    conn2.close()

if __name__ == "__main__":
    main()
