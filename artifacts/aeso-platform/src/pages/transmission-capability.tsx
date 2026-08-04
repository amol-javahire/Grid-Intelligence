/**
 * Transmission Capability — AESO's published connection headroom.
 *
 * Source: Transmission-Capability-Results-Sept-2025.xlsx (AESO 2025 Assessment,
 * 26 Sep 2025). 239 bus records across 202 substations and 328 transmission lines.
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
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleMarker, GeoJSON, MapContainer, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { ExternalLink, AlertTriangle, Map as MapIcon, Table2, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";

const AESO_LINKS = [
  { label: "Transmission Capability Map (interactive)", href: "https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/" },
  { label: "Capability Map — ArcGIS viewer", href: "https://experience.arcgis.com/experience/f9bbea2a88ce4de493f0d077cf927003/page/Page?views=Feature-Info" },
  { label: "Planning area boundary data (GIS)", href: "https://www.aeso.ca/market/market-and-system-reporting/data-requests/planning-area-boundary-data/" },
  { label: "AESO Planning Regions map (PDF)", href: "https://www.aeso.ca/assets/Uploads/Planning-Regions.pdf" },
  { label: "Connection Project Reporting", href: "https://www.aeso.ca/grid/connecting-to-the-grid/" },
];

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

type MapFeature<P> = { type: "Feature"; geometry: { type: string; coordinates: unknown } | null; properties: P };
type FeatureCollection<P> = { type: "FeatureCollection"; features: MapFeature<P>[] };
type RegionMapProps = { areaCode: number | null; areaName: string | null; region: string | null };
type LineMapProps = {
  lineName: string; voltageKv: number | null; fromSubstation: string | null;
  toSubstation: string | null; precision: string | null;
  capability: { minCapabilityMw: number; maxCapabilityMw: number } | null;
};
type SubstationMapProps = {
  name: string | null; facilityCode: string; displayName: string | null;
  voltage: string | null; landLocation: string | null; planningArea: string | null;
  region: string | null;
  capabilities: Array<{ busNumber: number; voltageKv: number; capabilityMw: number }>;
};
type GeneratorMapProps = {
  assetId: string | null; assetName: string | null; assetType: string | null;
  maximumCapabilityMw: number | null; planningArea: string | null; region: string | null;
};
type ProjectMapProps = {
  projectNumber: number | null; projectName: string | null; status: string | null;
  planningArea: string | null; fuelType: string | null; stage: number | null;
  supplyMw: number | null; demandMw: number | null;
};
type MapData = {
  retrievedAt: string; capabilityAsOf: string | null; capabilityDataAvailable: boolean;
  counts: Record<string, number>;
  sources: { geometry: string; capability: string; note: string };
  layers: {
    planningAreas: FeatureCollection<RegionMapProps>;
    lines: FeatureCollection<LineMapProps>;
    substations: FeatureCollection<SubstationMapProps>;
    generators: FeatureCollection<GeneratorMapProps>;
    projects: FeatureCollection<ProjectMapProps>;
  };
};

const REGION_COLOURS: Record<string, string> = {
  Northwest: "#22d3ee", Northeast: "#a78bfa", Edmonton: "#60a5fa",
  Central: "#34d399", Calgary: "#fbbf24", South: "#fb7185",
};
const GENERATOR_COLOURS: Record<string, string> = {
  Wind: "#38bdf8", Solar: "#fbbf24", Hydro: "#22d3ee",
  "Energy Storage": "#e879f9", "Combined Cycle": "#34d399",
  "Simple Cycle": "#fb923c", Cogeneration: "#a78bfa",
  "Gas Fired Steam": "#f87171", "Biomass and Other": "#84cc16",
};

function mapPoint(feature: MapFeature<unknown>): [number, number] | null {
  if (!feature.geometry || feature.geometry.type !== "Point") return null;
  const [lng, lat] = feature.geometry.coordinates as [number, number];
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

function fmtMw(value: number | null | undefined): string {
  return value == null ? "?" : `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} MW`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "?")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function lineStyle(voltage: number | null | undefined) {
  if ((voltage ?? 0) >= 500) return { color: "#f97316", weight: 3.2 };
  if ((voltage ?? 0) >= 240) return { color: "#a78bfa", weight: 2.4 };
  if ((voltage ?? 0) >= 138) return { color: "#38bdf8", weight: 1.8 };
  if ((voltage ?? 0) >= 69) return { color: "#4ade80", weight: 1.2 };
  return { color: "#64748b", weight: 0.8 };
}

function LayerToggle({ checked, onChange, colour, label, count }: {
  checked: boolean; onChange: (checked: boolean) => void;
  colour: string; label: string; count: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
        <span className="truncate">{label}</span>
        <span className="text-muted-foreground">{count.toLocaleString()}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function MapPopupRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function NativeMap() {
  const [showRegions, setShowRegions] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [showSubstations, setShowSubstations] = useState(true);
  const [showGenerators, setShowGenerators] = useState(true);
  const [showProjects, setShowProjects] = useState(false);
  const [minimumVoltage, setMinimumVoltage] = useState(138);

  const map = useQuery<MapData>({
    queryKey: ["aeso-native-map"],
    queryFn: async () => {
      const response = await fetch("/api/aeso/map");
      if (!response.ok) throw new Error(`map source returned ${response.status}`);
      return response.json();
    },
    staleTime: 10 * 60 * 1000,
  });

  const filteredLines = useMemo<FeatureCollection<LineMapProps> | null>(() => {
    if (!map.data) return null;
    return {
      type: "FeatureCollection",
      features: map.data.layers.lines.features.filter(
        (feature) => (feature.properties.voltageKv ?? 0) >= minimumVoltage,
      ),
    };
  }, [map.data, minimumVoltage]);

  const regionStyle = useMemo(() => (feature?: any) => {
    const colour = REGION_COLOURS[feature?.properties?.region] ?? "#64748b";
    return { color: colour, fillColor: colour, fillOpacity: 0.1, weight: 1.4, opacity: 0.7 };
  }, []);

  const txStyle = useMemo(() => (feature?: any) => ({
    ...lineStyle(feature?.properties?.voltageKv), opacity: 0.82,
  }), []);

  const bindRegion = useMemo(() => (feature: any, layer: L.Layer) => {
    layer.bindTooltip(
      `<strong>${escapeHtml(feature.properties.areaCode)} ? ${escapeHtml(feature.properties.areaName)}</strong><br/>${escapeHtml(feature.properties.region)} region`,
      { sticky: true },
    );
  }, []);

  const bindLine = useMemo(() => (feature: any, layer: L.Layer) => {
    const p = feature.properties as LineMapProps;
    const capability = p.capability
      ? p.capability.minCapabilityMw === p.capability.maxCapabilityMw
        ? fmtMw(p.capability.minCapabilityMw)
        : `${fmtMw(p.capability.minCapabilityMw)}?${fmtMw(p.capability.maxCapabilityMw)}`
      : "Not assessed in September 2025";
    layer.bindPopup(
      `<strong>${escapeHtml(p.lineName)}</strong><br/>${escapeHtml(p.voltageKv)} kV ? ${escapeHtml(p.fromSubstation)} ? ${escapeHtml(p.toSubstation)}<hr style="margin:8px 0;border-color:#475569"/><small>Additional connection capability</small><br/><strong>${escapeHtml(capability)}</strong><br/><small>GIS precision: ${escapeHtml(p.precision)}</small>`,
    );
  }, []);

  if (map.isLoading) {
    return <div className="h-[70vh] rounded-lg border border-border bg-card flex items-center justify-center text-sm text-muted-foreground">Loading 2,500+ AESO map features?</div>;
  }
  if (map.error || !map.data) {
    return (
      <div className="h-64 rounded-lg border border-red-500/30 bg-red-500/5 flex items-center justify-center p-6 text-sm text-red-300">
        AESO ArcGIS services are unavailable. No substitute geometry was displayed.
      </div>
    );
  }

  const data = map.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(REGION_COLOURS).map(([region, colour]) => (
          <div key={region} className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colour }} />
            {region}
          </div>
        ))}
      </div>

      <div className="relative h-[70vh] min-h-[620px] overflow-hidden rounded-lg border border-border bg-card">
        <MapContainer center={[54.1, -114.2]} zoom={5} minZoom={4} maxZoom={14} preferCanvas
          style={{ height: "100%", width: "100%", zIndex: 0 }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; CARTO'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {showRegions && (
            <GeoJSON key="regions" data={data.layers.planningAreas as any}
              style={regionStyle} onEachFeature={bindRegion} />
          )}
          {showLines && filteredLines && (
            <GeoJSON key={`lines-${minimumVoltage}`} data={filteredLines as any}
              style={txStyle} onEachFeature={bindLine} />
          )}

          {showSubstations && data.layers.substations.features.map((feature, index) => {
            const center = mapPoint(feature);
            if (!center) return null;
            const p = feature.properties;
            const maxCapability = p.capabilities.length
              ? Math.max(...p.capabilities.map((item) => item.capabilityMw)) : null;
            return (
              <CircleMarker key={`sub-${p.facilityCode}-${index}`} center={center}
                radius={maxCapability == null ? 3 : Math.min(10, 3 + Math.sqrt(maxCapability) / 3)}
                pathOptions={{ color: "#f8fafc", fillColor: "#0f172a", fillOpacity: 0.9, weight: 1 }}>
                <Popup>
                  <div className="min-w-[220px] space-y-2 text-sm">
                    <div><div className="font-semibold">{p.displayName ?? p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.planningArea} ? {p.region}</div></div>
                    <MapPopupRow label="Voltage" value={`${p.voltage ?? "?"} kV`} />
                    <MapPopupRow label="Land location" value={p.landLocation ?? "?"} />
                    <div className="border-t pt-2 text-xs">
                      <div className="mb-1 text-muted-foreground">Additional connection capability</div>
                      {p.capabilities.length ? p.capabilities.map((item) => (
                        <div key={`${item.busNumber}-${item.voltageKv}`} className="flex justify-between gap-4">
                          <span>Bus {item.busNumber} ? {item.voltageKv} kV</span>
                          <strong>{fmtMw(item.capabilityMw)}</strong>
                        </div>
                      )) : <span>Not assessed in September 2025</span>}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}

          {showGenerators && data.layers.generators.features.map((feature, index) => {
            const center = mapPoint(feature);
            if (!center) return null;
            const p = feature.properties;
            const colour = GENERATOR_COLOURS[p.assetType ?? ""] ?? "#94a3b8";
            return (
              <CircleMarker key={`gen-${p.assetId ?? index}`} center={center}
                radius={Math.min(11, 4 + Math.sqrt(p.maximumCapabilityMw ?? 0) / 6)}
                pathOptions={{ color: "#f8fafc", fillColor: colour, fillOpacity: 0.9, weight: 1 }}>
                <Popup>
                  <div className="min-w-[205px] space-y-2 text-sm">
                    <div><div className="font-semibold">{p.assetName ?? p.assetId}</div>
                      <div className="text-xs text-muted-foreground">{p.assetId} ? {p.assetType}</div></div>
                    <MapPopupRow label="Maximum capability" value={fmtMw(p.maximumCapabilityMw)} />
                    <MapPopupRow label="Location" value={`${p.planningArea ?? "?"} ? ${p.region ?? "?"}`} />
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}

          {showProjects && data.layers.projects.features.map((feature, index) => {
            const center = mapPoint(feature);
            if (!center) return null;
            const p = feature.properties;
            const isSupply = (p.supplyMw ?? 0) > 0;
            const colour = isSupply ? "#fbbf24" : "#60a5fa";
            return (
              <CircleMarker key={`project-${p.projectNumber ?? index}`} center={center} radius={5}
                pathOptions={{ color: colour, fillColor: colour, fillOpacity: 0.75, weight: 2 }}>
                <Popup>
                  <div className="min-w-[220px] space-y-2 text-sm">
                    <div><div className="font-semibold">{p.projectName}</div>
                      <div className="text-xs text-muted-foreground">P{p.projectNumber} ? Stage {p.stage ?? "?"}</div></div>
                    <MapPopupRow label="Supply" value={fmtMw(p.supplyMw)} />
                    <MapPopupRow label="Demand" value={fmtMw(p.demandMw)} />
                    <MapPopupRow label="Type" value={p.fuelType ?? "?"} />
                    <MapPopupRow label="Status" value={p.status ?? "?"} />
                    <MapPopupRow label="Planning area" value={p.planningArea ?? "?"} />
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>

        <div className="absolute right-4 top-4 z-[500] w-72 rounded-lg border border-border bg-card/95 p-4 shadow-xl backdrop-blur">
          <div className="mb-2 text-sm font-medium">Map layers</div>
          <LayerToggle checked={showRegions} onChange={setShowRegions} colour="#34d399" label="Six planning regions" count={data.counts.planningAreas} />
          <LayerToggle checked={showLines} onChange={setShowLines} colour="#a78bfa" label="Transmission lines" count={filteredLines?.features.length ?? 0} />
          <LayerToggle checked={showSubstations} onChange={setShowSubstations} colour="#f8fafc" label="Substations" count={data.counts.substations} />
          <LayerToggle checked={showGenerators} onChange={setShowGenerators} colour="#38bdf8" label="Existing generators" count={data.counts.generators} />
          <LayerToggle checked={showProjects} onChange={setShowProjects} colour="#fbbf24" label="Connection projects" count={data.counts.projects} />
          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Minimum line voltage</div>
            <div className="grid grid-cols-4 gap-1">
              {[69, 138, 240, 500].map((value) => (
                <button key={value} type="button" onClick={() => setMinimumVoltage(value)}
                  className={`rounded border px-1.5 py-1 text-[10px] ${minimumVoltage === value
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent"}`}>
                  {value}+
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{data.capabilityDataAvailable
          ? `Capability values loaded ? ${data.capabilityAsOf}`
          : "Live geometry loaded ? capability tables not yet seeded"}</span>
        <a href={data.sources.geometry} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 hover:text-foreground">
          Open official AESO map <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <p className="text-xs text-muted-foreground">
        Exact AESO ArcGIS geometry: {data.counts.lines.toLocaleString()} lines, {data.counts.substations.toLocaleString()} substations,
        {" "}{data.counts.generators.toLocaleString()} generators and {data.counts.projects.toLocaleString()} connection projects.
        Project locations are approximate and subject to change.
      </p>
    </div>
  );
}

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
          ["map", "Network map", MapIcon],
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

      {tab === "map" && <NativeMap />}

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
