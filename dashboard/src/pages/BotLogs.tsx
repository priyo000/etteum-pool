import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clearAuthLogs, fetchAuthLogs, fetchAuthQueue, fetchWarmupQueue, getWsBase, loginAccount, loginAccounts } from "@/lib/api";
import { AlertTriangle, CheckCircle, ChevronDown, RefreshCw, RotateCcw, Trash2, Radio } from "lucide-react";
import { formatTimeID } from "@/lib/utils";

interface AuthLog {
  id: number;
  timestamp: string;
  type: string;
  accountId?: number;
  email?: string;
  provider?: string;
  step?: string;
  message?: string;
  error?: string;
  data?: unknown;
}

interface ProcessLog {
  key: string;
  operation: string;
  latest: AuthLog;
  events: AuthLog[];
  startedAt: string;
  updatedAt: string;
}

const liveTypes = new Set([
  "queue_added", "queue_processing", "login_progress", "login_success", "login_failed", "queue_complete",
]);

function statusVariant(type: string): "success" | "warning" | "error" | "secondary" {
  if (type.includes("success") || type === "queue_complete" || type === "warmup_complete") return "success";
  if (type.includes("failed") || type.includes("auth_error")) return "error";
  if (type.includes("processing") || type.includes("progress") || type.includes("exhausted") || type.includes("transient") || type.includes("unsupported")) return "warning";
  return "secondary";
}

function processStatusVariant(process: ProcessLog): "success" | "warning" | "error" | "secondary" {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusVariant(process.latest.type);
}

function processStatusLabel(process: ProcessLog) {
  if (process.events.some((log) => log.type === "login_success" || log.type === "warmup_success")) return "success";
  if (process.events.some((log) => log.type === "login_failed" || log.type === "warmup_auth_error")) return "error";
  return statusLabel(process.latest.type);
}

