#!/usr/bin/env python3
"""
Monthly regulatory scraper — fetches new items from ERCOT, CAISO, PUCT, and FERC
and upserts them into the regulatory_items table.

Run: cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/scrape-regulatory.py

Sources:
  ERCOT news:     https://www.ercot.com/news/releases
  CAISO notices:  https://www.caiso.com/market/Pages/MarketNotices/Default.aspx
  FERC news:      https://www.ferc.gov/news-events/news
  PUCT press:     https://www.puc.texas.gov/about/puc/news/press/
"""
import os, re, json, psycopg2
from datetime import date, datetime
from urllib.request import urlopen, Request
from urllib.error import URLError
from html.parser import HTMLParser

DATABASE_URL = os.environ["DATABASE_URL"]

# ── Simple HTML stripper ───────────────────────────────────────────────────────
class _Stripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)
    def get_text(self):
        return " ".join(p.strip() for p in self.parts if p.strip())

def strip_html(html: str) -> str:
    s = _Stripper()
    s.feed(html)
    return s.get_text()

def fetch(url: str, timeout=15) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GridPlatformBot/1.0; +https://replit.com)"
    }
    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="replace")
    except URLError as e:
        print(f"  WARN: Could not fetch {url}: {e}")
        return ""

# ── ERCOT news scraper ─────────────────────────────────────────────────────────
def scrape_ercot() -> list[dict]:
    print("Scraping ERCOT news releases...")
    html = fetch("https://www.ercot.com/news/releases")
    if not html:
        return []

    items = []
    # ERCOT news items are in <li class="news-item"> tags
    blocks = re.findall(
        r'<li[^>]*class="[^"]*news-item[^"]*"[^>]*>(.*?)</li>',
        html, re.DOTALL
    )
    for block in blocks[:20]:
        title_m = re.search(r'<a[^>]*>([^<]+)</a>', block)
        date_m  = re.search(r'<span[^>]*class="[^"]*date[^"]*"[^>]*>([^<]+)</span>', block)
        href_m  = re.search(r'href="([^"]+)"', block)

        if not title_m:
            continue

        title = title_m.group(1).strip()
        pub_date = date_m.group(1).strip() if date_m else None
        href = href_m.group(1).strip() if href_m else None
        url = f"https://www.ercot.com{href}" if href and href.startswith("/") else href

        # Parse date
        parsed_date = None
        if pub_date:
            for fmt in ["%B %d, %Y", "%m/%d/%Y", "%Y-%m-%d"]:
                try:
                    parsed_date = datetime.strptime(pub_date, fmt).date().isoformat()
                    break
                except ValueError:
                    pass

        # Auto-classify category
        t_lower = title.lower()
        if any(w in t_lower for w in ["interconnect", "queue", "generation tie"]):
            category = "interconnection"
        elif any(w in t_lower for w in ["weather", "winter", "summer", "storm"]):
            category = "reliability"
        elif any(w in t_lower for w in ["transmission", "crez", "line"]):
            category = "transmission"
        elif any(w in t_lower for w in ["ancillary", "market", "price", "ordc", "capacity"]):
            category = "market_rules"
        else:
            category = "market_rules"

        items.append({
            "market": "ERCOT",
            "category": category,
            "title": title,
            "summary": f"ERCOT press release: {title}",
            "detail": None,
            "effective_date": parsed_date,
            "announced_date": parsed_date,
            "status": "active",
            "impact_level": "medium",
            "source_url": url,
            "source_name": "ERCOT",
            "tags": json.dumps(["scraped", "ercot", "press_release"]),
            "model_impact": "Review press release for grid impact assessment.",
        })

    print(f"  Found {len(items)} ERCOT items")
    return items

# ── CAISO market notices scraper ──────────────────────────────────────────────
def scrape_caiso() -> list[dict]:
    print("Scraping CAISO market notices...")
    # Try CAISO initiatives page
    html = fetch("https://www.caiso.com/market/Pages/MarketNotices/Default.aspx")
    if not html:
        return []

    items = []
    # Extract notice entries
    blocks = re.findall(
        r'<tr[^>]*>(.*?)</tr>',
        html, re.DOTALL
    )
    for block in blocks[:30]:
        cells = re.findall(r'<td[^>]*>(.*?)</td>', block, re.DOTALL)
        if len(cells) < 2:
            continue
        title_raw = strip_html(cells[0]) if cells else ""
        date_raw  = strip_html(cells[1]) if len(cells) > 1 else ""
        href_m    = re.search(r'href="([^"]+)"', cells[0])

        if not title_raw or len(title_raw) < 10:
            continue

        url = href_m.group(1).strip() if href_m else None
        if url and not url.startswith("http"):
            url = f"https://www.caiso.com{url}"

        parsed_date = None
        for fmt in ["%m/%d/%Y", "%B %d, %Y", "%Y-%m-%d"]:
            try:
                parsed_date = datetime.strptime(date_raw.strip(), fmt).date().isoformat()
                break
            except ValueError:
                pass

        t_lower = title_raw.lower()
        if any(w in t_lower for w in ["interconnect", "queue"]):
            category = "interconnection"
        elif any(w in t_lower for w in ["edam", "weim", "market", "dame", "day-ahead"]):
            category = "market_rules"
        elif any(w in t_lower for w in ["resource adequacy", "ra ", "capacity"]):
            category = "capacity"
        elif any(w in t_lower for w in ["transmission", "network"]):
            category = "transmission"
        elif any(w in t_lower for w in ["renewable", "carbon", "clean", "sb 100"]):
            category = "environmental"
        else:
            category = "market_rules"

        items.append({
            "market": "CAISO",
            "category": category,
            "title": title_raw[:200],
            "summary": f"CAISO market notice: {title_raw[:200]}",
            "detail": None,
            "effective_date": parsed_date,
            "announced_date": parsed_date,
            "status": "active",
            "impact_level": "medium",
            "source_url": url,
            "source_name": "CAISO",
            "tags": json.dumps(["scraped", "caiso", "market_notice"]),
            "model_impact": "Review market notice for pricing and dispatch impact.",
        })

    print(f"  Found {len(items)} CAISO items")
    return items

