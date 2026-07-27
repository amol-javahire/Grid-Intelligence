import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/* ══════════════════════════════════════════════════════════════════════════
   AESO Asset Rankings

   WHY THIS DIFFERS FROM THE ERCOT RANKING ENGINE
   ----------------------------------------------
   ERCOT's three highest-weighted dimensions — nodal curtailment, nodal basis
   risk and nodal congestion — depend on locational marginal prices. Alberta
   settles at a SINGLE province-wide pool price and will not have nodal LMPs
   until REM go-live (~2027). Importing those dimensions and quietly scoring
   them zero would produce a ranking that looks rigorous and means nothing.

   So: six dimensions computed from measured Alberta data, plus two disclosed
   proxies that are labelled as such rather than presented as measurements.
   ══════════════════════════════════════════════════════════════════════════ */

type DataStatus = "measured" | "proxy" | "nodata";

interface Dim {
  key: string;
  label: string;
  weight: number;          // default weight, %
  status: DataStatus;
  hint: string;
}

const DIMENSIONS: Dim[] = [
  { key: "capture",   label: "Capture rate",        weight: 25, status: "measured",
    hint: "Generation-weighted pool price ÷ system average. In a single-price market this is the primary economic signal — it replaces ERCOT's basis/congestion trio." },
  { key: "revenue",   label: "Revenue scale",       weight: 15, status: "measured",
    hint: "Metered MWh × capture price over the window." },
  { key: "carbon",    label: "Carbon exposure",     weight: 15, status: "measured",
    hint: "TIER compliance cost by fuel and heat rate. Alberta-specific — no ERCOT equivalent." },
  { key: "capacity",  label: "Capacity contribution", weight: 12, status: "measured",
    hint: "Log-scaled maximum capability. Alberta is energy-only, so this is adequacy-relevant, not a capacity-market revenue stream." },
  { key: "queue",     label: "Queue & deliverability", weight: 12, status: "nodata",
    hint: "Connection Project List stage, AUC approval, LTA inclusion. Awaiting the Connection Project List ingestion." },
  { key: "maturity",  label: "Development maturity", weight: 6, status: "nodata",
    hint: "Time in queue and energization probability. Awaiting the Connection Project List ingestion." },
  { key: "constraint",label: "Constraint exposure", weight: 10, status: "proxy",
    hint: "UNCALIBRATED. MSA measured 561 GWh of constrained intermittent generation in Q1 2026 (up ~250% YoY), but there is no published project-level allocation. Applied as a technology-level proxy." },
  { key: "rem",       label: "REM transition risk", weight: 5, status: "proxy",
    hint: "FORWARD-LOOKING PROXY, not a measurement. Exposure to 2027 nodal repricing, inferred from region and technology. No LMP scenarios exist yet." },
];

// Objective presets reweight the dimensions — same interaction model as ERCOT,
// different dimension set.
const OBJECTIVES: Record<string, { label: string; blurb: string; w: Record<string, number> }> = {
  balanced: {
    label: "Risk-adjusted value", blurb: "Balanced default",
    w: { capture: 25, revenue: 15, carbon: 15, capacity: 12, queue: 12, maturity: 6, constraint: 10, rem: 5 },
  },
  merchant: {
    label: "Merchant upside", blurb: "Uncontracted / trading",
    w: { capture: 35, revenue: 25, carbon: 8, capacity: 10, queue: 5, maturity: 2, constraint: 12, rem: 3 },
  },
  decarb: {
    label: "Decarbonisation", blurb: "Scope 2 / emissions target",
    w: { capture: 15, revenue: 10, carbon: 35, capacity: 12, queue: 10, maturity: 5, constraint: 10, rem: 3 },
  },
  hedge: {
    label: "Corporate load hedge", blurb: "Matching a load shape",
    w: { capture: 30, revenue: 12, carbon: 10, capacity: 15, queue: 10, maturity: 5, constraint: 15, rem: 3 },
  },
  buildout: {
    label: "Development pipeline", blurb: "Greenfield / queue focus",
    w: { capture: 12, revenue: 8, carbon: 10, capacity: 12, queue: 30, maturity: 18, constraint: 7, rem: 3 },
  },
  remready: {
    label: "REM readiness", blurb: "Positioning for 2027 nodal",
    w: { capture: 20, revenue: 10, carbon: 12, capacity: 12, queue: 12, maturity: 6, constraint: 13, rem: 15 },
  },
};

