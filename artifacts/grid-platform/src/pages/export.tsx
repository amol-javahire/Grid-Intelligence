import { useState } from "react";
import { useGetTopCandidates, useListCandidates } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Download, FileSpreadsheet, MapPin, Zap, TrendingUp } from "lucide-react";
import { Progress } from "@/components/ui/progress";

export default function ExportCenter() {
  const [objective, setObjective] = useState<any>("lowest_lcoe");
  const { data: topCandidates, isLoading } = useGetTopCandidates({ objective, limit: 10 });
  const { data: allCandidates } = useListCandidates();

  const handleExportAll = () => {
    if (!allCandidates) return;
    
    const headers = ["ID", "Name", "Market", "Asset Type", "Status", "Capacity (MW)", "Estimated LCOE", "Offtake Price", "Overall Score", "Latitude", "Longitude", "County", "State", "Interconnection Node"];
    const rows = allCandidates.map(c => [
      c.id, c.name, c.market, c.assetType, c.status, c.capacityMw, c.estimatedLcoe || '', c.offtakePriceMwh || '', c.overallScore, c.latitude, c.longitude, c.county || '', c.state || '', c.interconnectionNode || ''
    ]);
    
    const csvContent = [
      headers.join(","),
      ...rows.map(r => r.join(","))
    ].join("\n");
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "grid_origination_full_export.csv");
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportTop = () => {
    if (!topCandidates) return;
    
    const headers = ["Name", "Market", "Asset Type", "Capacity (MW)", "Score"];
    const rows = topCandidates.map(c => [
      c.name, c.market, c.assetType, c.capacityMw, c.overallScore
    ]);
    
    const csvContent = [
      headers.join(","),
      ...rows.map(r => r.join(","))
    ].join("\n");
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `top_candidates_${objective}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="p-8 h-full overflow-auto space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Export & Briefing Center</h1>
          <p className="text-muted-foreground">Generate tear sheets and full database exports.</p>
        </div>
        <Button onClick={handleExportAll} className="bg-secondary text-secondary-foreground hover:bg-secondary/80">
          <FileSpreadsheet className="mr-2 h-4 w-4" /> Export Full Database
        </Button>
      </div>

      <div className="flex items-center gap-4 border-b pb-6 border-border">
        <h2 className="text-lg font-semibold shrink-0">Top 10 Candidates Briefing</h2>
        <div className="flex-1" />
        <span className="text-sm text-muted-foreground">Objective Model:</span>
        <Select value={objective} onValueChange={setObjective}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Select objective" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lowest_lcoe">Lowest LCOE</SelectItem>
            <SelectItem value="risk_adjusted_value">Risk-Adjusted Value</SelectItem>
            <SelectItem value="load_hedge">Load Hedge</SelectItem>
            <SelectItem value="decarbonization">Decarbonization Impact</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={handleExportTop}>
          <Download className="mr-2 h-4 w-4" /> Export Top 10
        </Button>
      </div>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : topCandidates && topCandidates.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {topCandidates.map((candidate, idx) => (
            <Card key={candidate.id} className="bg-card border-border flex flex-col hover:border-primary/50 transition-colors">
              <CardHeader className="pb-3 border-b border-border/50">
                <div className="flex justify-between items-start">
                  <div>
                    <Badge variant="outline" className="mb-2 bg-background">Rank #{idx + 1}</Badge>
                    <CardTitle className="text-lg">{candidate.name}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {candidate.county ? `${candidate.county}, ${candidate.state}` : candidate.market}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-primary">{candidate.overallScore.toFixed(1)}</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider">Score</div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4 flex-1">
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1"><Zap className="h-3 w-3" /> Capacity</div>
                    <div className="font-semibold">{candidate.capacityMw} MW</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Est. LCOE</div>
                    <div className="font-semibold">{
                      candidate.estimatedLcoe
                        ? `$${candidate.estimatedLcoe.toFixed(2)}/MWh`
                        : ({solar:39,wind:33,offshore_wind:72,natural_gas:55,nuclear:89,hydro:46,storage:98,geothermal:48} as Record<string,number>)[candidate.assetType]
                          ? `~\$${ ({solar:39,wind:33,offshore_wind:72,natural_gas:55,nuclear:89,hydro:46,storage:98,geothermal:48} as Record<string,number>)[candidate.assetType]}/MWh`
                          : 'N/A'
                    }</div>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Interconnection</span>
                      <span className="font-medium">{candidate.interconnectionScore}/100</span>
                    </div>
                    <Progress value={candidate.interconnectionScore} className="h-1.5" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Financial Viability</span>
                      <span className="font-medium">{candidate.financialScore}/100</span>
                    </div>
                    <Progress value={candidate.financialScore} className="h-1.5" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Location Pricing</span>
                      <span className="font-medium">{candidate.locationScore}/100</span>
                    </div>
                    <Progress value={candidate.locationScore} className="h-1.5" />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 pb-4 px-6 border-t border-border/50 mt-4 flex gap-2">
                <Badge variant="secondary" className="capitalize">{candidate.assetType.replace('_', ' ')}</Badge>
                <Badge variant="outline">{candidate.market}</Badge>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <div className="h-64 flex flex-col items-center justify-center border rounded-md border-dashed">
          <p className="text-muted-foreground mb-2">No top candidates found for this objective.</p>
        </div>
      )}
    </div>
  );
}