function providerLabel(provider?: string) {
  if (!provider) return "-";
  return provider === "codebuddy" ? "CodeBuddy" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

function operationFor(type: string) {
  return type.startsWith("warmup_") ? "WarmUp" : "Login";
}

function processKey(log: AuthLog) {
  const account = log.accountId || log.email || log.id;
  return `${operationFor(log.type)}-${account}`;
}

function statusLabel(type: string) {
  return type.replace(/^login_/, "").replace(/^warmup_/, "").replace(/^queue_/, "").replace(/_/g, " ");
}

function mergeLogs(current: AuthLog[], incoming: AuthLog[]) {
  const map = new Map<string, AuthLog>();
  for (const log of [...current, ...incoming]) {
    const key = `${log.id}-${log.timestamp}-${log.type}-${log.accountId || ""}-${log.step || ""}`;
    map.set(key, log);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 300);
}

function logsToProcesses(logs: AuthLog[]): ProcessLog[] {
  const groups = new Map<string, ProcessLog>();
  const oldestFirst = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const log of oldestFirst) {
    const key = processKey(log);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        operation: operationFor(log.type),
        latest: log,
        events: [log],
        startedAt: log.timestamp,
        updatedAt: log.timestamp,
      });
      continue;
    }

    existing.events.push(log);
    existing.latest = { ...log, email: log.email || existing.latest.email, provider: log.provider || existing.latest.provider };
    existing.updatedAt = log.timestamp;
  }

  return [...groups.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export default function BotLogs() {
  const [logs, setLogs] = useState<AuthLog[]>([]);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const queueRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    const [logRes, queueRes, warmupQueueRes] = await Promise.all([
      fetchAuthLogs(300) as Promise<{ data: AuthLog[] }>,
      fetchAuthQueue().catch(() => null),
      fetchWarmupQueue().catch(() => null),
    ]);
    setLogs((current) => mergeLogs(current, (logRes.data || []).filter((log) => !log.type.startsWith("warmup_"))));
    setQueue(queueRes);
    setWarmupQueue(warmupQueueRes);
  }

  useEffect(() => {
    let mounted = true;
    let refreshingQueues = false;

    async function refreshQueues() {
      if (refreshingQueues || !mounted) return;
      refreshingQueues = true;
      try {
        const [queueRes, warmupQueueRes] = await Promise.all([
          fetchAuthQueue().catch(() => null),
          fetchWarmupQueue().catch(() => null),
        ]);
        if (!mounted) return;
        setQueue(queueRes);
        setWarmupQueue(warmupQueueRes);
      } finally {
        refreshingQueues = false;
      }
    }

    function scheduleQueueRefresh() {
      if (queueRefreshTimerRef.current) return;
      queueRefreshTimerRef.current = setTimeout(() => {
        queueRefreshTimerRef.current = null;
        refreshQueues();
      }, 300);
    }

    load().catch(() => {});

    const ws = new WebSocket(`${getWsBase()}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!liveTypes.has(msg.type) || msg.type.startsWith("warmup_")) return;

        if (msg.type === "queue_complete") {
          setQueue((current: any) => ({ ...(current || {}), ...(msg.data || {}), queued: 0, active: 0, processing: false }));
        }
        const data = msg.data || {};
        const log: AuthLog = {
          id: data.logId || data.id || Date.now(),
          timestamp: data.timestamp || new Date().toISOString(),
          type: msg.type,
          accountId: data.accountId || data.id,
          email: data.email,
          provider: data.provider,
          step: data.step,
          message: data.message || data.error || msg.type,
          error: data.error,
          data,
        };
        setLogs((current) => mergeLogs(current, [log]));
        scheduleQueueRefresh();
      } catch {
        // ignore invalid ws messages
      }
    };

    return () => {
      mounted = false;
      if (queueRefreshTimerRef.current) {
        clearTimeout(queueRefreshTimerRef.current);
        queueRefreshTimerRef.current = null;
      }
      ws.close();
    };
  }, []);

  const failed = useMemo(() => logs.filter((log) => log.type === "login_failed"), [logs]);
  const failedAccounts = useMemo(() => {
    const map = new Map<string, AuthLog>();
    for (const log of failed) {
      const key = `${log.accountId || log.email || log.id}-${log.provider || "unknown"}`;
      if (!map.has(key) || new Date(log.timestamp).getTime() > new Date(map.get(key)!.timestamp).getTime()) {
        map.set(key, log);
      }
    }
    return [...map.values()];
  }, [failed]);
  const success = useMemo(() => logs.filter((log) => log.type === "login_success"), [logs]);
  const processes = useMemo(() => logsToProcesses(logs), [logs]);
  const running = Number(queue?.active || 0);
  const queued = Number(queue?.queued || 0);
  const warmupRunning = Number(warmupQueue?.active || 0);
  const warmupQueued = Number(warmupQueue?.queued || 0);

  async function handleClear() {
    await clearAuthLogs();
    setLogs([]);
  }

  async function handleRetry(accountId?: number) {
    if (!accountId) return;
    await loginAccount(accountId);
    await load().catch(() => {});
  }

  async function handleRetryAll() {
    const ids = Array.from(new Set(failedAccounts.map((log) => log.accountId).filter((id): id is number => Boolean(id))));
    if (ids.length === 0) return;
    await loginAccounts(ids);
    await load().catch(() => {});
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Bot Logs</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Live progress for auto-login bot and WarmUp health checks, including failed accounts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={connected ? "success" : "secondary"}>{connected ? "Live" : "Disconnected"}</Badge>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4 mr-2" />Refresh</Button>
          <Button variant="outline" size="sm" onClick={handleClear}><Trash2 className="w-4 h-4 mr-2" />Clear</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Login Queue</p><p className="text-2xl font-bold">{queued}/{running}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">WarmUp Queue</p><p className="text-2xl font-bold">{warmupQueued}/{warmupRunning}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Success</p><p className="text-2xl font-bold text-green-400">{success.length}</p></CardContent></Card>
        <Card className="border-[var(--border)]"><CardContent className="p-4"><p className="text-xs text-[var(--muted-foreground)]">Failed</p><p className="text-2xl font-bold text-red-400">{failed.length}</p></CardContent></Card>
      </div>

      {(running > 0 || queued > 0 || warmupRunning > 0 || warmupQueued > 0) && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-300 flex items-center gap-2">
          <Radio className="w-4 h-4 animate-pulse" />
          Bot/WarmUp sedang berjalan: login {running} running/{queued} queued, warmup {warmupRunning} running/{warmupQueued} queued. Log akan update otomatis.
        </div>
      )}

      {failedAccounts.length > 0 && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-400" /> Failed Accounts</CardTitle>
              <Button variant="outline" size="sm" onClick={handleRetryAll}>
                <RotateCcw className="mr-2 h-4 w-4" /> Retry All ({failedAccounts.length})
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-md border border-red-500/20">
              {failedAccounts.map((log) => (
                <div key={`failed-${log.accountId || log.id}-${log.provider || "unknown"}`} className="grid grid-cols-[1fr_auto] gap-3 border-b border-red-500/10 px-3 py-2 text-sm last:border-0 md:grid-cols-[240px_140px_1fr_auto]">
                  <div className="truncate font-medium text-[var(--foreground)]">{log.email || `Account #${log.accountId}`}</div>
                  <div className="text-xs text-[var(--muted-foreground)] md:text-sm">{providerLabel(log.provider)}</div>
                  <div className="col-span-2 truncate text-xs text-red-400 md:col-span-1" title={log.error || log.message}>{log.error || log.message}</div>
                  <Button variant="ghost" size="sm" onClick={() => handleRetry(log.accountId)} disabled={!log.accountId}>
                    <RotateCcw className="mr-1 h-3 w-3" /> Retry
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-[var(--border)]">
        <CardHeader><CardTitle className="text-base">Live Bot & WarmUp Progress</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Time</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Account</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Provider</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Step</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Message</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((process) => (
                  <Fragment key={process.key}>
                    <tr
                      className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50"
                      onClick={() => setExpanded((current) => current === process.key ? null : process.key)}
                    >
                      <td className="p-4 text-xs text-[var(--muted-foreground)] font-mono">{formatTimeID(process.updatedAt)}</td>
                      <td className="p-4"><Badge variant={processStatusVariant(process)}>{processStatusLabel(process)}</Badge></td>
                      <td className="p-4 text-sm text-[var(--foreground)]">{process.latest.email || (process.latest.accountId ? `#${process.latest.accountId}` : "-")}</td>
                      <td className="p-4 text-sm text-[var(--muted-foreground)]">{providerLabel(process.latest.provider)}</td>
                      <td className="p-4 text-xs text-[var(--muted-foreground)]">{process.latest.step || process.operation}</td>
                      <td className="p-4 text-sm text-[var(--muted-foreground)]">
                        <div className="flex items-center gap-2">
                          {processStatusLabel(process) === "success" && <CheckCircle className="w-4 h-4 text-green-400" />}
                          {processStatusLabel(process) === "error" && <AlertTriangle className="w-4 h-4 text-red-400" />}
                          {processStatusLabel(process) !== "success" && processStatusLabel(process) !== "error" && (process.latest.type === "login_progress" || process.latest.type === "queue_processing" || process.latest.type === "warmup_processing") && <span className="h-2 w-2 rounded-full bg-yellow-400" />}
                          <span className="min-w-0 flex-1 truncate">{process.latest.error || process.latest.message || "-"}</span>
                          <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{process.events.length} steps</span>
                          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${expanded === process.key ? "rotate-180" : ""}`} />
                        </div>
                      </td>
                    </tr>
                    {expanded === process.key && (
                      <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/20">
                        <td colSpan={6} className="p-4">
                          <div className="space-y-2">
                            {process.events.map((log) => (
                              <div key={`${log.id}-${log.timestamp}`} className="grid grid-cols-[80px_120px_1fr] gap-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs">
                                <span className="font-mono text-[var(--muted-foreground)]">{formatTimeID(log.timestamp)}</span>
                                <span className="text-[var(--muted-foreground)]">{log.step || statusLabel(log.type)}</span>
                                <span className={log.error ? "text-red-400" : "text-[var(--foreground)]"}>{log.error || log.message || "-"}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {processes.length === 0 && (
                  <tr><td colSpan={6} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No bot logs yet. Add an account or start login to see progress.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
