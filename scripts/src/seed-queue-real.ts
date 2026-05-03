import https from "https";
import { db, queueProjectsTable } from "@workspace/db";

// ── Low-level HTTP fetch returning Buffer ────────────────────────────────────
async function fetchBuf(
  url: string,
  reqHeaders: Record<string, string> = {},
  redirects = 0,
): Promise<Buffer> {
  if (redirects > 8) throw new Error(`Too many redirects: ${url}`);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || 443,
      headers: {
        "User-Agent": "GridOriginationPlatform/1.0 (energy-data-research)",
        Accept: "application/octet-stream,*/*",
        ...reqHeaders,
      },
    };
    https.get(opts, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        resolve(fetchBuf(loc, reqHeaders, redirects + 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchJSON(url: string): Promise<unknown> {
  const buf = await fetchBuf(url, { Accept: "application/json" });
  return JSON.parse(buf.toString("utf8"));
}

// ── County centroids from US Census Bureau ───────────────────────────────────
type CentroidMap = Record<string, [number, number]>; // "COUNTY|ST" → [lat, lon]

const STATE_ABBR: Record<string, string> = {
  California: "CA", Nevada: "NV", Arizona: "AZ", Texas: "TX",
  Pennsylvania: "PA", Ohio: "OH", Illinois: "IL", "New Jersey": "NJ",
  Maryland: "MD", Virginia: "VA", "West Virginia": "WV", Delaware: "DE",
  Indiana: "IN", Michigan: "MI", Kentucky: "KY", "North Carolina": "NC",
  Tennessee: "TN",
};

async function buildCentroids(): Promise<CentroidMap> {
  const url =
    "https://www2.census.gov/geo/docs/reference/cenpop2020/county/CenPop2020_Mean_CO.txt";
  console.log("  Fetching county centroids from Census Bureau...");
  const text = (await fetchBuf(url)).toString("utf8");
  const map: CentroidMap = {};
  for (const line of text.trim().split("\n").slice(1)) {
    const p = line.split(",");
    if (p.length < 7) continue;
    const abbr = STATE_ABBR[p[3]];
    if (!abbr) continue;
    const county = p[2].toUpperCase().replace(/ COUNTY$/, "").replace(/ PARISH$/, "").trim();
    const lat = parseFloat(p[5]);
    const lon = parseFloat(p[6]);
    if (!isNaN(lat) && !isNaN(lon)) map[`${county}|${abbr}`] = [lat, lon];
  }
  console.log(`  County centroid lookup: ${Object.keys(map).length} entries`);
  return map;
}

function geocode(
  rawCounty: string | null | undefined,
  rawState: string | null | undefined,
  map: CentroidMap,
): [number, number] | null {
  if (!rawCounty || !rawState) return null;
  const county = rawCounty
    .toUpperCase()
    .replace(/ COUNTY$/i, "")
    .replace(/ PARISH$/i, "")
    .replace(/ CO\.$/i, "")
    .trim();
  const state = rawState.toUpperCase().trim().slice(0, 2);
  return map[`${county}|${state}`] ?? null;
}

// ── Fuel-type mapping ────────────────────────────────────────────────────────
function mapFuel(
  f1: unknown,
  f2?: unknown,
  f3?: unknown,
): string {
  const fuels = [f1, f2, f3]
    .filter(Boolean)
    .map((f) => String(f).toLowerCase());
  const has = (kw: string) => fuels.some((f) => f.includes(kw));
  if (has("offshore")) return "offshore_wind";
  const isSolar = has("solar") || has("photovoltaic");
  const isWind = has("wind turbine") || (has("wind") && !has("offshore"));
  const isStore = has("storage") || has("battery") || has("pumped");
  if (isSolar && isWind) return "hybrid";
  if (isSolar && isStore) return "hybrid";
  if (isWind && isStore) return "hybrid";
  if (isSolar) return "solar";
  if (isWind) return "wind";
  if (isStore) return "storage";
  if (has("geothermal")) return "geothermal";
  if (has("nuclear")) return "nuclear";
  if (has("hydro")) return "hydro";
  if (has("biomass") || has("biogas") || has("landfill")) return "biomass";
  if (has("gas") || has("combustion") || has("combined cycle") || has("steam turbine"))
    return "natural_gas";
  return "solar";
}

// ── EIA fuel-code mapping ────────────────────────────────────────────────────
function mapEIAFuel(technology: string): string {
  const t = technology.toLowerCase();
  if (t.includes("solar")) return "solar";
  if (t.includes("wind")) return "wind";
  if (t.includes("storage") || t.includes("battery")) return "storage";
  if (t.includes("pumped")) return "storage";
  if (t.includes("geothermal")) return "geothermal";
  if (t.includes("nuclear") || t.includes("smr")) return "nuclear";
  if (t.includes("hydro")) return "hydro";
  if (t.includes("biomass") || t.includes("landfill")) return "biomass";
  if (t.includes("gas") || t.includes("combustion") || t.includes("combined cycle"))
    return "natural_gas";
  return "solar";
}

// ── Status mapping ───────────────────────────────────────────────────────────
function mapStatus(v: unknown): string {
  const s = String(v ?? "").toLowerCase().trim();
  if (s.includes("active") || s === "a") return "active";
  if (s.includes("complet") || s === "cod" || s === "op") return "completed";
  if (s.includes("withdr") || s === "w" || s === "c") return "withdrawn";
  if (s.includes("suspend")) return "suspended";
  return "active";
}

// ── Excel serial-date → JS Date ──────────────────────────────────────────────
function xlDate(v: unknown): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (!isNaN(n) && n > 1000) return new Date((n - 25569) * 86400 * 1000);
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

// ── CAISO utility → price zone ───────────────────────────────────────────────
function caisoZone(util: unknown): string {
  const u = String(util ?? "").toUpperCase();
  if (u.includes("PGAE") || u.includes("PG&E") || u.includes("PACIFIC GAS")) return "NP15";
  if (u.includes("SDGE") || u.includes("SAN DIEGO")) return "SP15";
  return "SP15";
}

// ── Parse CAISO PublicQueueReport + Cluster 15 ────────────────────────────────
async function fetchCAISO(
  centroids: CentroidMap,
): Promise<Array<typeof queueProjectsTable.$inferInsert>> {
  const XLSX = await import("xlsx");
  const projects: Array<typeof queueProjectsTable.$inferInsert> = [];
  const seen = new Set<string>();

  // Helper to parse a PublicQueueReport-style workbook
  function parseQueueWB(
    buf: Buffer,
    source: string,
    queuePrefix: string,
  ) {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
    for (const sheetName of wb.SheetNames) {
      const sh = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sh, {
        header: 1,
        defval: null,
      }) as unknown[][];

      // Find header row
      const hdrIdx = rows.findIndex(
        (r) =>
          Array.isArray(r) &&
          r.some((c) =>
            String(c ?? "")
              .replace(/\r\n/g, " ")
              .toLowerCase()
              .includes("project name"),
          ),
      );
      if (hdrIdx < 0) continue;

      const hdr = (rows[hdrIdx] as unknown[]).map((c) =>
        String(c ?? "").replace(/\r\n/g, " ").trim().toLowerCase(),
      );
      const ci = (kw: string) => hdr.findIndex((h) => h.includes(kw));

      const nameCol      = ci("project name");
      const queuePosCol  = ci("queue position");
      const queueNumCol  = ci("queue number");
      const reqDateCol   = ci("receive date");
      const statusCol    = ci("application status");
      const studyCol     = ci("study");
      const withdrDateCol = ci("withdrawn date");
      const fuel1Col     = ci("fuel-1") >= 0 ? ci("fuel-1") : ci("fuel 1");
      const fuel2Col     = ci("fuel-2") >= 0 ? ci("fuel-2") : ci("fuel 2");
      const fuel3Col     = ci("fuel-3") >= 0 ? ci("fuel-3") : ci("fuel 3");
      const mwNetCol     = ci("net mws to grid") >= 0
        ? ci("net mws to grid")
        : ci("net mw poi");
      const countyCol    = ci("county");
      const stateCol     = ci("state");
      const utilCol      = ci("utility");

      const isWithdrawnSheet = sheetName.toLowerCase().includes("withdrawn");
      let rowsParsed = 0;

      for (const row of rows.slice(hdrIdx + 1)) {
        if (!Array.isArray(row)) continue;
        const rawName = row[nameCol];
        if (!rawName) continue;
        const name = String(rawName).trim();
        if (!name || name.toLowerCase().startsWith("project name")) continue;
        if (seen.has(name)) continue;
        seen.add(name);

        const mwRaw = mwNetCol >= 0 ? row[mwNetCol] : null;
        const mw = parseFloat(String(mwRaw ?? 0)) || 0;
        if (mw <= 0) continue;

        const status = mapStatus(statusCol >= 0 ? row[statusCol] : (isWithdrawnSheet ? "withdrawn" : "active"));
        const fuelType = mapFuel(
          fuel1Col >= 0 ? row[fuel1Col] : null,
          fuel2Col >= 0 ? row[fuel2Col] : null,
          fuel3Col >= 0 ? row[fuel3Col] : null,
        );

        const county = countyCol >= 0 ? String(row[countyCol] ?? "").trim() : "";
        const state  = stateCol  >= 0 ? String(row[stateCol]  ?? "").trim() : "CA";
        const coords = geocode(county, state, centroids);

        const queuePosVal =
          queuePosCol >= 0 ? row[queuePosCol] : queueNumCol >= 0 ? row[queueNumCol] : null;
        const queueId = `${queuePrefix}-${String(queuePosVal ?? rowsParsed + 1).trim()}`;

        const reqDate   = xlDate(reqDateCol   >= 0 ? row[reqDateCol]   : null);
        const withDate  = xlDate(withdrDateCol >= 0 ? row[withdrDateCol] : null);
        const studyPhase =
          !isWithdrawnSheet && studyCol >= 0
            ? String(row[studyCol] ?? "").trim() || null
            : null;

        projects.push({
          projectName: name,
          market: "CAISO",
          queueId,
          fuelType,
          capacityMw: String(mw.toFixed(2)),
          status,
          latitude:  coords ? String(coords[0]) : null,
          longitude: coords ? String(coords[1]) : null,
          county:    county || null,
          state:     state  || null,
          interconnectionNode: utilCol >= 0 ? caisoZone(row[utilCol]) : "SP15",
          requestDate: reqDate,
          studyGroupPhase: studyPhase,
          withdrawalDate: withDate,
        });
        rowsParsed++;
      }
      console.log(`    ${source} / ${sheetName}: ${rowsParsed} projects`);
    }
  }

  // ── Download PublicQueueReport ──────────────────────────────────────────
  console.log("  Downloading CAISO PublicQueueReport.xlsx...");
  try {
    const buf = await fetchBuf("https://www.caiso.com/Documents/PublicQueueReport.xlsx");
    if (buf.slice(0, 4).toString("hex") === "504b0304") {
      parseQueueWB(buf, "PublicQueueReport", "CAISO");
    } else {
      console.warn("  CAISO PublicQueueReport returned non-XLSX content");
    }
  } catch (e) {
    console.warn("  CAISO PublicQueueReport fetch failed:", (e as Error).message);
  }

  // ── Download Cluster 15 ─────────────────────────────────────────────────
  console.log("  Downloading CAISO Cluster 15...");
  try {
    const buf = await fetchBuf(
      "https://www.caiso.com/Documents/cluster-15-interconnection-requests.xlsx",
    );
    if (buf.slice(0, 4).toString("hex") === "504b0304") {
      parseQueueWB(buf, "Cluster15", "CAISO-CL15");
    } else {
      console.warn("  CAISO Cluster 15 returned non-XLSX content");
    }
  } catch (e) {
    console.warn("  CAISO Cluster 15 fetch failed:", (e as Error).message);
  }

  console.log(`  CAISO total: ${projects.length} real projects`);
  return projects;
}

// ── Try EIA API for proposed generators (ERCOT = TX; PJM states) ─────────────
interface EIARow {
  period: string;
  stateid: string;
  "entity-name": string;
  technology: string;
  "nameplate-capacity-mw": number;
  status: string;
  "balancing_authority_code"?: string;
}

const EIA_KEY = process.env.EIA_API_KEY ?? "DEMO_KEY";

async function fetchEIAGenerators(
  states: string[],
  market: string,
  centroids: CentroidMap,
): Promise<Array<typeof queueProjectsTable.$inferInsert>> {
  const PJM_NODES = [
    "WESTERN HUB","EASTERN HUB","AEP-DAYTON HUB","NI HUB","PSEG",
    "PPL","DOM","BGE","JCPL","PENELEC","APS",
  ];
  const ERCOT_NODES = ["LZ_HOUSTON","LZ_WEST","LZ_NORTH","LZ_SOUTH","LZ_AEN","LZ_CPS","LZ_LCRA"];
  const nodes = market === "ERCOT" ? ERCOT_NODES : PJM_NODES;

  const stateParam = states.map((s) => `facets[stateid][]=${s}`).join("&");
  const statusParam = ["P", "L", "T", "U", "V"].map((s) => `facets[status][]=${s}`).join("&");
  const url =
    `https://api.eia.gov/v2/electricity/operating-generator-capacity/data/` +
    `?api_key=${EIA_KEY}&data[0]=nameplate-capacity-mw&${stateParam}&${statusParam}` +
    `&frequency=monthly&start=2024-06&end=2024-06&length=5000`;

  console.log(`  Fetching EIA proposed generators for ${market} (${states.join(",")})`);
  let data: EIARow[];
  try {
    const json = (await fetchJSON(url)) as { response?: { data?: EIARow[]; total?: number } };
    data = json?.response?.data ?? [];
    console.log(`  EIA ${market}: ${data.length} rows (total: ${json?.response?.total ?? "?"})`);
  } catch (e) {
    console.warn(`  EIA API failed for ${market}: ${(e as Error).message}`);
    return [];
  }

  if (data.length === 0) {
    console.warn(`  EIA returned 0 rows for ${market} — may be rate-limited with DEMO_KEY`);
    return [];
  }

  const projects: Array<typeof queueProjectsTable.$inferInsert> = [];
  const seen = new Set<string>();

  // State centroid fallback (within each state, jitter within typical renewable areas)
  const STATE_CENTERS: Record<string, [number, number, number, number]> = {
    TX: [31.0, -100.5, 1.8, 2.0],
    PA: [40.5, -77.5, 0.6, 1.0],
    OH: [40.2, -82.5, 0.5, 1.0],
    IL: [40.5, -89.5, 0.6, 1.0],
    NJ: [39.9, -74.5, 0.3, 0.4],
    MD: [39.2, -77.0, 0.3, 0.6],
    VA: [37.5, -78.5, 0.8, 1.2],
    WV: [38.8, -80.5, 0.5, 0.8],
    DE: [39.1, -75.5, 0.2, 0.2],
    IN: [39.8, -86.2, 0.5, 0.8],
    MI: [42.3, -84.5, 0.8, 1.2],
    KY: [37.5, -85.5, 0.7, 1.0],
    NC: [35.5, -79.5, 0.8, 1.5],
    TN: [35.8, -86.5, 0.5, 0.8],
  };

  let idCounter = 1;
  for (const row of data) {
    const name = String(row["entity-name"] ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const mw = parseFloat(String(row["nameplate-capacity-mw"] ?? 0)) || 0;
    if (mw <= 0) continue;

    const fuelType = mapEIAFuel(String(row.technology ?? ""));
    const state = String(row.stateid ?? "").trim();
    const sc = STATE_CENTERS[state];
    const lat = sc ? sc[0] + (Math.random() - 0.5) * sc[2] : null;
    const lon = sc ? sc[1] + (Math.random() - 0.5) * sc[3] : null;

    projects.push({
      projectName: name,
      market,
      queueId: `${market}-EIA-${String(idCounter++).padStart(4, "0")}`,
      fuelType,
      capacityMw: String(mw.toFixed(2)),
      status: "active",
      latitude:  lat !== null ? String(lat.toFixed(5)) : null,
      longitude: lon !== null ? String(lon.toFixed(5)) : null,
      county:    null,
      state:     state || null,
      interconnectionNode: nodes[Math.floor(Math.random() * nodes.length)],
      requestDate: null,
      studyGroupPhase: null,
      withdrawalDate: null,
    });
  }
  return projects;
}

// ── Synthetic fallback (geographic zones) ────────────────────────────────────
function rnd(min: number, max: number, dp = 5) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(dp));
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickW<T>(items: T[], w: number[]): T {
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

type Zone = {
  county: string; state: string;
  latMin: number; latMax: number; lonMin: number; lonMax: number;
  fuels: string[]; weights: number[];
};

const ERCOT_ZONES: Zone[] = [
  { county:"Pecos",     state:"TX", latMin:30.4,latMax:31.3,lonMin:-102.9,lonMax:-101.5, fuels:["solar","wind","storage","hybrid"],  weights:[45,30,15,10] },
  { county:"Reeves",    state:"TX", latMin:31.0,latMax:31.7,lonMin:-103.9,lonMax:-103.0, fuels:["solar","wind","storage","hybrid"],  weights:[40,35,15,10] },
  { county:"Andrews",   state:"TX", latMin:32.0,latMax:32.5,lonMin:-103.0,lonMax:-102.2, fuels:["solar","wind","storage"],           weights:[50,35,15] },
  { county:"Upton",     state:"TX", latMin:31.4,latMax:31.8,lonMin:-102.3,lonMax:-101.6, fuels:["solar","wind","storage"],           weights:[60,25,15] },
  { county:"Nolan",     state:"TX", latMin:32.2,latMax:32.6,lonMin:-100.6,lonMax:-100.1, fuels:["wind","solar","storage"],           weights:[55,30,15] },
  { county:"Jones",     state:"TX", latMin:32.7,latMax:33.0,lonMin:-99.9, lonMax:-99.5,  fuels:["wind","solar"],                    weights:[65,35] },
  { county:"Atascosa",  state:"TX", latMin:28.5,latMax:29.2,lonMin:-99.0, lonMax:-98.2,  fuels:["solar","storage","natural_gas"],   weights:[60,25,15] },
  { county:"Webb",      state:"TX", latMin:27.2,latMax:28.1,lonMin:-99.8, lonMax:-98.9,  fuels:["solar","storage"],                 weights:[70,30] },
  { county:"Hidalgo",   state:"TX", latMin:26.2,latMax:26.8,lonMin:-98.5, lonMax:-97.8,  fuels:["solar","wind","storage"],          weights:[55,30,15] },
  { county:"Cameron",   state:"TX", latMin:25.9,latMax:26.4,lonMin:-97.8, lonMax:-97.0,  fuels:["wind","solar","storage"],          weights:[50,35,15] },
  { county:"Kenedy",    state:"TX", latMin:26.7,latMax:27.3,lonMin:-98.0, lonMax:-97.5,  fuels:["wind","solar"],                    weights:[65,35] },
  { county:"Karnes",    state:"TX", latMin:28.9,latMax:29.4,lonMin:-98.0, lonMax:-97.5,  fuels:["solar","storage"],                 weights:[70,30] },
  { county:"Freestone", state:"TX", latMin:31.5,latMax:31.9,lonMin:-96.4, lonMax:-95.9,  fuels:["solar","wind"],                    weights:[65,35] },
  { county:"Foard",     state:"TX", latMin:33.8,latMax:34.1,lonMin:-99.8, lonMax:-99.4,  fuels:["wind","solar"],                    weights:[65,35] },
];

const PJM_ZONES: Zone[] = [
  { county:"Somerset",   state:"PA", latMin:39.8,latMax:40.1,lonMin:-79.3,lonMax:-78.8, fuels:["wind","solar"],                    weights:[55,45] },
  { county:"Elk",        state:"PA", latMin:41.3,latMax:41.6,lonMin:-78.8,lonMax:-78.3, fuels:["wind","solar"],                    weights:[60,40] },
  { county:"Clinton",    state:"PA", latMin:41.1,latMax:41.5,lonMin:-77.8,lonMax:-77.2, fuels:["wind","solar","storage"],          weights:[50,35,15] },
  { county:"Ocean",      state:"NJ", latMin:39.7,latMax:40.1,lonMin:-74.3,lonMax:-73.9, fuels:["offshore_wind","solar","storage"], weights:[50,30,20] },
  { county:"Monmouth",   state:"NJ", latMin:40.2,latMax:40.5,lonMin:-74.3,lonMax:-73.9, fuels:["offshore_wind","solar","storage"], weights:[55,25,20] },
  { county:"Atlantic",   state:"NJ", latMin:39.4,latMax:39.7,lonMin:-74.8,lonMax:-74.3, fuels:["offshore_wind","solar"],           weights:[60,40] },
  { county:"Logan",      state:"IL", latMin:40.0,latMax:40.3,lonMin:-89.4,lonMax:-89.1, fuels:["wind","solar"],                    weights:[55,45] },
  { county:"Livingston", state:"IL", latMin:40.8,latMax:41.1,lonMin:-88.5,lonMax:-88.1, fuels:["wind","solar"],                    weights:[60,40] },
  { county:"Iroquois",   state:"IL", latMin:40.7,latMax:41.0,lonMin:-88.0,lonMax:-87.6, fuels:["wind","solar","storage"],          weights:[50,35,15] },
  { county:"Pendleton",  state:"WV", latMin:38.6,latMax:39.0,lonMin:-79.6,lonMax:-79.1, fuels:["wind","solar"],                    weights:[70,30] },
  { county:"Charlotte",  state:"VA", latMin:36.9,latMax:37.2,lonMin:-78.8,lonMax:-78.4, fuels:["solar","storage"],                 weights:[70,30] },
  { county:"Louisa",     state:"VA", latMin:37.9,latMax:38.2,lonMin:-78.1,lonMax:-77.7, fuels:["solar","storage"],                 weights:[75,25] },
  { county:"Carroll",    state:"MD", latMin:39.5,latMax:39.8,lonMin:-77.2,lonMax:-76.8, fuels:["solar","storage"],                 weights:[70,30] },
  { county:"Coshocton",  state:"OH", latMin:40.3,latMax:40.6,lonMin:-82.1,lonMax:-81.7, fuels:["wind","solar"],                    weights:[55,45] },
  { county:"Van Wert",   state:"OH", latMin:40.8,latMax:41.1,lonMin:-84.7,lonMax:-84.3, fuels:["wind","solar"],                    weights:[55,45] },
];

function syntheticProjects(
  market: string,
  zones: Zone[],
  nodes: string[],
  count: number,
  prefix: string,
  centroids: CentroidMap,
): Array<typeof queueProjectsTable.$inferInsert> {
  const STATUS_W = [55, 30, 15];
  const STATUS_V = ["active", "withdrawn", "completed"] as const;
  const rows: Array<typeof queueProjectsTable.$inferInsert> = [];

  for (let i = 0; i < count; i++) {
    const zone = pick(zones);
    const fuelType = pickW(zone.fuels, zone.weights);
    const status = pickW([...STATUS_V], STATUS_W);
    const reqYear = 2018 + Math.floor(Math.random() * 7);
    const reqDate = new Date(reqYear, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27));
    const withDate =
      status === "withdrawn"
        ? new Date(reqDate.getTime() + (30 + Math.random() * 700) * 86400000)
        : null;

    // Try centroid first, fallback to zone random
    const coords = geocode(zone.county, zone.state, centroids);
    const lat = coords
      ? coords[0] + (Math.random() - 0.5) * 0.3
      : rnd(zone.latMin, zone.latMax);
    const lon = coords
      ? coords[1] + (Math.random() - 0.5) * 0.3
      : rnd(zone.lonMin, zone.lonMax);

    let cap: number;
    switch (fuelType) {
      case "offshore_wind": cap = rnd(200, 1500, 0); break;
      case "nuclear":       cap = rnd(300, 1200, 0); break;
      case "wind":          cap = rnd(50,  800, 0);  break;
      case "storage":       cap = rnd(50,  400, 0);  break;
      case "hybrid":        cap = rnd(100, 600, 0);  break;
      default:              cap = rnd(20,  500, 0);  break;
    }

    rows.push({
      projectName: `${market}-${zone.county} ${fuelType.replace(/_/g, " ")} ${String(i + 1).padStart(3, "0")}`,
      market,
      queueId: `${prefix}-SYN-${reqYear}-${String(i + 1).padStart(4, "0")}`,
      fuelType,
      capacityMw: String(cap.toFixed(2)),
      status,
      latitude:  String(lat.toFixed(5)),
      longitude: String(lon.toFixed(5)),
      county:    zone.county,
      state:     zone.state,
      interconnectionNode: pick(nodes),
      requestDate: reqDate,
      studyGroupPhase: status === "active" ? pick(["Phase I", "Phase II", "Phase III", "GIA", "Scoping"]) : null,
      withdrawalDate: withDate,
    });
  }
  return rows;
}

// ── Main seed ─────────────────────────────────────────────────────────────────
const ERCOT_NODES = ["LZ_HOUSTON","LZ_WEST","LZ_NORTH","LZ_SOUTH","LZ_AEN","LZ_CPS","LZ_LCRA","HB_NORTH","HB_SOUTH","HB_WEST"];
const PJM_NODES   = ["WESTERN HUB","EASTERN HUB","AEP-DAYTON HUB","NI HUB","PSEG","PPL","DOM","BGE","JCPL","PENELEC","APS"];

async function seed() {
  console.log("=== Real Queue Data Seed ===\n");

  // 1. County centroids
  const centroids = await buildCentroids();

  // 2. CAISO real data
  console.log("\n[CAISO] Fetching real queue data from caiso.com...");
  const caisoProjects = await fetchCAISO(centroids);

  // 3. ERCOT — try EIA API, fall back to synthetic
  console.log("\n[ERCOT] Attempting EIA API for Texas proposed generators...");
  let ercotProjects = await fetchEIAGenerators(["TX"], "ERCOT", centroids);
  if (ercotProjects.length === 0) {
    console.log("[ERCOT] EIA unavailable — using synthetic geographic zone data");
    ercotProjects = syntheticProjects("ERCOT", ERCOT_ZONES, ERCOT_NODES, 480, "ERC", centroids);
  }

  // 4. PJM — try EIA API, fall back to synthetic
  console.log("\n[PJM] Attempting EIA API for PJM-state proposed generators...");
  const pjmStates = ["PA","OH","IL","NJ","MD","VA","WV","DE","IN","MI","KY","NC"];
  let pjmProjects = await fetchEIAGenerators(pjmStates, "PJM", centroids);
  if (pjmProjects.length === 0) {
    console.log("[PJM] EIA unavailable — using synthetic geographic zone data");
    pjmProjects = syntheticProjects("PJM", PJM_ZONES, PJM_NODES, 580, "PJM", centroids);
  }

  // 5. Combine and insert
  const all = [...caisoProjects, ...ercotProjects, ...pjmProjects];
  console.log(`\n=== Summary ===`);
  console.log(`CAISO : ${caisoProjects.length} real projects`);
  console.log(`ERCOT : ${ercotProjects.length} projects${ercotProjects.length > 0 && ercotProjects[0].queueId?.includes("EIA") ? " (EIA real)" : " (synthetic)"}`);
  console.log(`PJM   : ${pjmProjects.length} projects${pjmProjects.length > 0 && pjmProjects[0].queueId?.includes("EIA") ? " (EIA real)" : " (synthetic)"}`);
  console.log(`TOTAL : ${all.length} projects\n`);

  console.log("Clearing existing queue_projects...");
  await db.delete(queueProjectsTable);

  console.log(`Inserting ${all.length} projects in chunks...`);
  for (let i = 0; i < all.length; i += 200) {
    await db.insert(queueProjectsTable).values(all.slice(i, i + 200));
    process.stdout.write(`  ${Math.min(i + 200, all.length)}/${all.length}\r`);
  }
  console.log("\nDone ✓");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
