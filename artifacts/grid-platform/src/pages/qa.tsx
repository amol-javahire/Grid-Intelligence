import { useState, useRef, useEffect } from "react";
import { CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, BrainCircuit, Zap, Loader2, Database, TableIcon, BarChart2, Activity, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type TableBlock = {
  type: "table";
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
};

type ChartBlock = {
  type: "chart";
  chartType: "timeseries" | "bar";
  columns: string[];
  rows: Record<string, unknown>[];
};

type SimulationBlock = {
  type: "simulation";
  simulation_type: string;
  result: Record<string, unknown>;
};

type Block = TableBlock | ChartBlock | SimulationBlock;

interface Message {
  role: "user" | "assistant";
  content: string;
  sqlQueries?: string[];
  simulations?: string[];
  blocks?: Block[];
}

const CHART_COLORS = ["#14b8a6", "#f59e0b", "#8b5cf6", "#22c55e", "#ef4444", "#3b82f6", "#f97316"];

const NON_METRIC_COLS = new Set([
  "year", "month", "node", "market", "asset_type", "fuel_type",
  "name", "status", "id", "data_points",
]);

function getNumericCols(columns: string[]): string[] {
  return columns.filter(c => !NON_METRIC_COLS.has(c));
}

function buildTimeSeriesData(columns: string[], rows: Record<string, unknown>[]) {
  return rows.map(row => {
    const period = `${row.year}-${String(row.month).padStart(2, "0")}`;
    const entry: Record<string, unknown> = { period };
    for (const col of columns) {
      if (col !== "year" && col !== "month") {
        const v = row[col];
        entry[col] = v !== null && v !== undefined ? Number(v) : null;
      }
    }
    return entry;
  });
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  }
  const n = Number(value);
  if (!isNaN(n) && value !== "" && value !== true && value !== false) {
    return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
  }
  return String(value);
}