# ── FERC news scraper ──────────────────────────────────────────────────────────
def scrape_ferc() -> list[dict]:
    print("Scraping FERC news...")
    html = fetch("https://www.ferc.gov/news-events/news")
    if not html:
        return []

    items = []
    blocks = re.findall(
        r'<div[^>]*class="[^"]*views-row[^"]*"[^>]*>(.*?)</div>',
        html, re.DOTALL
    )
    for block in blocks[:15]:
        title_m = re.search(r'<h[23][^>]*>.*?<a[^>]*>([^<]+)</a>.*?</h[23]>', block, re.DOTALL)
        date_m  = re.search(r'<time[^>]*datetime="([^"]+)"', block)
        href_m  = re.search(r'href="(/news-events/news/[^"]+)"', block)

        if not title_m:
            continue

        title = title_m.group(1).strip()
        url = f"https://www.ferc.gov{href_m.group(1)}" if href_m else None
        parsed_date = date_m.group(1)[:10] if date_m else None

        t_lower = title.lower()
        if any(w in t_lower for w in ["interconnect", "order 2023", "queue"]):
            category = "interconnection"
        elif any(w in t_lower for w in ["electric", "market", "rate", "tariff"]):
            category = "market_rules"
        elif any(w in t_lower for w in ["transmission", "grid"]):
            category = "transmission"
        else:
            category = "market_rules"

        items.append({
            "market": "FEDERAL",
            "category": category,
            "title": title,
            "summary": f"FERC news: {title}",
            "detail": None,
            "effective_date": parsed_date,
            "announced_date": parsed_date,
            "status": "active",
            "impact_level": "medium",
            "source_url": url,
            "source_name": "FERC",
            "tags": json.dumps(["scraped", "ferc", "news"]),
            "model_impact": "Review FERC action for interconnection or market structure impact.",
        })

    print(f"  Found {len(items)} FERC items")
    return items

# ── Upsert to DB ───────────────────────────────────────────────────────────────
def upsert_items(items: list[dict]):
    if not items:
        return 0

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Ensure table exists
    cur.execute("""
        CREATE TABLE IF NOT EXISTS regulatory_items (
            id              SERIAL PRIMARY KEY,
            market          VARCHAR(10) NOT NULL,
            category        VARCHAR(30) NOT NULL,
            title           TEXT NOT NULL,
            summary         TEXT NOT NULL,
            detail          TEXT,
            effective_date  DATE,
            announced_date  DATE,
            status          VARCHAR(20) NOT NULL,
            impact_level    VARCHAR(10) NOT NULL,
            source_url      TEXT,
            source_name     TEXT,
            tags            TEXT,
            model_impact    TEXT,
            scraped_at      TIMESTAMPTZ DEFAULT NOW(),
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    inserted = 0
    for item in items:
        # Skip if title already exists (avoid duplicates from repeated scrapes)
        cur.execute("SELECT id FROM regulatory_items WHERE title = %s AND market = %s",
                    (item["title"], item["market"]))
        if cur.fetchone():
            continue

        cur.execute("""
            INSERT INTO regulatory_items
              (market, category, title, summary, detail, effective_date, announced_date,
               status, impact_level, source_url, source_name, tags, model_impact)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            item["market"], item["category"], item["title"], item["summary"],
            item.get("detail"), item.get("effective_date"), item.get("announced_date"),
            item["status"], item["impact_level"], item.get("source_url"),
            item.get("source_name"), item.get("tags"), item.get("model_impact"),
        ))
        inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    return inserted

def main():
    print("=" * 60)
    print(f"Regulatory Scraper — {date.today()}")
    print("=" * 60)

    all_items = []
    all_items.extend(scrape_ercot())
    all_items.extend(scrape_caiso())
    all_items.extend(scrape_ferc())

    print(f"\nTotal scraped: {len(all_items)} items")
    inserted = upsert_items(all_items)
    print(f"Inserted {inserted} new items (skipped {len(all_items) - inserted} duplicates)")
    print("Done.")

if __name__ == "__main__":
    main()
