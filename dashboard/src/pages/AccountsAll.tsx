import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Search,
  RefreshCw,
  Trash2,
  Pencil,
  ExternalLink,
} from "lucide-react";
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
  loginAccounts,
  refreshAccountQuota,
  toggleAccountEnabled,
  warmupAccounts,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder";

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: AccountStatus;
  enabled?: boolean;
  quotaLimit?: number;
  quotaRemaining?: number;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
}

const ALL_PROVIDERS: readonly Provider[] = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"];

const STATUS_VARIANT: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

function labelProvider(p: string) {
  if (p === "kiro-pro") return "Kiro Pro";
  if (p === "codebuddy") return "CodeBuddy";
  return p[0].toUpperCase() + p.slice(1);
}

function formatCredit(value?: number | null) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

/**
 * Cross-provider global account table. Same filter/select/bulk capabilities
 * as the per-provider AccountList, with an extra Provider filter chip group
 * and a Provider column. Useful when the user wants to operate on accounts
 * across all providers at once (e.g. "delete every exhausted account").
 */
export default function AccountsAll() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<AccountStatus[]>([]);
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [quotaMin, setQuotaMin] = useState<number | undefined>(undefined);
  const [quotaMax, setQuotaMax] = useState<number | undefined>(undefined);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [page, setPage] = useState(1);
  const perPage = 25;

  const { message, setMessage: setTimedMessage, clearMessage } = useTimedMessage<string>(null, 4000);
  const [error, setError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<EditAccountTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  function showSuccess(text: string) { setTimedMessage(text); setError(null); }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); clearMessage(); }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchAccounts() as { data: Account[] };
      setAccounts(res.data || []);
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Reload on key WS events
  useWsEvent(["account_status", "account_updated", "account_deleted"], () => {
    load();
  });

  const filtered = useMemo(() => {
    let result = accounts.filter((a) => a.email.toLowerCase().includes(search.toLowerCase()));
    if (statuses.length > 0 && statuses.length < 5) {
      const set = new Set(statuses);
      result = result.filter((a) => set.has(a.status));
    }
    if (providers.length > 0 && providers.length < ALL_PROVIDERS.length) {
      const set = new Set(providers);
      result = result.filter((a) => set.has(a.provider));
    }
    if (enabledFilter === "enabled") result = result.filter((a) => a.enabled !== false);
    else if (enabledFilter === "disabled") result = result.filter((a) => a.enabled === false);
    if (quotaMin !== undefined) result = result.filter((a) => (a.quotaRemaining ?? 0) >= quotaMin);
    if (quotaMax !== undefined) result = result.filter((a) => (a.quotaRemaining ?? 0) <= quotaMax);
    result.sort((a, b) => a.email.localeCompare(b.email));
    return result;
  }, [accounts, search, statuses, providers, enabledFilter, quotaMin, quotaMax]);

  useEffect(() => { setPage(1); }, [search, statuses, providers, enabledFilter, quotaMin, quotaMax]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AccountStatus | "all", number>> = { all: accounts.length };
    for (const a of accounts) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return counts;
  }, [accounts]);

  const quotaRange = useMemo(() => {
    if (accounts.length === 0) return { min: undefined, max: undefined };
    let min = Infinity, max = -Infinity;
    for (const a of accounts) {
      const q = a.quotaRemaining ?? 0;
      if (q < min) min = q;
      if (q > max) max = q;
    }
    return { min, max };
  }, [accounts]);

  const selection = useSelection(filtered, (a) => a.id);

  // Bulk handlers (mirror AccountList)
  function selectedIdsOrThrow(): number[] {
    const ids = selection.selectedIds;
    if (ids.length === 0) { showError(new Error("No accounts selected")); return []; }
    return ids;
  }

  async function handleBulkDelete() {
    const ids = selectedIdsOrThrow(); if (ids.length === 0) return;
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
    const ids = selectedIdsOrThrow(); if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await warmupAccounts(ids) as any;
      showSuccess(res?.message || `Queued ${ids.length} for warmup.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkLogin() {
    const ids = selectedIdsOrThrow(); if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await loginAccounts(ids) as any;
      showSuccess(res?.message || `Queued ${ids.length} for login.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkToggle(enabled: boolean) {
    const ids = selectedIdsOrThrow(); if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      setAccounts((prev) => prev.map((a) => ids.includes(a.id) ? { ...a, enabled } : a));
      await Promise.allSettled(ids.map((id) => toggleAccountEnabled(id, enabled)));
      showSuccess(`${enabled ? "Enabled" : "Disabled"} ${ids.length} account${ids.length === 1 ? "" : "s"}.`);
    } catch (err) { showError(err); }
    finally { setBulkBusy(false); }
  }

  async function handleBulkRefreshQuota() {
    const ids = selectedIdsOrThrow(); if (ids.length === 0) return;
    setBulkBusy(true);
    try {
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
    exportAccountsCSV(items as any, "accounts-all");
  }

  function handleBulkExportJSON() {
    const items = selection.count > 0 ? selection.selectedItems : filtered;
    if (items.length === 0) { showError(new Error("Nothing to export")); return; }
    exportAccountsJSON(items as any, "accounts-all");
  }

  async function handleSingleDelete(id: number) {
    if (!confirm(`Delete account #${id}?`)) return;
    try {
      await deleteAccount(id);
      showSuccess(`Deleted #${id}`);
      await load();
    } catch (err) { showError(err); }
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
    setProviders((state.providers as Provider[]) ?? []);
  }

  const currentFilterState: AccountFilterState = {
    search,
    statuses,
    enabledFilter,
    quotaMin,
    quotaMax,
    providers,
  };

  function toggleProvider(p: Provider) {
    setProviders((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">All Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            {accounts.length} accounts across {ALL_PROVIDERS.length} providers · {filtered.length} visible
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/accounts">
            <Button variant="outline" size="sm">
              <ExternalLink className="w-4 h-4 mr-2" /> Per-provider view
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <Input placeholder="Search by email..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <MultiStatusFilter
            statuses={statuses}
            onStatusesChange={setStatuses}
            enabledFilter={enabledFilter}
            onEnabledFilterChange={setEnabledFilter}
            counts={statusCounts}
          />
        </div>

        {/* Provider chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Provider
          </span>
          <button
            type="button"
            onClick={() => setProviders([])}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              providers.length === 0
                ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
            }`}
          >
            All
          </button>
          {ALL_PROVIDERS.map((p) => {
            const active = providers.includes(p);
            const count = accounts.filter((a) => a.provider === p).length;
            return (
              <button
                key={p}
                type="button"
                onClick={() => toggleProvider(p)}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  active
                    ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                }`}
              >
                {labelProvider(p)}
                <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">({count})</span>
              </button>
            );
          })}
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
            scope="global"
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
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Email</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Provider</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Enabled</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden sm:table-cell">Credit</th>
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
                        <div>{account.email}</div>
                        {account.errorMessage && (
                          <div className="text-xs text-[var(--error)] mt-1 line-clamp-1" title={account.errorMessage}>
                            {account.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="p-4">
                        <Link
                          to={`/accounts/${account.provider}`}
                          className="text-xs text-[var(--primary)] hover:underline"
                        >
                          {labelProvider(account.provider)}
                        </Link>
                      </td>
                      <td className="p-4">
                        <Badge variant={STATUS_VARIANT[account.status]}>{account.status}</Badge>
                      </td>
                      <td className="p-4">
                        <Badge variant={isEnabled ? "success" : "secondary"}>
                          {isEnabled ? "On" : "Off"}
                        </Badge>
                      </td>
                      <td className="p-4 hidden sm:table-cell text-xs text-[var(--muted-foreground)]">
                        {formatCredit(account.quotaRemaining)}/{formatCredit(account.quotaLimit)}
                      </td>
                      <td className="p-4">
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(account)} title="Edit">
                            <Pencil className="w-4 h-4 text-[var(--info)]" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleSingleDelete(account.id)} title="Delete">
                            <Trash2 className="w-4 h-4 text-[var(--error)]" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-sm text-[var(--muted-foreground)]">
                      No accounts match these filters
                    </td>
                  </tr>
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
