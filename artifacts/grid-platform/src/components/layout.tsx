import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3, Map as MapIcon, List, Activity, Zap, Layers, Database,
  MessageSquare, Download, Bookmark, ChevronRight, Menu,
  TerminalSquare, GitBranch, BookOpen, Leaf, Cpu, Flame,
  MapPin, FlaskConical, ShieldCheck, BookMarked, ChevronDown,
  Brain, Clock, Network, Wind, Battery, Thermometer, Calculator,
  Scale, Factory, TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type NavItem = {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

type NavGroup = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  items: NavItem[];
};

type NavEntry = NavItem | { group: NavGroup };

const sidebarEntries: NavEntry[] = [
  { title: "Dashboard",            href: "/",           icon: BarChart3 },
  { title: "Rankings",             href: "/rankings",   icon: List },
  { title: "Map Workspace",        href: "/map",        icon: MapIcon },
  { title: "ERCOT Historical",     href: "/ercot",           icon: Activity },
  { title: "ERCOT Gas & Power",   href: "/ercot-gas",       icon: Flame },
  { title: "ERCOT Dispatch / SCED", href: "/ercot-dispatch", icon: Zap },
  {
    group: {
      label: "CAISO",
      icon: Zap,
      defaultOpen: false,
      items: [
        { title: "Historical (Monthly)", href: "/caiso",        icon: Activity },
        { title: "Hourly Price Data",    href: "/caiso-hourly", icon: Clock },
      ],
    },
  },
  { title: "Nodal Analysis",       href: "/nodal",      icon: Layers },
  { title: "Congestion Analysis",  href: "/congestion", icon: GitBranch },
  {
    group: {
      label: "Congestion Intelligence",
      icon: Cpu,
      defaultOpen: true,
      items: [
        { title: "CI Overview",       href: "/ci",             icon: Flame },
        { title: "Heat Map",          href: "/ci-heatmap",     icon: MapPin },
        { title: "Node Detail",       href: "/ci-node",        icon: Activity },
        { title: "Basis Analyzer",    href: "/ci-basis",       icon: GitBranch },
        { title: "Backtest",          href: "/ci-backtest",    icon: FlaskConical },
        { title: "Data Quality",      href: "/ci-quality",     icon: ShieldCheck },
        { title: "Methodology",       href: "/ci-methodology", icon: BookMarked },
      ],
    },
  },
  {
    group: {
      label: "PyPSA Engine",
      icon: Network,
      defaultOpen: false,
      items: [
        { title: "OPF Network",     href: "/pypsa-network",     icon: Zap },
        { title: "ML Model",        href: "/pypsa-ml",          icon: Brain },
        { title: "Curtailment Sim", href: "/pypsa-curtailment", icon: Wind },
        { title: "TX Relief Sim",   href: "/pypsa-tx-relief",   icon: GitBranch },
        { title: "Scarcity Sim",    href: "/pypsa-scarcity",    icon: Flame },
        { title: "Battery Revenue", href: "/pypsa-battery",     icon: Battery },
        { title: "Capacity Expansion", href: "/pypsa-expansion", icon: Layers },
      ],
    },
  },
  { title: "Interconnection Queue", href: "/queue",        icon: Database },
  { title: "Generator Stack",       href: "/generators",  icon: Factory },
  { title: "EV Charging Load",      href: "/ev-charging", icon: Zap },
  { title: "AI & Datacenters",      href: "/datacenters", icon: Cpu },
  { title: "Regulatory & Tax",      href: "/regulatory",  icon: Scale },
  { title: "Temperature Data",      href: "/weather",     icon: Thermometer },
  { title: "Load Forecast Stress",  href: "/load-forecast-stress", icon: TrendingUp },
  { title: "NPV Calculator",        href: "/ppa",         icon: Calculator },
  { title: "REC Analysis",          href: "/recs",        icon: Leaf },
  { title: "Q&A Copilot",           href: "/qa",         icon: MessageSquare },
  { title: "Export Center",         href: "/export",     icon: Download },
  { title: "Saved Screenings",      href: "/screenings", icon: Bookmark },
  { title: "Platform Guide",        href: "/guide",      icon: BookOpen },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    sidebarEntries.forEach(e => {
      if ("group" in e) init[e.group.label] = e.group.defaultOpen ?? false;
    });
    return init;
  });

  const toggleGroup = (label: string) =>
    setOpenGroups(prev => ({ ...prev, [label]: !prev[label] }));

  const renderItem = (item: NavItem, indent = false) => {
    const isActive = location === item.href;
    return (
      <Link key={item.href} href={item.href}>
        <div
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
            indent && isSidebarOpen && "pl-6",
            isActive
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          )}
          title={!isSidebarOpen ? item.title : undefined}
        >
          <item.icon className="h-4 w-4 shrink-0" />
          {isSidebarOpen && <span>{item.title}</span>}
        </div>
      </Link>
    );
  };

  const renderGroup = (group: NavGroup) => {
    const isOpen = openGroups[group.label] ?? false;
    const hasActive = group.items.some(i => location === i.href);
    return (
      <div key={group.label}>
        <button
          onClick={() => toggleGroup(group.label)}
          className={cn(
            "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            hasActive
              ? "text-primary"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground/90 hover:bg-sidebar-accent"
          )}
          title={!isSidebarOpen ? group.label : undefined}
        >
          <group.icon className="h-4 w-4 shrink-0" />
          {isSidebarOpen && (
            <>
              <span className="flex-1 text-left truncate">{group.label}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform shrink-0", isOpen && "rotate-180")} />
            </>
          )}
        </button>
        {isOpen && isSidebarOpen && (
          <div className="mt-0.5 space-y-0.5">
            {group.items.map(item => renderItem(item, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        className={cn(
          "flex-shrink-0 flex flex-col transition-all duration-300 border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          isSidebarOpen ? "w-64" : "w-16"
        )}
      >
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
            <TerminalSquare className="h-6 w-6 text-primary shrink-0" />
            <span className={cn("font-semibold tracking-tight text-lg transition-opacity", !isSidebarOpen && "opacity-0")}>
              Grid Origination
            </span>
          </div>
        </div>

        <ScrollArea className="flex-1 py-4">
          <nav className="space-y-0.5 px-2">
            {sidebarEntries.map((entry, i) =>
              "group" in entry
                ? renderGroup(entry.group)
                : renderItem(entry)
            )}
          </nav>
        </ScrollArea>

        <div className="p-4 border-t border-sidebar-border">
          <Button
            variant="ghost"
            size="icon"
            className="w-full flex justify-center text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          >
            <ChevronRight className={cn("h-5 w-5 transition-transform", isSidebarOpen && "rotate-180")} />
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 flex items-center px-6 border-b border-border bg-card shrink-0 gap-4 justify-between lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="font-semibold text-sm">Grid Origination Platform</div>
        </header>
        <main className="flex-1 overflow-auto relative bg-background">
          <div className="absolute inset-0 h-full w-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
