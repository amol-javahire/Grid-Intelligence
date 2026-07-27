import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import PoolPrice from "@/pages/pool-price";
import Generation from "@/pages/generation";
import SupplyDemand from "@/pages/supply-demand";
import Outages from "@/pages/outages";
import SevenDayCapacity from "@/pages/7day-capacity";
import Queue from "@/pages/queue";
import Congestion from "@/pages/congestion";
import AesoQACopilot from "@/pages/qa";
import LTA from "@/pages/lta";
import REM from "@/pages/rem";
import AUC from "@/pages/auc";
import MSA from "@/pages/msa";
import AesoRankings from "@/pages/rankings";
import NpvCalculator from "@/pages/npv";
import Guide from "@/pages/guide";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/pool-price" component={PoolPrice} />
        <Route path="/generation" component={Generation} />
        <Route path="/supply-demand" component={SupplyDemand} />
        <Route path="/outages" component={Outages} />
        <Route path="/7day-capacity" component={SevenDayCapacity} />
        <Route path="/queue" component={Queue} />
        <Route path="/congestion" component={Congestion} />
        <Route path="/lta" component={LTA} />
        <Route path="/rem" component={REM} />
        <Route path="/auc" component={AUC} />
        <Route path="/msa" component={MSA} />
        <Route path="/rankings" component={AesoRankings} />
        <Route path="/npv" component={NpvCalculator} />
        <Route path="/qa" component={AesoQACopilot} />
        <Route path="/guide" component={Guide} />
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
