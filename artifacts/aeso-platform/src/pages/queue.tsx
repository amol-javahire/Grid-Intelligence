/**
 * AESO Interconnection Queue
 *
 * Data source: AESO Connection Project List (published monthly, public).
 *   Seeded by scripts/src/seed-aeso-queue-real.ts → aeso_queue_projects.
 *   Served by GET /api/aeso/queue (all rows, no server-side paging).
 *
 * Fuel buttons mirror the Generation Stack tab. The cumulative chart plots
 * running total MW against time, one line per fuel type.
 *
 * Two things the chart deliberately exposes rather than hides:
 *   - Date basis toggle. "In-service date" (AESO's ISD) shows when capacity is
 *     *expected to arrive*; "Application date" (AESO's Applied On) shows when
 *     it *entered the queue*. These tell very different stories — the gap
 *     between them is queue latency.
 *   - Cancelled projects are EXCLUDED by default. AESO keeps recently
 *     cancelled projects in the list for three months; counting them in a
 *     cumulative capacity curve overstates the pipeline. Toggle to include.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

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

// Named colours for AESO's MW Type vocabulary; unknown types fall through to
// the palette below so a new AESO category still renders distinctly.
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

export default function Queue() {
  const [fuel, setFuel] = useState<string>("ALL");
  const [basis, setBasis] = useState<"isd" | "applied">("isd");
  const [includeCancelled, setIncludeCancelled] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["aeso-queue"],
    queryFn: () => get<QueueRow[]>("/api/aeso/queue"),
  });

  const rows = data ?? [];

  // ── Fuel roster, ordered by total MW so buttons and colours are stable ────
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

  // ── Cumulative capacity series ───────────────────────────────────────────
  const { chartData, chartFuels, plotted, skipped } = useMemo(() => {
    const dateOf = (r: QueueRow) => (basis === "isd" ? r.expectedOnline : r.queueDate);

    const eligible = rows.filter((r) => includeCancelled || !isCancelled(r.status));
    const usable = eligible.filter((r) => dateOf(r) && (r.capacityMw ?? 0) > 0);
    const skipped = eligible.length - usable.length;

    if (usable.length === 0) {
      return { chartData: [] as Record<string, number | string>[], chartFuels: [] as string[], plotted: 0, skipped };
    }

    // Bucket MW additions by month and fuel
    const byMonth = new Map<string, Map<string, number>>();
    const fuelsSeen = new Set<string>();
    for (const r of usable) {
      const k = monthKey(dateOf(r)!);
      const f = r.fuelType?.trim() || "Unspecified";
      fuelsSeen.add(f);
      const bucket = byMonth.get(k) ?? new Map<string, number>();
      bucket.set(f, (bucket.get(f) ?? 0) + (r.capacityMw ?? 0));
      byMonth.set(k, bucket);
    }

    const keys = [...byMonth.keys()].sort();
    const chartFuels = fuelList.map((f) => f.fuelType).filter((f) => fuelsSeen.has(f));

    // Walk every month from first to last, carrying running totals forward so
    // lines stay continuous through months with no new capacity.
    const running = new Map<string, number>(chartFuels.map((f) => [f, 0]));
    const out: Record<string, number | string>[] = [];
    let cur = keys[0];
    const last = keys[keys.length - 1];
    // Guard against a malformed date producing an unbounded loop.
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

  // Lines to draw: everything when ALL, otherwise just the chosen fuel
  const visibleFuels = fuel === "ALL" ? chartFuels : chartFuels.filter((f) => f === fuel);

  // ── Table + KPI scope follows the fuel selection ─────────────────────────
  const scoped = fuel === "ALL" ? rows : rows.filter((r) => (r.fuelType?.trim() || "Unspecified") === fuel);
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Interconnection Queue</h1>
        <p className="text-muted-foreground text-sm mt-1">
          AESO Connection Project List — every project with an accepted system access service request
        </p>
      </div>

      {/* ── fuel selector ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFuel("ALL")}
          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
            fuel === "ALL"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border hover:bg-accent"}`}
        >
          All fuels
          {rows.length > 0 && (
            <span className="ml-2 text-xs opacity-70">{rows.length}</span>
          )}
        </button>
        {fuelList.map((f) => (
          <button
            key={f.fuelType}
            onClick={() => setFuel(f.fuelType)}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              fuel === f.fuelType
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

      {/* ── KPIs for current selection ─────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Projects</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{isLoading ? "—" : scoped.length}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {fuel === "ALL" ? "all fuel types" : fuel}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase">Queued Capacity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : fmtMw(scopedMw)}
              <span className="text-sm font-normal text-muted-foreground"> MW</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">contract capacity (Rate STS/DTS)</div>
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

      {/* ── cumulative capacity chart ──────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-sm font-medium">
                Cumulative queued capacity by {basisLabel}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Running total of contract capacity, one line per fuel type.
                {basis === "isd"
                  ? " Plotted against AESO's in-service date — when capacity is expected to arrive."
                  : " Plotted against AESO's Applied On date — when capacity entered the queue."}
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
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={10}
                       minTickGap={28} />
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
        {(skipped > 0 || plotted > 0) && !isLoading && (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              {plotted} project{plotted === 1 ? "" : "s"} plotted.
              {skipped > 0 && ` ${skipped} omitted for missing a ${basisLabel} or capacity figure — AESO does not publish these for every project.`}
              {" "}Steps are drawn at the month of each project's date, so the curve is a
              pipeline view, not a forecast: AESO in-service dates slip, and projects
              routinely sit past their own ISD while still listed as Active.
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── project table ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            {fuel === "ALL" ? "All projects" : `${fuel} projects`}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              largest first
            </span>
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
              No projects found
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
