import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchRequests, getWsBase } from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";

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
}

function getCreditMeta(req: RequestLog) {
  const body = req.requestBody as { _poolprox?: { creditSource?: string; creditUnit?: string; creditRate?: number } } | null | undefined;
  return body?._poolprox || {};
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
  }, [provider]);

  useEffect(() => {
    const ws = new WebSocket(`${getWsBase()}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "request_log") {
          setLogs((current) => [msg.data as RequestLog, ...current].slice(0, 100));
        }
      } catch {}
    };
    return () => { ws.close(); };
  }, [provider]);

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
      <div className="flex items-center justify-between">
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

      <div className="flex gap-3">
        <div className="relative max-w-sm flex-1">
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
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Model</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Duration</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Tokens</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Credits</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Account</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((req) => (
                  <tr key={req.id} onClick={() => setSelected(req)} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 cursor-pointer">
                    <td className="p-4 text-xs text-[var(--muted-foreground)] font-mono">{formatDateTimeID(req.createdAt)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)]">{labelProvider(req.provider)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)]">{req.model || "-"}</td>
                    <td className="p-4"><Badge variant={getStatusColor(req.status)}>{req.status}</Badge></td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)]">{req.durationMs ?? 0}ms</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{req.totalTokens || 0}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{Number(req.creditsUsed || 0).toFixed(2)}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)]">{req.accountEmail || (req.accountId ? `#${req.accountId}` : "-")}</td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No request logs yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
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
              <span className="text-[var(--muted-foreground)]">{selected.durationMs || 0}ms</span>
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

            <div className="mt-5 space-y-1">
              <p className="text-xs uppercase text-[var(--muted-foreground)]">Account</p>
              <p className="text-sm font-medium text-[var(--foreground)]">{selected.accountEmail || `#${selected.accountId}`}</p>
              <p className="text-xs text-[var(--muted-foreground)]">Credit: {selected.accountQuotaBefore ?? 0} → {selected.accountQuotaAfter ?? 0}</p>
            </div>

            {selected.errorMessage && (
              <div className="mt-5 rounded-md bg-red-500/10 p-3 text-sm text-red-400">{selected.errorMessage}</div>
            )}

            <JsonBlock title="Request Body" value={selected.requestBody} />
            <JsonBlock title="Response Body" value={selected.responseBody} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    blue: "bg-blue-500/10 text-blue-300",
    green: "bg-green-500/10 text-green-300",
    indigo: "bg-indigo-500/10 text-indigo-300",
    yellow: "bg-yellow-500/10 text-yellow-300",
  };
  return <div className={`rounded-md p-3 ${colors[color]}`}><p className="text-[10px] uppercase opacity-80">{label}</p><p className="font-bold">{value}</p></div>;
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
