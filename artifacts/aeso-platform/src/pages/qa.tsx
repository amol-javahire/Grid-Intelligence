import { useState, useRef, useEffect } from "react";
import { CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, BrainCircuit, Zap, Loader2, Database, TableIcon, BarChart2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

type TableBlock = { type: "table"; columns: string[]; rows: Record<string, unknown>[]; totalRows: number };
type ChartBlock = { type: "chart"; chartType: "timeseries" | "bar"; columns: string[]; rows: Record<string, unknown>[] };
type Block = TableBlock | ChartBlock;

interface Message {
  role: "user" | "assistant";
  content: string;
  sqlQueries?: string[];
  blocks?: Block[];
}

const CHART_COLORS = ["#14b8a6", "#f59e0b", "#8b5cf6", "#22c55e", "#ef4444", "#3b82f6", "#f97316"];
const NON_METRIC = new Set(["year", "month", "date", "node", "fuel_type", "asset_type", "asset_id", "name", "status", "id", "hour_ending", "intertie_or_flowgate"]);

function getNumericCols(cols: string[]) {
  return cols.filter(c => !NON_METRIC.has(c));
}

function buildTsData(columns: string[], rows: Record<string, unknown>[]) {
  return rows.map(row => {
    const period = row.date
      ? String(row.date).slice(0, 7)
      : row.year && row.month
        ? `${row.year}-${String(row.month).padStart(2, "0")}`
        : "—";
    const entry: Record<string, unknown> = { period };
    for (const col of columns) {
      if (col !== "year" && col !== "month" && col !== "date") {
        const v = row[col];
        entry[col] = v !== null && v !== undefined ? Number(v) : null;
      }
    }
    return entry;
  });
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  const n = Number(value);
  if (!isNaN(n) && value !== "" && value !== true && value !== false) {
    return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
  }
  return String(value);
}

function formatCol(col: string) {
  return col.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function DataTable({ block }: { block: TableBlock }) {
  const { columns, rows, totalRows } = block;
  return (
    <div className="mt-3 rounded-lg border border-border overflow-hidden bg-card/80">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
        <TableIcon className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-muted-foreground">
          {rows.length} rows{totalRows > rows.length ? ` (of ${totalRows})` : ""} · {columns.length} columns
        </span>
      </div>
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10">
            <TableRow>
              {columns.map(col => (
                <TableHead key={col} className="text-xs py-2 whitespace-nowrap font-semibold">{formatCol(col)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i} className="hover:bg-primary/5">
                {columns.map(col => (
                  <TableCell key={col} className="text-xs py-1.5 whitespace-nowrap tabular-nums">{formatCell(row[col])}</TableCell>
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

  const data = buildTsData(columns, rows);
  const visibleCols = numericCols.slice(0, 4);

  return (
    <div className="mt-3 rounded-lg border border-border overflow-hidden bg-card/80">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
        <BarChart2 className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-muted-foreground">
          Trend — {visibleCols.map(formatCol).join(", ")}
        </span>
      </div>
      <div className="p-3">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="period"
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} width={48} />
            <Tooltip
              contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", fontSize: 11 }}
              labelStyle={{ color: "#94a3b8", marginBottom: 4 }}
              itemStyle={{ color: "#e2e8f0" }}
              formatter={(v: number | string) => [typeof v === "number" ? v.toFixed(2) : v, ""]}
            />
            {visibleCols.length > 1 && <Legend wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />}
            {visibleCols.map((col, idx) => (
              <Line
                key={col}
                type="monotone"
                dataKey={col}
                name={formatCol(col)}
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

const SUGGESTED = [
  "What was the average Alberta pool price in each month of 2025?",
  "Explain the REM program — how do CFDs work and who has won auctions?",
  "Show me the SMP vs pool price spread — is congestion rent increasing?",
  "What is the MSA's role and what is their most recent publication?",
  "What does the generation mix look like? Break down by fuel type.",
  "What does the AUC regulate and how does micro-generation approval work?",
  "Which fuel type has the most MW in the interconnection queue?",
  "What are the key market power metrics the MSA tracks?",
];

export default function AesoQACopilot() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "I'm the AESO Market Copilot, with full awareness of every tab on this platform.\n\n**Live market data:** Pool prices, generation mix, SMP congestion spreads, supply & demand, operating reserves, interchange flows, and the interconnection queue.\n\n**Regulatory & policy:** REM (Renewable Electricity Market) auctions and CFD mechanics, AUC rules and rate-setting process, MSA market surveillance reports and live document listings.\n\nAsk me anything about Alberta's power market — from the latest pool price trends to how a REM contract works.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sqlStatus, setSqlStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sqlStatus]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setSqlStatus(null);

    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      const response = await fetch("/api/aeso/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok) throw new Error("Request failed");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      let assistantContent = "";
      const sqlQueryLog: string[] = [];
      const pendingBlocks: Block[] = [];

      setMessages(prev => [...prev, { role: "assistant", content: "", sqlQueries: [], blocks: [] }]);

      const updateLast = () => {
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: assistantContent,
            sqlQueries: sqlQueryLog.length > 0 ? [...sqlQueryLog] : undefined,
            blocks: pendingBlocks.length > 0 ? [...pendingBlocks] : undefined,
          };
          return updated;
        });
      };

      const handleEvent = (data: Record<string, unknown>) => {
        if (data.type === "sql_query" && typeof data.rationale === "string") {
          setSqlStatus(data.rationale);
          sqlQueryLog.push(data.rationale);
        } else if (data.type === "sql_done" || data.type === "sql_error") {
          setSqlStatus(null);
        } else if (data.type === "table") {
          pendingBlocks.push({
            type: "table",
            columns: data.columns as string[],
            rows: data.rows as Record<string, unknown>[],
            totalRows: data.totalRows as number,
          });
          updateLast();
        } else if (data.type === "chart") {
          pendingBlocks.push({
            type: "chart",
            chartType: data.chartType as "timeseries" | "bar",
            columns: data.columns as string[],
            rows: data.rows as Record<string, unknown>[],
          });
          updateLast();
        } else if (data.content) {
          assistantContent += data.content as string;
          updateLast();
        } else if (data.error) {
          assistantContent = String(data.error);
          updateLast();
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
            } catch { /* ignore malformed */ }
          }
        }
        if (sseBuffer.trim()) {
          const dataLine = sseBuffer.split("\n").find(l => l.startsWith("data: "));
          if (dataLine) {
            try { handleEvent(JSON.parse(dataLine.slice(6)) as Record<string, unknown>); } catch {}
          }
        }
      }
    } catch {
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: "Sorry, I encountered an error connecting to the AI backend. Please try again." },
      ]);
    } finally {
      setIsLoading(false);
      setSqlStatus(null);
    }
  };

  return (
    <div className="p-8 h-full flex flex-col items-center">
      <div className="w-full max-w-4xl h-full flex flex-col gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <div className="p-2 bg-primary/20 rounded-md">
            <BrainCircuit className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">AESO Market Copilot</h1>
            <p className="text-muted-foreground">
              Natural language Q&amp;A powered by OpenAI + live AESO market data.
            </p>
          </div>
          <Badge
            variant="outline"
            className="ml-auto bg-card"
            style={{ color: "#22c55e", borderColor: "rgba(34,197,94,0.3)" }}
          >
            <Zap className="mr-1 h-3 w-3" style={{ color: "#22c55e" }} /> OpenAI + Live DB
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
                  <div className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[82%] gap-1`}>
                    {msg.role === "assistant" && msg.sqlQueries && msg.sqlQueries.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {msg.sqlQueries.map((q, qi) => (
                          <span
                            key={qi}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                          >
                            <Database className="h-3 w-3" />
                            {q}
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
                          {msg.blocks.map((block, bi) =>
                            block.type === "table"
                              ? <DataTable key={`t-${bi}`} block={block} />
                              : block.type === "chart"
                                ? <DataChart key={`c-${bi}`} block={block} />
                                : null
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {sqlStatus && (
                <div className="flex gap-3">
                  <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-secondary border border-border">
                    <Database className="h-4 w-4 text-primary animate-pulse" />
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl rounded-tl-sm bg-primary/10 border border-primary/20 text-sm text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {sqlStatus}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          <CardFooter className="p-3 border-t bg-card shrink-0">
            <form onSubmit={e => { e.preventDefault(); sendMessage(input); }} className="flex w-full items-center gap-2">
              <Input
                type="text"
                placeholder="Ask about pool prices, generation mix, congestion rent, intertie flows..."
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
          Copilot knows all tabs — pool price · gen mix · SMP congestion · queue · REM · AUC · MSA
        </p>
      </div>
    </div>
  );
}