interface Asset {
  asset_id: string;
  asset_name: string | null;
  fuel_type: string | null;
  owner: string | null;
  max_capability_mw: number | null;
  location: string | null;
  gen_mwh: number | null;
  gen_hours: number | null;
  capture_price: number | null;
}

interface RankResponse {
  months: number;
  referencePoolPrice: number | null;
  assets: Asset[];
  coverage: { assetsTotal: number; assetsWithGeneration: number; poolPriceHours: number };
}

// TIER exposure by fuel — higher score = LESS carbon cost exposure.
const CARBON_SCORE: Record<string, number> = {
  wind: 100, solar: 100, hydro: 98, other: 70,
  storage: 85, cogeneration: 35, gas: 30, coal: 5, dual_fuel: 25,
};

function fuelKey(f: string | null): string {
  const s = (f ?? "").toLowerCase();
  if (s.includes("wind")) return "wind";
  if (s.includes("solar")) return "solar";
  if (s.includes("hydro")) return "hydro";
  if (s.includes("storage") || s.includes("battery")) return "storage";
  if (s.includes("cogen")) return "cogeneration";
  if (s.includes("coal")) return "coal";
  if (s.includes("dual")) return "dual_fuel";
  if (s.includes("gas") || s.includes("simple") || s.includes("combined")) return "gas";
  return "other";
}

// Technology-level constraint proxy — explicitly not measured per-asset.
const CONSTRAINT_PROXY: Record<string, number> = {
  wind: 45, solar: 55, hydro: 85, storage: 80,
  gas: 90, cogeneration: 92, coal: 88, dual_fuel: 88, other: 75,
};

// REM transition proxy — intermittent assets face the most nodal repricing risk.
const REM_PROXY: Record<string, number> = {
  wind: 40, solar: 45, storage: 75, hydro: 70,
  gas: 65, cogeneration: 60, coal: 55, dual_fuel: 60, other: 60,
};

function scoreAsset(a: Asset, refPool: number | null) {
  const fk = fuelKey(a.fuel_type);
  const mw = a.max_capability_mw ?? 0;
  const hasGen = (a.gen_mwh ?? 0) > 0 && a.capture_price != null && refPool != null && refPool !== 0;

  // Capture rate → score. 1.0× = 60; each ±10% moves ±20 points, clamped.
  const captureRate = hasGen ? (a.capture_price as number) / (refPool as number) : null;
  const capture = captureRate == null ? null
    : Math.max(0, Math.min(100, 60 + (captureRate - 1) * 200));

  // Revenue scale — log-scaled so a 900 MW plant doesn't swamp a 20 MW one.
  const revenue = hasGen
    ? Math.max(0, Math.min(100, (Math.log10(((a.gen_mwh as number) * (a.capture_price as number)) + 1) / 8) * 100))
    : null;

  const carbon = CARBON_SCORE[fk] ?? 60;
  const capacity = mw > 0 ? Math.max(0, Math.min(100, (Math.log10(mw + 1) / 3) * 100)) : null;
  const constraint = CONSTRAINT_PROXY[fk] ?? 75;
  const rem = REM_PROXY[fk] ?? 60;

  return {
    capture, revenue, carbon, capacity,
    queue: null as number | null,      // awaiting Connection Project List
    maturity: null as number | null,   // awaiting Connection Project List
    constraint, rem, captureRate,
  };
}

