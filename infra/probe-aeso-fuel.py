#!/usr/bin/env python3
"""
probe-aeso-fuel.py — find where AESO exposes fuel_type and maximum_capability.

Neither is present in assetlist-api or meteredvolume-api (both verified 2026-07-27),
so aeso_asset_registry.fuel_type and .max_capability_mw are NULL for all 3,728 rows.
That makes capacity factor uncomputable and empties /api/aeso/rankings, which filters
on max_capability_mw > 0.

This script does NOT write to the database. It hits candidate endpoints and prints
the real response shape so the seeder can be written against observed structure
rather than assumed structure — three payload-shape surprises this session is enough.

The key question this answers: does the CSD asset list key on asset_ID (joins cleanly
to what we already have) or on asset display name (needs fuzzy matching, much worse)?

Usage:
    python3 infra/probe-aeso-fuel.py
"""
import json, os, sys
import requests

API_KEY = os.environ.get("AESO_API_KEY", "")
if not API_KEY:
    print("AESO_API_KEY not set (check it is not commented out in .env)")
    sys.exit(1)

BASE = "https://apimgw.aeso.ca/public"
HEADERS = {"API-KEY": API_KEY, "Accept": "application/json"}

DAY = "2026-06-15"      # a settled day well inside any disclosure lag

CANDIDATES = [
    # ── fuel type + nameplate capability ────────────────────────────────────
    ("CSD generation assets", "currentsupplydemand-api/v1/csd/generation/assets/current", None),
    ("CSD summary",           "currentsupplydemand-api/v1/csd/summary/current",           None),
    ("Asset list (control)",  "assetlist-api/v1/assetlist",                               None),

    # ── offer blocks / merit order — the supply-stack inputs ────────────────
    # Endpoint names are UNVERIFIED. AESO's public gateway is not consistently
    # documented, so this sprays plausible paths and reports which return 200.
    # A 404 here is information, not a failure.
    ("Energy merit order",    "energymeritorder-api/v1/meritOrder/energy",
        {"startDate": DAY, "endDate": DAY}),
    ("Merit order (alt)",     "meritorder-api/v1/meritorder",
        {"startDate": DAY, "endDate": DAY}),
    ("Offer control",         "operatingreservecontrol-api/v1/offercontrol",
        {"startDate": DAY, "endDate": DAY}),
    ("Marginal price (SMP)",  "systemmarginalprice-api/v1.1/price/systemMarginalPrice",
        {"startDate": DAY, "endDate": DAY}),
    ("Actual/forecast load",  "actualforecast-api/v1/load/albertaInternalLoad",
        {"startDate": DAY, "endDate": DAY}),
]


def walk(obj, path="", depth=0, out=None):
    """Print the structural skeleton: key names and types, one example leaf each."""
    if out is None:
        out = []
    pad = "  " * depth
    if isinstance(obj, dict):
        for k, v in list(obj.items())[:25]:
            if isinstance(v, (dict, list)):
                kind = "dict" if isinstance(v, dict) else f"list[{len(v)}]"
                out.append(f"{pad}{k}: {kind}")
                if depth < 3:
                    walk(v, f"{path}.{k}", depth + 1, out)
            else:
                out.append(f"{pad}{k} = {json.dumps(v)[:60]}")
    elif isinstance(obj, list) and obj:
        out.append(f"{pad}[0] of {len(obj)}:")
        walk(obj[0], path + "[0]", depth + 1, out)
    return out


def probe(label, path, params):
    print("\n" + "=" * 72)
    print(f"{label}\n  GET {BASE}/{path}")
    print("=" * 72)
    try:
        r = requests.get(f"{BASE}/{path}", headers=HEADERS, params=params or {}, timeout=60)
    except Exception as e:
        print(f"  request failed: {e}")
        return
    print(f"  HTTP {r.status_code}  ({len(r.content):,} bytes)")
    if r.status_code != 200:
        print(f"  body: {r.text[:300]}")
        return
    try:
        data = r.json()
    except Exception as e:
        print(f"  not JSON: {e}\n  {r.text[:300]}")
        return

    for line in walk(data):
        print("  " + line)

    # The specific question: is there an ID we can join on, and a capability number?
    blob = json.dumps(data).lower()
    print("\n  --- field presence ---")
    for probe_key in ("asset_id", "asset_ID".lower(), "fuel_type", "sub_fuel_type",
                      "maximum_capability", "max_capability", "net_generation"):
        print(f"    {probe_key:22s} {'FOUND' if probe_key in blob else 'absent'}")


if __name__ == "__main__":
    for label, path, params in CANDIDATES:
        probe(label, path, params)
    print("\nDone. Paste the output above — no data was written.")
