import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle, CheckSquare, Square, MinusSquare, Flame, Power, LayoutGrid, LayoutList, MoreVertical, Clock } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  deleteAccount,
  deleteAllAccountsByProvider,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  openPanel,
  toggleAccountEnabled,
  toggleAllAccounts,
  warmupAccount,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder" | "byok";
type Status = "active" | "exhausted" | "error" | "pending" | "disabled";

interface CodexQuotaWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: string | null;
  reset_after_seconds: number;
}

interface CodexQuotaMetadata {
  plan_type?: string;
  subscription?: {
    status?: string;
    expires_at?: string | null;
    renews_at?: string | null;
    source_keys?: string[];
  };
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
  rate_limited?: boolean;
}

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: Status;
  enabled?: boolean;
  quotaLimit?: number;
  quotaRemaining?: number;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  metadata?: {
    codex_quota?: CodexQuotaMetadata;
    overage?: { enabled: boolean; capable: boolean; used: number; cap: number; remaining: number } | null;
    inferenceProbe?: string;
  } | null;
  apiKeyPreview?: string;
}

const statusVariants: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

function labelProvider(provider: string) {
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "byok") return "BYOK";
  if (provider === "kiro-pro") return "Kiro Pro";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatCredit(value?: number | null) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "0.0";
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return formatDateTimeID(value);
}

