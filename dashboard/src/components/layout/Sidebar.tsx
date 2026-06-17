import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
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
  Sparkles,
  Filter,
  ListFilter,
  Plug,
  Layers,
  LogOut,
  X,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useWsStatus } from "@/hooks/useWebSocket";

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
    title: "TOOLS",
    items: [
      { label: "Image Studio", path: "/image-studio", icon: Sparkles },
      { label: "Integration", path: "/integration", icon: Plug },
      { label: "Account Filter", path: "/account-filter", icon: ListFilter },
    ],
  },
  {
    title: "PROXY",
    items: [
      { label: "API Key", path: "/api-key", icon: Key },
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe },
      { label: "VCC Pool", path: "/vcc-pool", icon: CreditCard },
      { label: "Filter Rules", path: "/filter-rules", icon: Filter },
      { label: "Combo Fallback", path: "/combo", icon: Layers },
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

interface SidebarProps {
  onLogout?: () => void;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ onLogout, open, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  useEffect(() => {
    onClose?.();
  }, [location.pathname]);

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--success)", label: "Live" }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "Connecting" }
        : { color: "var(--error)", label: "Offline" };

  return (
    <aside
      className={cn(
        "fixed top-0 left-0 h-screen bg-[var(--sidebar-bg)] border-r border-[var(--sidebar-border)] flex flex-col z-50 transition-all duration-200",
        collapsed ? "w-[64px]" : "w-[240px]",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}
    >
      {/* Logo */}
      <div className={cn(
        "relative p-4 border-b border-[var(--sidebar-border)]",
        collapsed ? "flex items-center justify-center" : "flex items-center justify-between"
      )}>
        <div className="flex items-center gap-2">
          <img src="/etteum.svg" alt="Etteum" className="w-8 h-8 flex-shrink-0" />
          {!collapsed && (
            <div>
              <h1 className="text-sm font-bold text-[var(--foreground)]">Etteum</h1>
              <span className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    backgroundColor: wsMeta.color,
                    boxShadow: `0 0 6px ${wsMeta.color}`,
                  }}
                />
                {wsMeta.label}
              </span>
            </div>
          )}
        </div>
        {onClose && !collapsed && (
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] md:hidden"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Floating toggle button — sits on the right edge of sidebar */}
        <button
          onClick={onToggleCollapse}
          className="hidden md:flex absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 items-center justify-center rounded-md bg-[var(--card)] border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--primary)]/50 transition-colors shadow-sm z-10"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}>
        {navSections.map((section) => (
          <div key={section.title} className="mb-6">
            {!collapsed && (
              <h2 className="text-[10px] font-semibold text-[var(--muted-foreground)] uppercase tracking-wider px-3 mb-2">
                {section.title}
              </h2>
            )}
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-md text-sm transition-colors",
                        collapsed ? "px-2 py-2 justify-center" : "px-3 py-2",
                        isActive
                          ? "bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
                      )
                    }
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    {!collapsed && item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Bottom Settings, Theme & Logout */}
      <div className={cn("p-3 border-t border-[var(--sidebar-border)] space-y-1", collapsed && "px-2")}>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex items-center gap-3 rounded-md text-sm transition-colors text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] w-full",
            collapsed ? "px-2 py-2 justify-center" : "px-3 py-2"
          )}
          aria-label="Toggle theme"
          title={collapsed ? (theme === "dark" ? "Light Mode" : "Dark Mode") : undefined}
        >
          {theme === "dark" ? <Sun className="w-4 h-4 flex-shrink-0" /> : <Moon className="w-4 h-4 flex-shrink-0" />}
          {!collapsed && (theme === "dark" ? "Light Mode" : "Dark Mode")}
        </button>
        {onLogout && (
          <button
            onClick={onLogout}
            className={cn(
              "flex items-center gap-3 rounded-md text-sm transition-colors text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:bg-[var(--destructive)]/10 w-full",
              collapsed ? "px-2 py-2 justify-center" : "px-3 py-2"
            )}
            title={collapsed ? "Logout" : undefined}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            {!collapsed && "Logout"}
          </button>
        )}
      </div>
    </aside>
  );
}
