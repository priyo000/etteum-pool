import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchRequests, fetchRequestDetail } from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

interface RequestLog {
  id: number;
  createdAt: string;
  provider: string;
  model: string | null;
  status: "success" | "error";
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditsUsed?: number | null;
  accountId: number | null;
  accountEmail?: string | null;
  accountQuotaBefore?: number | null;
  accountQuotaAfter?: number | null;
  errorMessage: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  compressionStats?: CompressionStats | null;
}

interface CompressionStats {
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  savedPct: number;
  byTechnique?: {
    tsc?: number;
    rtk?: number;
    dcp?: number;
    caveman?: number;
    imageDedupe?: number;
    cacheMarkers?: number;
  };
  /** Per-shape-filter savings inside RTK (only present when RTK fired). */
  rtkFilters?: Record<string, number>;
  durationMs: number;
}

function getCreditMeta(req: RequestLog) {
  const body = req.requestBody as { _poolprox?: { creditSource?: string; creditUnit?: string; creditRate?: number; combo?: ComboTrace } } | null | undefined;
  return body?._poolprox || {};
}

interface ComboTrace {
  ruleName: string;
  requestedModel: string;
  usedProvider: string;
  usedModel: string;
  usedStep: number;
  attemptedSteps: string[];
}

function getComboTrace(req: RequestLog): ComboTrace | undefined {
  return getCreditMeta(req).combo as ComboTrace | undefined;
}

function getStatusColor(status: string): "success" | "warning" | "error" {
  if (status === "success") return "success";
  if (status.includes("429")) return "warning";
  return "error";
}

