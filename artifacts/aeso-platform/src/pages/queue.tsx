/**
 * Alberta Project Pipeline — two independent sources, two sub-tabs.
 *
 * 1. Connection Project List (AESO, monthly)
 *    Table aeso_queue_projects ← scripts/seed-aeso-queue-real.ts
 *    Has MW and interconnection status. No capital cost.
 *
 * 2. Inventory of Major Alberta Projects (Government of Alberta, monthly)
 *    Table alberta_major_projects ← scripts/seed-alberta-major-projects.ts
 *    Has capital cost, developer and construction stage. No MW.
 *
 * The two are NOT joined. Project naming differs between them and no shared
 * key exists, so any join would be fuzzy guesswork presented as fact.
 *
 * GENERATION vs LOAD: AESO's list mixes supply and demand. Alberta's
 * data-centre wave enters as "Data Load" at 800–1,900 MW a piece, which
 * swamps generation on a shared cumulative axis and means opposite things for
 * origination — load is demand that needs supplying, not supply competing with
 * you. They are split into separate views for that reason.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { RefreshCw, AlertTriangle, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

// ── Types ───────────────────────────────────────────────────────────────────
type QueueRow = {
  id: number;
  projectName: string | null;
  fuelType: string | null;
  capacityMw: number | null;
  region: string | null;
  county: string | null;
  status: string | null;
  queueDate: string | null;
  expectedOnline: string | null;
  transmissionConnection: string | null;
  lat: number | null;
  lng: number | null;
};

type MajorProject = {
  id: number;
  projectName: string;
  municipality: string | null;
  region: string | null;
  sector: string | null;
  projectType: string | null;
  stage: string | null;
  status: string | null;
  costMillions: number | null;
  developer: string | null;
  startDate: string | null;
  completionDate: string | null;
  isPowerRelated: boolean;
};

// ── Fuel classification ─────────────────────────────────────────────────────
// AESO's "MW Type" column mixes generation technologies with load and
// non-generation project types. Anything matching LOAD_PATTERNS is demand.
const LOAD_PATTERNS = [/load/i, /data\s*cent/i, /demand/i];
const isLoadType = (f: string | null) =>
  LOAD_PATTERNS.some((re) => re.test(f ?? ""));

const FUEL_COLOUR: Record<string, string> = {
  WIND: "#38bdf8",
  SOLAR: "#fbbf24",
  COGEN: "#a78bfa",
  COGENERATION: "#a78bfa",
  "COMBINED CYCLE": "#34d399",
  "SIMPLE CYCLE": "#fb923c",
  "GAS FIRED STEAM": "#f87171",
  GAS: "#fb923c",
  HYDRO: "#22d3ee",
  STORAGE: "#e879f9",
  "ENERGY STORAGE": "#e879f9",
  "DATA LOAD": "#60a5fa",
  LOAD: "#94a3b8",
  OTHER: "#94a3b8",
};
const PALETTE = [
  "#38bdf8", "#fbbf24", "#a78bfa", "#34d399", "#fb923c",
  "#f87171", "#22d3ee", "#e879f9", "#4ade80", "#facc15",
  "#c084fc", "#2dd4bf", "#fca5a5", "#93c5fd", "#94a3b8",
];

const fmtMw = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 0 });

const fmtCost = (m: number | null | undefined) => {
  if (m == null) return "—";
  if (m >= 1000) return `$${(m / 1000).toFixed(2)}B`;
  return `$${m.toFixed(0)}M`;
};

const monthKey = (d: string) => d.slice(0, 7);

function addMonth(key: string): string {
  const y = parseInt(key.slice(0, 4));
  const m = parseInt(key.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const isCancelled = (s: string | null) => /cancel/i.test(s ?? "");

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const chartTooltip = {
  contentStyle: { backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" },
  itemStyle: { color: "hsl(var(--foreground))" },
  labelStyle: { color: "hsl(var(--muted-foreground))" },
};

// ── Shared refresh button ───────────────────────────────────────────────────
function RefreshButton({
  endpoint, onDone, label = "Refresh",
}: { endpoint: string; onDone: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(endpoint, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (r.status === 202) {
        setMsg("Re-downloading from source…");
        // Seeder runs server-side; poll back in once it should be done.
        setTimeout(() => { onDone(); setMsg("Updated"); setBusy(false);
          setTimeout(() => setMsg(null), 4000); }, 25000);
        return;
      }
      setMsg(body.message ?? `Failed (${r.status})`);
    } catch {
      setMsg("Request failed");
    }
    setBusy(false);
    setTimeout(() => setMsg(null), 6000);
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <button
        onClick={go}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-border hover:bg-accent transition-colors disabled:opacity-40"
      >
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        {label}
      </button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Connection Project List (AESO)
// ════════════════════════════════════════════════════════════════════════════
function ConnectionProjectList() {
  const [kind, setKind] = useState<"generation" | "load">("generation");
  const [fuel, setFuel] = useState<string>("ALL");
  const [basis, setBasis] = useState<"isd" | "applied">("isd");
  const [includeCancelled, setIncludeCancelled] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["aeso-queue"],
    queryFn: () => get<QueueRow[]>("/api/aeso/queue"),
  });

  const allRows = data ?? [];

  // Split supply from demand before anything else is computed.
  const rows = useMemo(
    () => allRows.filter((r) => (kind === "load" ? isLoadType(r.fuelType) : !isLoadType(r.fuelType))),
    [allRows, kind],
  );
  const genCount = allRows.filter((r) => !isLoadType(r.fuelType)).length;
  const loadCount = allRows.filter((r) => isLoadType(r.fuelType)).length;
  const loadMw = allRows.filter((r) => isLoadType(r.fuelType))
    .reduce((a, r) => a + (r.capacityMw ?? 0), 0);

  const fuelList = useMemo(() => {
    const m = new Map<string, { fuelType: string; count: number; mw: number }>();
    for (const r of rows) {
      const key = r.fuelType?.trim() || "Unspecified";
      const cur = m.get(key) ?? { fuelType: key, count: 0, mw: 0 };
      cur.count += 1;
      cur.mw += r.capacityMw ?? 0;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.mw - a.mw);
  }, [rows]);

  const colourOf = useMemo(() => {
    const map = new Map<string, string>();
    fuelList.forEach((f, i) => {
      map.set(f.fuelType, FUEL_COLOUR[f.fuelType.toUpperCase()] ?? PALETTE[i % PALETTE.length]);
    });
    return (f: string) => map.get(f) ?? "#94a3b8";
  }, [fuelList]);

  // Reset the fuel filter when switching supply/demand — the fuel lists differ.
  const activeFuel = fuelList.some((f) => f.fuelType === fuel) ? fuel : "ALL";

  const { chartData, chartFuels, plotted, skipped } = useMemo(() => {
    const dateOf = (r: QueueRow) => (basis === "isd" ? r.expectedOnline : r.queueDate);
    const eligible = rows.filter((r) => includeCancelled || !isCancelled(r.status));
    const usable = eligible.filter((r) => dateOf(r) && (r.capacityMw ?? 0) > 0);
    const skipped = eligible.length - usable.length;

    if (usable.length === 0) {
      return { chartData: [] as Record<string, number | string>[], chartFuels: [] as string[], plotted: 0, skipped };
    }

    const byMonth = new Map<string, Map<string, number>>();
    const seen = new Set<string>();
    for (const r of usable) {
      const k = monthKey(dateOf(r)!);
      const f = r.fuelType?.trim() || "Unspecified";
      seen.add(f);
      const bucket = byMonth.get(k) ?? new Map<string, number>();
      bucket.set(f, (bucket.get(f) ?? 0) + (r.capacityMw ?? 0));
      byMonth.set(k, bucket);
    }

    const keys = [...byMonth.keys()].sort();
    const chartFuels = fuelList.map((f) => f.fuelType).filter((f) => seen.has(f));
    const running = new Map<string, number>(chartFuels.map((f) => [f, 0]));
    const out: Record<string, number | string>[] = [];
    let cur = keys[0];
    const last = keys[keys.length - 1];
    for (let i = 0; i < 1200; i++) {
      const bucket = byMonth.get(cur);
      if (bucket) for (const [f, mw] of bucket) running.set(f, (running.get(f) ?? 0) + mw);
      const point: Record<string, number | string> = { month: cur };
      for (const f of chartFuels) point[f] = Math.round(running.get(f) ?? 0);
      out.push(point);
      if (cur === last) break;
      cur = addMonth(cur);
    }
    return { chartData: out, chartFuels, plotted: usable.length, skipped };
  }, [rows, basis, includeCancelled, fuelList]);

  const visibleFuels = activeFuel === "ALL" ? chartFuels : chartFuels.filter((f) => f === activeFuel);

  const scoped = activeFuel === "ALL"
    ? rows
    : rows.filter((r) => (r.fuelType?.trim() || "Unspecified") === activeFuel);
  const scopedMw = scoped.reduce((a, r) => a + (r.capacityMw ?? 0), 0);
  const scopedActive = scoped.filter((r) => !isCancelled(r.status));

  const topRegion = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of scoped) {
      const k = r.region?.trim() || "Unknown";
      m.set(k, (m.get(k) ?? 0) + (r.capacityMw ?? 0));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  }, [scoped]);

  const sortedTable = useMemo(
    () => [...scoped].sort((a, b) => (b.capacityMw ?? 0) - (a.capacityMw ?? 0)),
    [scoped],
  );

  const basisLabel = basis === "isd" ? "in-service date" : "application date";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-muted-foreground text-sm">
          Every project with an accepted system access service request, from AESO's
          monthly Connection Project List. Contract capacity under Rate STS (generation)
          or Rate DTS (load).
        </p>
        <RefreshButton endpoint="/api/aeso/queue/refresh" onDone={() => refetch()} />
      </div>

      {/* ── supply / demand split ───────────────────────────────────────── */}
      <div className="flex rounded-lg border border-border overflow-hidden w-fit">
        <button
          onClick={() => { setKind("generation"); setFuel("ALL"); }}
          className={`px-4 py-2 text-sm transition-colors ${
            kind === "generation" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          Generation
          <span className="ml-2 text-xs opacity-70">{genCount}</span>
        </button>
        <button
          onClick={() => { setKind("load"); setFuel("ALL"); }}
          className={`px-4 py-2 text-sm transition-colors border-l border-border ${
            kind === "load" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          Load
          <span className="ml-2 text-xs opacity-70">{loadCount}</span>
        </button>
      </div>

      {kind === "load" && loadCount > 0 && (
        <Card className="border-sky-500/40 bg-sky-500/5">
          <CardContent className="py-3 px-4 flex gap-3 items-start">
            <AlertTriangle className="h-4 w-4 text-sky-500 mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">This is demand, not supply. </span>
              {fmtMw(loadMw)} MW of load requests — largely Alberta's data-centre wave.
              It does not compete with a generation project for market share; it is the
              load that would need serving. Most sit at "ISD Under Review", meaning AESO
              is reassessing their in-service dates, so treat these as signals of intent
              rather than committed capacity.
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── fuel selector ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFuel("ALL")}
          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
            activeFuel === "ALL"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border hover:bg-accent"}`}
        >
          {kind === "load" ? "All load types" : "All fuels"}
          {rows.length > 0 && <span className="ml-2 text-xs opacity-70">{rows.length}</span>}
        </button>
        {fuelList.map((f) => (
          <button
            key={f.fuelType}
            onClick={() => setFuel(f.fuelType)}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              activeFuel === f.fuelType
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-accent"}`}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-2"
                  style={{ background: colourOf(f.fuelType) }} />
            {f.fuelType}
            <span className="ml-2 text-xs opacity-70">{f.count}</span>
          </button>
        ))}
      </div>

      {/* ── KPIs ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Projects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? "—" : scoped.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {activeFuel === "ALL" ? (kind === "load" ? "all load types" : "all fuel types") : activeFuel}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">
              {kind === "load" ? "Requested Load" : "Queued Capacity"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : fmtMw(scopedMw)}
              <span className="text-sm font-normal text-muted-foreground"> MW</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Rate {kind === "load" ? "DTS" : "STS"} contract capacity
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Not Cancelled</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? "—" : scopedActive.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {scoped.length - scopedActive.length} recently cancelled
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Top Planning Area</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate" title={topRegion?.[0] ?? ""}>
              {isLoading ? "—" : topRegion?.[0] ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{fmtMw(topRegion?.[1])} MW</div>
          </CardContent>
        </Card>
      </div>

      {/* ── cumulative chart ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-medium">
                Cumulative {kind === "load" ? "load" : "capacity"} by {basisLabel}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Running total of contract capacity, one line per {kind === "load" ? "load type" : "fuel type"}.
                {basis === "isd"
                  ? " Against AESO's in-service date — when it is expected to arrive."
                  : " Against AESO's Applied On date — when it entered the queue."}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => setBasis("isd")}
                  className={`px-2.5 py-1 text-xs transition-colors ${
                    basis === "isd" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                >
                  In-service date
                </button>
                <button
                  onClick={() => setBasis("applied")}
                  className={`px-2.5 py-1 text-xs transition-colors border-l border-border ${
                    basis === "applied" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                >
                  Application date
                </button>
              </div>
              <button
                onClick={() => setIncludeCancelled((v) => !v)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  includeCancelled
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-accent"}`}
                title="AESO keeps cancelled projects listed for three months after cancellation"
              >
                {includeCancelled ? "Incl. cancelled" : "Excl. cancelled"}
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="h-96">
          {isLoading ? (
            <Skeleton className="w-full h-full" />
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              No projects with both a {basisLabel} and a capacity figure
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={10} minTickGap={28} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                       tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`}
                       label={{ value: "Cumulative MW", angle: -90, position: "insideLeft",
                                fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                <Tooltip {...chartTooltip}
                         formatter={(v: number, name: string) => [`${fmtMw(v)} MW`, name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {visibleFuels.map((f) => (
                  <Line key={f} type="stepAfter" dataKey={f} name={f}
                        stroke={colourOf(f)} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
        {!isLoading && plotted > 0 && (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {plotted} project{plotted === 1 ? "" : "s"} plotted.
              {skipped > 0 && ` ${skipped} omitted for missing a ${basisLabel} or capacity figure — AESO does not publish both for every project.`}
              {" "}Steps sit at the month of each project's date, so this is a pipeline
              view, not a forecast: AESO in-service dates slip, and projects routinely
              sit past their own ISD while still listed as Active.
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── table ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {activeFuel === "ALL" ? (kind === "load" ? "All load projects" : "All generation projects") : `${activeFuel} projects`}
            <span className="ml-2 text-xs font-normal text-muted-foreground">largest first</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="w-full h-[500px]" />
          ) : sortedTable.length > 0 ? (
            <div className="overflow-x-auto h-[500px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 pr-6 font-medium text-muted-foreground">Project</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">MW Type</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground text-right whitespace-nowrap">Capacity</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">Planning Area</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground">Status</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">Applied</th>
                    <th className="pb-2 font-medium text-muted-foreground whitespace-nowrap">ISD</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTable.map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-3 pr-6 font-medium">{p.projectName ?? "—"}</td>
                      <td className="py-3 pr-6 text-muted-foreground whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-2"
                              style={{ background: colourOf(p.fuelType?.trim() || "Unspecified") }} />
                        {p.fuelType ?? "—"}
                      </td>
                      <td className="py-3 pr-6 font-mono text-right whitespace-nowrap">
                        {p.capacityMw != null ? `${fmtMw(p.capacityMw)} MW` : "—"}
                      </td>
                      <td className="py-3 pr-6 whitespace-nowrap">{p.region ?? "—"}</td>
                      <td className="py-3 pr-6 whitespace-nowrap">
                        <Badge variant="outline"
                               className={isCancelled(p.status) ? "border-red-500/50 text-red-600" : ""}>
                          {p.status ?? "—"}
                        </Badge>
                      </td>
                      <td className="py-3 pr-6 text-muted-foreground whitespace-nowrap">{p.queueDate ?? "—"}</td>
                      <td className="py-3 text-muted-foreground whitespace-nowrap">{p.expectedOnline ?? "TBD"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              No {kind === "load" ? "load" : "generation"} projects found
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Major Alberta Projects (Government of Alberta)
// ════════════════════════════════════════════════════════════════════════════
function MajorAlbertaProjects() {
  const [powerOnly, setPowerOnly] = useState(true);
  const [sector, setSector] = useState<string>("ALL");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["alberta-major-projects", powerOnly],
    queryFn: () => get<MajorProject[]>(`/api/aeso/major-projects?powerOnly=${powerOnly}`),
  });

  const rows = data ?? [];

  const sectorList = useMemo(() => {
    const m = new Map<string, { sector: string; count: number; cost: number }>();
    for (const r of rows) {
      const key = r.sector?.trim() || "Unspecified";
      const cur = m.get(key) ?? { sector: key, count: 0, cost: 0 };
      cur.count += 1;
      cur.cost += r.costMillions ?? 0;
      m.set(key, cur);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const colourOf = useMemo(() => {
    const map = new Map<string, string>();
    sectorList.forEach((s, i) => map.set(s.sector, PALETTE[i % PALETTE.length]));
    return (s: string) => map.get(s) ?? "#94a3b8";
  }, [sectorList]);

  const activeSector = sectorList.some((s) => s.sector === sector) ? sector : "ALL";
  const scoped = activeSector === "ALL"
    ? rows
    : rows.filter((r) => (r.sector?.trim() || "Unspecified") === activeSector);

  const scopedCost = scoped.reduce((a, r) => a + (r.costMillions ?? 0), 0);
  const costedCount = scoped.filter((r) => r.costMillions != null).length;

  // Cumulative capital cost by construction start — same shape as the AESO
  // chart, but dollars instead of megawatts.
  const { chartData, chartSectors, plotted, skipped } = useMemo(() => {
    const usable = scoped.filter((r) => r.startDate && (r.costMillions ?? 0) > 0);
    const skipped = scoped.length - usable.length;
    if (usable.length === 0) {
      return { chartData: [] as Record<string, number | string>[], chartSectors: [] as string[], plotted: 0, skipped };
    }
    const byMonth = new Map<string, Map<string, number>>();
    const seen = new Set<string>();
    for (const r of usable) {
      const k = monthKey(r.startDate!);
      const s = r.sector?.trim() || "Unspecified";
      seen.add(s);
      const bucket = byMonth.get(k) ?? new Map<string, number>();
      bucket.set(s, (bucket.get(s) ?? 0) + (r.costMillions ?? 0));
      byMonth.set(k, bucket);
    }
    const keys = [...byMonth.keys()].sort();
    const chartSectors = sectorList.map((s) => s.sector).filter((s) => seen.has(s));
    const running = new Map<string, number>(chartSectors.map((s) => [s, 0]));
    const out: Record<string, number | string>[] = [];
    let cur = keys[0];
    const last = keys[keys.length - 1];
    for (let i = 0; i < 1200; i++) {
      const bucket = byMonth.get(cur);
      if (bucket) for (const [s, c] of bucket) running.set(s, (running.get(s) ?? 0) + c);
      const point: Record<string, number | string> = { month: cur };
      for (const s of chartSectors) point[s] = Math.round(running.get(s) ?? 0);
      out.push(point);
      if (cur === last) break;
      cur = addMonth(cur);
    }
    return { chartData: out, chartSectors, plotted: usable.length, skipped };
  }, [scoped, sectorList]);

  const visibleSectors = activeSector === "ALL" ? chartSectors : chartSectors.filter((s) => s === activeSector);

  const sortedTable = useMemo(
    () => [...scoped].sort((a, b) => (b.costMillions ?? 0) - (a.costMillions ?? 0)),
    [scoped],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-muted-foreground text-sm max-w-3xl">
          Every Alberta project valued at C$5M or more — recently completed, under
          construction, or expected to start construction within two years. Published
          monthly by the Government of Alberta.{" "}
          <a href="https://majorprojects.alberta.ca/" target="_blank" rel="noopener noreferrer"
             className="text-primary hover:underline inline-flex items-center gap-1">
            Source <ExternalLink size={11} />
          </a>
        </p>
        <RefreshButton endpoint="/api/aeso/major-projects/refresh" onDone={() => refetch()} />
      </div>

      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="py-3 px-4 flex gap-3 items-start">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Not joined to the AESO queue. </span>
            This inventory carries capital cost, developer and construction stage but no MW.
            The AESO Connection Project List carries MW and interconnection status but no cost.
            Project names differ between the two and there is no shared identifier, so the
            platform deliberately does not attempt to match them — a fuzzy name join would
            produce confident-looking nonsense.
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2 items-center">
        <button
          onClick={() => setPowerOnly((v) => !v)}
          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
            powerOnly
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border hover:bg-accent"}`}
        >
          {powerOnly ? "Power & data centres only" : "All sectors"}
        </button>
        <span className="text-xs text-muted-foreground">
          {powerOnly
            ? "generation, storage, transmission and data centres"
            : "every sector, including roads, schools and housing"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSector("ALL")}
          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
            activeSector === "ALL"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border hover:bg-accent"}`}
        >
          All sectors
          {rows.length > 0 && <span className="ml-2 text-xs opacity-70">{rows.length}</span>}
        </button>
        {sectorList.slice(0, 12).map((s) => (
          <button
            key={s.sector}
            onClick={() => setSector(s.sector)}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              activeSector === s.sector
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-accent"}`}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-2"
                  style={{ background: colourOf(s.sector) }} />
            {s.sector}
            <span className="ml-2 text-xs opacity-70">{s.count}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Projects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? "—" : scoped.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {activeSector === "ALL" ? "all listed sectors" : activeSector}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Capital Value</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? "—" : fmtCost(scopedCost)}</div>
            <div className="text-xs text-muted-foreground mt-1">
              from {costedCount} of {scoped.length} with a published cost
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Largest Project</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold truncate" title={sortedTable[0]?.projectName ?? ""}>
              {isLoading ? "—" : sortedTable[0]?.projectName ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {fmtCost(sortedTable[0]?.costMillions)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Cumulative capital value by construction start</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Running total of published project cost, one line per sector.
          </p>
        </CardHeader>
        <CardContent className="h-96">
          {isLoading ? (
            <Skeleton className="w-full h-full" />
          ) : chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              No projects with both a start date and a published cost
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={10} minTickGap={28} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                       tickFormatter={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}B` : `$${v}M`)} />
                <Tooltip {...chartTooltip}
                         formatter={(v: number, name: string) => [fmtCost(v), name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {visibleSectors.map((s) => (
                  <Line key={s} type="stepAfter" dataKey={s} name={s}
                        stroke={colourOf(s)} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
        {!isLoading && plotted > 0 && (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {plotted} project{plotted === 1 ? "" : "s"} plotted.
              {skipped > 0 && ` ${skipped} omitted for missing a start date or cost — the province withholds cost for some projects, so these totals are a floor, not a true total.`}
            </p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {activeSector === "ALL" ? "All projects" : `${activeSector} projects`}
            <span className="ml-2 text-xs font-normal text-muted-foreground">most valuable first</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="w-full h-[500px]" />
          ) : sortedTable.length > 0 ? (
            <div className="overflow-x-auto h-[500px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 pr-6 font-medium text-muted-foreground">Project</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">Sector / Type</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground text-right whitespace-nowrap">Cost</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">Municipality</th>
                    <th className="pb-2 pr-6 font-medium text-muted-foreground whitespace-nowrap">Stage</th>
                    <th className="pb-2 font-medium text-muted-foreground whitespace-nowrap">Developer</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTable.map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-3 pr-6 font-medium">{p.projectName}</td>
                      <td className="py-3 pr-6 text-muted-foreground whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-2"
                              style={{ background: colourOf(p.sector?.trim() || "Unspecified") }} />
                        {[p.sector, p.projectType].filter(Boolean).join(" / ") || "—"}
                      </td>
                      <td className="py-3 pr-6 font-mono text-right whitespace-nowrap">
                        {fmtCost(p.costMillions)}
                      </td>
                      <td className="py-3 pr-6 whitespace-nowrap">{p.municipality ?? "—"}</td>
                      <td className="py-3 pr-6 whitespace-nowrap">
                        <Badge variant="outline">{p.stage ?? "—"}</Badge>
                      </td>
                      <td className="py-3 text-muted-foreground whitespace-nowrap">{p.developer ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-muted-foreground text-center px-6">
              No projects. If this is unexpected, the table may not be seeded yet — run
              <code className="mx-1 px-1 rounded bg-muted">pnpm seed-alberta-major-projects</code>
              or press Refresh.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
export default function Queue() {
  const [tab, setTab] = useState<"connection" | "major">("connection");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Alberta Project Pipeline</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Two independent public sources — AESO's interconnection queue and the province's
          major-projects inventory
        </p>
      </div>

      <div className="flex rounded-lg border border-border overflow-hidden w-fit">
        <button
          onClick={() => setTab("connection")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "connection" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          Connection Project List
        </button>
        <button
          onClick={() => setTab("major")}
          className={`px-4 py-2 text-sm font-medium transition-colors border-l border-border ${
            tab === "major" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        >
          Major Alberta Projects
        </button>
      </div>

      {tab === "connection" ? <ConnectionProjectList /> : <MajorAlbertaProjects />}
    </div>
  );
}
