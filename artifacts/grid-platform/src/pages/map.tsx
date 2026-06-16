import { useState, useMemo, useEffect, useRef } from "react";
import { useListCandidates, useListQueueProjects } from "@workspace/api-client-react";
import { MapContainer, TileLayer, Marker, Popup, GeoJSON } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { Card } from "@/components/ui/card";
import { Loader2, Zap, Server, ChevronDown } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";

// Log-scale helpers
const LOG_MIN = Math.log10(1);
const LOG_MAX = Math.log10(3000);
const posToMw = (pos: number) => Math.round(Math.pow(10, LOG_MIN + (pos / 100) * (LOG_MAX - LOG_MIN)));
const fmtMw   = (mw: number)  => mw >= 1000 ? `${(mw / 1000).toFixed(1)} GW` : `${mw} MW`;

// Fix leaflet default icon
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

// ── Market (ISO) pin colors for EIA 860 circles ─────────────────────────────
const MARKET_COLORS: Record<string, string> = {
  ERCOT: "#14b8a6",  // teal
  CAISO: "#3b82f6",  // blue
  PJM:   "#8b5cf6",  // purple
};

// ── Shared fuel-type colors (queue diamonds + legend) ────────────────────────
const FUEL_COLORS: Record<string, string> = {
  solar:         "#f59e0b",
  wind:          "#14b8a6",
  offshore_wind: "#06b6d4",
  storage:       "#8b5cf6",
  natural_gas:   "#f97316",
  nuclear:       "#3b82f6",
  hydro:         "#22c55e",
  geothermal:    "#ec4899",
  hybrid:        "#a3e635",
  solar_storage: "#f59e0b",
  wind_storage:  "#14b8a6",
  biomass:       "#84cc16",
};

const FUEL_LABELS: Record<string, string> = {
  solar:         "Solar",
  wind:          "Wind",
  offshore_wind: "Offshore Wind",
  storage:       "Battery Storage",
  natural_gas:   "Natural Gas",
  nuclear:       "Nuclear",
  hydro:         "Hydro",
  geothermal:    "Geothermal",
  hybrid:        "Hybrid (Solar+Storage)",
  biomass:       "Biomass",
  coal:          "Coal",
  oil:           "Oil",
  other:         "Other",
};

// ── Transmission voltage bands — matching OpenGridWorks categories ────────────
const VOLTAGE_BANDS = [
  { min: 735, max: Infinity, label: "735kV+",     color: "#ef4444", weight: 3.5 },
  { min: 500, max: 734,      label: "500–734kV",  color: "#f97316", weight: 2.5 },
  { min: 345, max: 499,      label: "345–499kV",  color: "#f59e0b", weight: 2.0 },
  { min: 230, max: 344,      label: "230–344kV",  color: "#a78bfa", weight: 1.5 },
  { min: 100, max: 229,      label: "100–229kV",  color: "#3b82f6", weight: 1.0 },
  { min: 31,  max: 99,       label: "31–99kV",    color: "#22c55e", weight: 0.7 },
  { min: 0,   max: 30,       label: "<31kV",      color: "#6b7280", weight: 0.5 },
];

const VOLTAGE_BAND_LABELS = VOLTAGE_BANDS.map(b => b.label);

function getVoltageBandLabel(voltage: number): string {
  for (const band of VOLTAGE_BANDS) {
    if (voltage >= band.min && voltage <= band.max) return band.label;
  }
  return "<31kV";
}

function getVoltageStyle(voltage: number) {
  const label = getVoltageBandLabel(voltage);
  const band = VOLTAGE_BANDS.find(b => b.label === label) ?? VOLTAGE_BANDS[VOLTAGE_BANDS.length - 1];
  return { color: band.color, weight: band.weight };
}

