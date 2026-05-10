import StatsCards from "@/components/dashboard/StatsCards";
import ProviderCards from "@/components/dashboard/ProviderCards";
import TokenUsage from "@/components/dashboard/TokenUsage";
import { useEffect, useState } from "react";
import { fetchDashboardStats, fetchModelUsage, fetchProviders, runPollingLoop } from "@/lib/api";
import { modelColor } from "@/lib/utils";

const providerMeta: Record<string, { name: string; color: string; bgColor: string }> = {
  kiro: { name: "Kiro", color: "#3b82f6", bgColor: "bg-blue-500/10" },
  "kiro-pro": { name: "Kiro Pro", color: "#f59e0b", bgColor: "bg-amber-500/10" },
  codebuddy: { name: "CodeBuddy", color: "#8b5cf6", bgColor: "bg-purple-500/10" },
  canva: { name: "Canva", color: "#14b8a6", bgColor: "bg-teal-500/10" },
  zai: { name: "Z.ai", color: "#ef4444", bgColor: "bg-red-500/10" },
  moclaw: { name: "Moclaw", color: "#10b981", bgColor: "bg-emerald-500/10" },
};

const allowedProviders = new Set(Object.keys(providerMeta));

export default function Dashboard() {
  const [stats, setStats] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [modelStats, setModelStats] = useState<any[]>([]);

  async function load() {
    await Promise.all([
      fetchDashboardStats().then(setStats).catch(() => setStats(null)),
      fetchProviders().then((res: { data: any[] }) => setProviders(res.data || [])).catch(() => setProviders([])),
      fetchModelUsage().then((res: { data: any[] }) => setModelStats(res.data || [])).catch(() => setModelStats([])),
    ]);
  }

  useEffect(() => {
    const controller = new AbortController();
    runPollingLoop(load, 5000, controller.signal);
    return () => controller.abort();
  }, []);

  const totalRequests = Number(stats?.requests?.total || 0);
  const successRequests = Number(stats?.requests?.success || 0);
  const dashboardStats = {
    accounts: {
      active: Number(stats?.pool?.active || 0),
      total: Number(stats?.pool?.total || 0),
    },
    requests: totalRequests,
    successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(1)) : 0,
    uptime: `${Math.floor(performance.now() / 1000)}s`,
  };

  const providerCards = providers.filter((data: any) => allowedProviders.has(data.provider)).map((data: any) => {
    const provider = data.provider;
    const meta = providerMeta[provider] || { name: provider, color: "#6366f1", bgColor: "bg-indigo-500/10" };
    const total = Number(data.totalAccounts || data.total || 0);
    const active = Number(data.activeAccounts || data.active || 0);
    const quotaLimit = Number(data.quotaLimit || 0);
    const quotaRemaining = Number(data.quotaRemaining || 0);
    return {
      ...meta,
        accounts: {
          active,
        exhausted: Number(data.exhaustedAccounts || 0),
        error: Number(data.errorAccounts || 0),
        total,
      },
      credits: { used: Math.max(0, quotaLimit - quotaRemaining), total: quotaLimit, remaining: quotaRemaining },
    };
  });

  const tokenStats = {
    total: Number(stats?.tokens?.total || 0),
    prompt: Number(stats?.tokens?.prompt || 0),
    completion: Number(stats?.tokens?.completion || 0),
    credits: Number(stats?.tokens?.credits || 0),
  };

  const modelUsage = modelStats.filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.credits || 0) > 0).slice(0, 8).map((m, idx) => ({
    provider: m.provider || "unknown",
    model: m.model || "unknown",
    tokens: Number(m.totalTokens || 0),
    promptTokens: Number(m.promptTokens || 0),
    completionTokens: Number(m.completionTokens || 0),
    credits: Number(m.credits || 0),
    requests: Number(m.totalRequests || 0),
    creditSource: m.creditSource || "estimated",
    color: modelColor(`${m.provider || "unknown"}/${m.model || "unknown"}`, idx),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Dashboard</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Overview of your proxy pool status
        </p>
      </div>

      <StatsCards data={dashboardStats} />

      <div>
        <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">Providers</h2>
        <ProviderCards providers={providerCards} />
      </div>

      <TokenUsage stats={tokenStats} modelUsage={modelUsage} />
    </div>
  );
}
