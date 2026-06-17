import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Users, AlertCircle, CheckCircle2, XCircle, Info, ChevronRight, ChevronDown } from "lucide-react";
import { joinCanvaTeam, fetchCanvaTeams, type CanvaBrand } from "@/lib/api";
import { useWsEvent } from "@/hooks/useWebSocket";

export interface CanvaAccount {
  id: number;
  email: string;
  status: string;
}

interface ProgressEntry {
  accountId: number;
  email: string;
  status: "pending" | "running" | "success" | "failed";
  action?: "joined" | "switched" | "skipped" | "already_member";
  brandId?: string;
  brandName?: string;
  error?: string;
  code?: string;
  warning?: string;
}

interface LogLine {
  ts: number;
  level: "step" | "debug";
  text: string;
}

const MAX_LOG_LINES_PER_ACCOUNT = 50;

interface JoinTeamModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canvaAccounts: CanvaAccount[];
  onSuccess?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

const INVITE_URL_PATTERN = /^https?:\/\/(www\.)?canva\.com\/brand\/join\?token=/i;

export function JoinTeamModal({
  open,
  onOpenChange,
  canvaAccounts,
  onSuccess,
  onError,
}: JoinTeamModalProps) {
  const [inviteUrl, setInviteUrl] = useState("");
  const [onExisting, setOnExisting] = useState<"switch" | "skip" | "add">("switch");
  const [concurrency, setConcurrency] = useState<number>(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<number, ProgressEntry>>({});
  const [logs, setLogs] = useState<Record<number, LogLine[]>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Per-account team list, lazily fetched when the account is selected.
  // "loading" while a fetch is in flight, "error" on failure, otherwise the
  // brand array. Personal brand is included.
  const [accountTeams, setAccountTeams] = useState<
    Record<number, CanvaBrand[] | "loading" | "error">
  >({});
  const [summary, setSummary] = useState<{ total: number; succeeded: number; failed: number } | null>(null);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setInviteUrl("");
      setOnExisting("switch");
      setConcurrency(1);
      setSelectedIds(new Set());
      setSubmitting(false);
      setRunning(false);
      setProgress({});
      setLogs({});
      setExpanded(new Set());
      setAccountTeams({});
      setSummary(null);
    }
  }, [open]);

  // Lazy-fetch the team list for any newly selected account so the user
  // can see WHERE the account currently lives before kicking off a join.
  // Bounded to 3 concurrent fetches so we don't hammer the server when
  // the user clicks "Select all".
  useEffect(() => {
    if (!open) return;

    const idsToFetch = Array.from(selectedIds).filter(
      (id) => accountTeams[id] === undefined,
    );
    if (idsToFetch.length === 0) return;

    let cancelled = false;
    // Mark all targets as loading immediately for instant UI feedback.
    setAccountTeams((prev) => {
      const next = { ...prev };
      for (const id of idsToFetch) next[id] = "loading";
      return next;
    });

    const concurrency = 3;
    let cursor = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= idsToFetch.length || cancelled) return;
        const id = idsToFetch[i];
        try {
          const res = await fetchCanvaTeams(id);
          if (cancelled) return;
          setAccountTeams((prev) => ({
            ...prev,
            [id]: res.brands || [],
          }));
        } catch {
          if (cancelled) return;
          setAccountTeams((prev) => ({ ...prev, [id]: "error" }));
        }
      }
    }

    Promise.all(
      Array.from({ length: Math.min(concurrency, idsToFetch.length) }, worker),
    );

    return () => { cancelled = true; };
    // accountTeams intentionally NOT in deps — we only fetch on selection
    // change. Setting it inside this effect would otherwise re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, open]);

  // Listen for live progress
  useWsEvent("canva_join_progress", (msg) => {
    const d: any = msg.data;
    if (!d?.accountId) return;
    setProgress((prev) => ({
      ...prev,
      [d.accountId]: {
        accountId: d.accountId,
        email: d.email,
        status: d.status,
        action: d.action,
        brandId: d.brand_id,
        brandName: d.brand_name,
        error: d.error,
        code: d.code,
        warning: d.warning,
      },
    }));
  });

  // Live stderr log lines from the Python script — one event per [STEP].
  useWsEvent("canva_join_log", (msg) => {
    const d: any = msg.data;
    if (!d?.accountId || !d?.line) return;
    setLogs((prev) => {
      const list = prev[d.accountId] || [];
      const next = [
        ...list,
        { ts: d.ts || Date.now(), level: d.level || "debug", text: String(d.line) },
      ];
      // Cap memory — keep only the last N lines per account.
      const trimmed = next.length > MAX_LOG_LINES_PER_ACCOUNT
        ? next.slice(next.length - MAX_LOG_LINES_PER_ACCOUNT)
        : next;
      return { ...prev, [d.accountId]: trimmed };
    });
    // Auto-expand the row of the account that's actively running so the
    // user can SEE what's happening without an extra click.
    setExpanded((prev) => {
      if (prev.has(d.accountId)) return prev;
      const next = new Set(prev);
      next.add(d.accountId);
      return next;
    });
  });

  useWsEvent("canva_join_completed", (msg) => {
    const d: any = msg.data;
    if (!d) return;
    setRunning(false);
    setSummary({
      total: d.total ?? 0,
      succeeded: d.succeeded ?? 0,
      failed: d.failed ?? 0,
    });
    onSuccess?.(`Join complete: ${d.succeeded}/${d.total} succeeded`);
  });

  const validUrl = INVITE_URL_PATTERN.test(inviteUrl);
  const canSubmit = validUrl && selectedIds.size > 0 && !submitting && !running;

  function toggleExpanded(accountId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function toggleAccount(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(canvaAccounts.map((a) => a.id)));
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setProgress({});
    setSummary(null);

    // Pre-populate progress entries as pending
    const ids = Array.from(selectedIds);
    const initial: Record<number, ProgressEntry> = {};
    for (const id of ids) {
      const acc = canvaAccounts.find((a) => a.id === id);
      initial[id] = {
        accountId: id,
        email: acc?.email || `<id:${id}>`,
        status: "pending",
      };
    }
    setProgress(initial);

    try {
      await joinCanvaTeam({
        invite_url: inviteUrl.trim(),
        account_ids: ids,
        on_existing: onExisting,
        concurrency,
      });
      setRunning(true);
    } catch (err) {
      onError?.(err);
      setRunning(false);
    } finally {
      setSubmitting(false);
    }
  }

  const progressList = useMemo(
    () => Object.values(progress).sort((a, b) => a.accountId - b.accountId),
    [progress],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-[var(--primary)]" />
            Join Canva Team
          </DialogTitle>
          <DialogDescription>
            Bulk-join your Canva accounts into a team via an invite link. Each account
            opens a browser session, accepts the invite, and updates its brand context.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Invite URL */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              Invite URL
            </label>
            <Input
              type="url"
              placeholder="https://www.canva.com/brand/join?token=..."
              value={inviteUrl}
              onChange={(e) => setInviteUrl(e.target.value)}
              disabled={running || submitting}
              className="font-mono text-xs"
            />
            {inviteUrl && !validUrl && (
              <p className="flex items-center gap-1 text-xs text-red-500">
                <AlertCircle className="h-3 w-3" />
                Must be a https://www.canva.com/brand/join?token=... link
              </p>
            )}
          </div>

          {/* On-existing behavior */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              If account is already in a team
            </label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { value: "switch", label: "Switch", desc: "Leave old, join new" },
                  { value: "skip", label: "Skip", desc: "Keep existing team" },
                  { value: "add", label: "Add", desc: "Multi-team (best effort)" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={running || submitting}
                  onClick={() => setOnExisting(opt.value)}
                  className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                    onExisting === opt.value
                      ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                      : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
                  }`}
                >
                  <span className="font-semibold">{opt.label}</span>
                  <span className="text-[10px]">{opt.desc}</span>
                </button>
              ))}
            </div>
            {onExisting === "add" && (
              <p className="flex items-start gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                Canva does not support true multi-team membership for free accounts.
                "Add" will fall back to "Switch".
              </p>
            )}
          </div>

          {/* Concurrency */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              Concurrency
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={running || submitting}
                className="flex-1 accent-[var(--primary)]"
              />
              <div className="flex h-7 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-xs font-mono">
                {concurrency}
              </div>
              <span className="text-[10px] text-[var(--muted-foreground)]">
                worker{concurrency === 1 ? "" : "s"}
              </span>
            </div>
            <p className="text-[10px] text-[var(--muted-foreground)]">
              {concurrency === 1
                ? "Sequential — safest. Recommended for first run."
                : `Up to ${concurrency} accounts join in parallel. Each spawns a browser; high values may trigger Canva anti-bot.`}
            </p>
          </div>

          {/* Account selection */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Accounts ({selectedIds.size}/{canvaAccounts.length} selected)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={running || submitting}
                  className="text-xs text-[var(--primary)] hover:underline disabled:opacity-50"
                >
                  Select all
                </button>
                <span className="text-xs text-[var(--muted-foreground)]">·</span>
                <button
                  type="button"
                  onClick={selectNone}
                  disabled={running || submitting}
                  className="text-xs text-[var(--muted-foreground)] hover:underline disabled:opacity-50"
                >
                  None
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--card)]">
              {canvaAccounts.length === 0 ? (
                <p className="p-3 text-center text-xs text-[var(--muted-foreground)]">
                  No Canva accounts found.
                </p>
              ) : (
                canvaAccounts.map((acc) => {
                  const teamsState = accountTeams[acc.id];
                  // Filter out the personal brand — only team memberships
                  // are interesting for this UI.
                  const teamBrands = Array.isArray(teamsState)
                    ? teamsState.filter((b) => !b.personal)
                    : [];
                  return (
                    <label
                      key={acc.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-sm last:border-b-0 hover:bg-[var(--muted)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(acc.id)}
                        onChange={() => toggleAccount(acc.id)}
                        disabled={running || submitting}
                        className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
                      />
                      <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                        <span className="truncate font-mono text-xs">{acc.email}</span>
                        {/* Current teams badges */}
                        {teamsState === "loading" && (
                          <span className="text-[10px] text-[var(--muted-foreground)]">
                            loading teams…
                          </span>
                        )}
                        {teamsState === "error" && (
                          <span className="text-[10px] text-red-500">
                            failed to fetch teams
                          </span>
                        )}
                        {Array.isArray(teamsState) && teamBrands.length === 0 && (
                          <span className="text-[10px] text-[var(--muted-foreground)]">
                            personal only — not in any team
                          </span>
                        )}
                        {Array.isArray(teamsState) && teamBrands.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1">
                            {teamBrands.slice(0, 2).map((b) => (
                              <Badge
                                key={b.id}
                                variant="outline"
                                className="max-w-[180px] truncate text-[9px]"
                                title={`${b.displayName || b.brandname} · ${b.memberCount} members · plan ${b.plan}`}
                              >
                                {b.displayName || b.brandname || b.id}
                              </Badge>
                            ))}
                            {teamBrands.length > 2 && (
                              <span className="text-[10px] text-[var(--muted-foreground)]">
                                +{teamBrands.length - 2} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <Badge
                        variant={acc.status === "active" ? "default" : "outline"}
                        className="shrink-0 text-[10px]"
                      >
                        {acc.status}
                      </Badge>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Progress list */}
          {progressList.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Progress
              </label>
              <div className="max-h-80 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--card)]">
                {progressList.map((p) => {
                  const lines = logs[p.accountId] || [];
                  const isOpen = expanded.has(p.accountId);
                  const hasLogs = lines.length > 0;
                  return (
                    <div key={p.accountId} className="border-b border-[var(--border)] last:border-b-0">
                      {/* Row header — clickable to toggle log panel */}
                      <button
                        type="button"
                        onClick={() => hasLogs && toggleExpanded(p.accountId)}
                        disabled={!hasLogs}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${hasLogs ? "cursor-pointer hover:bg-[var(--muted)]" : "cursor-default"}`}
                      >
                        {/* Expand chevron — only when there are logs */}
                        {hasLogs ? (
                          isOpen ? (
                            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
                          ) : (
                            <ChevronRight className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
                          )
                        ) : (
                          <span className="h-3 w-3 shrink-0" />
                        )}
                        {/* Status icon */}
                        {p.status === "pending" && (
                          <span className="h-3 w-3 shrink-0 rounded-full border border-[var(--border)]" />
                        )}
                        {p.status === "running" && (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--primary)]" />
                        )}
                        {p.status === "success" && (
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                        )}
                        {p.status === "failed" && (
                          <XCircle className="h-3 w-3 shrink-0 text-red-500" />
                        )}
                        <span className="flex-1 truncate font-mono">{p.email}</span>
                        {hasLogs && (
                          <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">
                            {lines.length} log{lines.length === 1 ? "" : "s"}
                          </span>
                        )}
                        {p.status === "success" && p.action && (
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {p.action}
                          </Badge>
                        )}
                        {p.brandName && (
                          <span className="truncate text-[10px] text-[var(--muted-foreground)]">
                            → {p.brandName}
                          </span>
                        )}
                        {p.status === "failed" && (
                          <span className="truncate text-[10px] text-red-500">
                            {p.code || "error"}: {p.error}
                          </span>
                        )}
                      </button>

                      {/* Live log panel */}
                      {isOpen && hasLogs && (
                        <div className="max-h-40 overflow-y-auto bg-[var(--background)] px-3 py-2 font-mono text-[10px]">
                          {lines.map((l, i) => (
                            <div
                              key={i}
                              className={l.level === "step"
                                ? "text-[var(--foreground)]"
                                : "text-[var(--muted-foreground)]"}
                            >
                              <span className="mr-2 opacity-50">
                                {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
                              </span>
                              {l.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {summary && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Done — {summary.succeeded}/{summary.total} succeeded, {summary.failed} failed.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {running || summary ? "Close" : "Cancel"}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {running ? "Running…" : `Join Team (${selectedIds.size})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