function formatWindow(seconds: number) {
  if (!seconds || seconds <= 0) return "?";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatResetIn(seconds: number) {
  if (!seconds || seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatResetTime(resetAt?: string | null, resetAfterSeconds?: number) {
  // Prefer reset_at (absolute time) for accuracy
  if (resetAt) {
    const d = new Date(resetAt);
    if (!isNaN(d.getTime())) {
      const now = Date.now();
      const diff = d.getTime() - now;
      if (diff <= 0) return { countdown: "now", absolute: null };
      // Show both countdown and absolute time
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const countdown = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      // Format date
      const dateStr = d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
      const timeStr = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
      return { countdown, absolute: `${dateStr}, ${timeStr}` };
    }
  }
  if (resetAfterSeconds && resetAfterSeconds > 0) {
    return { countdown: formatResetIn(resetAfterSeconds), absolute: null };
  }
  return null;
}

function CodexQuotaCell({ codex, fallbackRemaining, fallbackLimit }: { codex?: CodexQuotaMetadata; fallbackRemaining?: number; fallbackLimit?: number }) {
  const hasData = codex && (codex.primary?.used_percent !== undefined || codex.secondary?.used_percent !== undefined);

  const renderBar = (label: string, w?: CodexQuotaWindow) => {
    const used = Math.max(0, Math.min(100, w?.used_percent || 0));
    const remaining = 100 - used;
    const tone = remaining <= 10 ? "bg-[var(--error)]" : remaining <= 40 ? "bg-[var(--warning)]" : "bg-[var(--primary)]";
    const resetInfo = formatResetTime(w?.reset_at, w?.reset_after_seconds);

    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span className="font-medium">{label}</span>
          <span>{remaining.toFixed(1)}% left</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${remaining}%` }} />
        </div>
        {resetInfo ? (
          <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              Reset {resetInfo.countdown}
            </span>
            {resetInfo.absolute && (
              <span className="opacity-70">{resetInfo.absolute}</span>
            )}
          </div>
        ) : !hasData ? (
          <div className="text-[10px] text-[var(--muted-foreground)] opacity-60">Warmup to refresh</div>
        ) : null}
      </div>
    );
  };

  // Determine labels based on window seconds
  const primaryLabel = codex?.primary?.limit_window_seconds === 18000 ? "5 Hour"
    : codex?.primary?.limit_window_seconds ? formatWindow(codex.primary.limit_window_seconds)
    : "5 Hour";
  const secondaryLabel = codex?.secondary?.limit_window_seconds === 604800 ? "Weekly"
    : codex?.secondary?.limit_window_seconds ? formatWindow(codex.secondary.limit_window_seconds)
    : "Weekly";

  return (
    <div className="space-y-2 min-w-[200px]">
      {(codex?.plan_type || codex?.subscription?.status) && (
        <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
          {codex.plan_type && <span>Plan: <span className="text-[var(--foreground)]">{codex.plan_type}</span></span>}
          {codex.subscription?.status && <span className="ml-2">Status: <span className="text-[var(--foreground)]">{codex.subscription.status}</span></span>}
          {codex.rate_limited && <span className="ml-2 text-[var(--error)]">RATE LIMITED</span>}
        </div>
      )}
      {(codex?.subscription?.expires_at || codex?.subscription?.renews_at) && (
        <div className="text-[10px] text-[var(--muted-foreground)] space-y-0.5">
          {codex.subscription?.expires_at && <div>Expires: <span className="text-[var(--foreground)]">{formatDate(codex.subscription.expires_at)}</span></div>}
          {codex.subscription?.renews_at && <div>Renews: <span className="text-[var(--foreground)]">{formatDate(codex.subscription.renews_at)}</span></div>}
        </div>
      )}
      {renderBar(primaryLabel, codex?.primary)}
      {renderBar(secondaryLabel, codex?.secondary)}
    </div>
  );
}

function CreditBar({ remaining, limit, showLabel = true }: { remaining?: number | null; limit?: number | null; showLabel?: boolean }) {
  const rem = Number(remaining ?? 0);
  const lim = Number(limit ?? 0);

  // BYOK/unlimited accounts: show "Unlimited" or "Unknown" instead of -1/-1
  if (lim < 0 || (lim === 0 && rem < 0)) {
    return (
      <div className="space-y-1 min-w-[120px]">
        <div className="text-[10px] text-[var(--muted-foreground)]">
          {rem < 0 ? "Unlimited" : "Unknown"}
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--primary)]/30 overflow-hidden">
          <div className="h-full rounded-full bg-[var(--primary)]" style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  const pct = lim > 0 ? Math.max(0, Math.min(100, (rem / lim) * 100)) : 0;
  const tone = pct <= 10 ? "bg-[var(--error)]" : pct <= 40 ? "bg-[var(--warning)]" : "bg-[var(--primary)]";

  return (
    <div className="space-y-1 min-w-[120px]">
      {showLabel && (
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span>Credits remaining</span>
          <span>{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[10px] text-[var(--muted-foreground)]">
        {formatCredit(remaining)} / {formatCredit(limit)} left
      </div>
    </div>
  );
}

type ViewMode = "list" | "grid";
type SortKey = "email" | "status" | "enabled" | "credit" | "lastLogin";
type SortDir = "asc" | "desc";

export default function AccountList() {
  const { provider } = useParams<{ provider: string }>();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("accountViewMode") as ViewMode) || "list");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1" />
      : <ArrowDown className="w-3 h-3 ml-1" />;
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchAccounts({ provider: provider || undefined }) as { data: Account[] };
      setAccounts(res.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [provider]);

  function showSuccess(text: string) { setTimedMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function handleWarmup(id: number) {
    try { await warmupAccount(id); showSuccess(`WarmUp queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleWarmupAll() {
    try {
      const res = await warmupAllAccounts({ providers: [provider!], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || "WarmUp All queued.");
      await load();
    } catch (err) { showError(err); }
  }

  async function handleLogin(id: number) {
    try { await loginAccount(id); showSuccess(`Login queued #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleOpenPanel(id: number) {
    try { await openPanel(id); showSuccess(`Panel opened #${id}`); } catch (err) { showError(err); }
  }

  async function handleRetryErrors() {
    const ids = accounts.filter((a) => a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} error accounts for retry.`);
    await load();
  }

  async function handleDelete(id: number) {
    if (!confirm(`Delete account #${id}?`)) return;
    try { await deleteAccount(id); showSuccess(`Deleted #${id}`); await load(); } catch (err) { showError(err); }
  }

  async function handleDeleteAllProvider() {
    if (!provider || accounts.length === 0) return;
    const label = labelProvider(provider);
    if (!confirm(`Delete ALL ${accounts.length} ${label} accounts? This cannot be undone.`)) return;
    try {
      const res = await deleteAllAccountsByProvider(provider);
      setSelectedIds(new Set());
      showSuccess(`Deleted ${res.deleted} ${label} accounts.`);
      await load();
    } catch (err) {
      showError(err);
    }
  }

  async function handleToggle(id: number, currentEnabled: boolean) {
    const next = !currentEnabled;
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: next } : a)));
    try {
      await toggleAccountEnabled(id, next);
      showSuccess(next ? `Aktifkan #${id}` : `Non-aktifkan #${id}`);
    } catch (err) {
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: currentEnabled } : a)));
      showError(err);
    }
  }

  async function handleToggleAll(enabled: boolean) {
    if (!provider) return;
    const prev = accounts.map((a) => ({ id: a.id, enabled: a.enabled !== false }));
    setAccounts((prev) => prev.map((a) => ({ ...a, enabled })));
    try {
      const res = await toggleAllAccounts(provider, enabled);
      showSuccess(enabled ? `Aktifkan ${res.count} akun ${labelProvider(provider)}` : `Non-aktifkan ${res.count} akun ${labelProvider(provider)}`);
    } catch (err) {
      setAccounts((list) => list.map((a) => {
        const orig = prev.find((p) => p.id === a.id);
        return orig ? { ...a, enabled: orig.enabled } : a;
      }));
      showError(err);
    }
  }

  // Selection helpers
  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const pageIds = filtered.slice((page - 1) * perPage, page * perPage).map((a) => a.id);
    const allSelected = pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Bulk actions
  async function handleBulkRetry() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await loginAccounts(ids);
      showSuccess(`Queued ${ids.length} accounts for retry.`);
      clearSelection();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkLoading(false); }
  }

  async function handleBulkWarmup() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      for (const id of ids) {
        await warmupAccount(id);
      }
      showSuccess(`WarmUp queued for ${ids.length} accounts.`);
      clearSelection();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkLoading(false); }
  }

  async function handleBulkEnable() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      for (const id of ids) {
        await toggleAccountEnabled(id, true);
      }
      showSuccess(`Enabled ${ids.length} accounts.`);
      clearSelection();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkLoading(false); }
  }

  async function handleBulkDisable() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      for (const id of ids) {
        await toggleAccountEnabled(id, false);
      }
      showSuccess(`Disabled ${ids.length} accounts.`);
      clearSelection();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkLoading(false); }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected accounts? This cannot be undone.`)) return;
    setBulkLoading(true);
    try {
      for (const id of ids) {
        await deleteAccount(id);
      }
      showSuccess(`Deleted ${ids.length} accounts.`);
      clearSelection();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkLoading(false); }
  }

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statusFilter !== "all") {
      result = result.filter((a) => a.status === statusFilter);
    }
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "email":
          cmp = a.email.localeCompare(b.email);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "enabled":
          cmp = (a.enabled === false ? 0 : 1) - (b.enabled === false ? 0 : 1);
          break;
        case "credit":
          cmp = (a.quotaRemaining ?? 0) - (b.quotaRemaining ?? 0);
          break;
        case "lastLogin": {
          const da = new Date(a.lastLoginAt || a.lastUsedAt || 0).getTime();
          const db = new Date(b.lastLoginAt || b.lastUsedAt || 0).getTime();
          cmp = da - db;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [accounts, search, statusFilter, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, provider, statusFilter]);

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const enabledCount = accounts.filter((a) => a.enabled !== false).length;
  const disabledCount = accounts.filter((a) => a.enabled === false).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-[var(--foreground)]">{labelProvider(provider || "")}</h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">{accounts.length} accounts</p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleWarmupAll}>
            <RefreshCw className="w-4 h-4 mr-2" /> Warmup All
          </Button>
          <Button variant="outline" size="sm" onClick={handleRetryErrors} disabled={errorCount === 0}>
            <RotateCcw className="w-4 h-4 mr-2" /> Retry Errors ({errorCount})
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleToggleAll(true)} disabled={disabledCount === 0}>
            <CheckCircle2 className="w-4 h-4 mr-2 text-[var(--success)]" /> Enable All ({disabledCount})
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleToggleAll(false)} disabled={enabledCount === 0}>
            <XCircle className="w-4 h-4 mr-2 text-[var(--error)]" /> Disable All ({enabledCount})
          </Button>
          <Button variant="outline" size="sm" onClick={handleDeleteAllProvider} disabled={accounts.length === 0}>
            <Trash2 className="w-4 h-4 mr-2 text-[var(--error)]" /> Delete All ({accounts.length})
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
          <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* View toggle */}
          <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden mr-1">
            <button
              onClick={() => { setViewMode("list"); localStorage.setItem("accountViewMode", "list"); }}
              className={`p-1.5 transition-colors ${viewMode === "list" ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
              title="List view"
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setViewMode("grid"); localStorage.setItem("accountViewMode", "grid"); }}
              className={`p-1.5 transition-colors ${viewMode === "grid" ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
              title="Grid view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
          {(["all", "active", "exhausted", "error", "pending", "disabled"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                statusFilter === s
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk Action Toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/5 px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--foreground)] mr-1">
            {selectedIds.size} selected
          </span>
          <div className="h-4 w-px bg-[var(--border)]" />
          <Button variant="outline" size="sm" onClick={handleBulkRetry} disabled={bulkLoading}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Retry
          </Button>
          <Button variant="outline" size="sm" onClick={handleBulkWarmup} disabled={bulkLoading}>
            <Flame className="w-3.5 h-3.5 mr-1.5 text-[var(--warning)]" /> Warmup
          </Button>
          <Button variant="outline" size="sm" onClick={handleBulkEnable} disabled={bulkLoading}>
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-[var(--success)]" /> Enable
          </Button>
          <Button variant="outline" size="sm" onClick={handleBulkDisable} disabled={bulkLoading}>
            <XCircle className="w-3.5 h-3.5 mr-1.5 text-[var(--muted-foreground)]" /> Disable
          </Button>
          <div className="h-4 w-px bg-[var(--border)]" />
          <Button variant="outline" size="sm" onClick={handleBulkDelete} disabled={bulkLoading} className="text-[var(--error)] border-[var(--error)]/30 hover:bg-[var(--error)]/10">
            <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkLoading}>
            Clear
          </Button>
        </div>
      )}

      {/* Grid View */}
      {viewMode === "grid" && (
        <div>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.slice((page - 1) * perPage, page * perPage).map((account) => {
              const isEnabled = account.enabled !== false;
              const isSelected = selectedIds.has(account.id);
              return (
                <div
                  key={account.id}
                  className={`rounded-lg border bg-[var(--card)] p-4 space-y-3 transition-colors ${
                    isSelected ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-[var(--border)]"
                  } ${isEnabled ? "" : "opacity-50"}`}
                >
                  {/* Top row: checkbox + email + status + actions */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <button onClick={() => toggleSelect(account.id)} className="mt-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors shrink-0">
                        {isSelected
                          ? <CheckSquare className="w-4 h-4 text-[var(--primary)]" />
                          : <Square className="w-4 h-4" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--foreground)] truncate" title={account.apiKeyPreview || account.email}>
                          {account.email}
                          {account.apiKeyPreview && (
                            <span className="block text-xs font-mono text-[var(--muted-foreground)] truncate mt-0.5" title={account.apiKeyPreview}>
                              {account.apiKeyPreview.slice(0, 12)}...{account.apiKeyPreview.slice(-6)}
                            </span>
                          )}
                        </p>
                        {account.errorMessage && (
                          <p className="text-[10px] text-[var(--error)] mt-0.5 line-clamp-1" title={account.errorMessage}>{account.errorMessage}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge variant={statusVariants[account.status]} className="text-[10px]">{account.status}</Badge>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        onClick={() => handleToggle(account.id, isEnabled)}
                        title={isEnabled ? "Disable" : "Enable"}
                        className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${isEnabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${isEnabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  </div>

                  {/* Info row */}
                  <div className="flex items-center gap-3 text-[10px] text-[var(--muted-foreground)]">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-[var(--primary)]" />
                      {labelProvider(account.provider)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDate(account.lastLoginAt || account.lastUsedAt)}
                    </span>
                  </div>

                  {/* Credit bar */}
                  {account.provider === "codex"
                    ? <CodexQuotaCell codex={account.metadata?.codex_quota} fallbackRemaining={account.quotaRemaining} fallbackLimit={account.quotaLimit} />
                    : <CreditBar remaining={account.quotaRemaining} limit={account.quotaLimit} />}

                  {/* Actions */}
                  <div className="flex items-center gap-1 pt-1 border-t border-[var(--border)]">
                    {(account.provider.startsWith("kiro") || account.provider === "qoder") && (
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleOpenPanel(account.id)} title="Open Panel">
                        <ExternalLink className="w-3.5 h-3.5 text-[var(--info)]" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleWarmup(account.id)} title="WarmUp">
                      <RefreshCw className="w-3.5 h-3.5 text-[var(--warning)]" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleLogin(account.id)} title="Retry login" disabled={account.status !== "pending" && account.status !== "error"}>
                      <RotateCcw className="w-3.5 h-3.5" />
                    </Button>
                    <div className="flex-1" />
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(account.id)} title="Delete">
                      <Trash2 className="w-3.5 h-3.5 text-[var(--error)]" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {!loading && filtered.length === 0 && (
            <div className="p-8 text-center text-sm text-[var(--muted-foreground)]">No accounts found</div>
          )}
          {filtered.length > perPage && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-[var(--muted-foreground)]">
                {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
                <span className="text-xs text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
                <Button variant="outline" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Table (List View) */}
      {viewMode === "list" && <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="w-10 p-4">
                    <button onClick={toggleSelectAll} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors" title="Select all on page">
                      {(() => {
                        const pageIds = filtered.slice((page - 1) * perPage, page * perPage).map((a) => a.id);
                        const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
                        const someSelected = pageIds.some((id) => selectedIds.has(id));
                        if (allSelected) return <CheckSquare className="w-4 h-4 text-[var(--primary)]" />;
                        if (someSelected) return <MinusSquare className="w-4 h-4 text-[var(--primary)]" />;
                        return <Square className="w-4 h-4" />;
                      })()}
                    </button>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("email")}>
                    <span className="inline-flex items-center">Email<SortIcon column="email" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("status")}>
                    <span className="inline-flex items-center">Status<SortIcon column="status" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("enabled")}>
                    <span className="inline-flex items-center">Enabled<SortIcon column="enabled" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)] hidden sm:table-cell" onClick={() => handleSort("credit")}>
                    <span className="inline-flex items-center">Credit<SortIcon column="credit" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 cursor-pointer select-none hover:text-[var(--foreground)] hidden md:table-cell" onClick={() => handleSort("lastLogin")}>
                    <span className="inline-flex items-center">Last Login<SortIcon column="lastLogin" /></span>
                  </th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * perPage, page * perPage).map((account) => {
                  const isEnabled = account.enabled !== false;
                  return (
                  <tr key={account.id} className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 ${isEnabled ? "" : "opacity-50"} ${selectedIds.has(account.id) ? "bg-[var(--primary)]/5" : ""}`}>
                    <td className="w-10 p-4">
                      <button onClick={() => toggleSelect(account.id)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                        {selectedIds.has(account.id)
                          ? <CheckSquare className="w-4 h-4 text-[var(--primary)]" />
                          : <Square className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="p-4 text-sm text-[var(--foreground)]">
                      <div>
                        {account.email}
                        {account.apiKeyPreview && (
                          <div className="text-[10px] font-mono text-[var(--muted-foreground)] truncate mt-0.5" title={account.apiKeyPreview}>
                            {account.apiKeyPreview.slice(0, 12)}...{account.apiKeyPreview.slice(-6)}
                          </div>
                        )}
                      </div>
                      {account.errorMessage && <div className="text-xs text-[var(--error)] mt-1 line-clamp-1" title={account.errorMessage}>{account.errorMessage}</div>}
                    </td>
                    <td className="p-4"><Badge variant={statusVariants[account.status]}>{account.status}</Badge></td>
                    <td className="p-4">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        onClick={() => handleToggle(account.id, isEnabled)}
                        title={isEnabled ? "Klik untuk non-aktifkan" : "Klik untuk aktifkan"}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--background)] ${isEnabled ? "bg-[var(--success)]" : "bg-[var(--secondary)]"}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)] hidden sm:table-cell">
                      {account.provider === "codex"
                        ? <CodexQuotaCell codex={account.metadata?.codex_quota} fallbackRemaining={account.quotaRemaining} fallbackLimit={account.quotaLimit} />
                        : <div className="flex items-center gap-1.5">
                            <CreditBar remaining={account.quotaRemaining} limit={account.quotaLimit} />
                            {account.metadata?.overage?.enabled && account.metadata.overage.remaining > 0 && (
                              <Badge variant="success" className="text-[10px] px-1 py-0">
                                PAYG: {Math.round(account.metadata.overage.used)}
                              </Badge>
                            )}
                          </div>}
                    </td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden md:table-cell">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        {(account.provider.startsWith("kiro") || account.provider === "qoder") && (
                          <Button variant="ghost" size="icon" onClick={() => handleOpenPanel(account.id)} title={`Open ${account.provider === "qoder" ? "Qoder" : "Kiro"} Panel`}>
                            <ExternalLink className="w-4 h-4 text-[var(--info)]" />
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" onClick={() => handleWarmup(account.id)} title="WarmUp">
                          <RefreshCw className="w-4 h-4 text-[var(--warning)]" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleLogin(account.id)} title="Queue login" disabled={account.status !== "pending" && account.status !== "error"}>
                          <RotateCcw className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(account.id)} title="Delete">
                          <Trash2 className="w-4 h-4 text-[var(--error)]" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={7} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No accounts found</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > perPage && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
              <p className="text-xs text-[var(--muted-foreground)]">
                {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
                <span className="text-xs text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
                <Button variant="outline" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}
