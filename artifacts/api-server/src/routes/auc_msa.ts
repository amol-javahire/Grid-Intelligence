import { Router } from "express";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const router = Router();

// ── Disk-persistent cache (survives server restarts) ─────────────
const CACHE_DIR = "/tmp/aeso-scrape-cache";

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readDiskCache<T>(key: string, maxAgeMs: number): T | null {
  try {
    const file = path.join(CACHE_DIR, key + ".json");
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeDiskCache(key: string, data: unknown) {
  try {
    ensureCacheDir();
    fs.writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify(data));
  } catch { /* ignore write failures */ }
}

// ── In-memory cache (fast second layer) ─────────────────────────
interface CacheEntry { data: unknown; expiresAt: number }
const memCache = new Map<string, CacheEntry>();

function getMemCache<T>(key: string): T | null {
  const entry = memCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.data as T;
}
function setMemCache(key: string, data: unknown, ttlMs: number) {
  memCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;
const WEEK = 7 * DAY;

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

type AucFeedData = { items: ReturnType<typeof parseAucRss>; fetchedAt: string; source: string };

// ── Exported helpers (shared by copilot) ──────────────────────────
export async function getAucFeed(): Promise<AucFeedData> {
  const cacheKey = "auc_feed";

  // 1. In-memory (fastest)
  const inMem = getMemCache<AucFeedData>(cacheKey);
  if (inMem) return inMem;

  // 2. Disk cache (survives restarts, fresh for 1 week)
  const onDisk = readDiskCache<AucFeedData>(cacheKey, WEEK);
  if (onDisk) {
    setMemCache(cacheKey, onDisk, HOUR);
    return onDisk;
  }

  // 3. Live fetch — only if no disk cache exists
  const xml  = curlGet("https://www.auc.ab.ca/feed/");
  const news = parseAucRss(xml);
  const data: AucFeedData = { items: news, fetchedAt: new Date().toISOString(), source: "https://www.auc.ab.ca/feed/" };
  writeDiskCache(cacheKey, data);
  setMemCache(cacheKey, data, HOUR);
  return data;
}

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

type MsaDocsData = { docs: MsaDoc[]; category: string; fetchedAt: string; source: string };

export async function getMsaDocs(category = "all"): Promise<MsaDocsData> {
  const url = MSA_CATEGORY_URLS[category] ?? MSA_CATEGORY_URLS.all;
  const cacheKey = `msa_docs_${category}`;

  // 1. In-memory
  const inMem = getMemCache<MsaDocsData>(cacheKey);
  if (inMem) return inMem;

  // 2. Disk cache (fresh for 1 week)
  const onDisk = readDiskCache<MsaDocsData>(cacheKey, WEEK);
  if (onDisk) {
    setMemCache(cacheKey, onDisk, HOUR);
    return onDisk;
  }

  // 3. Live fetch — only if no disk cache exists
  const html = curlGet(url);
  const docs = parseMsaDocs(html);
  const data: MsaDocsData = { docs, category, fetchedAt: new Date().toISOString(), source: url };
  writeDiskCache(cacheKey, data);
  setMemCache(cacheKey, data, HOUR);
  return data;
}

router.get("/aeso/auc/feed", async (_req, res) => {
  try {
    const data = await getAucFeed();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch AUC feed" });
  }
});

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
router.get("/aeso/msa/recent", async (_req, res) => {
  const cacheKey = "msa_recent";

  // 1. In-memory
  const inMem = getMemCache(cacheKey);
  if (inMem) return res.json(inMem);

  // 2. Disk cache (fresh for 1 week)
  const onDisk = readDiskCache(cacheKey, WEEK);
  if (onDisk) {
    setMemCache(cacheKey, onDisk, HOUR);
    return res.json(onDisk);
  }

  // 3. Live fetch — only if no disk cache exists
  try {
    const html = curlGet("https://www.albertamsa.ca/");
    const updates: { date: string; title: string; url: string }[] = [];

    const text = stripHtml(html);
    const dateLines = [...text.matchAll(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})\s+([^.]+)/g)];
    for (const m of dateLines.slice(0, 10)) {
      updates.push({ date: m[1].trim(), title: m[2].trim(), url: "https://www.albertamsa.ca/documents" });
    }

    const docLinks = [...html.matchAll(/href="(\/assets\/Documents\/[^"]+)"\s*[^>]*>([^<]+)/gi)];
    const docItems = docLinks.slice(0, 8).map(m => ({
      url: `https://www.albertamsa.ca${m[1]}`,
      title: m[2].trim(),
    }));

    const data = { updates: updates.slice(0, 10), docLinks: docItems, fetchedAt: new Date().toISOString() };
    writeDiskCache(cacheKey, data);
    setMemCache(cacheKey, data, HOUR);
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch MSA recent updates" });
  }
});

// ── Cache status ─────────────────────────────────────────────────
router.get("/aeso/scrape/cache-status", (_req, res) => {
  const entries: Record<string, { expiresIn: string; hasData: boolean; onDisk: boolean }> = {};
  for (const [key, entry] of memCache.entries()) {
    const remaining = Math.max(0, entry.expiresAt - Date.now());
    const mins = Math.floor(remaining / 60000);
    const diskFile = path.join(CACHE_DIR, key + ".json");
    entries[key] = {
      expiresIn: `${mins}m (memory)`,
      hasData: !!entry.data,
      onDisk: fs.existsSync(diskFile),
    };
  }
  res.json({ cacheEntries: entries, cacheDir: CACHE_DIR });
});

// ── Manual refresh (admin only) ──────────────────────────────────
router.post("/aeso/scrape/refresh", async (_req, res) => {
  try {
    ensureCacheDir();
    // Clear disk caches to force re-fetch on next request
    for (const key of ["auc_feed", "msa_docs_all", "msa_recent"]) {
      const file = path.join(CACHE_DIR, key + ".json");
      if (fs.existsSync(file)) fs.unlinkSync(file);
      memCache.delete(key);
    }
    res.json({ message: "Cache cleared — next page load will re-fetch from live sources" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
