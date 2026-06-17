import { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchApi } from "@/lib/api";

interface ProviderHealth {
  provider: string;
  active: number;
  total: number;
}

interface ModelsHealthResponse {
  overall: "ok" | "degraded" | "down";
  total_active: number;
  total_accounts: number;
  providers: ProviderHealth[];
}

export default function ModelHealthBadge() {
  const [health, setHealth] = useState<ModelsHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  async function fetchHealth() {
    try {
      const data = await fetchApi<ModelsHealthResponse>("/api/accounts/models/health");
      setHealth(data);
    } catch {
      // silently fail — badge dims
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Close popover on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchHealth();
    setRefreshing(false);
  }

  const overall = health?.overall ?? null;

  const dotColor =
    overall === "ok"
      ? "bg-[var(--success)]"
      : overall === "degraded"
        ? "bg-[var(--warning)]"
        : overall === "down"
          ? "bg-[var(--error)]"
          : "bg-[var(--muted-foreground)] opacity-40";

  const textColor =
    overall === "ok"
      ? "text-[var(--success)]"
      : overall === "degraded"
        ? "text-[var(--warning)]"
        : overall === "down"
          ? "text-[var(--error)]"
          : "text-[var(--muted-foreground)]";

  const label =
    loading
      ? null
      : overall === "ok"
        ? "All OK"
        : overall === "degraded"
          ? `${health!.providers.filter((p) => p.active === 0).length} degraded`
          : overall === "down"
            ? "Down"
            : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Model health status"
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
          "bg-[var(--card)] border border-[var(--border)] shadow-sm",
          "hover:border-[var(--muted-foreground)]/50 transition-colors",
          textColor
        )}
      >
        {/* Dot */}
        <span
          className={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            dotColor,
            overall === "down" && !loading && "animate-pulse"
          )}
        />
        {/* Text */}
        {!loading && label && <span>{label}</span>}
        {loading && <span className="text-[var(--muted-foreground)]">…</span>}
        <Activity className="w-3 h-3 opacity-60" />
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute right-0 top-full mt-2 min-w-[260px] bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-lg p-3 z-50">
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-[var(--foreground)]">
              Model Health
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label="Refresh health"
                className="p-1 rounded hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
              </button>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="p-1 rounded hover:bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Summary */}
          {health && (
            <div className="mb-2 text-xs text-[var(--muted-foreground)]">
              {health.total_active} / {health.total_accounts} accounts active
            </div>
          )}

          {/* Provider table */}
          {health && health.providers.length > 0 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[var(--muted-foreground)]">
                  <th className="text-left pb-1 font-medium">Provider</th>
                  <th className="text-right pb-1 font-medium">Active</th>
                  <th className="text-right pb-1 font-medium">Total</th>
                  <th className="text-right pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {health.providers.map((p) => (
                  <tr key={p.provider} className="text-[var(--foreground)]">
                    <td className="py-1 pr-2 font-mono">{p.provider}</td>
                    <td className="py-1 text-right">{p.active}</td>
                    <td className="py-1 text-right">{p.total}</td>
                    <td className="py-1 text-right">
                      {p.active > 0 ? (
                        <span className="text-[var(--success)]">✓</span>
                      ) : (
                        <span className="text-[var(--error)]">✗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !loading && (
              <div className="text-xs text-[var(--muted-foreground)] py-1">
                No provider data available.
              </div>
            )
          )}

          {loading && (
            <div className="text-xs text-[var(--muted-foreground)] py-1">Loading…</div>
          )}
        </div>
      )}
    </div>
  );
}
