import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Trash2,
  RefreshCw,
  Play,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Download,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export interface BulkActionBarProps {
  count: number;
  totalCount?: number;
  onClear: () => void;
  /** Disable all destructive ops while a request is in flight. */
  busy?: boolean;
  onDelete?: () => Promise<void> | void;
  onWarmup?: () => Promise<void> | void;
  onLogin?: () => Promise<void> | void;
  onEnable?: () => Promise<void> | void;
  onDisable?: () => Promise<void> | void;
  onRefreshQuota?: () => Promise<void> | void;
  onExportCSV?: () => void;
  onExportJSON?: () => void;
}

/**
 * Sticky bottom action bar that appears when the user has selected at least
 * one row. Mirrors the gmail/notion-style "X selected" pattern.
 *
 * Destructive actions (delete) trigger an inline two-step confirm to avoid
 * accidental bulk nukes. Other actions fire immediately — they're either
 * idempotent (refresh, warmup) or easily reversed (enable/disable).
 */
export function BulkActionBar({
  count,
  totalCount,
  onClear,
  busy,
  onDelete,
  onWarmup,
  onLogin,
  onEnable,
  onDisable,
  onRefreshQuota,
  onExportCSV,
  onExportJSON,
}: BulkActionBarProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Small delay so the transition is visible
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (count === 0) return null;

  async function handleConfirmDelete() {
    if (!onDelete) return;
    await onDelete();
    setConfirmingDelete(false);
  }

  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[95vw] transition-all duration-200 ${
        mounted ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
      role="region"
      aria-label="Bulk actions"
    >
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] backdrop-blur-sm px-3 py-2 shadow-lg shadow-black/40">
        {/* Counter + clear */}
        <div className="flex items-center gap-2 pr-2">
          <span className="text-sm font-semibold text-[var(--foreground)]">{count}</span>
          <span className="text-xs text-[var(--muted-foreground)]">
            {totalCount !== undefined && totalCount !== count && (
              <span>/ {totalCount} </span>
            )}
            selected
          </span>
          <div className="w-px h-5 bg-[var(--border)] mx-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            className="h-6 w-6 p-0"
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Collapse toggle on small screens */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed((v) => !v)}
          className="h-7 w-7 p-0 sm:hidden"
          aria-label={collapsed ? "Expand actions" : "Collapse actions"}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>

        {/* Action buttons */}
        <div className={`flex flex-wrap items-center gap-1 ${collapsed ? "hidden sm:flex" : ""}`}>
          {onWarmup && (
            <Button variant="outline" size="sm" onClick={() => onWarmup()} disabled={busy} className="h-8">
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Warmup
            </Button>
          )}
          {onLogin && (
            <Button variant="outline" size="sm" onClick={() => onLogin()} disabled={busy} className="h-8">
              <Play className="mr-1 h-3.5 w-3.5" /> Login
            </Button>
          )}
          {onRefreshQuota && (
            <Button variant="outline" size="sm" onClick={() => onRefreshQuota()} disabled={busy} className="h-8">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Quota
            </Button>
          )}
          {onEnable && (
            <Button variant="outline" size="sm" onClick={() => onEnable()} disabled={busy} className="h-8">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-[var(--success)]" /> Enable
            </Button>
          )}
          {onDisable && (
            <Button variant="outline" size="sm" onClick={() => onDisable()} disabled={busy} className="h-8">
              <XCircle className="mr-1 h-3.5 w-3.5 text-[var(--error)]" /> Disable
            </Button>
          )}

          {/* Export dropdown */}
          {(onExportCSV || onExportJSON) && (
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExportOpen((v) => !v)}
                className="h-8"
                aria-label="Export options"
              >
                <Download className="mr-1 h-3.5 w-3.5" />
                Export
                {exportOpen ? <ChevronUp className="ml-1 h-3 w-3" /> : <ChevronDown className="ml-1 h-3 w-3" />}
              </Button>
              {exportOpen && (
                <div className="absolute bottom-full mb-1 right-0 z-10 min-w-[120px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
                  {onExportCSV && (
                    <button
                      type="button"
                      onClick={() => { onExportCSV(); setExportOpen(false); }}
                      className="w-full px-3 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                    >
                      CSV
                    </button>
                  )}
                  {onExportJSON && (
                    <button
                      type="button"
                      onClick={() => { onExportJSON(); setExportOpen(false); }}
                      className="w-full px-3 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                    >
                      JSON
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Delete with 2-step confirm */}
          {onDelete && (
            <div className="flex items-center gap-1">
              {!confirmingDelete ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={busy}
                  className="h-8"
                  aria-label={`Delete ${count} selected accounts`}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                </Button>
              ) : (
                <div className="flex items-center gap-1 rounded-md border border-[var(--error)]/30 bg-[var(--error)]/5 px-2 py-1">
                  <span className="text-xs font-medium text-[var(--muted-foreground)]">
                    Delete {count}?
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleConfirmDelete}
                    disabled={busy}
                    className="h-7 px-2 text-xs text-[var(--error)] hover:bg-[var(--error)]/10"
                    aria-label="Confirm delete"
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                    className="h-7 px-2 text-xs"
                    aria-label="Cancel delete"
                  >
                    No
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
