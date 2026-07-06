import { Router } from "express";
import { execSync } from "child_process";

const router = Router();

// ── Simple in-memory cache ──────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number }
const cache = new Map<string, CacheEntry>();

function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data as T;
}
function setCache(key: string, data: unknown, ttlMs: number) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// ── Helpers ─────────────────────────────────────────────────────
function curlGet(url: string): string {
  try {
    return execSync(
      `curl -sL --max-time 20 -A "Mozilla/5.0 (compatible; AESOBot/1.0)" "${url}"`,
      { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }
    ).toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
          .replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

// ── AUC RSS scraper ─────────────────────────────────────────────
function parseAucRss(xml: string) {
  const items: {
    title: string; link: string; pubDate: string;
    categories: string[]; excerpt: string;
  }[] = [];

  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  for (const m of itemBlocks) {
    const block = m[1];
    const title    = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) ?? [])[1] ?? "";
    const link     = (block.match(/<link>(https?:\/\/[^<]+)<\/link>/) ?? [])[1] ?? "";
    const pubDate  = (block.match(/<pubDate>([^<]+)<\/pubDate>/) ?? [])[1] ?? "";
    const cats     = [...block.matchAll(/<category>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/category>/g)].map(c => c[1]);
    const descRaw  = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) ?? [])[1] ?? "";
    const excerpt  = stripHtml(descRaw).slice(0, 300);
    if (title && link) {
      items.push({ title: stripHtml(title), link, pubDate: pubDate.trim(), categories: cats, excerpt });
    }
  }
  return items;
}

// ── Exported helpers (shared by copilot) ──────────────────────────
export async function getAucFeed(): Promise<{ items: ReturnType<typeof parseAucRss>; fetchedAt: string; source: string }> {
  const cacheKey = "auc:feed";
  const cached = getCache<{ items: ReturnType<typeof parseAucRss>; fetchedAt: string; source: string }>(cacheKey);
  if (cached) return cached;
  const xml  = curlGet("https://www.auc.ab.ca/feed/");
  const news = parseAucRss(xml);
  const data = { items: news, fetchedAt: new Date().toISOString(), source: "https://www.auc.ab.ca/feed/" };
  setCache(cacheKey, data, HOUR);
  return data;
}

export async function getMsaDocs(category = "all"): Promise<{ docs: MsaDoc[]; category: string; fetchedAt: string; source: string }> {
  const url = MSA_CATEGORY_URLS[category] ?? MSA_CATEGORY_URLS.all;
  const cacheKey = `msa:docs:${category}`;
  const cached = getCache<{ docs: MsaDoc[]; category: string; fetchedAt: string; source: string }>(cacheKey);
  if (cached) return cached;
  const html = curlGet(url);
  const docs = parseMsaDocs(html);
  const data = { docs, category, fetchedAt: new Date().toISOString(), source: url };
  setCache(cacheKey, data, DAY);
  return data;
}

router.get("/aeso/auc/feed", async (req, res) => {
  try {
    const data = await getAucFeed();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AUC feed" });
  }
});

// ── MSA document scraper ─────────────────────────────────────────
interface MsaDoc {
  title: string; category: string; date: string;
  url: string; type: "PDF" | "XLSX" | "Other";
}

function parseMsaDocs(html: string): MsaDoc[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const docs: MsaDoc[] = [];
  const seen = new Set<string>();

  for (const rowM of rows) {
    const cells = [...rowM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if (cells.length < 3) continue;

    const linkM = cells[0].match(/href="(\/assets\/Documents\/[^"]+)"/i);
    const title = stripHtml(cells[0]);
    const cat   = stripHtml(cells[1]);
    const date  = stripHtml(cells[2]);
    const url   = linkM ? linkM[1] : "";

    if (!title || !cat || cat === "Category" || !url || seen.has(url)) continue;
    seen.add(url);

    const ext = url.split(".").pop()?.toLowerCase() ?? "";
    const type: MsaDoc["type"] = ext === "pdf" ? "PDF" : ext === "xlsx" ? "XLSX" : "Other";
    docs.push({ title, category: cat, date, url, type });
  }
  return docs;
}

const MSA_CATEGORY_URLS: Record<string, string> = {
  all:        "https://www.albertamsa.ca/documents",
  reports:    "https://www.albertamsa.ca/documents/reports/quarterly-reports",
  annual:     "https://www.albertamsa.ca/documents/reports/annual-report-to-the-minister",
  notices:    "https://www.albertamsa.ca/documents/notices/notices",
  compliance: "https://www.albertamsa.ca/documents/compliance/compliance-process",
  guidelines: "https://www.albertamsa.ca/documents/guidelines/guidelines",
  retail:     "https://www.albertamsa.ca/documents/retail-and-rate-cap/retail-statistics",
};

router.get("/aeso/msa/documents", async (req, res) => {
  const category = (req.query.category as string) ?? "all";
  try {
    const data = await getMsaDocs(category);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch MSA documents" });
  }
});

// ── MSA home page recent updates ─────────────────────────────────
router.get("/aeso/msa/recent", async (req, res) => {
  const cacheKey = "msa:recent";
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const html = curlGet("https://www.albertamsa.ca/");
    // Extract recent update items (date + title + link)
    const updates: { date: string; title: string; url: string }[] = [];
    const blocks = [...html.matchAll(/<(?:li|div)[^>]*class="[^"]*(?:update|news|recent)[^"]*"[^>]*>([\s\S]*?)<\/(?:li|div)>/gi)];

    // Fallback: grab any date-prefixed lines from text
    const text = stripHtml(html);
    const dateLines = [...text.matchAll(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\s+([^.]+)/g)];
    for (const m of dateLines.slice(0, 10)) {
      updates.push({ date: m[1].trim(), title: m[2].trim(), url: "https://www.albertamsa.ca/documents" });
    }

    // Also scrape the doc links from home page
    const docLinks = [...html.matchAll(/href="(\/assets\/Documents\/[^"]+)"\s*[^>]*>([^<]+)/gi)];
    const docItems = docLinks.slice(0, 8).map(m => ({
      url: `https://www.albertamsa.ca${m[1]}`,
      title: m[2].trim(),
    }));

    const data = { updates: updates.slice(0, 10), docLinks: docItems, fetchedAt: new Date().toISOString() };
    setCache(cacheKey, data, HOUR);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch MSA recent updates" });
  }
});

// ── Cache status ─────────────────────────────────────────────────
router.get("/aeso/scrape/cache-status", (_req, res) => {
  const entries: Record<string, { expiresIn: string; hasData: boolean }> = {};
  for (const [key, entry] of cache.entries()) {
    const remaining = Math.max(0, entry.expiresAt - Date.now());
    const mins = Math.floor(remaining / 60000);
    entries[key] = { expiresIn: `${mins}m`, hasData: !!entry.data };
  }
  res.json({ cacheEntries: entries });
});

export default router;
