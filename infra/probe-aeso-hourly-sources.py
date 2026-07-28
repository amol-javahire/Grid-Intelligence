#!/usr/bin/env python3
"""
probe-aeso-hourly-sources.py — what CAN we actually get hourly for a full year?

Target variables (from the Generation Stack requirement):
    TNG per asset      ✔ already seeded (meteredvolume-api, 14.9M rows)
    pool price         ✔ already seeded (poolprice-api, 22.5k hours)
    AIL / demand       ? actualforecast-api looks historical — confirm range
    MC per asset       ? CSD is a SNAPSHOT; is there an hourly capability series?
    outages            ? per-asset historical outage/derate series
    intertie flows     ? BC / MT / SK hourly
    DCR per asset      ? contingency reserve is in the CSD snapshot only?
    merit order        ? offer blocks per asset per hour — the supply-stack input

Two surfaces are probed because AESO splits data across them unpredictably:
    1. https://apimgw.aeso.ca/public   (JSON, API key)
    2. http://ets.aeso.ca/ets_web/...  (CSV servlets, no auth, date params vary)

ETS servlets use MMDDYYYY date parameters under several different names, so each
candidate is tried with a few conventions and the winning one is reported.

This writes NOTHING. It prints status, size, and the first lines of any success
so the seeder can be written against observed structure.

Usage:
    python3 infra/probe-aeso-hourly-sources.py
"""
import os, sys, datetime
import requests

API_KEY = os.environ.get("AESO_API_KEY", "")
APIMGW  = "https://apimgw.aeso.ca/public"
ETS     = "http://ets.aeso.ca/ets_web/ip/Market/Reports"
UA      = {"User-Agent": "grid-intelligence/1.0 (probe)"}

# A settled week comfortably inside any publication lag.
D1 = datetime.date(2026, 6, 1)
D2 = datetime.date(2026, 6, 7)

ISO1, ISO2 = D1.isoformat(), D2.isoformat()
US1,  US2  = D1.strftime("%m%d%Y"), D2.strftime("%m%d%Y")

# ── apimgw candidates ───────────────────────────────────────────────────────
API_CANDIDATES = [
    ("AIL actual/forecast", "actualforecast-api/v1/load/albertaInternalLoad",
        {"startDate": ISO1, "endDate": ISO2}),
    ("System marginal price", "systemmarginalprice-api/v1.1/price/systemMarginalPrice",
        {"startDate": ISO1, "endDate": ISO2}),
    ("CSD assets (current)", "currentsupplydemand-api/v1/csd/generation/assets/current", {}),
    ("Asset outages?", "assetoutage-api/v1/assetoutage",
        {"startDate": ISO1, "endDate": ISO2}),
    ("Intertie?", "intertie-api/v1/intertie",
        {"startDate": ISO1, "endDate": ISO2}),
    ("Merit order?", "energymeritorder-api/v1/meritOrder/energy",
        {"startDate": ISO1, "endDate": ISO2}),
]

# ── ETS servlet candidates ──────────────────────────────────────────────────
# Each entry: label, servlet, list of param dicts to try in order.
DATE_CONVENTIONS = [
    {"beginDate": US1, "endDate": US2},
    {"startDate": US1, "endDate": US2},
    {"beginDate": US1, "endDate": US2, "contentType": "csv"},
]

ETS_CANDIDATES = [
    ("Actual/Forecast AIL",   "ActualForecastWMRQHReportServlet"),
    ("Pool price history",    "HistoricalPoolPriceReportServlet"),
    ("Daily avg pool price",  "DailyAveragePoolPriceReportServlet"),
    ("System marginal price", "SMPriceReportServlet"),
    ("Merit order snapshot",  "MeritOrderSnapshotEnergyReportServlet"),
    ("Energy merit order",    "EnergyMeritOrderReportServlet"),
    ("Asset list",            "AssetListReportServlet"),
    ("Generation outages",    "GenerationOutageReportServlet"),
    ("Outage report",         "OutageReportServlet"),
    ("Actual interchange",    "ActualInterchangeReportServlet"),
    ("Interchange",           "InterchangeReportServlet"),
    ("Supply adequacy 7d",    "SupplyAdequacyReportServlet"),
    ("Hourly availability",   "HourlyAvailabilityReportServlet"),
]

WIDTH = 74


def show(label, url, resp, note=""):
    print("\n" + "=" * WIDTH)
    print(f"{label}")
    print(f"  {url}")
    if note:
        print(f"  {note}")
    print("=" * WIDTH)
    if resp is None:
        print("  FAILED (no response)")
        return False
    print(f"  HTTP {resp.status_code}   {len(resp.content):,} bytes")
    if resp.status_code != 200:
        print(f"  {resp.text[:200]}")
        return False
    body = resp.text.strip()
    if not body or len(body) < 40:
        print(f"  EMPTY / trivial body: {body[:120]!r}")
        return False
    for line in body.splitlines()[:14]:
        print(f"    {line[:150]}")
    return True


def probe_api():
    if not API_KEY:
        print("AESO_API_KEY not set — skipping apimgw probes")
        return
    headers = {"API-KEY": API_KEY, "Accept": "application/json", **UA}
    for label, path, params in API_CANDIDATES:
        url = f"{APIMGW}/{path}"
        try:
            r = requests.get(url, headers=headers, params=params, timeout=90)
        except Exception as e:
            show(f"[API] {label}", url, None, note=str(e))
            continue
        show(f"[API] {label}", url, r)


def probe_ets():
    for label, servlet in ETS_CANDIDATES:
        url = f"{ETS}/{servlet}"
        got = False
        for conv in DATE_CONVENTIONS:
            params = {"contentType": "csv", **conv}
            try:
                r = requests.get(url, params=params, headers=UA, timeout=90)
            except Exception as e:
                show(f"[ETS] {label}", url, None, note=str(e))
                break
            if r.status_code == 200 and len(r.text.strip()) > 40:
                ok = show(f"[ETS] {label}", r.url, r,
                          note=f"date convention: {list(conv)}")
                if ok:
                    got = True
                    break
        if not got:
            print(f"\n[ETS] {label:24s} — no convention returned usable CSV ({servlet})")


if __name__ == "__main__":
    print(f"Probing AESO hourly sources for {ISO1} → {ISO2}\n")
    probe_api()
    probe_ets()
    print("\n\nDone — nothing written. Paste the output.")
