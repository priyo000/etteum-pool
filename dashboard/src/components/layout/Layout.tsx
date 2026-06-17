import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import ModelHealthBadge from "./ModelHealthBadge";
import { Menu } from "lucide-react";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "true" : "false");
    } catch {}
  }, [collapsed]);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />

      <main
        className={
          "h-screen overflow-y-auto p-4 pt-18 md:pt-6 md:p-6 transition-all duration-200 " +
          (collapsed ? "md:ml-[64px]" : "md:ml-[240px]")
        }
      >
        {/* Mobile menu button */}
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-4 left-4 z-30 md:hidden p-2 rounded-md bg-[var(--card)] border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors shadow-md"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Model health badge — fixed top-right, above content, below sidebar */}
        <ModelHealthBadge />

        <Outlet />
      </main>
    </div>
  );
}
