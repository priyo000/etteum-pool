import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  Crown,
  Users,
  Zap,
  AlertCircle,
  Loader2,
  Copy,
} from "lucide-react";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { formatDateTimeID } from "@/lib/utils";
import {
  fetchAccount,
  fetchCanvaTeams,
  switchCanvaBrand,
  type CanvaBrand,
} from "@/lib/api";

/* ── Types ─────────────────────────────────────────────────────── */

interface AccountRow {
  id: number;
  email: string;
  provider: string;
  status: string;
  enabled?: boolean;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaResetAt?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, any> | null;
  tokens?: Record<string, any> | null;
}

const statusVariants: Record<string, "success" | "warning" | "error" | "secondary"> = {
  active: "success",
  exhausted: "warning",
  error: "error",
  pending: "secondary",
  disabled: "secondary",
};

/* ── Plan badge helper ─────────────────────────────────────────── */

interface PlanBadgeMeta {
  variant: "outline" | "warning" | "success" | "info";
  label: string;
  withCrown: boolean;
  solid: boolean;
}

function planMeta(code: string | undefined | null): PlanBadgeMeta {
  const upper = (code || "").toUpperCase();
  switch (upper) {
    case "A":
      return { variant: "outline", label: "Free", withCrown: false, solid: false };
    case "L":
      return { variant: "warning", label: "Limited", withCrown: false, solid: false };
    case "P":
      return { variant: "success", label: "Pro", withCrown: true, solid: true };
    case "E":
      return { variant: "info", label: "Enterprise", withCrown: true, solid: true };
    default:
      return {
        variant: "outline",
        label: `?${upper || "—"}`,
        withCrown: false,
        solid: false,
      };
  }
}

function PlanBadge({ code }: { code: string | undefined | null }) {
  const meta = planMeta(code);
  // For "solid" Pro/Enterprise we override the muted bg with a stronger tone.
  const solidClass =
    meta.solid && meta.variant === "success"
      ? "!bg-[var(--success)] !text-white"
      : meta.solid && meta.variant === "info"
        ? "!bg-[var(--info)] !text-white"
        : "";
  return (
    <Badge variant={meta.variant} className={`gap-1 ${solidClass}`}>
      {meta.withCrown && <Crown className="h-3 w-3" />}
      {meta.label}
    </Badge>
  );
}

/* ── Helpers to read "active brand" from the account row ───────── */

function readActiveBrandId(account: AccountRow | null): string | null {
  if (!account) return null;
  const md: any = account.metadata || {};
  const tokens: any = account.tokens || {};
  return (
    md?.canva?.active_brand_id ??
    md?.canva?.activeBrandId ??
    md?.canva?.brand_id ??
    md?.canva?.cb ??
    tokens?.cb ??
    null
  );
}

/* ── Empty / loading / error subcomponents ─────────────────────── */

function TableSkeleton() {
  return (
    <div className="divide-y divide-[var(--border)]">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 animate-pulse">
          <div className="h-5 w-16 rounded-full bg-[var(--secondary)]" />
          <div className="h-4 w-48 rounded bg-[var(--secondary)]" />
          <div className="h-4 w-24 rounded bg-[var(--secondary)] ml-auto" />
          <div className="h-8 w-28 rounded bg-[var(--secondary)]" />
        </div>
      ))}
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────── */