function formatColHeader(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function DataTable({ block }: { block: TableBlock }) {
  const { columns, rows, totalRows } = block;
  const truncated = totalRows > rows.length;

  return (
    <div className="mt-3 rounded-lg border border-border overflow-hidden bg-card/80">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
        <TableIcon className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-muted-foreground">
          {rows.length} rows{truncated ? ` (of ${totalRows})` : ""} · {columns.length} columns
        </span>
      </div>
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              {columns.map(col => (
                <TableHead key={col} className="text-xs py-2 whitespace-nowrap font-semibold">
                  {formatColHeader(col)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i} className="hover:bg-primary/5">
                {columns.map(col => (
                  <TableCell key={col} className="text-xs py-1.5 whitespace-nowrap tabular-nums">
                    {formatCellValue(row[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DataChart({ block }: { block: ChartBlock }) {
  const { columns, rows } = block;
  const numericCols = getNumericCols(columns);

  if (numericCols.length === 0 || rows.length === 0) return null;

  if (block.chartType === "timeseries") {
    const data = buildTimeSeriesData(columns, rows);
    const visibleCols = numericCols.slice(0, 4);

    return (
      <div className="mt-3 rounded-lg border border-border overflow-hidden bg-card/80">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
          <BarChart2 className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium text-muted-foreground">
            Monthly trend — {visibleCols.map(formatColHeader).join(", ")}
          </span>
        </div>
        <div className="p-3">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                tickFormatter={v => {
                  const parts = String(v).split("-");
                  return parts.length === 2 ? `${parts[1]}/${parts[0].slice(2)}` : v;
                }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} width={48} />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "8px",
                  fontSize: 11,
                }}
                labelStyle={{ color: "#94a3b8", marginBottom: 4 }}
                itemStyle={{ color: "#e2e8f0" }}
                formatter={(v: number | string) => [
                  typeof v === "number" ? v.toFixed(2) : v,
                  "",
                ]}
              />
              {visibleCols.length > 1 && (
                <Legend wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
              )}
              {visibleCols.map((col, idx) => (
                <Line
                  key={col}
                  type="monotone"
                  dataKey={col}
                  name={formatColHeader(col)}
                  stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  return null;
}

const SIM_TYPE_LABELS: Record<string, string> = {
  opf: "DC-OPF",
  curtailment: "Curtailment Analysis",
  tx_relief: "Transmission Relief",
  scarcity: "Scarcity / Load Shedding",
  battery: "Battery Storage OPF",
};

function SimulationResultBlock({ block }: { block: SimulationBlock }) {
  const { simulation_type, result } = block;
  const label = SIM_TYPE_LABELS[simulation_type] ?? simulation_type;

  const lmp = result.lmp as Record<string, number> | undefined;
  const lines = result.lines as Array<Record<string, unknown>> | undefined;
  const zoneSummary = result.zone_summary as Array<Record<string, unknown>> | undefined;
  const scarcityZones = (result.zone_risk ?? result.zones) as Array<Record<string, unknown>> | undefined;
  const schedule = result.hourly_schedule as Array<Record<string, unknown>> | undefined;
  const baseline = result.baseline as Record<string, unknown> | undefined;
  const upgraded = result.upgraded as Record<string, unknown> | undefined;

  const lmpData = lmp
    ? Object.entries(lmp).map(([zone, price]) => ({ zone, price }))
    : [];

  return (
    <div className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: "rgba(20,184,166,0.3)", background: "rgba(20,184,166,0.04)" }}>
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: "rgba(20,184,166,0.2)", background: "rgba(20,184,166,0.08)" }}>
        <Cpu className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold text-primary">PyPSA {label}</span>
        {!!result.status && (
          <Badge variant="outline" className="ml-auto text-xs" style={{ color: "#22c55e", borderColor: "rgba(34,197,94,0.3)" }}>
            {String(result.status)}
          </Badge>
        )}
      </div>

      <div className="p-3 space-y-3">
        {/* Nodal LMPs bar chart */}
        {lmpData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Nodal LMPs ($/MWh)</p>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={lmpData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="zone" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} width={44} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }}
                  formatter={(v: number) => [`$${v.toFixed(2)}/MWh`, "LMP"]}
                />
                <Bar dataKey="price" fill="#14b8a6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Summary stats row */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {result.total_curtailed_mw !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Total Curtailed</p>
              <p className="font-semibold text-amber-400">{Number(result.total_curtailed_mw).toFixed(0)} MW</p>
            </div>
          )}
          {result.curtail_pct !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Curtailment %</p>
              <p className="font-semibold text-amber-400">{Number(result.curtail_pct).toFixed(1)}%</p>
            </div>
          )}
          {result.avg_lmp !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Avg System LMP</p>
              <p className="font-semibold text-primary">${Number(result.avg_lmp).toFixed(2)}/MWh</p>
            </div>
          )}
          {result.total_load_shed_mw !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Load Shed</p>
              <p className="font-semibold text-red-400">{Number(result.total_load_shed_mw).toFixed(0)} MW</p>
            </div>
          )}
          {result.max_lmp !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Max LMP (Scarcity)</p>
              <p className="font-semibold text-red-400">${Number(result.max_lmp).toFixed(2)}/MWh</p>
            </div>
          )}
          {result.arbitrage_value_annual !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Annual Arbitrage</p>
              <p className="font-semibold text-green-400">${(Number(result.arbitrage_value_annual) / 1e6).toFixed(1)}M</p>
            </div>
          )}
          {result.total_congestion_rent !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Congestion Rent</p>
              <p className="font-semibold text-purple-400">${Number(result.total_congestion_rent).toFixed(0)}/hr</p>
            </div>
          )}
          {(result as Record<string, unknown>)["spread_reduction"] !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Spread Reduction</p>
              <p className="font-semibold text-green-400">${Number((result as Record<string, unknown>)["spread_reduction"]).toFixed(2)}/MWh</p>
            </div>
          )}
          {(result as Record<string, unknown>)["cong_rent_reduction_k$"] !== undefined && (
            <div className="rounded p-2 bg-card/60 border border-border">
              <p className="text-muted-foreground">Cong. Rent Saved</p>
              <p className="font-semibold text-green-400">${Number((result as Record<string, unknown>)["cong_rent_reduction_k$"]).toFixed(0)}k/hr</p>
            </div>
          )}
        </div>

        {/* Line flows table */}
        {lines && lines.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Transmission Line Flows</p>
            <div className="overflow-x-auto rounded border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs py-1.5">Line</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Flow MW</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Cap MW</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Loading %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line, i) => {
                    const loading = Number(line.loading_pct ?? line.loading_before_pct ?? 0);
                    const congested = loading >= 95;
                    return (
                      <TableRow key={i} className={congested ? "bg-red-500/5" : ""}>
                        <TableCell className="text-xs py-1 font-mono">{String(line.name)}</TableCell>
                        <TableCell className="text-xs py-1 text-right tabular-nums">{Number(line.flow_mw ?? line.flow_before_mw ?? 0).toFixed(0)}</TableCell>
                        <TableCell className="text-xs py-1 text-right tabular-nums">{Number(line.capacity_mw).toFixed(0)}</TableCell>
                        <TableCell className={`text-xs py-1 text-right tabular-nums font-semibold ${congested ? "text-red-400" : "text-muted-foreground"}`}>
                          {loading.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Zone summary for curtailment */}
        {zoneSummary && zoneSummary.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Zone Curtailment Summary</p>
            <div className="overflow-x-auto rounded border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs py-1.5">Zone</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">LMP</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Curtailed MW</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Curtail %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {zoneSummary.map((z, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs py-1 font-mono">{String(z.zone)}</TableCell>
                      <TableCell className="text-xs py-1 text-right tabular-nums">${Number(z.lmp).toFixed(2)}</TableCell>
                      <TableCell className="text-xs py-1 text-right tabular-nums text-amber-400">{Number(z.curtailed_mw).toFixed(0)}</TableCell>
                      <TableCell className="text-xs py-1 text-right tabular-nums">{Number(z.curtail_pct).toFixed(1)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Scarcity zone_risk results */}
        {scarcityZones && scarcityZones.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Zone Risk Assessment</p>
            <div className="overflow-x-auto rounded border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs py-1.5">Zone</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">LMP</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Load Shed MW</TableHead>
                    <TableHead className="text-xs py-1.5 text-right">Risk Level</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scarcityZones.map((z, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs py-1 font-mono">{String(z.zone ?? z.bus ?? "")}</TableCell>
                      <TableCell className="text-xs py-1 text-right tabular-nums">${Number(z.lmp ?? 0).toFixed(2)}</TableCell>
                      <TableCell className="text-xs py-1 text-right tabular-nums text-red-400">{Number(z.load_shed_mw ?? 0).toFixed(0)}</TableCell>
                      <TableCell className="text-xs py-1 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${z.risk_level === "CRITICAL" ? "bg-red-500/20 text-red-400" : z.risk_level === "HIGH" ? "bg-amber-500/20 text-amber-400" : "bg-green-500/20 text-green-400"}`}>
                          {String(z.risk_level ?? "LOW")}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Before/after TX relief — baseline / upgraded */}
        {baseline && upgraded && (
          <div className="grid grid-cols-2 gap-2">
            {([["Baseline", baseline], ["Upgraded", upgraded]] as [string, Record<string, unknown>][]).map(([label, d]) => (
              <div key={label} className="rounded p-2 bg-card/60 border border-border">
                <p className="text-xs font-semibold text-muted-foreground mb-1">{label}</p>
                <p className="text-xs">Avg LMP: <span className="text-primary font-semibold">${Number(d.avg_lmp ?? 0).toFixed(2)}</span></p>
                <p className="text-xs">Cong. Rent: <span className="text-purple-400 font-semibold">${Number((d as Record<string, unknown>)["total_congestion_rent_k$"] ?? 0).toFixed(1)}k/hr</span></p>
                <p className="text-xs">Curtailed: <span className="text-amber-400 font-semibold">{Number(d.total_curtailed_mw ?? 0).toFixed(0)} MW</span></p>
              </div>
            ))}
          </div>
        )}

        {/* Battery hourly chart */}
        {schedule && schedule.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">24-Hour Battery Dispatch</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={schedule.slice(0, 24)} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "#94a3b8" }} tickFormatter={h => `${h}:00`} />
                <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} width={40} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 10 }}
                  formatter={(v: number) => [`${v.toFixed(0)} MW`, ""]}
                />
                <Legend wrapperStyle={{ fontSize: 9, color: "#94a3b8" }} />
                <Bar dataKey="charge_mw" name="Charge" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                <Bar dataKey="discharge_mw" name="Discharge" fill="#14b8a6" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

const SUGGESTED = [
  "What happens to HB_PAN LMPs if wind CF increases from 40% to 65%?",
  "How much load shedding if 3 GW of thermal is derated 15% at peak load?",
  "What is the arbitrage value of a 200 MW / 4-hour battery at HB_WEST?",
  "Which ERCOT nodes have the highest negative price frequency?",
];

export default function QACopilot() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "I'm the Grid Origination Copilot. I can query live market data AND run live PyPSA DC-OPF power simulations to answer what-if scenarios.\n\nTry asking: \"What happens to HB_PAN if wind CF goes to 65%?\" or \"What's the arbitrage value of a 200 MW battery at HB_WEST?\"",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: "sql" | "sim" } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusMsg]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setStatusMsg(null);

    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      let assistantContent = "";
      const sqlQueryLog: string[] = [];
      const simLog: string[] = [];
      const pendingBlocks: Block[] = [];

      setMessages(prev => [...prev, { role: "assistant", content: "", sqlQueries: [], simulations: [], blocks: [] }]);

      const updateLastMessage = () => {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: assistantContent,
            sqlQueries: sqlQueryLog.length > 0 ? [...sqlQueryLog] : undefined,
            simulations: simLog.length > 0 ? [...simLog] : undefined,
            blocks: pendingBlocks.length > 0 ? [...pendingBlocks] : undefined,
          };
          return updated;
        });
      };

      const handleEvent = (data: Record<string, unknown>) => {
        if (data.type === "sql_query" && typeof data.rationale === "string") {
          setStatusMsg({ text: data.rationale, type: "sql" });
          sqlQueryLog.push(data.rationale);
        } else if (data.type === "sql_done" || data.type === "sql_error") {
          setStatusMsg(null);
        } else if (data.type === "simulation_start") {
          const simType = SIM_TYPE_LABELS[data.simulation_type as string] ?? String(data.simulation_type);
          const msg = typeof data.rationale === "string" ? data.rationale : `Running ${simType}...`;
          setStatusMsg({ text: msg, type: "sim" });
          simLog.push(simType);
        } else if (data.type === "simulation_done") {
          setStatusMsg(null);
          pendingBlocks.push({
            type: "simulation",
            simulation_type: data.simulation_type as string,
            result: data.result as Record<string, unknown>,
          });
          updateLastMessage();
        } else if (data.type === "simulation_error") {
          setStatusMsg(null);
        } else if (data.type === "table") {
          pendingBlocks.push({
            type: "table",
            columns: data.columns as string[],
            rows: data.rows as Record<string, unknown>[],
            totalRows: data.totalRows as number,
          });
          updateLastMessage();
        } else if (data.type === "chart") {
          pendingBlocks.push({
            type: "chart",
            chartType: data.chartType as "timeseries" | "bar",
            columns: data.columns as string[],
            rows: data.rows as Record<string, unknown>[],
          });
          updateLastMessage();
        } else if (data.content) {
          assistantContent += data.content as string;
          updateLastMessage();
        } else if (data.error) {
          assistantContent = String(data.error);
          updateLastMessage();
        }
      };

      if (reader) {
        let sseBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });

          const events = sseBuffer.split("\n\n");
          sseBuffer = events.pop() ?? "";

          for (const rawEvent of events) {
            const dataLine = rawEvent.split("\n").find(l => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
              handleEvent(data);
            } catch {
              // ignore malformed events
            }
          }
        }

        if (sseBuffer.trim()) {
          const dataLine = sseBuffer.split("\n").find(l => l.startsWith("data: "));
          if (dataLine) {
            try {
              const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
              handleEvent(data);
            } catch {}
          }
        }
      }
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error connecting to the AI backend. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
      setStatusMsg(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="p-8 h-full flex flex-col items-center">
      <div className="w-full max-w-4xl h-full flex flex-col gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <div className="p-2 bg-primary/20 rounded-md">
            <BrainCircuit className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Origination Copilot</h1>
            <p className="text-muted-foreground">
              Natural language interface — live market data + PyPSA DC-OPF simulations.
            </p>
          </div>
          <Badge
            variant="outline"
            className="ml-auto bg-card"
            style={{ color: "#22c55e", borderColor: "rgba(34,197,94,0.3)" }}
          >
            <Zap className="mr-1 h-3 w-3" style={{ color: "#22c55e" }} /> OpenAI + OPF Engine
          </Badge>
        </div>

        {messages.length === 1 && (
          <div className="grid grid-cols-2 gap-2 shrink-0">
            {SUGGESTED.map((s, i) => (
              <button
                key={i}
                onClick={() => sendMessage(s)}
                className="text-left text-sm p-3 rounded-lg border border-border bg-card hover:border-primary/50 hover:bg-primary/5 transition-all text-muted-foreground hover:text-foreground"
              >
                {i < 3 && <span className="inline-flex items-center gap-1 text-xs text-primary font-medium mb-1"><Activity className="h-3 w-3" /> OPF Scenario</span>}
                <br className={i < 3 ? "" : "hidden"} />
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 border border-border rounded-xl bg-card/50 overflow-hidden flex flex-col min-h-0">
          <ScrollArea className="flex-1 p-6">
            <div className="space-y-5">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                  <div
                    className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary border border-border"
                    }`}
                  >
                    {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                  </div>
                  <div
                    className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[82%] gap-1`}
                  >
                    {msg.role === "assistant" && (msg.sqlQueries?.length || msg.simulations?.length) && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {msg.sqlQueries?.map((q, qi) => (
                          <span
                            key={`sql-${qi}`}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                          >
                            <Database className="h-3 w-3" />
                            {q}
                          </span>
                        ))}
                        {msg.simulations?.map((s, si) => (
                          <span
                            key={`sim-${si}`}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border"
                            style={{ background: "rgba(20,184,166,0.1)", color: "#14b8a6", borderColor: "rgba(20,184,166,0.3)" }}
                          >
                            <Cpu className="h-3 w-3" />
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap w-full ${
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-tr-sm"
                          : "bg-card border shadow-sm rounded-tl-sm"
                      }`}
                    >
                      {msg.content === "" && isLoading && i === messages.length - 1 ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        msg.content
                      )}

                      {msg.role === "assistant" && msg.blocks && msg.blocks.length > 0 && (
                        <div className="mt-1">
                          {msg.blocks.map((block, bi) => {
                            if (block.type === "table") {
                              return <DataTable key={`t-${bi}`} block={block} />;
                            }
                            if (block.type === "chart") {
                              return <DataChart key={`c-${bi}`} block={block} />;
                            }
                            if (block.type === "simulation") {
                              return <SimulationResultBlock key={`s-${bi}`} block={block} />;
                            }
                            return null;
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {statusMsg && (
                <div className="flex gap-3">
                  <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-secondary border border-border">
                    {statusMsg.type === "sim"
                      ? <Cpu className="h-4 w-4 text-primary animate-pulse" />
                      : <Database className="h-4 w-4 text-primary animate-pulse" />
                    }
                  </div>
                  <div
                    className="flex items-center gap-2 px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm border"
                    style={statusMsg.type === "sim"
                      ? { background: "rgba(20,184,166,0.1)", borderColor: "rgba(20,184,166,0.3)", color: "#14b8a6" }
                      : { background: "rgba(20,184,166,0.08)", borderColor: "rgba(20,184,166,0.2)", color: "#14b8a6" }
                    }
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {statusMsg.text}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <CardFooter className="p-3 border-t bg-card shrink-0">
            <form onSubmit={handleSubmit} className="flex w-full items-center gap-2">
              <Input
                type="text"
                placeholder="Ask a scenario: 'What happens to HB_PAN if wind CF goes to 65%?' or query data directly..."
                value={input}
                onChange={e => setInput(e.target.value)}
                className="flex-1 bg-background"
                disabled={isLoading}
              />
              <Button type="submit" size="icon" disabled={!input.trim() || isLoading}>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </CardFooter>
        </div>

        <p className="text-xs text-muted-foreground text-center shrink-0">
          Copilot runs live PyPSA DC-OPF simulations + queries ERCOT/CAISO/PJM data · 3,875 EIA candidates · 263k hourly price records
        </p>
      </div>
    </div>
  );
}
