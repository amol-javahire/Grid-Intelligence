import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, FlaskConical, Info, CheckCircle, XCircle } from "lucide-react";
import {
  ScatterChart, Scatter, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, ReferenceLine, Legend, Cell,
} from "recharts";

const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TS = { backgroundColor:"#0f172a", borderColor:"#1e293b", color:"#f8fafc", fontSize:11 };

type BacktestResult = {
  n: number; testYear: number; trainingPeriod: string; testPeriod: string;
  mae: number; rmse: number; dirAcc: number;
  precision: number; recall: number; f1: number;
  tp: number; fp: number; fn: number;
  nodeMAETop10:    { node:string; mae:number; n:number }[];
  nodeMAEBottom10: { node:string; mae:number; n:number }[];
  byMonth: { month:number; mae:number; n:number }[];
  scatter: { predicted:number; actual:number; nodeType:string }[];
};

const NODE_TYPE_COLOR: Record<string,string> = {
  resource_node:"#14b8a6", hub:"#8b5cf6", load_zone:"#f59e0b",
};

export default function CIBacktest() {
  const { data, isLoading } = useQuery<BacktestResult>({
    queryKey: ["ci","backtest"],
    queryFn:  () => fetch("/api/congestion-intel/backtest").then(r => r.json()),
    staleTime: 600_000,
  });

  if (isLoading) return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Running backtest across all node-month pairs…</p>
      </div>
    </div>
  );

  if (!data || !data.n) return (
    <div className="flex-1 flex items-center justify-center h-full p-8">
      <div className="max-w-md text-center space-y-3">
        <FlaskConical className="h-10 w-10 text-muted-foreground/40 mx-auto" />
        <h2 className="text-base font-semibold">Backtest Unavailable</h2>
        {data ? (
          <>
            <p className="text-sm text-muted-foreground">
              No overlapping nodes found between the training period ({data.trainingPeriod}) and test year ({data.testYear}).
              The backtest requires resource node data for <strong className="text-foreground">both</strong> the training years and the test year.
            </p>
            <p className="text-xs text-muted-foreground/70">
              This environment is missing 2024–2025 resource node data. Once the ERCOT bundle seeder runs and backfills historical months, the backtest will populate automatically.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Could not load backtest data.</p>
        )}
      </div>
    </div>
  );

  const metricColor = (val:number, good:number, bad:number) =>
    val <= good ? "text-emerald-400" : val >= bad ? "text-red-400" : "text-amber-400";

  const dirColor = (val:number) =>
    val >= 70 ? "text-emerald-400" : val >= 50 ? "text-amber-400" : "text-red-400";

  return (
    <div className="p-6 h-full flex flex-col space-y-4">
      {/* Header */}
      <div className="shrink-0">
        <div className="flex items-center gap-3 mb-1">
          <FlaskConical className="h-5 w-5 text-amber-400" />
          <h1 className="text-2xl font-bold">{data.testYear} Backtest — Seasonal Mean Model</h1>
          <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-400">Held-Out Test</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Seasonal mean model trained on {data.trainingPeriod} monthly basis data, evaluated against unseen {data.testPeriod} actuals
        </p>
      </div>

      {/* Model card */}
      <div className="shrink-0 flex items-start gap-2 text-xs text-muted-foreground bg-amber-950/20 border border-amber-800/30 rounded-md px-3 py-2.5">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
        <div>
          <span className="font-semibold text-amber-400">Model trained on {data.trainingPeriod} data and tested against unseen {data.testYear} actuals. </span>
          <span>
            Prediction = mean monthly basis for each node × month combination from {data.trainingPeriod}.
            This is a seasonal mean baseline — the simplest credible benchmark before more complex ML.
            {data.n.toLocaleString()} node-month test pairs across {data.byMonth.length} months of {data.testYear}.
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 shrink-0">
        {[
          { label:"MAE",   val:`$${data.mae}`, unit:"/MWh", color:metricColor(data.mae,3,8), desc:"Mean Absolute Error" },
          { label:"RMSE",  val:`$${data.rmse}`,unit:"/MWh", color:metricColor(data.rmse,5,15), desc:"Root Mean Squared Error" },
          { label:"Dir Acc",val:`${data.dirAcc}%`, unit:"", color:dirColor(data.dirAcc), desc:"Directional accuracy" },
          { label:"Cong F1",val:`${data.f1}%`,  unit:"", color:dirColor(data.f1), desc:"F1 score for |basis|>$10" },
          { label:"Test N", val:data.n.toLocaleString(), unit:"pairs", color:"text-foreground", desc:`${data.byMonth.length} months × nodes` },
        ].map(m => (
          <Card key={m.label}>
            <CardHeader className="pb-1 pt-3 px-4"><CardDescription className="text-xs">{m.label}</CardDescription></CardHeader>
            <CardContent className="pb-3 px-4">
              <div className={`text-2xl font-bold ${m.color}`}>{m.val}<span className="text-sm font-normal text-muted-foreground ml-0.5">{m.unit}</span></div>
              <div className="text-xs text-muted-foreground">{m.desc}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Confusion matrix + month MAE */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
        {/* Confusion matrix */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Congestion Event Detection (|basis| &gt; $10)</CardTitle>
            <CardDescription className="text-xs">Precision {data.precision}% · Recall {data.recall}% · F1 {data.f1}%</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label:"True Positives",  val:data.tp, icon:CheckCircle, color:"text-emerald-400 bg-emerald-950/30 border-emerald-800/30", desc:"Correctly predicted congestion" },
                { label:"False Positives", val:data.fp, icon:XCircle,     color:"text-amber-400 bg-amber-950/30 border-amber-800/30",     desc:"Predicted congestion, was normal" },
                { label:"False Negatives", val:data.fn, icon:XCircle,     color:"text-red-400 bg-red-950/30 border-red-800/30",           desc:"Missed congestion event" },
                { label:"True Negatives",  val:data.n - data.tp - data.fp - data.fn, icon:CheckCircle, color:"text-teal-400 bg-teal-950/30 border-teal-800/30", desc:"Correctly predicted normal" },
              ].map(c => (
                <div key={c.label} className={`border rounded-md px-3 py-2 ${c.color}`}>
                  <div className="flex items-center gap-2">
                    <c.icon className="h-3.5 w-3.5" />
                    <span className="text-xs font-medium">{c.label}</span>
                  </div>
                  <div className="text-2xl font-bold mt-1">{c.val.toLocaleString()}</div>
                  <div className="text-xs opacity-70">{c.desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* MAE by month */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">MAE by Month ({data.testPeriod})</CardTitle>
            <CardDescription className="text-xs">Average absolute prediction error across all nodes per test month</CardDescription>
          </CardHeader>
          <CardContent style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.byMonth.map(m => ({ label: MONTHS[m.month], mae: m.mae, n: m.n }))} margin={{ top:0, right:8, left:0, bottom:0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                <XAxis dataKey="label" stroke="#64748b" tick={{ fill:"#64748b", fontSize:11 }} />
                <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={42} tickFormatter={v=>`$${v}`} />
                <RechartsTooltip contentStyle={TS} formatter={(v:number,n:string,p:any) => [`$${v}/MWh (${p.payload.n} nodes)`, "MAE"]} />
                <Bar dataKey="mae" fill="#f59e0b" isAnimationActive={false} radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Predicted vs actual scatter */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Predicted vs Actual Basis — Scatter Plot ({data.scatter.length.toLocaleString()} points)</CardTitle>
          <CardDescription className="text-xs">Each point = one node × month test pair. Perfect predictions lie on the 45° diagonal.</CardDescription>
        </CardHeader>
        <CardContent style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top:0, right:8, left:0, bottom:0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" />
              <XAxis dataKey="predicted" type="number" name="Predicted" stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} tickFormatter={v=>`$${v}`} label={{ value:"Predicted", fill:"#64748b", fontSize:10, position:"insideBottom", offset:-2 }} />
              <YAxis dataKey="actual" type="number" name="Actual" stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} tickFormatter={v=>`$${v}`} width={42} />
              <ReferenceLine segment={[{x:-80,y:-80},{x:80,y:80}]} stroke="#64748b" strokeDasharray="4 4" label={{ value:"45°", fill:"#64748b", fontSize:9 }} />
              <RechartsTooltip contentStyle={TS} formatter={(v:number,n:string) => [`$${v?.toFixed(2)}/MWh`, n]} />
              <Scatter data={data.scatter} name="Node-month" isAnimationActive={false}>
                {data.scatter.map((s, i) => (
                  <Cell key={i} fill={NODE_TYPE_COLOR[s.nodeType] ?? "#94a3b8"} fillOpacity={0.5} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Top/bottom performers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[
          { title:"Top 10 — Best Forecast Accuracy (lowest MAE)", rows:data.nodeMAETop10, color:"text-emerald-400" },
          { title:"Bottom 10 — Hardest to Forecast (highest MAE)", rows:data.nodeMAEBottom10, color:"text-red-400" },
        ].map(({ title, rows, color }) => (
          <div key={title} className="border border-border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-card border-b border-border text-xs font-semibold text-muted-foreground">{title}</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="px-3 py-1.5 text-left">Node</th>
                  <th className="px-3 py-1.5 text-right">MAE ($/MWh)</th>
                  <th className="px-3 py-1.5 text-right">Months</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.node} className="border-b border-border/30 hover:bg-muted/20">
                    <td className="px-3 py-1.5 font-mono">{r.node}</td>
                    <td className={`px-3 py-1.5 text-right font-bold ${color}`}>${r.mae}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
