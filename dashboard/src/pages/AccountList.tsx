import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle, Pencil, Eye, MoreHorizontal, LogIn, Flame, Users, Play, Loader2, Cpu, FlaskConical, Check } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
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
  clearAccountCooldown,
  deleteAccount,
  fetchAccounts,
  fetchModels,
  loginAccount,
  loginAccounts,
  openPanel,
  refreshAccountQuota,
  testAccount,
  toggleAccountEnabled,
  toggleAllAccounts,
  warmupAccount,
  warmupAccounts,
  warmupAllAccounts,
} from "@/lib/api";

const PROVIDER_PREFIX: Record<string, string> = {
  kiro: "kiro-",
  "kiro-pro": "kp-",
  codebuddy: "cb-",
  canva: "canva-",
  codex: "codex-",
  qoder: "qd-",
};

const PANEL_URLS: Record<string, string> = {
  kiro: "https://app.kiro.dev/settings/account",
  "kiro-pro": "https://app.kiro.dev/settings/account",
  qoder: "https://qoder.com/account/profile",
};

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
  const [statuses, setStatuses] = useState<AccountStatus[]>([]);
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [quotaMin, setQuotaMin] = useState<number | undefined>(undefined);
  const [quotaMax, setQuotaMax] = useState<number | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("email");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [editTarget, setEditTarget] = useState<EditAccountTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  interface ModelInfo { id: string; object: string; created: number; owned_by: string; context_window?: number; max_output?: number; thinking?: boolean; vision?: boolean; }
  const [testModels, setTestModels] = useState<ModelInfo[]>([]);
  const [testModelsLoading, setTestModelsLoading] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { status: "idle" | "testing" | "ok" | "error"; message?: string; latency_ms?: number; diagnosis?: string | null }>>({});

  // Per-account test state (keyed by account.id)
  type AccountTestResult = { status: "idle" | "testing" | "ok" | "error"; latency_ms?: number; diagnosis?: string | null; error?: string };
  const [accountTestResults, setAccountTestResults] = useState<Record<number, AccountTestResult>>({});
  const [testingAllAccounts, setTestingAllAccounts] = useState(false);

  async function loadTestModels() {
    if (!provider) return;
    setTestModelsLoading(true);
    try {
      const res = await fetchModels() as { data: ModelInfo[] };
      const filteredModels = (res.data || []).filter((m) => m.owned_by === provider);
      setTestModels(filteredModels);
    } catch {
      setTestModels([]);
    } finally {
      setTestModelsLoading(false);
    }
  }

  useEffect(() => { loadTestModels(); }, [provider]);

  async function handleTestModel(modelId: string) {
    setTestResults((prev) => ({ ...prev, [modelId]: { status: "testing" } }));
    const account = accounts.find((a) => a.status === "active") ?? accounts[0];
    if (!account) {
      setTestResults((prev) => ({ ...prev, [modelId]: { status: "error", message: "No accounts available" } }));
      return;
    }
    try {
      const res = await testAccount(account.id, modelId);
      if (res.success) {
        setTestResults((prev) => ({ ...prev, [modelId]: { status: "ok", latency_ms: res.latency_ms, diagnosis: res.diagnosis } }));
      } else {
        setTestResults((prev) => ({ ...prev, [modelId]: { status: "error", message: res.error ?? "Failed", latency_ms: res.latency_ms, diagnosis: res.diagnosis } }));
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [modelId]: { status: "error", message: String(err) } }));
    }
  }

  async function handleTestAllModels() {
    for (const m of testModels) {
      await handleTestModel(m.id);
    }
  }

  async function handleTestAccount(accountId: number) {
    setAccountTestResults((prev) => ({ ...prev, [accountId]: { status: "testing" } }));
    try {
      const res = await testAccount(accountId);
      if (res.success) {
        setAccountTestResults((prev) => ({ ...prev, [accountId]: { status: "ok", latency_ms: res.latency_ms, diagnosis: res.diagnosis } }));
      } else {
        setAccountTestResults((prev) => ({ ...prev, [accountId]: { status: "error", latency_ms: res.latency_ms, diagnosis: res.diagnosis, error: res.error ?? "Failed" } }));
      }
    } catch (err) {
      setAccountTestResults((prev) => ({ ...prev, [accountId]: { status: "error", error: String(err) } }));
    }
  }

  async function handleTestAllAccounts() {
    setTestingAllAccounts(true);
    // Reset all results first
    setAccountTestResults({});
    for (const acc of accounts) {
      await handleTestAccount(acc.id);
      // Small delay between tests to avoid hammering
      await new Promise((r) => setTimeout(r, 300));
    }
    setTestingAllAccounts(false);
  }

  const lastSyncRef = useRef<Date | null>(null);
  const [lastSyncDisplay, setLastSyncDisplay] = useState<string>("");

  function updateSyncDisplay() {
    if (!lastSyncRef.current) { setLastSyncDisplay(""); return; }
    const diff = Math.floor((Date.now() - lastSyncRef.current.getTime()) / 1000);
    if (diff < 60) setLastSyncDisplay("just now");
    else if (diff < 3600) setLastSyncDisplay(`${Math.floor(diff / 60)}m ago`);
    else setLastSyncDisplay(`${Math.floor(diff / 3600)}h ago`);
  }

  function showSuccess(msg: string) { setTimedMessage(msg); setError(null); }
  function showError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
    setTimedMessage(null as any);
  }

  async function load() {
    if (!provider) return;
    setLoading(true);
    try {
      const res = await fetchAccounts();
      const data = (res as any).data ?? res;
      setAccounts((data as Account[]).filter((a) => a.provider === provider));
      lastSyncRef.current = new Date();
      updateSyncDisplay();
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [provider]);
  useEffect(() => {
    const id = setInterval(updateSyncDisplay, 30000);
    return () => clearInterval(id);
  }, []);

  useWsEvent("account_updated", (data: any) => {
    if (data.provider !== provider) return;
    setAccounts((prev) => prev.map((a) => a.id === data.id ? { ...a, ...data } : a));
    lastSyncRef.current = new Date();
    updateSyncDisplay();
  });

  async function handleWarmupAll() {
    try { await warmupAllAccounts({ providers: [provider!] }); showSuccess("Warmup triggered for all accounts."); await load(); }
    catch (err) { showError(err); }
  }

  async function handleRetryErrors() {
    const errAccounts = accounts.filter((a) => a.status === "error");
    try {
      await Promise.all(errAccounts.map((a) => clearAccountCooldown(a.id)));
      showSuccess(`Retrying ${errAccounts.length} error account(s).`);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleToggleAll(enable: boolean) {
    try { await toggleAllAccounts(provider!, enable); showSuccess(`${enable ? "Enabled" : "Disabled"} all accounts.`); await load(); }
    catch (err) { showError(err); }
  }

  async function handleToggleEnabled(id: number, enabled: boolean) {
    try { await toggleAccountEnabled(id, enabled); setAccounts((prev) => prev.map((a) => a.id === id ? { ...a, enabled } : a)); }
    catch (err) { showError(err); }
  }

  async function handleWarmup(id: number) {
    try { await warmupAccount(id); showSuccess("Warmup triggered."); await load(); }
    catch (err) { showError(err); }
  }

  async function handleLogin(id: number) {
    try { await loginAccount(id); showSuccess("Login triggered."); await load(); }
    catch (err) { showError(err); }
  }

  async function handleDelete(id: number) {
    try { await deleteAccount(id); setAccounts((prev) => prev.filter((a) => a.id !== id)); showSuccess("Account deleted."); }
    catch (err) { showError(err); }
  }

  async function handleRefreshQuota(id: number) {
    try { await refreshAccountQuota(id); showSuccess("Quota refreshed."); await load(); }
    catch (err) { showError(err); }
  }

  async function handleOpenPanel(id: number) {
    try { await openPanel(id); }
    catch (err) { showError(err); }
  }

  async function handleLoginAll() {
    try { await loginAccounts(accounts.map((a) => a.id)); showSuccess("Login triggered for all accounts."); await load(); }
    catch (err) { showError(err); }
  }

  async function handleBulkDelete() {
    setBulkBusy(true);
    try {
      const ids = selection.selectedItems.map((a) => a.id);
      await bulkDeleteAccounts(ids);
      showSuccess(`Deleted ${ids.length} account(s).`);
      selection.clearAll();
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkWarmup() {
    setBulkBusy(true);
    try {
      const ids = selection.selectedItems.map((a) => a.id);
      await warmupAccounts(ids);
      showSuccess(`Warmup triggered for ${ids.length} account(s).`);
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkLogin() {
    setBulkBusy(true);
    try {
      const ids = selection.selectedItems.map((a) => a.id);
      await loginAccounts(ids);
      showSuccess(`Login triggered for ${ids.length} account(s).`);
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkToggle(enable: boolean) {
    setBulkBusy(true);
    try {
      const ids = selection.selectedItems.map((a) => a.id);
      await Promise.all(ids.map((id) => toggleAccountEnabled(id, enable)));
      showSuccess(`${enable ? "Enabled" : "Disabled"} ${ids.length} account(s).`);
      await load();
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkRefreshQuota() {
    setBulkBusy(true);
    try {
      const ids = selection.selectedItems.map((a) => a.id);
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

  function applyPreset(state: AccountFilterState) {
    setSearch(state.search ?? "");
    setStatuses((state.statuses as AccountStatus[]) ?? []);
    setEnabledFilter((state.enabledFilter as EnabledFilter) ?? "all");
    setQuotaMin(state.quotaMin);
    setQuotaMax(state.quotaMax);
  }

  const currentFilterState: AccountFilterState = { search, statuses, enabledFilter, quotaMin, quotaMax };

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statuses.length > 0 && statuses.length < 5) {
      const set = new Set(statuses);
      result = result.filter((a) => set.has(a.status as AccountStatus));
    }
    if (enabledFilter === "enabled") result = result.filter((a) => a.enabled !== false);
    else if (enabledFilter === "disabled") result = result.filter((a) => a.enabled === false);
    if (quotaMin !== undefined) result = result.filter((a) => (a.quotaRemaining ?? 0) >= quotaMin);
    if (quotaMax !== undefined) result = result.filter((a) => (a.quotaRemaining ?? 0) <= quotaMax);
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "email": cmp = a.email.localeCompare(b.email); break;
        case "status": cmp = a.status.localeCompare(b.status); break;
        case "enabled": cmp = (a.enabled === false ? 0 : 1) - (b.enabled === false ? 0 : 1); break;
        case "credit": cmp = (a.quotaRemaining ?? 0) - (b.quotaRemaining ?? 0); break;
        case "lastLogin": {
          const da = new Date(a.lastLoginAt || a.lastUsedAt || 0).getTime();
          const db = new Date(b.lastLoginAt || b.lastUsedAt || 0).getTime();
          cmp = da - db; break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [accounts, search, statuses, enabledFilter, quotaMin, quotaMax, sortKey, sortDir]);

  useEffect(() => { setPage(1); }, [search, provider, statuses, enabledFilter, quotaMin, quotaMax]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AccountStatus | "all", number>> = { all: accounts.length };
    for (const a of accounts) {
      const s = a.status as AccountStatus;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [accounts]);

  const quotaRange = useMemo(() => {
    if (accounts.length === 0) return { min: undefined, max: undefined };
    let min = Infinity; let max = -Infinity;
    for (const a of accounts) { const q = a.quotaRemaining ?? 0; if (q < min) min = q; if (q > max) max = q; }
    return { min, max };
  }, [accounts]);

  const selection = useSelection(filtered, (a) => a.id);

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const enabledCount = accounts.filter((a) => a.enabled !== false).length;
  const disabledCount = accounts.filter((a) => a.enabled === false).length;

  // Stats rail computed values
  const stats = useMemo(() => ({
    active: accounts.filter((a) => a.status === "active" && a.enabled !== false).length,
    exhausted: accounts.filter((a) => a.status === "exhausted").length,
    error: accounts.filter((a) => a.status === "error").length,
    pending: accounts.filter((a) => a.status === "pending").length,
  }), [accounts]);

  function toggleStatPill(s: AccountStatus) {
    if (statuses.includes(s)) {
      setStatuses(statuses.filter((x) => x !== s));
    } else {
      setStatuses([...statuses, s]);
    }
  }

  function resetFilters() {
    setSearch(""); setStatuses([]); setEnabledFilter("all"); setQuotaMin(undefined); setQuotaMax(undefined);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3 ml-1 text-[var(--primary)]" /> : <ArrowDown className="w-3 h-3 ml-1 text-[var(--primary)]" />;
  }

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  // Test models summary
  const testSummary = useMemo(() => {
    const results = Object.values(testResults);
    const ran = results.filter((r) => r.status === "ok" || r.status === "error");
    if (ran.length === 0) return null;
    const passed = results.filter((r) => r.status === "ok").length;
    const failed = results.filter((r) => r.status === "error").length;
    const latencies = results.filter((r) => r.latency_ms != null).map((r) => r.latency_ms!);
    const avgMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    return { passed, failed, avgMs };
  }, [testResults]);

  return (
    <div className="space-y-5 p-4 md:p-6 max-w-screen-2xl mx-auto">

      {/* ── 2. HEADER ────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")} aria-label="Back to accounts">
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-[var(--foreground)]">{labelProvider(provider || "")}</h1>
              <Badge variant="outline" className="font-mono text-xs">{accounts.length}</Badge>
              <Badge variant="secondary" className="text-xs">{provider}</Badge>
            </div>
            <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
              {accounts.length} accounts{lastSyncDisplay ? ` · Last synced ${lastSyncDisplay}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={handleWarmupAll}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Warmup All
          </Button>
          <Button variant="outline" size="sm" onClick={handleLoginAll}>
            <LogIn className="w-3.5 h-3.5 mr-1.5" />
            Login All
          </Button>
          <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Refresh accounts">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="default" size="sm" onClick={() => { const el = document.getElementById("test-models-section"); el?.scrollIntoView({ behavior: "smooth" }); }}>
            <FlaskConical className="w-3.5 h-3.5 mr-1.5" />
            Test Models
          </Button>
          <Button variant="outline" size="sm" onClick={handleTestAllAccounts} disabled={testingAllAccounts || accounts.length === 0}>
            {testingAllAccounts ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1.5" />}
            {testingAllAccounts ? `Testing… ${Object.values(accountTestResults).filter(r => r.status !== "idle").length}/${accounts.length}` : "Test All Accounts"}
          </Button>
        </div>
      </div>

      {/* ── MESSAGES ─────────────────────────────────────────────── */}
      {(message || error) && (
        <div className={`rounded-md px-4 py-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20" : "bg-[var(--error)]/10 text-[var(--error)] border border-[var(--error)]/20"}`}>
          {message || error}
        </div>
      )}

      {/* ── 3. STATS RAIL ────────────────────────────────────────── */}
      {accounts.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { key: "active" as AccountStatus, label: "Active", count: stats.active, color: "var(--success)" },
            { key: "exhausted" as AccountStatus, label: "Exhausted", count: stats.exhausted, color: "var(--warning)" },
            { key: "error" as AccountStatus, label: "Error", count: stats.error, color: "var(--error)" },
            { key: "pending" as AccountStatus, label: "Pending", count: stats.pending, color: "var(--muted-foreground)" },
          ] as const).map(({ key, label, count, color }) => {
            const isActive = statuses.includes(key);
            return (
              <button
                key={key}
                onClick={() => toggleStatPill(key)}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--card)] border transition-colors duration-150 text-left",
                  isActive ? "border-[var(--primary)]/60 bg-[var(--primary)]/5" : "border-[var(--border)] hover:border-[var(--primary)]/40"
                )}
                aria-pressed={isActive}
                aria-label={`Filter by ${label}`}
              >
                <div className="w-0.5 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                <div>
                  <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">{label}</p>
                  <p className="text-2xl font-bold text-[var(--foreground)] tabular-nums leading-tight">{count}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* ── 4. FILTER BAR ────────────────────────────────────────── */}
      <Card className="border-[var(--border)]">
        <CardContent className="p-4">
          {/* Row 1 */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
              <Input
                placeholder="Search accounts..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <MultiStatusFilter
              statuses={statuses}
              onStatusesChange={setStatuses}
              enabledFilter={enabledFilter}
              onEnabledFilterChange={setEnabledFilter}
              counts={statusCounts}
            />
            <SavedPresetsBar
              scope={provider as any}
              currentState={currentFilterState}
              onApply={applyPreset}
            />
          </div>

          {/* Row 2 */}
          <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-[var(--border)]">
            <QuotaRangeFilter
              min={quotaMin}
              max={quotaMax}
              onChange={({ min, max }) => { setQuotaMin(min); setQuotaMax(max); }}
              dataMin={quotaRange.min}
              dataMax={quotaRange.max}
            />
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Sort</span>
              {(["email", "status", "credit", "lastLogin"] as SortKey[]).map((col) => (
                <button
                  key={col}
                  onClick={() => toggleSort(col)}
                  className={cn(
                    "flex items-center px-2.5 py-1 text-xs rounded-md border transition-colors",
                    sortKey === col
                      ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                      : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                  )}
                >
                  {col === "email" ? "Email" : col === "status" ? "Status" : col === "credit" ? "Quota" : "Login"}
                  {sortKey === col && (
                    sortDir === "asc"
                      ? <ArrowUp className="w-3 h-3 ml-1 text-[var(--primary)]" />
                      : <ArrowDown className="w-3 h-3 ml-1 text-[var(--primary)]" />
                  )}
                </button>
              ))}
              {(search || statuses.length > 0 || enabledFilter !== "all" || quotaMin !== undefined || quotaMax !== undefined) && (
                <Button variant="ghost" size="sm" onClick={resetFilters} className="h-7 px-2 text-xs text-[var(--muted-foreground)]">
                  <RotateCcw className="w-3 h-3 mr-1" /> Reset
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 5 & 6. TABLE ─────────────────────────────────────────── */}
      <Card className="border-[var(--border)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--card)] border-b-2 border-[var(--border)]">
                <th className="px-4 py-3 w-10">
                  <button
                    onClick={selection.allSelected ? selection.clearAll : selection.selectAll}
                    className={cn(
                      "w-4 h-4 rounded-sm border flex items-center justify-center transition-colors",
                      selection.allSelected
                        ? "bg-[var(--primary)] border-[var(--primary)]"
                        : "border-[var(--border)] hover:border-[var(--primary)]/60"
                    )}
                    aria-label={selection.allSelected ? "Deselect all" : "Select all"}
                  >
                    {selection.allSelected && <Check className="w-3 h-3 text-[var(--primary-foreground)]" />}
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">
                  <button onClick={() => toggleSort("email")} className="flex items-center cursor-pointer hover:text-[var(--foreground)] transition-colors select-none">
                    Email <SortIcon col="email" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">
                  <button onClick={() => toggleSort("status")} className="flex items-center cursor-pointer hover:text-[var(--foreground)] transition-colors select-none">
                    Status <SortIcon col="status" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">
                  <button onClick={() => toggleSort("enabled")} className="flex items-center cursor-pointer hover:text-[var(--foreground)] transition-colors select-none">
                    Enabled <SortIcon col="enabled" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">
                  <button onClick={() => toggleSort("credit")} className="flex items-center cursor-pointer hover:text-[var(--foreground)] transition-colors select-none">
                    Quota <SortIcon col="credit" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">
                  <button onClick={() => toggleSort("lastLogin")} className="flex items-center cursor-pointer hover:text-[var(--foreground)] transition-colors select-none">
                    Last Login <SortIcon col="lastLogin" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs text-[var(--muted-foreground)] uppercase tracking-wide font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {/* Loading skeleton */}
              {loading && accounts.length === 0 && (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="px-4 py-3">
                      <div className="flex items-center gap-4 animate-pulse">
                        <div className="w-4 h-4 rounded-sm bg-[var(--muted)]" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-3 bg-[var(--muted)] rounded w-48" />
                          <div className="h-2 bg-[var(--muted)]/60 rounded w-32" />
                        </div>
                        <div className="h-5 w-16 bg-[var(--muted)] rounded-full" />
                        <div className="h-6 w-20 bg-[var(--muted)] rounded" />
                        <div className="h-3 w-24 bg-[var(--muted)] rounded" />
                      </div>
                    </td>
                  </tr>
                ))
              )}

              {/* No accounts */}
              {!loading && accounts.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="py-16 text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--primary)]/10 border border-[var(--primary)]/20 mb-4">
                        <Users className="w-5 h-5 text-[var(--primary)]" />
                      </div>
                      <p className="text-sm font-medium text-[var(--foreground)] mb-1">No accounts yet</p>
                      <p className="text-xs text-[var(--muted-foreground)]">Add accounts via the API or CLI to get started</p>
                    </div>
                  </td>
                </tr>
              )}

              {/* No filter results */}
              {!loading && accounts.length > 0 && filtered.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="py-16 text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--muted)] mb-4">
                        <Search className="w-5 h-5 text-[var(--muted-foreground)]" />
                      </div>
                      <p className="text-sm font-medium text-[var(--foreground)] mb-1">No accounts match</p>
                      <p className="text-xs text-[var(--muted-foreground)] mb-4">Try adjusting your filters or search term</p>
                      <Button variant="outline" size="sm" onClick={resetFilters}>Clear filters</Button>
                    </div>
                  </td>
                </tr>
              )}

              {/* Data rows */}
              {paginated.map((account) => {
                const isSelected = selection.isSelected(account.id);
                const pct = (account.quotaLimit ?? 0) > 0
                  ? Math.min(100, Math.round(((account.quotaRemaining ?? 0) / account.quotaLimit!) * 100))
                  : 0;
                const barColor = pct > 50 ? "var(--success)" : pct > 20 ? "var(--warning)" : "var(--error)";

                return (
                  <tr
                    key={account.id}
                    className={cn(
                      "transition-colors duration-150",
                      isSelected
                        ? "bg-[var(--primary)]/10 border-l-2 border-[var(--primary)]"
                        : "hover:bg-[var(--secondary)]/50"
                    )}
                  >
                    {/* Checkbox */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => selection.toggle(account.id)}
                        className={cn(
                          "w-4 h-4 rounded-sm border flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-[var(--primary)] border-[var(--primary)]"
                            : "border-[var(--border)] hover:border-[var(--primary)]/60"
                        )}
                        aria-label={`${isSelected ? "Deselect" : "Select"} ${account.email}`}
                      >
                        {isSelected && <Check className="w-3 h-3 text-[var(--primary-foreground)]" />}
                      </button>
                    </td>

                    {/* Email */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-[var(--foreground)]">{account.email}</span>
                        {account.metadata?.inferenceProbe === "warmup" && (
                          <Flame className="w-3 h-3 text-[var(--warning)] flex-shrink-0" />
                        )}
                      </div>
                      <Badge variant="outline" className="text-[10px] mt-0.5">{account.provider}</Badge>
                    </td>

                    {/* Status */}
                     <td className="px-4 py-3">
                       <Badge variant={statusVariants[account.status] ?? "secondary"}>
                         {account.status}
                       </Badge>
                       {account.status === "error" && account.errorMessage && (
                         <p className="text-[10px] text-[var(--error)]/80 mt-0.5 max-w-[180px] truncate">
                           {account.errorMessage}
                         </p>
                       )}
                       {/* Per-account test result inline */}
                       {(() => {
                         const tr = accountTestResults[account.id];
                         if (!tr) return null;
                         if (tr.status === "testing") return (
                           <div className="flex items-center gap-1 mt-1">
                             <Loader2 className="w-3 h-3 animate-spin text-[var(--muted-foreground)]" />
                             <span className="text-[10px] text-[var(--muted-foreground)]">Testing…</span>
                           </div>
                         );
                         if (tr.status === "ok") return (
                           <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                             <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] flex-shrink-0" />
                             <span className="text-[10px] text-[var(--success)] font-medium">OK</span>
                             {tr.latency_ms != null && (
                               <span className="text-[10px] font-mono text-[var(--muted-foreground)] bg-[var(--muted)] px-1 rounded">{tr.latency_ms}ms</span>
                             )}
                           </div>
                         );
                         if (tr.status === "error") return (
                           <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                             <span className="w-1.5 h-1.5 rounded-full bg-[var(--error)] flex-shrink-0" />
                             {tr.diagnosis ? (
                               <Badge variant="error" className="text-[10px] px-1 py-0 h-4">{tr.diagnosis}</Badge>
                             ) : (
                               <span className="text-[10px] text-[var(--error)] font-medium">Failed</span>
                             )}
                             {tr.latency_ms != null && (
                               <span className="text-[10px] font-mono text-[var(--muted-foreground)] bg-[var(--muted)] px-1 rounded">{tr.latency_ms}ms</span>
                             )}
                           </div>
                         );
                         return null;
                       })()}
                     </td>

                    {/* Enabled toggle */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggleEnabled(account.id, !account.enabled)}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-colors",
                          account.enabled !== false
                            ? "bg-[var(--success)]/15 text-[var(--success)] hover:bg-[var(--success)]/25"
                            : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--muted-foreground)]/20"
                        )}
                        title={account.enabled !== false ? "Click to disable" : "Click to enable"}
                      >
                        {account.enabled !== false
                          ? <CheckCircle2 className="w-3 h-3" />
                          : <XCircle className="w-3 h-3" />
                        }
                        {account.enabled !== false ? "On" : "Off"}
                      </button>
                    </td>

                    {/* Quota */}
                    <td className="px-4 py-3">
                      {provider === "codex" && account.metadata?.codex_quota ? (
                        <CodexQuotaCell
                          codex={account.metadata.codex_quota}
                          fallbackRemaining={account.quotaRemaining}
                          fallbackLimit={account.quotaLimit}
                        />
                      ) : (
                        <div>
                          <span className="text-xs font-mono text-[var(--foreground)]">
                            {account.quotaRemaining?.toLocaleString() ?? "—"}
                            <span className="text-[var(--muted-foreground)]"> / {account.quotaLimit?.toLocaleString() ?? "—"}</span>
                          </span>
                          {(account.quotaLimit ?? 0) > 0 && (
                            <div className="mt-1 h-1 w-full rounded-full bg-[var(--muted)]">
                              <div
                                className="h-1 rounded-full transition-all"
                                style={{ width: `${pct}%`, backgroundColor: barColor }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Last login */}
                    <td className="px-4 py-3">
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {formatDate(account.lastLoginAt || account.lastUsedAt)}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${account.email}`}>
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel className="text-xs text-[var(--muted-foreground)]">Account actions</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openEdit(account)}>
                            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleWarmup(account.id)}>
                            <RefreshCw className="w-3.5 h-3.5 mr-2" /> Warmup
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleLogin(account.id)}>
                            <LogIn className="w-3.5 h-3.5 mr-2" /> Login
                          </DropdownMenuItem>
                           <DropdownMenuItem onClick={() => handleRefreshQuota(account.id)}>
                             <RotateCcw className="w-3.5 h-3.5 mr-2" /> Refresh Quota
                           </DropdownMenuItem>
                           <DropdownMenuItem onClick={() => handleTestAccount(account.id)} disabled={accountTestResults[account.id]?.status === "testing"}>
                             <FlaskConical className="w-3.5 h-3.5 mr-2" />
                             {accountTestResults[account.id]?.status === "testing" ? "Testing…" : "Test Account"}
                           </DropdownMenuItem>
                          {PANEL_URLS[provider ?? ""] && (
                            <DropdownMenuItem onClick={() => handleOpenPanel(account.id)}>
                              <ExternalLink className="w-3.5 h-3.5 mr-2" /> Open Panel
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleDelete(account.id)}
                            className="text-[var(--error)] focus:text-[var(--error)]"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)]">
            <span className="text-xs text-[var(--muted-foreground)]">
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="h-7 px-2 text-xs">
                ← Prev
              </Button>
              <span className="text-xs text-[var(--muted-foreground)] px-1">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="h-7 px-2 text-xs">
                Next →
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── 8. TEST MODELS ───────────────────────────────────────── */}
      {testModels.length > 0 && (
        <Card className="border-[var(--border)]" id="test-models-section">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-[var(--primary)]" />
                  Test Models
                  {testModelsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--muted-foreground)]" />}
                </CardTitle>
                {testSummary && (
                  <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
                    <span className="text-[var(--success)]">{testSummary.passed} passed</span>
                    {" · "}
                    <span className="text-[var(--error)]">{testSummary.failed} failed</span>
                    {testSummary.avgMs != null && ` · avg ${testSummary.avgMs}ms`}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handleTestAllModels} disabled={testModelsLoading}>
                <Play className="w-3 h-3 mr-1" /> Run All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {testModels.map((model) => {
                const result = testResults[model.id];
                const status = result?.status ?? "idle";
                const dotColor =
                  status === "ok" ? "var(--success)"
                  : status === "error" ? "var(--error)"
                  : status === "testing" ? "var(--warning)"
                  : "var(--muted-foreground)";
                const cardCls = cn(
                  "rounded-lg border p-3 flex items-center justify-between gap-3 transition-colors",
                  status === "ok" ? "bg-[var(--success)]/5 border-[var(--success)]/20"
                  : status === "error" ? "bg-[var(--error)]/5 border-[var(--error)]/20"
                  : "bg-[var(--card)] border-[var(--border)]"
                );
                return (
                  <div key={model.id} className={cardCls}>
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-[var(--foreground)] font-medium truncate">{model.id}</p>
                        {result?.message && (
                          <p className="text-[10px] text-[var(--muted-foreground)] truncate">{result.message}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {result?.latency_ms != null && (
                        <span className="text-[10px] text-[var(--muted-foreground)] font-mono">{result.latency_ms}ms</span>
                      )}
                      {result?.diagnosis != null && (() => {
                        const d = result.diagnosis;
                        const variant: "error" | "warning" = d === "429" || d === "RUNTIME" ? "warning" : "error";
                        return <Badge variant={variant} className="text-[10px]">{d}</Badge>;
                      })()}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={status === "testing"}
                        onClick={() => handleTestModel(model.id)}
                        className="h-7 px-2"
                      >
                        {status === "testing"
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Play className="w-3 h-3" />
                        }
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── BULK ACTION BAR ──────────────────────────────────────── */}
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

      {/* ── EDIT MODAL ───────────────────────────────────────────── */}
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

