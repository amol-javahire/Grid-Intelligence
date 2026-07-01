import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";

import Home from "@/pages/home";
import Rankings from "@/pages/rankings";
import MapWorkspace from "@/pages/map";
import ErcotHistorical from "@/pages/ercot";
import CaisoHistorical from "@/pages/caiso";
import PjmHistorical from "@/pages/pjm";
import NodalAnalysis from "@/pages/nodal";
import CongestionAnalysis from "@/pages/congestion";
import InterconnectionQueue from "@/pages/queue";
import RECAnalysis from "@/pages/recs";
import QACopilot from "@/pages/qa";
import ExportCenter from "@/pages/export";
import SavedScreenings from "@/pages/screenings";
import PlatformGuide from "@/pages/guide";
import CIOverview from "@/pages/ci-overview";
import CIHeatmap from "@/pages/ci-heatmap";
import CINode from "@/pages/ci-node";
import CIBasis from "@/pages/ci-basis";
import CIBacktest from "@/pages/ci-backtest";
import CIQuality from "@/pages/ci-quality";
import CIMethodology from "@/pages/ci-methodology";
import PypsaNetwork from "@/pages/pypsa-network";
import PypsaML from "@/pages/pypsa-ml";
import PypsaHourly from "@/pages/pypsa-hourly";
import PypsaCurtailment from "@/pages/pypsa-curtailment";
import PypsaTxRelief from "@/pages/pypsa-tx-relief";
import PypsaScarcity from "@/pages/pypsa-scarcity";
import PypsaBattery from "@/pages/pypsa-battery";
import CaisoHourly from "@/pages/caiso-hourly";
import WeatherPage from "@/pages/weather";
import PpaCalculator from "@/pages/ppa-calculator";
import EvChargingPage from "@/pages/ev-charging";
import DatacentersPage from "@/pages/datacenters";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/rankings" component={Rankings} />
        <Route path="/map" component={MapWorkspace} />
        <Route path="/ercot" component={ErcotHistorical} />
        <Route path="/caiso" component={CaisoHistorical} />
        <Route path="/pjm" component={PjmHistorical} />
        <Route path="/nodal" component={NodalAnalysis} />
        <Route path="/congestion" component={CongestionAnalysis} />
        <Route path="/queue" component={InterconnectionQueue} />
        <Route path="/recs" component={RECAnalysis} />
        <Route path="/qa" component={QACopilot} />
        <Route path="/export" component={ExportCenter} />
        <Route path="/screenings" component={SavedScreenings} />
        <Route path="/guide" component={PlatformGuide} />
        <Route path="/ci" component={CIOverview} />
        <Route path="/ci-heatmap" component={CIHeatmap} />
        <Route path="/ci-node" component={CINode} />
        <Route path="/ci-basis" component={CIBasis} />
        <Route path="/ci-backtest" component={CIBacktest} />
        <Route path="/ci-quality" component={CIQuality} />
        <Route path="/ci-methodology" component={CIMethodology} />
        <Route path="/pypsa-network" component={PypsaNetwork} />
        <Route path="/pypsa-ml" component={PypsaML} />
        <Route path="/pypsa-hourly" component={PypsaHourly} />
        <Route path="/pypsa-curtailment" component={PypsaCurtailment} />
        <Route path="/pypsa-tx-relief" component={PypsaTxRelief} />
        <Route path="/pypsa-scarcity" component={PypsaScarcity} />
        <Route path="/pypsa-battery" component={PypsaBattery} />
        <Route path="/caiso-hourly" component={CaisoHourly} />
        <Route path="/weather" component={WeatherPage} />
        <Route path="/ppa" component={PpaCalculator} />
        <Route path="/ev-charging" component={EvChargingPage} />
        <Route path="/datacenters" component={DatacentersPage} />
        {/* Legacy / spec-documented aliases */}
        <Route path="/rec"><Redirect to="/recs" /></Route>
        <Route path="/ci/heatmap"><Redirect to="/ci-heatmap" /></Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