function labelProvider(provider: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Requests() {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const perPage = 25;

  /**
   * Open the detail drawer for a row. The list endpoint omits the heavy
   * requestBody / responseBody columns to keep the page snappy, so we lazily
   * fetch the full record here. We immediately show what we already have so
   * the drawer feels instant, then fill in the bodies once they arrive.
   */
  async function openDetail(req: RequestLog) {
    setSelected(req);
    if (req.requestBody !== undefined && req.responseBody !== undefined) return;
    setDetailLoading(true);
    try {
      const res = (await fetchRequestDetail(req.id)) as { data: RequestLog };
      if (res?.data) {
        setSelected((current) => (current?.id === req.id ? { ...current, ...res.data } : current));
      }
    } catch {
      // best-effort; leave bodies undefined and let the UI render empty blocks
    } finally {
      setDetailLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchRequests(1, 100, provider) as { data: RequestLog[] };
      setLogs(res.data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setPage(1);
  }, [provider]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  useWsEvent(["request_log"], (msg) => {
    if (msg.type === "request_log") {
      setLogs((current) => [msg.data as RequestLog, ...current].slice(0, 100));
    }
  });

  const filtered = logs.filter((req) => {
    const q = search.toLowerCase();
    return (
      req.model?.toLowerCase().includes(q) ||
      req.provider.toLowerCase().includes(q) ||
      req.errorMessage?.toLowerCase().includes(q) ||
      String(req.accountId || "").includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Requests</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Recent API request logs from PostgreSQL
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requests..." className="pl-9" />
        </div>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
          <option value="all">All Providers</option>
          <option value="kiro">Kiro</option>
          <option value="codebuddy">CodeBuddy</option>
          <option value="canva">Canva</option>
        </select>
      </div>

      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Time</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Provider</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Model</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Duration</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Tokens</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Credits</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Account</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * perPage, page * perPage).map((req) => (
                  <tr key={req.id} onClick={() => openDetail(req)} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 cursor-pointer">
                    <td className="p-4 text-xs text-[var(--muted-foreground)] font-mono">{formatDateTimeID(req.createdAt)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)]">{labelProvider(req.provider)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)] hidden md:table-cell">{req.model || "-"}</td>
                    <td className="p-4"><Badge variant={getStatusColor(req.status)}>{req.status}</Badge></td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)] hidden md:table-cell">{((req.durationMs ?? 0) / 1000).toFixed(1)}s</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{req.totalTokens || 0}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{Number(req.creditsUsed || 0).toFixed(2)}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{req.accountEmail || (req.accountId ? `#${req.accountId}` : "-")}</td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No request logs yet</td></tr>
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

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setSelected(null)}>
          <aside className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[var(--border)] bg-[var(--card)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
              <div>
                <h2 className="font-bold text-[var(--foreground)]">{selected.model || "Request"}</h2>
                <p className="text-xs text-[var(--muted-foreground)]">{formatDateTimeID(selected.createdAt)}</p>
              </div>
              <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs">
              <Badge variant={getStatusColor(selected.status)}>{selected.status}</Badge>
              <span className="text-[var(--muted-foreground)]">HTTP {selected.status === "success" ? 200 : 503}</span>
              <span className="text-[var(--muted-foreground)]">{((selected.durationMs || 0) / 1000).toFixed(1)}s</span>
              <span className="text-[var(--muted-foreground)]">{labelProvider(selected.provider)}</span>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              <Metric label="Total" value={selected.totalTokens || 0} color="blue" />
              <Metric label="Prompt" value={selected.promptTokens || 0} color="green" />
              <Metric label="Completion" value={selected.completionTokens || 0} color="indigo" />
              <Metric label="Credit" value={(selected.creditsUsed || 0).toFixed(2)} color="yellow" />
            </div>

            <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3 text-xs text-[var(--muted-foreground)]">
              Credit source: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditSource || "unknown"}</span>
              {getCreditMeta(selected).creditUnit && <> · Unit: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditUnit}</span></>}
              {typeof getCreditMeta(selected).creditRate === "number" && <> · Rate: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditRate}</span></>}
            </div>

            {getComboTrace(selected) && (
              <ComboTracePanel trace={getComboTrace(selected)!} />
            )}

            {selected.compressionStats && (
              <CompressionPanel
                stats={selected.compressionStats}
                promptTokens={selected.promptTokens}
              />
            )}

            <div className="mt-5 space-y-1">
              <p className="text-xs uppercase text-[var(--muted-foreground)]">Account</p>
              <p className="text-sm font-medium text-[var(--foreground)]">{selected.accountEmail || `#${selected.accountId}`}</p>
              <p className="text-xs text-[var(--muted-foreground)]">Credit: {selected.accountQuotaBefore ?? 0} → {selected.accountQuotaAfter ?? 0}</p>
            </div>

            {selected.errorMessage && (
              <div className="mt-5 rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">{selected.errorMessage}</div>
            )}

            {detailLoading && selected.requestBody === undefined ? (
              <div className="mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading request & response body…
              </div>
            ) : (
              <>
                <JsonBlock title="Request Body" value={selected.requestBody} />
                <JsonBlock title="Response Body" value={selected.responseBody} />
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    blue: "bg-[var(--info)]/10 text-[var(--info)]",
    green: "bg-[var(--success)]/10 text-[var(--success)]",
    indigo: "bg-[var(--primary)]/10 text-[var(--primary)]",
    yellow: "bg-[var(--warning)]/10 text-[var(--warning)]",
  };
  return <div className={`rounded-md p-3 ${colors[color]}`}><p className="text-[10px] uppercase opacity-80">{label}</p><p className="font-bold">{value}</p></div>;
}

const TECHNIQUE_LABELS: Record<keyof NonNullable<CompressionStats["byTechnique"]>, string> = {
  tsc: "TSC (tool schema)",
  rtk: "RTK (tool truncation)",
  dcp: "DCP (dedup)",
  caveman: "Caveman (system prompt)",
  imageDedupe: "Image dedup",
  cacheMarkers: "Cache markers",
};

function ComboTracePanel({ trace }: { trace: ComboTrace }) {
  return (
    <div className="mt-3 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs">
      <div className="font-semibold text-blue-400 mb-2">Combo Fallback Trace</div>
      <div className="text-[var(--muted-foreground)]">
        Requested: <span className="font-mono text-[var(--foreground)]">{trace.requestedModel}</span>{" "}
        → Used: <span className="font-mono text-[var(--foreground)]">{trace.usedProvider}/{trace.usedModel}</span>
      </div>
      <div className="mt-2 space-y-1">
        {trace.attemptedSteps.map((step, i) => (
          <div key={`${step}-${i}`} className="flex items-center gap-2">
            <span className={`w-5 text-center rounded ${i === trace.usedStep ? "bg-green-500/20 text-green-400" : "bg-[var(--accent)] text-[var(--muted-foreground)]"}`}>
              {i + 1}
            </span>
            <span className="font-mono text-[var(--foreground)]">{step}</span>
            {i === trace.usedStep && <span className="text-green-400">success</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

const RTK_FILTER_LABELS: Record<string, string> = {
  "git-diff": "git diff (hunks)",
  "git-status": "git status",
  tree: "tree (depth ≤ 1)",
  "read-numbered": "Read (line-numbered)",
  grep: "grep (per-file)",
  "dedup-log": "dedup-log",
  generic: "generic head + tail",
};

function CompressionPanel({
  stats,
  promptTokens,
}: {
  stats: CompressionStats;
  promptTokens: number | null;
}) {
  const { tokensBefore, tokensAfter, saved, byTechnique = {}, rtkFilters, durationMs } = stats;
  const techEntries = Object.entries(byTechnique).filter(([, v]) => typeof v === "number" && v > 0) as Array<
    [keyof typeof TECHNIQUE_LABELS, number]
  >;
  const filterEntries: Array<[string, number]> = rtkFilters
    ? Object.entries(rtkFilters).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];

  // Best practice: anchor the displayed before/after to provider-reported
  // prompt_tokens (ground truth) instead of our char/4 heuristic. Our internal
  // estimate is only used to allocate per-technique attribution; for the
  // headline numbers we trust the upstream usage.prompt_tokens.
  //
  // Formula:
  //   actualBefore = promptTokens + saved   (what would have been billed without compression)
  //   actualAfter  = promptTokens           (what was actually billed)
  //   actualPct    = saved / actualBefore   (real savings ratio)
  //
  // If promptTokens is missing/0 (e.g. error response), fall back to our estimate.
  const hasProviderTruth = typeof promptTokens === "number" && promptTokens > 0;
  const displayAfter = hasProviderTruth ? promptTokens : tokensAfter;
  const displayBefore = hasProviderTruth ? promptTokens + saved : tokensBefore;
  const displayPct = displayBefore > 0 ? (saved / displayBefore) * 100 : 0;

  // No real savings on this request — show a muted "ran but no-op" line.
  if (saved <= 0) {
    return (
      <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3 text-xs text-[var(--muted-foreground)]">
        <span className="uppercase tracking-wide">Compression</span>
        <span className="ml-2">Pipeline ran in {durationMs}ms — no compressible content this turn.</span>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--success)]/30 bg-[var(--success)]/5 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-[var(--success)]">Compression</p>
        <p className="text-[10px] text-[var(--muted-foreground)]">Pipeline {durationMs}ms</p>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-xl font-bold text-[var(--success)]">−{formatNum(saved)}</span>
        <span className="text-xs text-[var(--muted-foreground)]">tokens saved</span>
        <span className="ml-auto text-sm font-semibold text-[var(--success)]">{displayPct.toFixed(2)}%</span>
      </div>

      <div
        className="mt-1 text-[11px] text-[var(--muted-foreground)]"
        title={
          hasProviderTruth
            ? `Anchored to provider-reported prompt_tokens (${formatNum(promptTokens!)}). Internal estimate was ${formatNum(tokensBefore)} → ${formatNum(tokensAfter)}.`
            : "Internal char/4 estimate (provider usage not available)"
        }
      >
        {formatNum(displayBefore)} <span className="opacity-50">→</span> {formatNum(displayAfter)} tokens
        {hasProviderTruth && <span className="ml-1 opacity-50">· actual</span>}
      </div>

      {techEntries.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-2">
          <p className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">By technique</p>
          {techEntries.map(([key, value]) => {
            const pct = saved > 0 ? (value / saved) * 100 : 0;
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="flex-1 text-[var(--foreground)]">{TECHNIQUE_LABELS[key]}</span>
                <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]">
                  <div className="h-full bg-[var(--success)]" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <span className="w-16 text-right text-[var(--muted-foreground)]">−{formatNum(value)}</span>
              </div>
            );
          })}
        </div>
      )}

      {filterEntries.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            RTK filters ({filterEntries.length}) <span className="opacity-50 group-open:hidden">▸</span><span className="opacity-50 hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-1 space-y-1">
            {filterEntries.map(([name, value]) => {
              const rtkTotal = byTechnique.rtk ?? 0;
              const pct = rtkTotal > 0 ? (value / rtkTotal) * 100 : 0;
              return (
                <div key={name} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 pl-2 text-[var(--muted-foreground)]">{RTK_FILTER_LABELS[name] ?? name}</span>
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]">
                    <div className="h-full bg-[var(--success)]/60" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                  <span className="w-16 text-right text-[var(--muted-foreground)]">−{formatNum(value)}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value || {}, null, 2);
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs uppercase text-[var(--muted-foreground)]">{title}</p>
        <button className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => navigator.clipboard.writeText(text)}>Copy</button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-black/30 p-3 text-xs text-[var(--muted-foreground)]">{text}</pre>
    </div>
  );
}
