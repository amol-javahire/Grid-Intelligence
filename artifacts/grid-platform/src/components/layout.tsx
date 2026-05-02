import { useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  BarChart3, 
  Map as MapIcon, 
  List, 
  Activity, 
  Zap, 
  Layers, 
  Database, 
  MessageSquare, 
  Download, 
  Bookmark,
  ChevronRight,
  Menu,
  TerminalSquare,
  GitBranch
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const sidebarNavItems = [
  { title: "Dashboard", href: "/", icon: BarChart3 },
  { title: "Rankings", href: "/rankings", icon: List },
  { title: "Map Workspace", href: "/map", icon: MapIcon },
  { title: "ERCOT Historical", href: "/ercot", icon: Activity },
  { title: "CAISO Historical", href: "/caiso", icon: Zap },
  { title: "PJM Historical", href: "/pjm", icon: Activity },
  { title: "Nodal Analysis", href: "/nodal", icon: Layers },
  { title: "Congestion Analysis", href: "/congestion", icon: GitBranch },
  { title: "Interconnection Queue", href: "/queue", icon: Database },
  { title: "Q&A Copilot", href: "/qa", icon: MessageSquare },
  { title: "Export Center", href: "/export", icon: Download },
  { title: "Saved Screenings", href: "/screenings", icon: Bookmark },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
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
          <nav className="space-y-1 px-2">
            {sidebarNavItems.map((item) => {
              const isActive = location === item.href;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
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
            })}
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

      {/* Main Content */}
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
