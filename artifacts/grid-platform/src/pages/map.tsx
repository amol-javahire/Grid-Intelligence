import { useState, useMemo } from "react";
import { useListCandidates, useListQueueProjects } from "@workspace/api-client-react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Layers } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Fix leaflet default icon
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Fuel type color palette
const FUEL_COLORS: Record<string, string> = {
  solar:       "#f59e0b",  // amber
  wind:        "#14b8a6",  // teal
  storage:     "#8b5cf6",  // purple
  natural_gas: "#f97316",  // orange
  nuclear:     "#3b82f6",  // blue
  hydro:       "#22c55e",  // green
  solar_storage:"#f59e0b",
  wind_storage: "#14b8a6",
};

const FUEL_LABELS: Record<string, string> = {
  solar: "Solar",
  wind: "Wind",
  storage: "Battery Storage",
  natural_gas: "Natural Gas",
  nuclear: "Nuclear",
  hydro: "Hydro",
};

// Queue dots are a distinct lighter color per ISO
const QUEUE_COLORS: Record<string, string> = {
  ERCOT: "#2dd4bf",
  CAISO: "#fbbf24",
  PJM:   "#a78bfa",
};

const createDot = (color: string, size = 14, opacity = 1) =>
  new L.DivIcon({
    className: "",
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid rgba(255,255,255,0.7);box-shadow:0 0 4px rgba(0,0,0,0.6);opacity:${opacity}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

const FUEL_TYPES = ["all", "solar", "wind", "storage", "natural_gas", "nuclear", "hydro"];
const MARKETS = ["all", "ERCOT", "CAISO", "PJM"];

export default function MapWorkspace() {
  const [showEia860, setShowEia860] = useState(true);
  const [showQueue, setShowQueue] = useState(true);
  const [fuelFilter, setFuelFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");

  const { data: candidates, isLoading: isLoadingCandidates } = useListCandidates({ limit: 5000 });
  const { data: queueProjects, isLoading: isLoadingQueue } = useListQueueProjects();

  const filteredCandidates = useMemo(() => {
    if (!candidates) return [];
    return candidates.filter(c => {
      if (!c.latitude || !c.longitude) return false;
      if (fuelFilter !== "all" && c.assetType !== fuelFilter) return false;
      if (marketFilter !== "all" && c.market !== marketFilter) return false;
      return true;
    });
  }, [candidates, fuelFilter, marketFilter]);

  const filteredQueue = useMemo(() => {
    if (!queueProjects) return [];
    return queueProjects.filter(q => {
      if (!q.latitude || !q.longitude) return false;
      if (marketFilter !== "all" && q.market !== marketFilter) return false;
      return true;
    });
  }, [queueProjects, marketFilter]);

  const isLoading = isLoadingCandidates || isLoadingQueue;

  return (
    <div className="h-full flex relative">
      <div className="flex-1 h-full z-0 relative">
        {isLoading && (
          <div className="absolute inset-0 bg-background/50 z-50 flex items-center justify-center backdrop-blur-sm">
            <div className="flex items-center gap-2 bg-card p-4 rounded-md shadow-md border">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm">Loading map data…</span>
            </div>
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

          {showEia860 && filteredCandidates.map(c => (
            <Marker
              key={`eia-${c.id}`}
              position={[c.latitude, c.longitude]}
              icon={createDot(FUEL_COLORS[c.assetType] ?? "#94a3b8")}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <div className="font-semibold text-sm mb-1">{c.name}</div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {c.market} · {FUEL_LABELS[c.assetType] ?? c.assetType}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">Capacity</span><br />
                      <span className="font-medium">{c.capacityMw.toLocaleString()} MW</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Location</span><br />
                      <span className="font-medium">{c.county}, {c.state}</span>
                    </div>
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {showQueue && filteredQueue.map(q => (
            <Marker
              key={`q-${q.id}`}
              position={[q.latitude!, q.longitude!]}
              icon={createDot(QUEUE_COLORS[q.market] ?? "#94a3b8", 10, 0.75)}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <div className="font-semibold text-sm mb-1">{q.projectName}</div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {q.market} Queue · {q.fuelType.replace("_", " ")}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">Capacity</span><br />
                      <span className="font-medium">{q.capacityMw?.toLocaleString()} MW</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Status</span><br />
                      <span className="font-medium capitalize">{q.status}</span>
                    </div>
                    {q.studyGroupPhase && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Phase</span><br />
                        <span className="font-medium">{q.studyGroupPhase}</span>
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* Side Panel */}
      <div className="absolute top-4 right-4 z-10 w-72 space-y-3">
        {/* Layer toggles + filters */}
        <Card className="bg-card/95 backdrop-blur shadow-lg border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold flex items-center gap-2 uppercase tracking-wider text-muted-foreground">
              <Layers className="h-3.5 w-3.5" /> Map Layers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">EIA 860 Plants</Label>
                <p className="text-xs text-muted-foreground">Operating & planned</p>
              </div>
              <Switch checked={showEia860} onCheckedChange={setShowEia860} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">ISO Queue Projects</Label>
                <p className="text-xs text-muted-foreground">Interconnection pipeline</p>
              </div>
              <Switch checked={showQueue} onCheckedChange={setShowQueue} />
            </div>

            <div className="pt-1 space-y-2">
              <Select value={marketFilter} onValueChange={setMarketFilter}>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue placeholder="All Markets" />
                </SelectTrigger>
                <SelectContent>
                  {MARKETS.map(m => (
                    <SelectItem key={m} value={m} className="text-xs">
                      {m === "all" ? "All Markets" : m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {showEia860 && (
                <Select value={fuelFilter} onValueChange={setFuelFilter}>
                  <SelectTrigger className="h-8 text-xs bg-background">
                    <SelectValue placeholder="All Fuel Types" />
                  </SelectTrigger>
                  <SelectContent>
                    {FUEL_TYPES.map(f => (
                      <SelectItem key={f} value={f} className="text-xs">
                        {f === "all" ? "All Fuel Types" : FUEL_LABELS[f] ?? f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Counts */}
            <div className="flex gap-3 text-xs pt-1 text-muted-foreground border-t border-border">
              {showEia860 && (
                <span><span className="font-semibold text-foreground">{filteredCandidates.length}</span> plants</span>
              )}
              {showQueue && (
                <span><span className="font-semibold text-foreground">{filteredQueue.length}</span> queue</span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Fuel type legend */}
        <Card className="bg-card/95 backdrop-blur shadow-lg border-border">
          <CardContent className="px-4 py-3 space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">EIA 860 — By Fuel</div>
            {Object.entries(FUEL_LABELS).map(([key, label]) => (
              <div key={key} className="flex items-center gap-2 text-xs">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: FUEL_COLORS[key] }} />
                <span>{label}</span>
              </div>
            ))}
            <div className="border-t border-border mt-2 pt-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">ISO Queue</div>
              {Object.entries(QUEUE_COLORS).map(([iso, color]) => (
                <div key={iso} className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0 opacity-75" style={{ backgroundColor: color }} />
                  <span className="text-muted-foreground">{iso} queue</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
