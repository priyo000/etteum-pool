import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import UsageChart from "./UsageChart";
import { formatNumber, parseUtcDate } from "@/lib/utils";
import { fetchUsage, runPollingLoop } from "@/lib/api";

interface TokenStats {
  total: number;
  prompt: number;
  completion: number;
  credits?: number;
}

interface ModelUsage {
  provider?: string;
  model: string;
  tokens: number;
  promptTokens?: number;
  completionTokens?: number;
  credits?: number;
  requests?: number;
  creditSource?: string;
  color: string;
}

interface TokenUsageProps {
  stats?: TokenStats;
  modelUsage?: ModelUsage[];
}

const defaultStats: TokenStats = {
  total: 0,
  prompt: 0,
  completion: 0,
  credits: 0,
};

const defaultModelUsage: ModelUsage[] = [];

/**
 * Backend buckets usage by the browser timezone and returns each bucket start as UTC ISO.
 * The browser uses local-time bucket generation so daily/monthly ranges align with the UI date.
 */

function getChartHours(period: string) {
  if (period === "1d") return 24;
  if (period === "7d") return 24 * 7;
  if (period === "30d") return 24 * 30;
  return null;
}

function modelKey(row: { provider?: string; model?: string }) {
  return `${row.provider || "unknown"}/${row.model || "unknown"}`;
}

/** Truncate a Date to the start of its hour in the user's timezone */
function truncHourLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

/** Truncate a Date to the start of its day in the user's timezone */
function truncDayLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Truncate a Date to the start of its month in the user's timezone */
function truncMonthLocal(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Convert a backend hour key (ISO UTC) to a numeric bucket key (epoch ms) */
function parseBucketKey(isoKey: string): number {
  return parseUtcDate(isoKey).getTime();
}

/** Format a bucket epoch to a display label in user's local timezone */
function formatLabel(epoch: number, period: string): string {
  const d = new Date(epoch);
  if (period === "1d") {
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  if (period === "7d" || period === "30d") {
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Generate ordered bucket epochs for the chart */
function generateBuckets(period: string, hours: number): number[] {
  const now = Date.now();
  const buckets: number[] = [];

  if (period === "1d") {
    const start = truncHourLocal(new Date(now - hours * 3600_000));
    for (let i = 0; i <= hours; i++) {
      buckets.push(start + i * 3600_000);
    }
    return buckets;
  }

  if (period === "7d" || period === "30d") {
    const days = period === "7d" ? 7 : 30;
    const start = new Date(truncDayLocal(new Date(now - days * 86400_000)));
    for (let i = 0; i <= days; i++) {
      buckets.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime());
    }
    return buckets;
  }

  // all
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    buckets.push(truncMonthLocal(new Date(d.getFullYear(), d.getMonth() - i, 1)));
  }
  return buckets;
}

function rowsToModelChart(rows: Array<{ hour: string; provider?: string; model?: string; tokens?: number }>, period: string, hours: number) {
  const models = Array.from(new Set(rows.map(modelKey)));
  const bucketEpochs = generateBuckets(period, hours);
  const bucketSet = new Set(bucketEpochs);

  // Initialize all buckets
  const byEpoch = new Map<number, Record<string, number | string>>();
  for (const epoch of bucketEpochs) {
    const entry: Record<string, number | string> = { hour: String(epoch), label: formatLabel(epoch, period) };
    for (const model of models) entry[model] = 0;
    byEpoch.set(epoch, entry);
  }

  // Map backend data to buckets
  for (const row of rows) {
    const epoch = parseBucketKey(row.hour);
    const model = modelKey(row);
    // Find the matching bucket (exact match since backend truncates the same way)
    const bucket = byEpoch.get(epoch);
    if (bucket) {
      bucket[model] = Number(bucket[model] || 0) + Number(row.tokens || 0);
    }
    // Data outside the bucket range is simply ignored (old data)
  }

  return bucketEpochs.map((epoch) => byEpoch.get(epoch)!);
}

export default function TokenUsage({
  stats = defaultStats,
  modelUsage = defaultModelUsage,
}: TokenUsageProps) {
  const [period, setPeriod] = useState("1d");
  const [chartData, setChartData] = useState<any[]>([]);
  const maxTokens = Math.max(1, ...modelUsage.map((m) => Number(m.tokens || 0)));
  const colorsByModel = Object.fromEntries(
    modelUsage.map((model) => [`${model.provider || "unknown"}/${model.model || "unknown"}`, model.color]),
  );

  useEffect(() => {
    const hours = getChartHours(period);
    const controller = new AbortController();
    runPollingLoop(async () => {
      try {
        const res = await fetchUsage(hours, period === "all" ? "all" : undefined) as { data: Array<{ hour: string; provider?: string; model?: string; tokens?: number }> };
        setChartData(rowsToModelChart(res.data || [], period, hours || 24 * 365));
      } catch {
        setChartData([]);
      }
    }, 5000, controller.signal);
    return () => controller.abort();
  }, [period]);

  return (
    <Card className="border-[var(--border)]">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Token Usage</CardTitle>
          <Tabs value={period} onValueChange={setPeriod}>
            <TabsList>
              <TabsTrigger value="1d">1d</TabsTrigger>
              <TabsTrigger value="7d">7d</TabsTrigger>
              <TabsTrigger value="30d">30d</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Total</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.total)}</p>
          </div>
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Prompt</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.prompt)}</p>
          </div>
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Completion</p>
            <p className="text-xl font-bold mt-1">{formatNumber(stats.completion)}</p>
          </div>
          <div className="rounded-lg bg-[var(--secondary)] p-4">
            <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">Credits</p>
            <p className="text-xl font-bold mt-1">{Number(stats.credits || 0).toFixed(2)}</p>
          </div>
        </div>

        {/* Chart */}
        <div>
          <h4 className="text-sm font-medium text-[var(--muted-foreground)] mb-4">Token Usage Over Time</h4>
          <UsageChart data={chartData} period={period} colorsByModel={colorsByModel} />
        </div>

        {/* By Model */}
        <div>
          <h4 className="text-sm font-medium text-[var(--muted-foreground)] mb-4">By Model</h4>
          <div className="space-y-3">
            {modelUsage.map((model) => (
              <div key={`${model.provider || "unknown"}/${model.model}`} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-[var(--foreground)]">{model.provider ? `${model.provider}/` : ""}{model.model}</span>
                    <span className="ml-2 text-[10px] uppercase text-[var(--muted-foreground)]">{model.creditSource || "estimated"}</span>
                  </div>
                  <span className="shrink-0 text-[var(--muted-foreground)]">
                    {Number(model.credits || 0).toFixed(2)} credits · {formatNumber(model.tokens)} tokens · {model.requests || 0} req
                  </span>
                </div>
                <div className="h-2 rounded-full bg-[var(--secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(Number(model.tokens || 0) / maxTokens) * 100}%`,
                      backgroundColor: model.color,
                    }}
                  />
                </div>
              </div>
            ))}
            {modelUsage.length === 0 && (
              <p className="text-sm text-[var(--muted-foreground)]">No model usage yet</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
