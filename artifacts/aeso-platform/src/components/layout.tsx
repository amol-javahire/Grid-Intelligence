import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  DollarSign, 
  Factory, 
  Scale, 
  AlertTriangle, 
  CalendarDays, 
  ListOrdered, 
  Route,
  BrainCircuit,
} from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/pool-price", label: "Pool Price", icon: DollarSign },
  { href: "/generation", label: "Generation Mix", icon: Factory },
  { href: "/supply-demand", label: "Supply & Demand", icon: Scale },
  { href: "/outages", label: "Outages", icon: AlertTriangle },
  { href: "/7day-capacity", label: "7-Day Capacity", icon: CalendarDays },
  { href: "/queue", label: "Queue", icon: ListOrdered },
  { href: "/congestion", label: "Congestion", icon: Route },
  { href: "/qa", label: "Market Copilot", icon: BrainCircuit },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      <aside className="w-64 border-r border-border bg-sidebar shrink-0 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border shrink-0">
          <div className="font-bold text-lg tracking-tight text-sidebar-foreground flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center text-primary-foreground">
              <Zap size={14} className="lucide lucide-zap" />
            </div>
            AESO Analytics
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  isActive 
                    ? "bg-sidebar-primary text-sidebar-primary-foreground" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <item.icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

function Zap(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}
