import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Search, Trash2, RefreshCw, RotateCcw } from "lucide-react";
import { formatDateTimeID } from "@/lib/utils";
import {
  deleteAccount,
  fetchAccounts,
  loginAccount,
  loginAccounts,
  warmupAccount,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "kiro" | "codebuddy" | "canva";
type Status = "active" | "exhausted" | "error" | "pending" | "disabled";

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: Status;
  quotaLimit?: number;
  quotaRemaining?: number;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
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

export default function AccountList() {
  const { provider } = useParams<{ provider: string }>();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
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

  function showSuccess(text: string) { setMessage(text); setError(null); setTimeout(() => setMessage(null), 4000); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

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

  const filtered = useMemo(() => {
    return accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
  }, [accounts, search]);

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
          <Button variant="outline" size="sm" onClick={handleWarmupAll} disabled={provider === "canva"}>
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
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Credit</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Last Login</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((account) => (
                  <tr key={account.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50">
                    <td className="p-4 text-sm text-[var(--foreground)]">
                      <div>{account.email}</div>
                      {account.errorMessage && <div className="text-xs text-red-400 mt-1 line-clamp-1" title={account.errorMessage}>{account.errorMessage}</div>}
                    </td>
                    <td className="p-4"><Badge variant={statusVariants[account.status]}>{account.status}</Badge></td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)]">{formatCredit(account.quotaRemaining)}/{formatCredit(account.quotaLimit)}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{formatDate(account.lastLoginAt || account.lastUsedAt)}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => handleWarmup(account.id)} title="WarmUp" disabled={provider === "canva"}>
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
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={5} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No accounts found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
