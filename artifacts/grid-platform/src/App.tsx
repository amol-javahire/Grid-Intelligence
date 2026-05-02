import { Switch, Route, Router as WouterRouter } from "wouter";
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
import QACopilot from "@/pages/qa";
import ExportCenter from "@/pages/export";
import SavedScreenings from "@/pages/screenings";
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
        <Route path="/qa" component={QACopilot} />
        <Route path="/export" component={ExportCenter} />
        <Route path="/screenings" component={SavedScreenings} />
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
