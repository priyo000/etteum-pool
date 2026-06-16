import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle, Pencil, Eye } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import { useSelection } from "@/hooks/useSelection";
import { MultiStatusFilter, type AccountStatus, type EnabledFilter } from "@/components/accounts/MultiStatusFilter";
import { QuotaRangeFilter } from "@/components/accounts/QuotaRangeFilter";
import { BulkActionBar } from "@/components/accounts/BulkActionBar";
import { EditAccountModal, type EditAccountTarget } from "@/components/accounts/EditAccountModal";
import { SavedPresetsBar } from "@/components/accounts/SavedPresetsBar";
import { exportAccountsCSV, exportAccountsJSON } from "@/lib/account-export";
import type { AccountFilterState } from "@/lib/account-presets";
import {
  bulkDeleteAccounts,
  deleteAccount,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  openPanel,
  refreshAccountQuota,
  toggleAccountEnabled,
  toggleAllAccounts,
  warmupAccount,
  warmupAccounts,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder";
type Status = "active" | "exhausted" | "error" | "pending" | "disabled";

interface CodexQuotaWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: string | null;
  reset_after_seconds: number;
}

interface CodexQuotaMetadata {
  plan_type?: string;
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
}

const statusVariants: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

function labelProvider(provider: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider.charAt(0).toUpperCase() + provider.slice(1);
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

function CodexQuotaCell({ codex, fallbackRemaining, fallbackLimit }: { codex?: CodexQuotaMetadata; fallbackRemaining?: number; fallbackLimit?: number }) {
  if (!codex || (!codex.primary && !codex.secondary)) {
    return <span className="text-xs text-[var(--muted-foreground)]">{formatCredit(fallbackRemaining)}/{formatCredit(fallbackLimit)}</span>;
  }
  const renderBar = (label: string, w?: CodexQuotaWindow) => {
    if (!w) return null;
    const used = Math.max(0, Math.min(100, w.used_percent || 0));
    const remaining = 100 - used;
    const tone = remaining <= 10 ? "bg-[var(--error)]" : remaining <= 40 ? "bg-[var(--warning)]" : "bg-[var(--success)]";
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)]">
          <span className="font-medium">{label} ({formatWindow(w.limit_window_seconds)})</span>
          <span>{remaining.toFixed(1)}% left · reset {formatResetIn(w.reset_after_seconds)}</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-[var(--secondary)] overflow-hidden">
          <div className={`h-full ${tone}`} style={{ width: `${remaining}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-1.5 min-w-[200px]">
      {codex.plan_type && <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Plan: {codex.plan_type}{codex.rate_limited && <span className="ml-2 text-[var(--error)]">RATE LIMITED</span>}</div>}
      {renderBar("Session", codex.primary)}
      {renderBar("Weekly", codex.secondary)}
    </div>
  );
}

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
  // Multi-status filter — empty array means "all".
  const [statuses, setStatuses] = useState<AccountStatus[]>([]);
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [quotaMin, setQuotaMin] = useState<number | undefined>(undefined);
  const [quotaMax, setQuotaMax] = useState<number | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Edit modal state
  const [editTarget, setEditTarget] = useState<EditAccountTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // Bulk action busy flag (disables destructive ops while in flight)
  const [bulkBusy, setBulkBusy] = useState(false);

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
      const res = await fetchAccounts() as { data: Account[] };
      setAccounts((res.data || []).filter((a) => a.provider === provider));
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

  /* ── Bulk action handlers ───────────────────────────────────── */

  function selectedIdsOrThrow(): number[] {
    const ids = selection.selectedIds;
    if (ids.length === 0) {
      showError(new Error("No accounts selected"));
      return [];
    }
    return ids;
  }

  async function handleBulkDelete() {
    const ids = selectedIdsOrThrow();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkDeleteAccounts(ids);
      showSuccess(`Deleted ${res.totalDeleted} account${res.totalDeleted === 1 ? "" : "s"}.`);
      selection.clearAll();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkWarmup() {
    const ids = selectedIdsOrThrow();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await warmupAccounts(ids) as any;
      showSuccess(res?.message || `Queued ${ids.length} for warmup.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkLogin() {
    const ids = selectedIdsOrThrow();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await loginAccounts(ids) as any;
      showSuccess(res?.message || `Queued ${ids.length} for login.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkToggle(enabled: boolean) {
    const ids = selectedIdsOrThrow();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      // No bulk-toggle endpoint; iterate. Optimistic UI update.
      setAccounts((prev) => prev.map((a) => ids.includes(a.id) ? { ...a, enabled } : a));
      await Promise.allSettled(ids.map((id) => toggleAccountEnabled(id, enabled)));
      showSuccess(`${enabled ? "Enabled" : "Disabled"} ${ids.length} account${ids.length === 1 ? "" : "s"}.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkRefreshQuota() {
    const ids = selectedIdsOrThrow();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      // No bulk endpoint — fan out (capped concurrency to be polite).
      const limit = 5;
      let i = 0;
      const workers = Array.from({ length: limit }, async () => {
        while (i < ids.length) {
          const id = ids[i++];
          try { await refreshAccountQuota(id); } catch {}
        }
      });
      await Promise.all(workers);
      showSuccess(`Refreshed quota for ${ids.length} account${ids.length === 1 ? "" : "s"}.`);
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  function handleBulkExportCSV() {
    const items = selection.count > 0 ? selection.selectedItems : filtered;
    if (items.length === 0) { showError(new Error("Nothing to export")); return; }
    exportAccountsCSV(items as any, provider || "accounts");
  }

  function handleBulkExportJSON() {
    const items = selection.count > 0 ? selection.selectedItems : filtered;
    if (items.length === 0) { showError(new Error("Nothing to export")); return; }
    exportAccountsJSON(items as any, provider || "accounts");
  }

  /* ── Edit modal ─────────────────────────────────────────────── */

  function openEdit(account: Account) {
    setEditTarget({
      id: account.id,
      email: account.email,
      provider: account.provider,
      status: account.status,
      enabled: account.enabled,
      quotaLimit: account.quotaLimit ?? null,
      quotaRemaining: account.quotaRemaining ?? null,
      errorMessage: account.errorMessage ?? null,
    });
    setEditOpen(true);
  }

  /* ── Preset apply ───────────────────────────────────────────── */

  function applyPreset(state: AccountFilterState) {
    setSearch(state.search ?? "");
    setStatuses((state.statuses as AccountStatus[]) ?? []);
    setEnabledFilter((state.enabledFilter as EnabledFilter) ?? "all");
    setQuotaMin(state.quotaMin);
    setQuotaMax(state.quotaMax);
  }

  const currentFilterState: AccountFilterState = {
    search,
    statuses,
    enabledFilter,
    quotaMin,
    quotaMax,
  };

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statuses.length > 0 && statuses.length < 5) {
      // Empty or full set = no filter; partial = honor it.
      const set = new Set(statuses);
      result = result.filter((a) => set.has(a.status as AccountStatus));
    }
    if (enabledFilter === "enabled") {
      result = result.filter((a) => a.enabled !== false);
    } else if (enabledFilter === "disabled") {
      result = result.filter((a) => a.enabled === false);
    }
    if (quotaMin !== undefined) {
      result = result.filter((a) => (a.quotaRemaining ?? 0) >= quotaMin);
    }
    if (quotaMax !== undefined) {
      result = result.filter((a) => (a.quotaRemaining ?? 0) <= quotaMax);
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
  }, [accounts, search, statuses, enabledFilter, quotaMin, quotaMax, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, provider, statuses, enabledFilter, quotaMin, quotaMax]);

  // Per-status counts for the filter chips.
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AccountStatus | "all", number>> = { all: accounts.length };
    for (const a of accounts) {
      const s = a.status as AccountStatus;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [accounts]);

  // Data range hint for QuotaRangeFilter
  const quotaRange = useMemo(() => {
    if (accounts.length === 0) return { min: undefined, max: undefined };
    let min = Infinity;
    let max = -Infinity;
    for (const a of accounts) {
      const q = a.quotaRemaining ?? 0;
      if (q < min) min = q;
      if (q > max) max = q;
    }
    return { min, max };
  }, [accounts]);

  // Selection hook over the filtered (visible) list
  const selection = useSelection(filtered, (a) => a.id);

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
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Search & Filter */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <MultiStatusFilter
            statuses={statuses}
            onStatusesChange={setStatuses}
            enabledFilter={enabledFilter}
            onEnabledFilterChange={setEnabledFilter}
            counts={statusCounts}
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <QuotaRangeFilter
            min={quotaMin}
            max={quotaMax}
            onChange={({ min, max }) => { setQuotaMin(min); setQuotaMax(max); }}
            dataMin={quotaRange.min}
            dataMax={quotaRange.max}
          />
          <SavedPresetsBar
            scope="per-provider"
            currentState={currentFilterState}
            onApply={applyPreset}
          />
        </div>
      </div>

      {/* Table */}
      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="w-10 p-4">
                    <input
                      type="checkbox"
                      aria-label="Select all visible"
                      checked={selection.allSelected}
                      ref={(el) => { if (el) el.indeterminate = selection.someSelected; }}
                      onChange={selection.toggleAll}
                      className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
                    />
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
                  const isSelected = selection.isSelected(account.id);
                  return (
                  <tr
                    key={account.id}
                    className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 ${isEnabled ? "" : "opacity-50"} ${isSelected ? "bg-[var(--primary)]/5" : ""}`}
                  >
                    <td className="w-10 p-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${account.email}`}
                        checked={isSelected}
                        onChange={() => selection.toggle(account.id)}
                        className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
                      />
                    </td>
                    <td className="p-4 text-sm text-[var(--foreground)]">
                      {account.provider === "canva" ? (
                        <button
                          type="button"
                          onClick={() => navigate(`/accounts/canva/${account.id}`)}
                          className="text-left hover:text-[var(--primary)] hover:underline focus:outline-none focus:text-[var(--primary)]"
                          title="View Canva teams & switch brand"
                        >
                          {account.email}
                        </button>
                      ) : (
                        <div>{account.email}</div>
                      )}
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
                        : <span className="flex items-center gap-1.5">
                            {formatCredit(account.quotaRemaining)}/{formatCredit(account.quotaLimit)}
                            {account.metadata?.overage?.enabled && account.metadata.overage.remaining > 0 && (
                              <Badge variant="success" className="text-[10px] px-1 py-0">
                                PAYG: {Math.round(account.metadata.overage.used)}
                              </Badge>
                            )}
                          </span>}
                    </td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden md:table-cell">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        {account.provider === "canva" && (
                          <Button variant="ghost" size="icon" onClick={() => navigate(`/accounts/canva/${account.id}`)} title="View Canva teams">
                            <Eye className="w-4 h-4 text-[var(--info)]" />
                          </Button>
                        )}
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
                        <Button variant="ghost" size="icon" onClick={() => openEdit(account)} title="Edit">
                          <Pencil className="w-4 h-4 text-[var(--info)]" />
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
      </Card>

      {/* Bulk action bar — sticky bottom, shown when count > 0 */}
      <BulkActionBar
        count={selection.count}
        totalCount={selection.totalCount}
        onClear={selection.clearAll}
        busy={bulkBusy}
        onDelete={handleBulkDelete}
        onWarmup={handleBulkWarmup}
        onLogin={handleBulkLogin}
        onEnable={() => handleBulkToggle(true)}
        onDisable={() => handleBulkToggle(false)}
        onRefreshQuota={handleBulkRefreshQuota}
        onExportCSV={handleBulkExportCSV}
        onExportJSON={handleBulkExportJSON}
      />

      {/* Inline edit modal */}
      <EditAccountModal
        open={editOpen}
        onOpenChange={setEditOpen}
        account={editTarget}
        onSaved={() => { showSuccess(`Account ${editTarget?.email} updated`); load(); }}
        onError={(err) => showError(err)}
      />
    </div>
  );
}