// ── Marker factories ─────────────────────────────────────────────────────────
const createDot = (color: string, size = 14) =>
  new L.DivIcon({
    className: "",
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid rgba(255,255,255,0.7);box-shadow:0 0 4px rgba(0,0,0,0.6)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

const createDiamond = (color: string, size = 12) => {
  const inner = size * 0.75;
  return new L.DivIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;">
      <div style="width:${inner}px;height:${inner}px;background:${color};transform:rotate(45deg);border:1.5px solid rgba(255,255,255,0.8);box-shadow:0 0 4px rgba(0,0,0,0.7);opacity:0.9;"></div>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

// Square marker — data centers
const DC_COLOR = "#38bdf8"; // sky blue
const createSquare = (size = 11) =>
  new L.DivIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;background:${DC_COLOR};border:2px solid rgba(255,255,255,0.75);box-shadow:0 0 5px rgba(56,189,248,0.6);border-radius:2px;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

// ── Transmission lines from our API (HIFLD 115kV+, pre-loaded into DB) ────────
const TX_LINES_URL = "/api/transmission-lines?minVoltage=115";

// ── OpenStreetMap datacenter fetch config ─────────────────────────────────
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_DC_QUERY = `[out:json][timeout:45];(node["building"="data_center"](24,-126,50,-66);way["building"="data_center"](24,-126,50,-66);node["man_made"="data_center"](24,-126,50,-66);way["man_made"="data_center"](24,-126,50,-66););out center tags;`;

interface DcMarker {
  id: string | number;
  lat: number;
  lon: number;
  name: string;
  operator: string;
  city: string;
  website: string;
}

// ── Filter constants ─────────────────────────────────────────────────────────
const ISO_MARKETS = ["ERCOT", "CAISO", "PJM"] as const;
const EIA_LEGEND   = ["solar", "wind", "storage", "natural_gas", "nuclear", "hydro", "biomass", "geothermal", "hybrid"] as const;
const QUEUE_LEGEND = ["solar", "wind", "offshore_wind", "storage", "natural_gas", "hybrid", "geothermal", "nuclear", "hydro"] as const;
const EIA_FILTERABLE   = new Set<string>(EIA_LEGEND);
const QUEUE_FILTERABLE = new Set<string>(QUEUE_LEGEND);

// ── Interactive panel helper components ──────────────────────────────────────

function LayerSection({
  title, subtitle, icon, enabled, onEnable, expanded, onExpand, countLabel, children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  enabled: boolean;
  onEnable: (v: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  countLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60 last:border-0">
      <div
        onClick={onExpand}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/5 transition-colors cursor-pointer select-none"
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === "Enter" && onExpand()}
      >
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
        />
        {icon}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium leading-tight">{title}</div>
          {subtitle && (
            <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{subtitle}</div>
          )}
        </div>
        {countLabel && (
          <span className="text-[10px] tabular-nums text-muted-foreground mr-1">{countLabel}</span>
        )}
        <div onClick={e => e.stopPropagation()} className="shrink-0">
          <Switch
            checked={enabled}
            onCheckedChange={onEnable}
            className="scale-90"
          />
        </div>
      </div>
      {expanded && <div className="px-4 pb-3 space-y-0.5">{children}</div>}
    </div>
  );
}

function FuelRow({
  fuelKey, color, label, count, active, onToggle, shape,
}: {
  fuelKey: string;
  color: string;
  label: string;
  count: number;
  active: boolean;
  onToggle: () => void;
  shape: "circle" | "diamond";
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-2 w-full text-left py-[3px] px-1 rounded hover:bg-white/5 transition-opacity ${active ? "opacity-100" : "opacity-30"}`}
    >
      {shape === "circle" ? (
        <div
          className="shrink-0 rounded-full border border-white/30"
          style={{ width: 9, height: 9, backgroundColor: color }}
        />
      ) : (
        <div className="shrink-0 flex items-center justify-center" style={{ width: 10, height: 10 }}>
          <div
            style={{ width: 7, height: 7, backgroundColor: color, transform: "rotate(45deg)", border: "1px solid rgba(255,255,255,0.4)" }}
          />
        </div>
      )}
      <span className="flex-1 text-[11px] leading-tight">{label}</span>
      <span className="text-[10px] text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
    </button>
  );
}

function VoltageRow({
  band, count, active, onToggle,
}: {
  band: typeof VOLTAGE_BANDS[number];
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex items-center gap-2 w-full text-left py-[3px] px-1 rounded hover:bg-white/5 transition-opacity ${active ? "opacity-100" : "opacity-30"}`}
    >
      <div
        className="shrink-0 rounded"
        style={{ width: 18, height: Math.max(band.weight, 1.5) + 1, backgroundColor: band.color, opacity: 0.9, flexShrink: 0 }}
      />
      <span className="flex-1 text-[11px] leading-tight">{band.label}</span>
      {count > 0 && (
        <span className="text-[10px] text-muted-foreground tabular-nums">{count.toLocaleString()}</span>
      )}
    </button>
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export default function MapWorkspace() {
  // Layer visibility
  const [showEia860,       setShowEia860]       = useState(true);
  const [showQueue,        setShowQueue]        = useState(true);
  const [showTransmission, setShowTransmission] = useState(false);
  const [showDatacenters,  setShowDatacenters]  = useState(false);

  // Section expand state (all open by default)
  const [eia860Expanded, setEia860Expanded] = useState(true);
  const [queueExpanded,  setQueueExpanded]  = useState(true);
  const [txExpanded,     setTxExpanded]     = useState(true);
  const [dcExpanded,     setDcExpanded]     = useState(false);

  // Inclusive filter sets — item in set = visible. All start fully populated (show all)
  const [eia860Fuels,      setEia860Fuels]      = useState<Set<string>>(() => new Set(EIA_LEGEND));
  const [queueFuels,       setQueueFuels]       = useState<Set<string>>(() => new Set(QUEUE_LEGEND));
  const [txVoltageFilters, setTxVoltageFilters] = useState<Set<string>>(() => new Set(VOLTAGE_BAND_LABELS));
  const [marketFilters,    setMarketFilters]    = useState<Set<string>>(() => new Set(ISO_MARKETS));

  const [mwPos, setMwPos] = useState<[number, number]>([0, 100]);

  function toggleSet(setter: React.Dispatch<React.SetStateAction<Set<string>>>, v: string) {
    setter(prev => {
      const next = new Set(prev);
      next.has(v) ? next.delete(v) : next.add(v);
      return next;
    });
  }
  const minMw = posToMw(mwPos[0]);
  const maxMw = posToMw(mwPos[1]);

  // Datacenter state
  const [dcMarkers,        setDcMarkers]        = useState<DcMarker[]>([]);
  const [dcLoading,        setDcLoading]        = useState(false);
  const [dcError,          setDcError]          = useState<string | null>(null);
  const dcFetched = useRef(false);

  // Transmission state
  const [txLines,         setTxLines]         = useState<FeatureCollection | null>(null);
  const [txLoading,       setTxLoading]       = useState(false);
  const [txError,         setTxError]         = useState<string | null>(null);
  const txFetched = useRef(false);

  // Fetch datacenters lazily from OpenStreetMap Overpass API
  useEffect(() => {
    if (!showDatacenters || dcFetched.current) return;
    dcFetched.current = true;
    setDcLoading(true);
    setDcError(null);

    fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: OVERPASS_DC_QUERY,
    })
      .then(r => r.json())
      .then((d: { elements?: any[] }) => {
        const markers: DcMarker[] = (d.elements ?? [])
          .map((el: any) => {
            const lat = el.lat ?? el.center?.lat;
            const lon = el.lon ?? el.center?.lon;
            if (!lat || !lon) return null;
            const t = el.tags ?? {};
            const city = [t["addr:city"], t["addr:state"]].filter(Boolean).join(", ");
            return {
              id: el.id,
              lat,
              lon,
              name:     t.name     ?? t["short_name"] ?? "Data Center",
              operator: t.operator ?? t.owner ?? "",
              city,
              website:  t.website  ?? "",
            } as DcMarker;
          })
          .filter(Boolean) as DcMarker[];
        setDcMarkers(markers);
        setDcLoading(false);
      })
      .catch(() => {
        setDcError("Failed to load datacenter data");
        setDcLoading(false);
      });
  }, [showDatacenters]);

  // Fetch transmission lines lazily when toggle is first turned on
  useEffect(() => {
    if (!showTransmission || txFetched.current) return;
    txFetched.current = true;
    setTxLoading(true);
    setTxError(null);

    fetch(TX_LINES_URL)
      .then(r => r.json() as Promise<FeatureCollection>)
      .then(fc => {
        // Normalize MultiLineString → LineString by flattening coordinates.
        // HIFLD data stores some lines as MultiLineString (3-D coords array).
        // If the API returns the wrong type, Leaflet's path renderer can enter
        // infinite recursion and hang the tab — the flatten here prevents that.
        const features = (fc.features ?? [])
          .filter((f: Feature) => f.geometry != null)
          .map((f: Feature) => {
            const geom = f.geometry as any;
            if (!geom || !Array.isArray(geom.coordinates)) return null;
            const coords = geom.coordinates;
            // 3-D array → either real MultiLineString or LineString mis-labelled
            if (coords.length > 0 && Array.isArray(coords[0]) && Array.isArray(coords[0]?.[0])) {
              return {
                ...f,
                geometry: {
                  type: "LineString" as const,
                  coordinates: (coords as number[][][]).flat(1),
                },
              };
            }
            return f;
          })
          .filter(Boolean) as Feature[];
        setTxLines({ type: "FeatureCollection", features });
        setTxLoading(false);
      })
      .catch(() => {
        setTxError("Failed to load transmission data");
        setTxLoading(false);
      });
  }, [showTransmission]);

  const { data: candidates,    isLoading: isLoadingCandidates } = useListCandidates({ limit: 5000 });
  const { data: queueProjects, isLoading: isLoadingQueue }      = useListQueueProjects();

  const filteredCandidates = useMemo(() => {
    if (!candidates) return [];
    return candidates.filter(c => {
      if (!c.latitude || !c.longitude) return false;
      if (!marketFilters.has(c.market)) return false;
      if (EIA_FILTERABLE.has(c.assetType) && !eia860Fuels.has(c.assetType)) return false;
      if (c.capacityMw < minMw || c.capacityMw > maxMw) return false;
      return true;
    });
  }, [candidates, eia860Fuels, marketFilters, minMw, maxMw]);

  const filteredQueue = useMemo(() => {
    if (!queueProjects) return [];
    return queueProjects.filter(q => {
      if (!q.latitude || !q.longitude) return false;
      if (!marketFilters.has(q.market)) return false;
      if (QUEUE_FILTERABLE.has(q.fuelType) && !queueFuels.has(q.fuelType)) return false;
      return true;
    });
  }, [queueProjects, marketFilters, queueFuels]);

  // Filter transmission lines by selected voltage bands (inclusive set)
  const filteredTxLines = useMemo((): FeatureCollection | null => {
    if (!txLines) return null;
    if (txVoltageFilters.size === VOLTAGE_BAND_LABELS.length) return txLines;
    return {
      type: "FeatureCollection",
      features: txLines.features.filter((f: Feature) => {
        const v = f.properties?.VOLTAGE ?? 0;
        return txVoltageFilters.has(getVoltageBandLabel(v));
      }),
    };
  }, [txLines, txVoltageFilters]);

  // Per-fuel counts (market-filtered only, not fuel-filtered) for legend badges
  const eia860Counts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!candidates) return counts;
    for (const c of candidates) {
      if (!marketFilters.has(c.market)) continue;
      counts[c.assetType] = (counts[c.assetType] ?? 0) + 1;
    }
    return counts;
  }, [candidates, marketFilters]);

  const queueCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!queueProjects) return counts;
    for (const q of queueProjects) {
      if (!marketFilters.has(q.market)) continue;
      counts[q.fuelType] = (counts[q.fuelType] ?? 0) + 1;
    }
    return counts;
  }, [queueProjects, marketFilters]);

  const txBandCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!txLines) return counts;
    for (const f of txLines.features) {
      const label = getVoltageBandLabel(f.properties?.VOLTAGE ?? 0);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  }, [txLines]);

  const isLoading = isLoadingCandidates || isLoadingQueue;

  // GeoJSON style function (must be stable ref to prevent constant re-render)
  const txStyle = useMemo(() => (feature?: Feature<Geometry, any>) => {
    const voltage = feature?.properties?.VOLTAGE ?? 0;
    const { color, weight } = getVoltageStyle(voltage);
    return { color, weight, opacity: 0.75 };
  }, []);

  return (
    <div className="h-full flex relative">
      <div className="flex-1 h-full z-0 relative">
        {/* Data loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 bg-background/50 z-50 flex items-center justify-center backdrop-blur-sm">
            <div className="flex items-center gap-2 bg-card p-4 rounded-md shadow-md border">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm">Loading map data…</span>
            </div>
          </div>
        )}

        {/* Transmission loading indicator (non-blocking) */}
        {txLoading && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-card/95 px-3 py-2 rounded-full shadow border text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            Loading transmission lines (~23,000 features)…
          </div>
        )}
        {txError && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-destructive/90 px-3 py-2 rounded-full shadow text-xs text-white">
            {txError}
          </div>
        )}

        <MapContainer
          center={[39.0, -98.0]}
          zoom={4}
          style={{ height: "100%", width: "100%", zIndex: 0 }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          {/* ── Transmission Lines (bottom layer) ── */}
          {showTransmission && filteredTxLines && (
            <GeoJSON
              key={`transmission-${Array.from(txVoltageFilters).sort().join(",")}`}
              data={filteredTxLines}
              style={txStyle}
              interactive={false}
            />
          )}

          {/* ── EIA 860 Operational Plants — circles coloured by ISO market ── */}
          {showEia860 && filteredCandidates.map(c => (
            <Marker
              key={`eia-${c.id}`}
              position={[c.latitude, c.longitude]}
              icon={createDot(MARKET_COLORS[c.market] ?? "#94a3b8")}
            >
              <Popup>
                <div className="min-w-[210px]">
                  <div className="font-semibold text-sm mb-1">{c.name}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: MARKET_COLORS[c.market] ?? "#94a3b8" }}
                    />
                    {c.market} · {FUEL_LABELS[c.assetType] ?? c.assetType}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div>
                      <span className="text-muted-foreground">Capacity</span><br />
                      <span className="font-semibold">{c.capacityMw.toLocaleString()} MW</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">COD</span><br />
                      <span className="font-semibold">{(c as any).commissioningYear ?? "—"}</span>
                    </div>
                    {(c.county || c.state) && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Location</span><br />
                        <span className="font-medium">{[c.county, c.state].filter(Boolean).join(", ")}</span>
                      </div>
                    )}
                    {c.notes && c.notes.includes("Owner:") && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Owner</span><br />
                        <span className="font-medium">
                          {c.notes.replace(/^.*Owner: /, "")}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 pt-1.5 border-t border-gray-700 flex items-center gap-1.5 text-xs text-green-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400" />
                    Operational
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* ── ISO Queue Projects — diamonds ── */}
          {showQueue && filteredQueue.map(q => (
            <Marker
              key={`q-${q.id}`}
              position={[q.latitude!, q.longitude!]}
              icon={createDiamond(FUEL_COLORS[q.fuelType] ?? "#94a3b8")}
            >
              <Popup>
                <div className="min-w-[210px]">
                  <div className="font-semibold text-sm mb-1">{q.projectName}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <span
                      className="inline-block shrink-0"
                      style={{
                        width: 8, height: 8,
                        background: FUEL_COLORS[q.fuelType] ?? "#94a3b8",
                        transform: "rotate(45deg)",
                        display: "inline-block",
                      }}
                    />
                    {q.market} Queue · {FUEL_LABELS[q.fuelType] ?? q.fuelType.replace(/_/g, " ")}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div>
                      <span className="text-muted-foreground">Capacity</span><br />
                      <span className="font-semibold">{q.capacityMw?.toLocaleString()} MW</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status</span><br />
                      <span className="font-medium capitalize">{q.status}</span>
                    </div>
                    {q.studyGroupPhase && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Study Phase</span><br />
                        <span className="font-medium">{q.studyGroupPhase}</span>
                      </div>
                    )}
                    {q.interconnectionNode && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Interconnect Point</span><br />
                        <span className="font-medium">{q.interconnectionNode}</span>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 pt-1.5 border-t border-gray-700 flex items-center gap-1.5 text-xs text-amber-400">
                    <span style={{ width: 6, height: 6, background: "#f59e0b", transform: "rotate(45deg)", display: "inline-block" }} />
                    Queue / Pipeline
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* ── Data Centers ── */}
          {showDatacenters && dcMarkers.map(dc => (
            <Marker
              key={`dc-${dc.id}`}
              position={[dc.lat, dc.lon]}
              icon={createSquare()}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <div className="font-semibold text-sm mb-1">{dc.name}</div>
                  {dc.operator && (
                    <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                      <div style={{ width: 8, height: 8, background: DC_COLOR, borderRadius: 1, border: "1px solid rgba(255,255,255,0.4)", flexShrink: 0 }} />
                      {dc.operator}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-y-1.5 text-xs">
                    {dc.city && (
                      <div>
                        <span className="text-muted-foreground">Location</span><br />
                        <span className="font-medium">{dc.city}</span>
                      </div>
                    )}
                    {dc.website && (
                      <div>
                        <a href={dc.website} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline truncate block">{dc.website.replace(/^https?:\/\//, "")}</a>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 pt-1.5 border-t border-gray-700 text-xs text-sky-400 flex items-center gap-1.5">
                    <div style={{ width: 6, height: 6, background: DC_COLOR, borderRadius: 1, flexShrink: 0 }} />
                    Data Center · OSM
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* ── Side Panel ── */}
      <div className="absolute top-4 right-4 z-10 w-68" style={{ width: 272 }}>
        <Card className="bg-card/95 backdrop-blur shadow-lg border-border overflow-hidden">

          {/* Market chips */}
          <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Markets</span>
            {ISO_MARKETS.map(m => {
              const active = marketFilters.has(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleSet(setMarketFilters, m)}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-all ${
                    active
                      ? "bg-primary/20 border-primary/60 text-primary"
                      : "bg-transparent border-border text-muted-foreground opacity-40"
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>

          {/* EIA 860 Plants */}
          <LayerSection
            title="EIA 860 Plants"
            subtitle="Operational · circle markers"
            enabled={showEia860}
            onEnable={setShowEia860}
            expanded={eia860Expanded}
            onExpand={() => setEia860Expanded(v => !v)}
            countLabel={showEia860 ? filteredCandidates.length.toLocaleString() : undefined}
          >
            {/* Market legend (pin color = ISO) */}
            {(["ERCOT","CAISO","PJM"] as const).map(mkt => (
              <FuelRow
                key={mkt}
                fuelKey={mkt}
                color={MARKET_COLORS[mkt]}
                label={mkt}
                count={Object.values(eia860Counts).reduce((s,v)=>s+v,0) > 0
                  ? (filteredCandidates.filter(c=>c.market===mkt).length)
                  : 0}
                active={marketFilters.has(mkt)}
                onToggle={() => toggleSet(setMarketFilters, mkt)}
                shape="circle"
              />
            ))}
            {/* Fuel type filter (still controls which technologies render) */}
            <div className="pt-1 mt-0.5 border-t border-border/30">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 px-0.5">Filter by Technology</div>
              {EIA_LEGEND.map(key => (
                <FuelRow
                  key={key}
                  fuelKey={key}
                  color={FUEL_COLORS[key] ?? "#94a3b8"}
                  label={FUEL_LABELS[key] ?? key}
                  count={eia860Counts[key] ?? 0}
                  active={eia860Fuels.has(key)}
                  onToggle={() => toggleSet(setEia860Fuels, key)}
                  shape="circle"
                />
              ))}
            </div>
            {/* MW slider */}
            <div className="pt-2 mt-1 border-t border-border/50 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Capacity Range</span>
                <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => setMwPos([0, 100])}>Reset</button>
              </div>
              <Slider min={0} max={100} step={1} value={mwPos} onValueChange={v => setMwPos(v as [number, number])} />
              <div className="flex justify-between text-[10px] font-medium">
                <span className="text-primary">{fmtMw(minMw)}</span>
                <span className="text-muted-foreground">—</span>
                <span className="text-primary">{fmtMw(maxMw)}</span>
              </div>
            </div>
          </LayerSection>

          {/* ISO Queue Projects */}
          <LayerSection
            title="ISO Queue Projects"
            subtitle="Interconnection pipeline · diamond"
            enabled={showQueue}
            onEnable={setShowQueue}
            expanded={queueExpanded}
            onExpand={() => setQueueExpanded(v => !v)}
            countLabel={showQueue ? filteredQueue.length.toLocaleString() : undefined}
          >
            {QUEUE_LEGEND.map(key => (
              <FuelRow
                key={key}
                fuelKey={key}
                color={FUEL_COLORS[key] ?? "#94a3b8"}
                label={FUEL_LABELS[key] ?? key.replace(/_/g, " ")}
                count={queueCounts[key] ?? 0}
                active={queueFuels.has(key)}
                onToggle={() => toggleSet(setQueueFuels, key)}
                shape="diamond"
              />
            ))}
          </LayerSection>

          {/* Transmission Lines */}
          <LayerSection
            title="Transmission Lines"
            subtitle={
              txLines
                ? `${(filteredTxLines?.features.length ?? 0).toLocaleString()} / ${txLines.features.length.toLocaleString()} lines`
                : txLoading
                ? "Loading from HIFLD…"
                : "≥100kV backbone, HIFLD"
            }
            icon={<Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
            enabled={showTransmission}
            onEnable={setShowTransmission}
            expanded={txExpanded}
            onExpand={() => setTxExpanded(v => !v)}
          >
            {txLoading && (
              <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading transmission data…
              </div>
            )}
            {!txLoading && VOLTAGE_BANDS.map(band => (
              <VoltageRow
                key={band.label}
                band={band}
                count={txBandCounts[band.label] ?? 0}
                active={txVoltageFilters.has(band.label)}
                onToggle={() => toggleSet(setTxVoltageFilters, band.label)}
              />
            ))}
            {txLines && (
              <p className="text-[10px] text-muted-foreground mt-1.5 pt-1.5 border-t border-border/40">
                Source: HIFLD Open Data · AC in service
              </p>
            )}
          </LayerSection>

          {/* Data Centers */}
          <LayerSection
            title="Data Centers"
            subtitle={
              dcMarkers.length > 0
                ? `${dcMarkers.length} facilities`
                : dcLoading
                ? "Loading from OSM…"
                : dcError
                ? "Load error"
                : "Hyperscale & colo, US-wide"
            }
            icon={<Server className="h-3.5 w-3.5 shrink-0" style={{ color: DC_COLOR }} />}
            enabled={showDatacenters}
            onEnable={setShowDatacenters}
            expanded={dcExpanded}
            onExpand={() => setDcExpanded(v => !v)}
            countLabel={dcMarkers.length > 0 ? dcMarkers.length.toString() : undefined}
          >
            <div className="flex items-center gap-2 py-[3px] px-1">
              <div
                className="shrink-0"
                style={{ width: 10, height: 10, background: DC_COLOR, borderRadius: 2, border: "1.5px solid rgba(255,255,255,0.4)", boxShadow: `0 0 4px ${DC_COLOR}66` }}
              />
              <span className="text-[11px]">Hyperscale &amp; Colocation</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 px-1">Source: OpenStreetMap</p>
          </LayerSection>

        </Card>
      </div>
    </div>
  );
}
