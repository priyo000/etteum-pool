import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import {
  deleteAccount,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  toggleAccountEnabled,
  warmupAccount,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "zai" | "windsurf" | "moclaw" | "codex";
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
  metadata?: { codex_quota?: CodexQuotaMetadata } | null;
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
    const tone = remaining <= 10 ? "bg-red-500" : remaining <= 40 ? "bg-yellow-500" : "bg-green-500";
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
      {codex.plan_type && <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Plan: {codex.plan_type}{codex.rate_limited && <span className="ml-2 text-red-400">RATE LIMITED</span>}</div>}
      {renderBar("Session", codex.primary)}
      {renderBar("Weekly", codex.secondary)}
    </div>
  );
}

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

  const filtered = useMemo(() => {
    return accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
  }, [accounts, search]);

  useEffect(() => { setPage(1); }, [search, provider]);

  const errorCount = accounts.filter((a) => a.status === "error").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/accounts")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-[var(--foreground)]">{labelProvider(provider || "")}</h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">{accounts.length} accounts</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleWarmupAll}>
            <RefreshCw className="w-4 h-4 mr-2" /> Warmup All
          </Button>
          <Button variant="outline" size="sm" onClick={handleRetryErrors} disabled={errorCount === 0}>
            <RotateCcw className="w-4 h-4 mr-2" /> Retry Errors ({errorCount})
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {message || error}
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
        <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      {/* Table */}
      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Email</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Enabled</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Credit</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Last Login</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * perPage, page * perPage).map((account) => {
                  const isEnabled = account.enabled !== false;
                  return (
                  <tr key={account.id} className={`border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 ${isEnabled ? "" : "opacity-50"}`}>
                    <td className="p-4 text-sm text-[var(--foreground)]">
                      <div>{account.email}</div>
                      {account.errorMessage && <div className="text-xs text-red-400 mt-1 line-clamp-1" title={account.errorMessage}>{account.errorMessage}</div>}
                    </td>
                    <td className="p-4"><Badge variant={statusVariants[account.status]}>{account.status}</Badge></td>
                    <td className="p-4">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        onClick={() => handleToggle(account.id, isEnabled)}
                        title={isEnabled ? "Klik untuk non-aktifkan" : "Klik untuk aktifkan"}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-1 focus:ring-offset-[var(--background)] ${isEnabled ? "bg-green-500" : "bg-[var(--secondary)]"}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)]">
                      {account.provider === "codex"
                        ? <CodexQuotaCell codex={account.metadata?.codex_quota} fallbackRemaining={account.quotaRemaining} fallbackLimit={account.quotaLimit} />
                        : `${formatCredit(account.quotaRemaining)}/${formatCredit(account.quotaLimit)}`}
                    </td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => handleWarmup(account.id)} title="WarmUp">
                          <RefreshCw className="w-4 h-4 text-yellow-400" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleLogin(account.id)} title="Queue login" disabled={account.status !== "pending" && account.status !== "error"}>
                          <RotateCcw className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(account.id)} title="Delete">
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No accounts found</td></tr>
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
    </div>
  );
}