function StatusChip({ s }: { s: DataStatus }) {
  const map = {
    measured: ["MEASURED", "bg-emerald-500/15 text-emerald-600"],
    proxy:    ["PROXY",    "bg-amber-500/15 text-amber-600"],
    nodata:   ["NO DATA",  "bg-muted text-muted-foreground"],
  } as const;
  const [label, cls] = map[s];
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${cls}`}>{label}</span>;
}

function Bar({ v }: { v: number | null }) {
  if (v == null) return <div className="h-1.5 w-full rounded bg-muted" title="no data" />;
  const color = v >= 75 ? "bg-emerald-500" : v >= 60 ? "bg-teal-500"
              : v >= 45 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${v}%` }} />
    </div>
  );
}

export default function AesoRankings() {
  const [objective, setObjective] = useState<keyof typeof OBJECTIVES>("balanced");
  const [fuelFilter, setFuelFilter] = useState<string>("all");

  const { data, isLoading, error } = useQuery<RankResponse>({
    queryKey: ["aeso-rankings"],
    queryFn: () => fetch("/api/aeso/rankings?months=12").then(r => {
      if (!r.ok) throw new Error(`rankings request failed (${r.status})`);
      return r.json();
    }),
  });

  const weights = OBJECTIVES[objective].w;

  const ranked = useMemo(() => {
    if (!data?.assets) return [];
    const refPool = data.referencePoolPrice;
    const rows = data.assets.map(a => {
      const s = scoreAsset(a, refPool);
      // Weighted mean over dimensions that HAVE data — a missing dimension is
      // excluded from both numerator and denominator rather than scored zero,
      // so absent data cannot silently drag an asset down the ranking.
      let num = 0, den = 0;
      for (const d of DIMENSIONS) {
        const v = (s as Record<string, number | null>)[d.key];
        if (v == null) continue;
        num += v * (weights[d.key] ?? 0);
        den += weights[d.key] ?? 0;
      }
      return { asset: a, s, overall: den > 0 ? num / den : null, covered: den };
    });
    return rows
      .filter(r => fuelFilter === "all" || fuelKey(r.asset.fuel_type) === fuelFilter)
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  }, [data, weights, fuelFilter]);

  const fuels = useMemo(() => {
    const set = new Set((data?.assets ?? []).map(a => fuelKey(a.fuel_type)));
    return ["all", ...Array.from(set).sort()];
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Asset Rankings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Alberta generation assets scored on eight dimensions. Alberta settles at a single
          province-wide pool price — nodal basis and locational congestion do not exist here
          until REM go-live, so those ERCOT dimensions are deliberately absent.
        </p>
      </div>

      {/* Objectives */}
      <div className="flex gap-2 flex-wrap">
        {(Object.keys(OBJECTIVES) as (keyof typeof OBJECTIVES)[]).map(k => (
          <button key={k} onClick={() => setObjective(k)}
            className={`px-3 py-2 rounded-lg text-sm font-medium border text-left transition-colors ${
              objective === k ? "bg-primary text-primary-foreground border-primary"
                              : "border-border text-muted-foreground hover:text-foreground"}`}>
            <div>{OBJECTIVES[k].label}</div>
            <div className="text-[10px] opacity-70">{OBJECTIVES[k].blurb}</div>
          </button>
        ))}
      </div>

      {/* Methodology / provenance */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Dimensions &amp; weights — {OBJECTIVES[objective].label}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-x-8 gap-y-3">
            {DIMENSIONS.map(d => (
              <div key={d.key} className="flex gap-3">
                <div className="w-10 shrink-0 text-right font-bold text-sm">{weights[d.key]}%</div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{d.label}</span>
                    <StatusChip s={d.status} />
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{d.hint}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-4 pt-3 border-t border-border">
            Composite is a weighted mean over dimensions that have data. A dimension with no data is
            excluded from the average rather than scored zero, so missing inputs cannot silently
            penalise an asset.
          </p>
        </CardContent>
      </Card>

      {/* Coverage */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            ["Assets ranked", `${data.coverage.assetsTotal}`, "from AESO asset registry"],
            ["With generation data", `${data.coverage.assetsWithGeneration}`, "metered volume available"],
            ["Reference pool price", data.referencePoolPrice != null ? `C$${data.referencePoolPrice.toFixed(2)}` : "—", `${data.months}-month average`],
            ["Pool price hours", `${Math.round(data.coverage.poolPriceHours).toLocaleString()}`, "settlement hours in window"],
          ].map(([l, v, s]) => (
            <Card key={l}><CardContent className="pt-5 pb-4">
              <div className="text-xs text-muted-foreground">{l}</div>
              <div className="text-2xl font-bold mt-1">{v}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{s}</div>
            </CardContent></Card>
          ))}
        </div>
      )}

      {/* Fuel filter */}
      {fuels.length > 1 && (
        <div className="flex gap-1.5 flex-wrap">
          {fuels.map(f => (
            <button key={f} onClick={() => setFuelFilter(f)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                fuelFilter === f ? "bg-primary text-primary-foreground"
                                 : "bg-muted text-muted-foreground hover:text-foreground"}`}>
              {f === "all" ? "All fuels" : f}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Ranked assets</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm font-medium text-destructive">Could not load rankings</p>
              <p className="text-xs text-muted-foreground mt-1">
                The request failed — this is an error, not an empty result set.
              </p>
            </div>
          ) : ranked.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm font-medium">No assets available yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-lg mx-auto">
                The AESO asset registry is empty. Run the AESO seeder to populate
                <code className="mx-1 px-1 rounded bg-muted">aeso_asset_registry</code> and
                <code className="mx-1 px-1 rounded bg-muted">aeso_metered_volume</code>,
                then rankings will compute automatically.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase text-muted-foreground border-b border-border">
                    <th className="text-left py-2 pr-2 font-medium">#</th>
                    <th className="text-left py-2 pr-3 font-medium">Asset</th>
                    <th className="text-left py-2 pr-3 font-medium">Fuel</th>
                    <th className="text-right py-2 pr-3 font-medium">MW</th>
                    <th className="text-right py-2 pr-3 font-medium">Capture</th>
                    <th className="text-left py-2 pr-3 font-medium w-40">Dimensions</th>
                    <th className="text-right py-2 font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.slice(0, 200).map((r, i) => (
                    <tr key={r.asset.asset_id} className="border-b border-border/50 hover:bg-muted/40">
                      <td className="py-2 pr-2 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.asset.asset_name ?? r.asset.asset_id}</div>
                        <div className="text-[10px] text-muted-foreground">{r.asset.owner ?? "—"}</div>
                      </td>
                      <td className="py-2 pr-3 text-xs">{r.asset.fuel_type ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.asset.max_capability_mw?.toFixed(0) ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {r.s.captureRate != null
                          ? <span className={r.s.captureRate >= 1 ? "text-emerald-600" : "text-amber-600"}>
                              {r.s.captureRate.toFixed(2)}×
                            </span>
                          : <span className="text-muted-foreground text-xs">no gen data</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="grid grid-cols-8 gap-0.5">
                          {DIMENSIONS.map(d => (
                            <Bar key={d.key} v={(r.s as Record<string, number | null>)[d.key]} />
                          ))}
                        </div>
                      </td>
                      <td className="py-2 text-right font-bold tabular-nums">
                        {r.overall != null ? r.overall.toFixed(1) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ranked.length > 200 && (
                <p className="text-[11px] text-muted-foreground mt-3">
                  Showing top 200 of {ranked.length} assets.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        <strong>Methodology.</strong> Capture rate is generation-weighted metered output against the
        Alberta pool price, divided by the system average over the same window — both from AESO API
        data. Carbon exposure reflects TIER compliance cost by fuel. Constraint exposure and REM
        transition risk are disclosed proxies applied at technology level, not per-asset
        measurements. Queue and maturity dimensions await the AESO Connection Project List
        ingestion. This is a screening tool for origination triage, not an investment recommendation.
      </p>
    </div>
  );
}
