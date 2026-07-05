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
        <Route path="/qa" component={AesoQACopilot} />
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