export default function CanvaAccountDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accountId = Number(id);

  const [account, setAccount] = useState<AccountRow | null>(null);
  const [teams, setTeams] = useState<CanvaBrand[]>([]);
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const { message: toast, setMessage: setToast } = useTimedMessage<{
    text: string;
    kind: "success" | "error";
  }>(null, 4000);

  const showSuccess = useCallback(
    (text: string) => setToast({ text, kind: "success" }),
    [setToast],
  );
  const showError = useCallback(
    (err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      setToast({ text, kind: "error" });
    },
    [setToast],
  );

  /* ── Loaders ─────────────────────────────────────────────────── */

  const loadAccount = useCallback(async () => {
    if (!Number.isFinite(accountId)) return;
    try {
      const row = await fetchAccount(accountId);
      setAccount(row);
      const ab = readActiveBrandId(row);
      if (ab) setActiveBrandId(ab);
    } catch (err) {
      showError(err);
    } finally {
      setLoadingAccount(false);
    }
  }, [accountId, showError]);

  const loadTeams = useCallback(async () => {
    if (!Number.isFinite(accountId)) return;
    setLoadingTeams(true);
    setTeamsError(null);
    try {
      const res = await fetchCanvaTeams(accountId);
      setTeams(res.brands || []);
    } catch (err) {
      setTeamsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTeams(false);
    }
  }, [accountId]);

  useEffect(() => {
    loadAccount();
    loadTeams();
  }, [loadAccount, loadTeams]);

  /* ── Switch handler ──────────────────────────────────────────── */

  async function handleSwitch(brand: CanvaBrand) {
    if (switching) return;
    setSwitching(brand.id);
    try {
      const res = await switchCanvaBrand(accountId, brand.id);
      // Optimistically update active brand from response if available.
      if (res?.brand_id) setActiveBrandId(res.brand_id);
      showSuccess(`Switched to "${brand.displayName || brand.brandname}"`);
      await Promise.all([loadAccount(), loadTeams()]);
    } catch (err) {
      showError(err);
    } finally {
      setSwitching(null);
    }
  }

  async function copyBrandId(brandId: string) {
    try {
      await navigator.clipboard.writeText(brandId);
      showSuccess("Brand ID copied");
    } catch {
      showError(new Error("Clipboard unavailable"));
    }
  }

  /* ── Derived ─────────────────────────────────────────────────── */

  const activeBrand = useMemo(
    () => teams.find((t) => t.id === activeBrandId) || null,
    [teams, activeBrandId],
  );

  const quotaResetText = account?.quotaResetAt
    ? formatDateTimeID(account.quotaResetAt)
    : "—";

  /* ── Render ──────────────────────────────────────────────────── */

  if (!Number.isFinite(accountId)) {
    return (
      <div className="p-6 text-sm text-[var(--error)]">
        Invalid account id.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div
          className={`rounded-md p-3 text-sm animate-in fade-in slide-in-from-top-2 ${
            toast.kind === "success"
              ? "bg-[var(--success)]/10 text-[var(--success)]"
              : "bg-[var(--error)]/10 text-[var(--error)]"
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/accounts/canva")}
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-[var(--foreground)] truncate">
                {loadingAccount ? "Loading…" : account?.email || `Account #${accountId}`}
              </h1>
              <Badge variant="outline" className="uppercase text-[10px]">Canva</Badge>
              {account?.status && (
                <Badge variant={statusVariants[account.status] || "secondary"}>
                  {account.status}
                </Badge>
              )}
            </div>
            <p className="text-sm text-[var(--muted-foreground)] mt-1">
              Account #{accountId}
              {account?.enabled === false && " · disabled"}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/accounts/canva")}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Accounts
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              loadAccount();
              loadTeams();
            }}
            disabled={loadingTeams}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loadingTeams ? "animate-spin" : ""}`} />
            Refresh teams
          </Button>
        </div>
      </div>

      {/* Active brand + quota summary */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-[var(--muted-foreground)] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
              Active brand
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingTeams || loadingAccount ? (
              <div className="h-6 w-40 rounded bg-[var(--secondary)] animate-pulse" />
            ) : activeBrand ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <PlanBadge code={activeBrand.plan} />
                  <span className="font-semibold truncate">
                    {activeBrand.displayName || activeBrand.brandname}
                  </span>
                </div>
                <code className="text-xs text-[var(--muted-foreground)] font-mono truncate block">
                  {activeBrand.id}
                </code>
              </div>
            ) : activeBrandId ? (
              <div className="space-y-1">
                <div className="text-sm">Unknown brand (not in teams list)</div>
                <code className="text-xs text-[var(--muted-foreground)] font-mono truncate block">
                  {activeBrandId}
                </code>
              </div>
            ) : (
              <div className="text-sm text-[var(--muted-foreground)]">
                Not detected yet — switch into a team to set context.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-[var(--muted-foreground)] flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--warning)]" />
              Quota (active context)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingAccount ? (
              <div className="h-6 w-40 rounded bg-[var(--secondary)] animate-pulse" />
            ) : (
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <div className="text-[10px] uppercase text-[var(--muted-foreground)] tracking-wide">
                    Remaining
                  </div>
                  <div className="font-semibold">{account?.quotaRemaining ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-[var(--muted-foreground)] tracking-wide">
                    Limit
                  </div>
                  <div className="font-semibold">{account?.quotaLimit ?? "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-[var(--muted-foreground)] tracking-wide">
                    Reset
                  </div>
                  <div className="font-semibold truncate" title={quotaResetText}>
                    {quotaResetText}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Teams table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="w-4 h-4" />
            Teams ({teams.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* Loading */}
          {loadingTeams && !teamsError && <TableSkeleton />}

          {/* Error */}
          {!loadingTeams && teamsError && (
            <div className="p-6">
              <div className="flex items-start gap-3 rounded-md border border-[var(--error)]/40 bg-[var(--error)]/5 p-4">
                <AlertCircle className="w-5 h-5 text-[var(--error)] mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-[var(--error)]">
                    Failed to load teams
                  </div>
                  <div className="text-xs text-[var(--muted-foreground)] mt-1 break-words">
                    {teamsError}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={loadTeams}>
                  <RefreshCw className="w-4 h-4 mr-1" /> Retry
                </Button>
              </div>
            </div>
          )}

          {/* Empty */}
          {!loadingTeams && !teamsError && teams.length === 0 && (
            <div className="p-10 text-center space-y-3">
              <Users className="w-10 h-10 mx-auto text-[var(--muted-foreground)] opacity-50" />
              <div className="text-sm text-[var(--foreground)] font-medium">
                Account hasn't joined any teams yet
              </div>
              <div className="text-xs text-[var(--muted-foreground)]">
                Use the bulk-join flow from the Canva accounts page to add this
                account to a team via an invite link.
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/accounts/canva")}
              >
                <ArrowLeft className="w-4 h-4 mr-2" /> Go to Canva accounts
              </Button>
            </div>
          )}

          {/* Table */}
          {!loadingTeams && !teamsError && teams.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-[var(--border)]">
                  <tr>
                    <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">
                      Plan
                    </th>
                    <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">
                      Display Name
                    </th>
                    <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">
                      Brand ID
                    </th>
                    <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden sm:table-cell">
                      Members
                    </th>
                    <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">
                      Active
                    </th>
                    <th className="text-right text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((brand) => {
                    const isActive = brand.id === activeBrandId;
                    const inFlight = switching === brand.id;
                    const anyInFlight = !!switching;
                    return (
                      <tr
                        key={brand.id}
                        className={`border-b border-[var(--border)] last:border-0 transition-colors hover:bg-[var(--secondary)]/50 animate-in fade-in ${
                          isActive ? "bg-[var(--success)]/5" : ""
                        }`}
                      >
                        <td className="p-4 align-middle">
                          <PlanBadge code={brand.plan} />
                        </td>
                        <td className="p-4 align-middle">
                          <div className="font-medium text-sm truncate max-w-[18rem]">
                            {brand.displayName || brand.brandname || "(unnamed)"}
                          </div>
                          {brand.personal && (
                            <div className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wide">
                              Personal workspace
                            </div>
                          )}
                          {/* Inline brand id on mobile (md-hidden col) */}
                          <code className="md:hidden block text-[10px] font-mono text-[var(--muted-foreground)] truncate mt-1">
                            {brand.id}
                          </code>
                        </td>
                        <td className="p-4 align-middle hidden md:table-cell">
                          <button
                            type="button"
                            onClick={() => copyBrandId(brand.id)}
                            className="group inline-flex items-center gap-1 font-mono text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] max-w-[14rem]"
                            title={`${brand.id} — click to copy`}
                          >
                            <span className="truncate">{brand.id}</span>
                            <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 shrink-0" />
                          </button>
                        </td>
                        <td className="p-4 align-middle hidden sm:table-cell text-sm">
                          {brand.memberCount ?? "—"}
                        </td>
                        <td className="p-4 align-middle">
                          {isActive ? (
                            <span className="inline-flex items-center gap-1 text-[var(--success)] text-sm font-medium">
                              <CheckCircle2 className="w-4 h-4" />
                              <span className="hidden sm:inline">In use</span>
                            </span>
                          ) : (
                            <span className="text-xs text-[var(--muted-foreground)]">—</span>
                          )}
                        </td>
                        <td className="p-4 align-middle text-right">
                          <Button
                            size="sm"
                            variant={isActive ? "outline" : "default"}
                            disabled={isActive || anyInFlight}
                            onClick={() => handleSwitch(brand)}
                            className="transition-transform hover:scale-[1.02]"
                          >
                            {inFlight && (
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                            )}
                            {isActive ? "Active" : "Use this team"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tip */}
      <Card className="bg-[var(--secondary)]/30 border-dashed">
        <CardContent className="p-4 flex items-start gap-3">
          <Zap className="w-4 h-4 text-[var(--warning)] mt-0.5 shrink-0" />
          <p className="text-xs text-[var(--muted-foreground)] leading-relaxed">
            <span className="font-medium text-[var(--foreground)]">Tip:</span>{" "}
            Canva Pro teams provide more AI credits than free brands. The pool
            will use the active brand's quota for chat completions.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
