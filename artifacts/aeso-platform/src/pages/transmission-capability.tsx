/**
 * Transmission Capability — AESO's published connection headroom.
 *
 * Source: Transmission-Capability-Results-Sept-2025.xlsx (AESO 2025 Assessment,
 * 26 Sep 2025). 237 buses across 201 substations, 328 transmission lines.
 *
 * Capability MW = additional generation connectable at that bus before N-0
 * (category A) thermal congestion, at the 0.5 percentile of the historical
 * duration curve.
 *
 * Two caveats are rendered prominently rather than buried, because misreading
 * either would mislead a siting decision:
 *   SCOPE  — South + Central East planning regions ONLY. No Edmonton, Wabamun,
 *            Fort McMurray, Grande Prairie or Peace River data exists. A
 *            missing substation means UNSTUDIED, not zero headroom.
 *   STATUS — AESO states these are indicative, not guaranteed in the
 *            Connection Process.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, AlertTriangle, Map as MapIcon, Table2, Zap } from "lucide-react";

const AESO_LINKS = [
  { label: "Transmission Capability Map (interactive)", href: "https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/" },
  { label: "Capability Map — ArcGIS viewer", href: "https://experience.arcgis.com/experience/f9bbea2a88ce4de493f0d077cf927003/page/Page?views=Feature-Info" },
  { label: "Planning area boundary data (GIS)", href: "https://www.aeso.ca/market/market-and-system-reporting/data-requests/planning-area-boundary-data/" },
  { label: "AESO Planning Regions map (PDF)", href: "https://www.aeso.ca/assets/Uploads/Planning-Regions.pdf" },
  { label: "Connection Project Reporting", href: "https://www.aeso.ca/grid/connecting-to-the-grid/" },
];

const ARCGIS_EMBED =
  "https://experience.arcgis.com/experience/f9bbea2a88ce4de493f0d077cf927003/page/Page?views=Feature-Info";

type Area = {
  planning_area_code: number; planning_area_name: string;
  buses: number; zero_buses: number; headroom_mw: number;
  best_bus_mw: number; facilities: number;
};
type Sub = {
  facility_name: string; facility_code: string; tfo: string;
  planning_area_code: number; planning_area_name: string;
  bus_number: number; voltage_kv: number; capability_mw: number;
};
type Line = {
  line_name: string; voltage_kv: number; binding_capability_mw: number;
  max_endpoint_mw: number; endpoints: string; planning_area_name: string; tfo: string;
};

function mwColour(mw: number): string {
  if (mw === 0) return "text-red-400";
  if (mw < 50) return "text-orange-400";
  if (mw < 200) return "text-yellow-400";
  return "text-emerald-400";
}

export default function TransmissionCapability() {
  const [tab, setTab] = useState<"areas" | "substations" | "lines" | "map">("areas");
  const [area, setArea] = useState<number | null>(null);
  const [voltage, setVoltage] = useState<number | null>(null);

  const qs = new URLSearchParams();
  if (area !== null) qs.set("area", String(area));
  if (voltage !== null) qs.set("voltage", String(voltage));
  const suffix = qs.toString() ? `?${qs}` : "";

  const areas = useQuery<{ areas: Area[]; asOf: string; source: string; studyArea: string }>({
    queryKey: ["tc-areas"],
    queryFn: () => fetch("/api/aeso/transmission-capability/areas").then((r) => r.json()),
  });
  const subs = useQuery<{ substations: Sub[]; count: number }>({
    queryKey: ["tc-subs", area, voltage],
    queryFn: () => fetch(`/api/aeso/transmission-capability/substations${suffix}`).then((r) => r.json()),
    enabled: tab === "substations",
  });
  const lines = useQuery<{ lines: Line[]; count: number }>({
    queryKey: ["tc-lines", area, voltage],
    queryFn: () => fetch(`/api/aeso/transmission-capability/lines${suffix}`).then((r) => r.json()),
    enabled: tab === "lines",
  });

  const totalMw = areas.data?.areas.reduce((s, a) => s + a.headroom_mw, 0) ?? 0;
  const totalBuses = areas.data?.areas.reduce((s, a) => s + a.buses, 0) ?? 0;
  const totalZero = areas.data?.areas.reduce((s, a) => s + a.zero_buses, 0) ?? 0;

  return (
    <div className="p-6 space-y-5 overflow-y-auto h-full">
      <div>
        <h1 className="text-2xl font-semibold">Transmission Capability</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How much new generation AESO says can connect at each bus before thermal congestion.
          Assessment dated {areas.data?.asOf ?? "2025-09-26"}.
        </p>
      </div>

      {/* Scope warning — deliberately above the data, not a footnote. */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 flex gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm space-y-1">
          <p className="font-medium text-amber-300">Study covers South &amp; Central East only</p>
          <p className="text-muted-foreground">
            AESO assessed 17 planning areas plus one Calgary bus, selected because they hold most
            active connection-project interest. There is <strong>no data</strong> for Edmonton,
            Wabamun, Fort McMurray, Grande Prairie or Peace River — a substation missing here is
            <em> unstudied</em>, not zero-headroom.
          </p>
          <p className="text-muted-foreground">
            Values are AESO&apos;s own, limited to category A (N-0) thermal congestion, and stated by
            AESO to be <strong>indicative and not guaranteed</strong> in the Connection Process.
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Total headroom", `${totalMw.toLocaleString()} MW`, "across studied areas"],
          ["Buses studied", String(totalBuses), `${areas.data?.areas.length ?? 0} planning areas`],
          ["Fully congested", `${totalZero}`, `${totalBuses ? Math.round((100 * totalZero) / totalBuses) : 0}% of buses at 0 MW`],
          ["Transmission lines", String(lines.data?.count ?? 328), "with published capability"],
        ].map(([label, value, sub]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold mt-1">{value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {([
          ["areas", "By planning area", Zap],
          ["substations", "Substations", Table2],
          ["lines", "Lines", Table2],
          ["map", "AESO map", MapIcon],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 -mb-px transition ${
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Filters (not shown on the areas overview or the embedded map) */}
      {(tab === "substations" || tab === "lines") && (
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <select
            value={area ?? ""}
            onChange={(e) => setArea(e.target.value ? Number(e.target.value) : null)}
            className="bg-card border border-border rounded px-3 py-1.5"
          >
            <option value="">All planning areas</option>
            {areas.data?.areas.map((a) => (
              <option key={a.planning_area_code} value={a.planning_area_code}>
                {String(a.planning_area_code).padStart(2, "0")}-{a.planning_area_name}
              </option>
            ))}
          </select>
          <select
            value={voltage ?? ""}
            onChange={(e) => setVoltage(e.target.value ? Number(e.target.value) : null)}
            className="bg-card border border-border rounded px-3 py-1.5"
          >
            <option value="">All voltages</option>
            {[69, 72, 138, 144, 240].map((v) => (
              <option key={v} value={v}>{v} kV</option>
            ))}
          </select>
          {(area !== null || voltage !== null) && (
            <button onClick={() => { setArea(null); setVoltage(null); }}
              className="text-muted-foreground hover:text-foreground underline">clear</button>
          )}
        </div>
      )}

      {tab === "areas" && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5">Planning area</th>
                <th className="text-right px-4 py-2.5 pr-6">Headroom MW</th>
                <th className="text-right px-4 py-2.5 pr-6">Best single bus</th>
                <th className="text-right px-4 py-2.5 pr-6">Buses</th>
                <th className="text-right px-4 py-2.5 pr-6">At 0 MW</th>
                <th className="text-right px-4 py-2.5">Substations</th>
              </tr>
            </thead>
            <tbody>
              {areas.data?.areas.map((a) => (
                <tr key={a.planning_area_code} className="border-t border-border hover:bg-muted/20">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="text-muted-foreground">
                      {String(a.planning_area_code).padStart(2, "0")}
                    </span>{" "}
                    {a.planning_area_name}
                  </td>
                  <td className={`text-right px-4 py-2.5 pr-6 font-medium ${mwColour(a.headroom_mw)}`}>
                    {a.headroom_mw.toLocaleString()}
                  </td>
                  <td className="text-right px-4 py-2.5 pr-6">{a.best_bus_mw.toLocaleString()}</td>
                  <td className="text-right px-4 py-2.5 pr-6">{a.buses}</td>
                  <td className={`text-right px-4 py-2.5 pr-6 ${a.zero_buses === a.buses ? "text-red-400 font-medium" : ""}`}>
                    {a.zero_buses}
                  </td>
                  <td className="text-right px-4 py-2.5">{a.facilities}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground px-4 py-3 border-t border-border">
            Area totals can mislead — Brooks shows 1,873 MW but 6 of 11 buses are at zero, so
            headroom is concentrated at specific buses. Check the substation tab before siting.
          </p>
        </div>
      )}

      {tab === "substations" && (
        <div className="rounded-lg border border-border overflow-hidden">
          {subs.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Substation</th>
                    <th className="text-left px-4 py-2.5">Code</th>
                    <th className="text-left px-4 py-2.5">Planning area</th>
                    <th className="text-right px-4 py-2.5 pr-6">Bus</th>
                    <th className="text-right px-4 py-2.5 pr-6">kV</th>
                    <th className="text-right px-4 py-2.5 pr-6">Capability MW</th>
                    <th className="text-left px-4 py-2.5">TFO</th>
                  </tr>
                </thead>
                <tbody>
                  {subs.data?.substations.map((s) => (
                    <tr key={`${s.facility_code}-${s.bus_number}`} className="border-t border-border hover:bg-muted/20">
                      <td className="px-4 py-2 whitespace-nowrap">{s.facility_name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{s.facility_code}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                        {String(s.planning_area_code).padStart(2, "0")}-{s.planning_area_name}
                      </td>
                      <td className="text-right px-4 py-2 pr-6 text-muted-foreground">{s.bus_number}</td>
                      <td className="text-right px-4 py-2 pr-6">{s.voltage_kv}</td>
                      <td className={`text-right px-4 py-2 pr-6 font-medium ${mwColour(s.capability_mw)}`}>
                        {s.capability_mw.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{s.tfo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground px-4 py-3 border-t border-border">
                {subs.data?.count ?? 0} buses. Capability is calculated independently at each
                location and does not account for other simultaneous connections.
              </p>
            </>
          )}
        </div>
      )}

      {tab === "lines" && (
        <div className="rounded-lg border border-border overflow-hidden">
          {lines.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Line</th>
                    <th className="text-left px-4 py-2.5">Between</th>
                    <th className="text-right px-4 py-2.5 pr-6">kV</th>
                    <th className="text-right px-4 py-2.5 pr-6">Binding MW</th>
                    <th className="text-right px-4 py-2.5 pr-6">Best end MW</th>
                    <th className="text-left px-4 py-2.5">Planning area</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.data?.lines.map((l) => (
                    <tr key={l.line_name} className="border-t border-border hover:bg-muted/20">
                      <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{l.line_name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{l.endpoints}</td>
                      <td className="text-right px-4 py-2 pr-6">{l.voltage_kv}</td>
                      <td className={`text-right px-4 py-2 pr-6 font-medium ${mwColour(l.binding_capability_mw)}`}>
                        {l.binding_capability_mw.toLocaleString()}
                      </td>
                      <td className="text-right px-4 py-2 pr-6 text-muted-foreground">
                        {l.max_endpoint_mw.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{l.planning_area_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground px-4 py-3 border-t border-border">
                {lines.data?.count ?? 0} lines, sorted most-constrained first. AESO reports each line
                once per terminal; &ldquo;Binding MW&rdquo; is the lower of the two ends — the
                constraint that actually applies.
              </p>
            </>
          )}
        </div>
      )}

      {tab === "map" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border overflow-hidden bg-card">
            <iframe
              src={ARCGIS_EMBED}
              title="AESO Transmission Capability Map"
              className="w-full"
              style={{ height: "70vh", border: 0 }}
              loading="lazy"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            AESO&apos;s own ArcGIS viewer, embedded live — always current, no sync needed. A native
            map with our own substation, line, generator and queue-project layers needs facility
            coordinates, which AESO publishes as GIS boundary data rather than in the capability
            workbook.
          </p>
        </div>
      )}

      {/* Source links */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-medium mb-2">AESO sources</div>
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-1.5">
          {AESO_LINKS.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
               className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              {l.label}
            </a>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Data: {areas.data?.source ?? "AESO Transmission Capability Results, Sept 2025 Assessment"}.
          AESO refreshes this assessment periodically — re-run the seeder when a new workbook is published.
        </p>
      </div>
    </div>
  );
}
