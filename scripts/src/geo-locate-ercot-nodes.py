#!/usr/bin/env python3
"""
Improve geolocation of ERCOT resource nodes by fuzzy-matching node name prefixes
to EIA 860 plant names already in the candidates table.

ERCOT naming convention:
  AJAXWIND_RN  → "Ajax Wind Farm"  (tech suffix stripped, name compressed)
  ANACACHO_ANA → "Anacacho Wind Farm" (direct prefix)
  BRAZ_WND_ALL → "Brazos Wind Farm"  (underscore-separated prefix + tech type)
  BAIRDWND_ALL → "Baird Wind Farm"   (name + tech fused)
  ANDMDSLR_ALL → "Anderson Mill Solar" or similar

Strategy:
1. Extract "core" from node name: take prefix before first _, strip tech tokens
2. Extract "core" from EIA name: strip generic energy words
3. Use rapidfuzz partial_ratio + token_sort_ratio to find best match
4. Accept matches above threshold (60), prefer zone-same matches
"""

import os, re, sys
import psycopg2
from rapidfuzz import fuzz, process

DATABASE_URL = os.environ["DATABASE_URL"]
conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

# ── Load unlocated resource nodes ──────────────────────────────────────────────
cur.execute("""
    SELECT id, node_name, load_zone
    FROM ercot_node_locations
    WHERE node_type = 'resource_node' AND location_source = 'zone_centroid'
    ORDER BY node_name
""")
unlocated = cur.fetchall()
print(f"Unlocated nodes: {len(unlocated)}")

# ── Load ERCOT EIA 860 plants ─────────────────────────────────────────────────
cur.execute("""
    SELECT id, name, latitude, longitude
    FROM candidates
    WHERE market = 'ERCOT' AND latitude IS NOT NULL
    ORDER BY name
""")
plants = cur.fetchall()
print(f"ERCOT EIA plants: {len(plants)}")

# ── Normalization helpers ─────────────────────────────────────────────────────

TECH_TOKENS_NODE = re.compile(
    r'\b(SLR|WND|WIND|ESS|BESS|RN|ALL|UNIT\d*|DGR\d*|G\d+|ES\d*|_\d+)\b',
    re.IGNORECASE
)
TECH_TOKENS_EIA = re.compile(
    r'\b(Wind|Solar|Farm|Project|LLC|LP|Energy|Power|Plant|Station|'
    r'Storage|Battery|BESS|ESS|Hybrid|Holdings|Partners|'
    r'I{1,3}|II|III|IV|V|VI|VII|VIII|IX|X|[0-9]+)\b',
    re.IGNORECASE
)
NON_ALPHA = re.compile(r'[^a-z]')

def clean_node(node_name: str) -> str:
    """Extract core name from ERCOT resource node name."""
    # Take the first segment before _
    prefix = node_name.split('_')[0]
    # Also consider the first two segments joined (for names like BRAZ_WND)
    parts = node_name.split('_')
    prefix2 = parts[0] if len(parts) == 1 else (parts[0] + parts[1] if len(parts) > 1 else parts[0])
    # Strip tech tokens
    cleaned = TECH_TOKENS_NODE.sub('', prefix).strip()
    if not cleaned:
        cleaned = prefix  # fallback
    return cleaned.lower()

def clean_eia(name: str) -> str:
    """Strip generic energy words from EIA plant name."""
    cleaned = TECH_TOKENS_EIA.sub(' ', name)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned.lower()

def score(node_clean: str, eia_clean: str) -> float:
    """Composite score: partial_ratio + token_sort_ratio, prefer longer match."""
    # Reject matches where the EIA clean name is much shorter than node prefix
    # (e.g., "H 4" cleans to "h" which falsely matches everything via partial_ratio)
    if len(eia_clean) < max(4, len(node_clean) - 2):
        return 0.0
    # partial_ratio: does node_clean appear as substring of eia_clean?
    pr = fuzz.partial_ratio(node_clean, eia_clean)
    # token_sort: handles word reordering
    ts = fuzz.token_sort_ratio(node_clean, eia_clean)
    # ratio: direct edit distance
    r = fuzz.ratio(node_clean, eia_clean)
    composite = pr * 0.5 + ts * 0.3 + r * 0.2
    return composite

# ── Build EIA lookup ──────────────────────────────────────────────────────────
plant_records = [(pid, name, float(lat), float(lon), clean_eia(name))
                 for pid, name, lat, lon in plants]

# ── Match each node ───────────────────────────────────────────────────────────
THRESHOLD = 80  # minimum composite score to accept a match

updates = []
no_match = []

for node_id, node_name, load_zone in unlocated:
    node_clean = clean_node(node_name)
    if len(node_clean) < 3:
        no_match.append((node_name, node_clean, "too_short"))
        continue

    best_score = 0
    best = None
    for pid, pname, plat, plon, pclean in plant_records:
        s = score(node_clean, pclean)
        if s > best_score:
            best_score = s
            best = (pid, pname, plat, plon)

    if best and best_score >= THRESHOLD:
        updates.append((node_id, node_name, best[1], best[2], best[3], best_score, load_zone))
    else:
        top = best[1] if best else "?"
        no_match.append((node_name, node_clean, f"best={best_score:.0f} ({top})"))

print(f"\nMatches found: {len(updates)}")
print(f"No match: {len(no_match)}")

# ── Show sample matches ───────────────────────────────────────────────────────
print("\n── Sample matches ──────────────────────────────────")
for node_id, node_name, eia_name, lat, lon, sc, zone in updates[:30]:
    print(f"  {node_name:25s} → {eia_name:45s}  score={sc:.0f}  {zone}")

print("\n── Sample non-matches ──────────────────────────────")
for nm, nc, reason in no_match[:30]:
    print(f"  {nm:25s}  clean='{nc}'  → {reason}")

# ── Score distribution ────────────────────────────────────────────────────────
if updates:
    scores = [u[5] for u in updates]
    import statistics
    print(f"\nScore stats: min={min(scores):.0f} median={statistics.median(scores):.0f} max={max(scores):.0f}")
    for thresh in [70, 75, 80, 85, 90, 95]:
        n = sum(1 for s in scores if s >= thresh)
        print(f"  ≥{thresh}: {n} matches")

# ── Apply updates ─────────────────────────────────────────────────────────────
dry_run = "--apply" not in sys.argv
if dry_run:
    print("\n[DRY RUN] Pass --apply to update the database")
else:
    print(f"\nApplying {len(updates)} updates...")
    for node_id, node_name, eia_name, lat, lon, sc, zone in updates:
        cur.execute("""
            UPDATE ercot_node_locations
            SET latitude = %s,
                longitude = %s,
                location_source = 'eia_fuzzy_match',
                eia_plant_name = %s
            WHERE id = %s
        """, (lat, lon, eia_name, node_id))
    conn.commit()
    print(f"Done. Updated {len(updates)} nodes to location_source='eia_fuzzy_match'.")
    
    # Report final stats
    cur.execute("""
        SELECT location_source, COUNT(*) 
        FROM ercot_node_locations WHERE node_type='resource_node'
        GROUP BY location_source ORDER BY count DESC
    """)
    print("\nFinal location breakdown:")
    for row in cur.fetchall():
        print(f"  {row[0]:25s}: {row[1]}")

cur.close()
conn.close()
