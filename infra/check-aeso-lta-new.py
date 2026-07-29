#!/usr/bin/env python3
"""
check-aeso-lta-new.py — flags (does not apply) new AESO LTA reports.

LTA_REPORTS in artifacts/api-server/src/routes/aeso_stats.ts is a hardcoded
list of AESO Long-Term Adequacy Metrics PDF URLs. AESO posts a new quarterly
report roughly 4x/year at aeso.ca. This script fetches AESO's LTA listing
page, extracts every /download/listedfiles/*LTA*.pdf or *adequacy*.pdf link,
and compares it against the URLs already hardcoded in aeso_stats.ts.

It does NOT edit source or trigger a rebuild — the fix for "a new report
exists" is a one-line addition to LTA_REPORTS by a human, not an unattended
code change. This script's only job is to make that one-line addition
impossible to miss: it logs a loud, greppable "NEW LTA REPORT FOUND" line
when it sees a URL that isn't already tracked.

Run: .venv/bin/python3 infra/check-aeso-lta-new.py
Exit code is always 0 (informational only) — this must never fail the cron
chain for the other jobs in refresh-cron.sh.
"""
import re
import sys
import urllib.request

LISTING_URL = "https://www.aeso.ca/market/market-and-system-reporting/long-term-adequacy-metrics/"
AESO_STATS_TS = "artifacts/api-server/src/routes/aeso_stats.ts"
PDF_PATTERN = re.compile(
    r'href="(/download/listedfiles/[^"]*(?:LTA|adequacy)[^"]*\.pdf)"', re.IGNORECASE
)


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; GridIntelBot/1.0)"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def known_urls_from_source() -> set[str]:
    try:
        with open(AESO_STATS_TS, "r", encoding="utf-8") as f:
            src = f.read()
    except FileNotFoundError:
        print(f"[check-aeso-lta-new] WARNING: {AESO_STATS_TS} not found — run from repo root")
        return set()
    return set(re.findall(r'url:\s*"(https://www\.aeso\.ca/download/listedfiles/[^"]+)"', src))


def main() -> int:
    known = known_urls_from_source()
    if not known:
        print("[check-aeso-lta-new] WARNING: no known LTA URLs extracted from source — skipping comparison")
        return 0

    try:
        html = fetch(LISTING_URL)
    except Exception as e:
        print(f"[check-aeso-lta-new] WARNING: could not fetch {LISTING_URL}: {e}")
        return 0

    found_paths = set(m.group(1) for m in PDF_PATTERN.finditer(html))
    found_urls = {f"https://www.aeso.ca{p}" for p in found_paths}

    new_urls = found_urls - known
    if new_urls:
        print("[check-aeso-lta-new] ================================================")
        print("[check-aeso-lta-new] NEW LTA REPORT FOUND — add to LTA_REPORTS in")
        print(f"[check-aeso-lta-new]   {AESO_STATS_TS}")
        for u in sorted(new_urls):
            print(f"[check-aeso-lta-new]   NEW: {u}")
        print("[check-aeso-lta-new] ================================================")
    else:
        print(f"[check-aeso-lta-new] OK — no new reports beyond the {len(known)} already tracked")

    return 0


if __name__ == "__main__":
    sys.exit(main())
