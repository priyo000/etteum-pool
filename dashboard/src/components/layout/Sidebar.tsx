import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Cpu,
  Key,
  Settings as SettingsIcon,
  Activity,
  BarChart3,
  Sliders,
  Bot,
  CreditCard,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "ACCOUNTS",
    items: [
      { label: "Dashboard", path: "/", icon: LayoutDashboard },
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
    ],
  },
  {
    title: "PROXY",
    items: [
      { label: "API Key", path: "/api-key", icon: Key },
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe },
      { label: "VCC Pool", path: "/vcc-pool", icon: CreditCard },
      { label: "Proxy Settings", path: "/settings", icon: Sliders },
    ],
  },
  {
    title: "LOGS & ANALYTICS",
    items: [
      { label: "Requests", path: "/requests", icon: Activity },
      { label: "Login Logs", path: "/bot-logs", icon: Bot },
      { label: "Usage", path: "/usage", icon: BarChart3 },
    ],
  },
];

export default function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-screen w-[240px] bg-[var(--sidebar-bg)] border-r border-[var(--sidebar-border)] flex flex-col z-50">
      {/* Logo */}
      <div className="p-6 border-b border-[var(--sidebar-border)]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[var(--primary)] flex items-center justify-center">
            <span className="text-white font-bold text-sm">P</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-[var(--foreground)]">PoolProxy</h1>
            <span className="text-xs text-[var(--muted-foreground)]">v1.0.0</span>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {navSections.map((section) => (
          <div key={section.title} className="mb-6">
            <h2 className="text-[10px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wider px-3 mb-2">
              {section.title}
            </h2>
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                        isActive
                          ? "bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
                      )
                    }
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom Settings */}
      <div className="p-3 border-t border-[var(--sidebar-border)]">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              isActive
                ? "bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
            )
          }
        >
          <SettingsIcon className="w-4 h-4" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
