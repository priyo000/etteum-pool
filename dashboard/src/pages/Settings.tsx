import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, RefreshCw, Server, Zap, Activity } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchProviders,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
  zai: "Z.AI",
  windsurf: "Windsurf",
  moclaw: "Moclaw",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

type ProviderStats = {
  provider: string;
  activeAccounts?: number;
  totalAccounts?: number;
  exhaustedAccounts?: number;
  errorAccounts?: number;
};

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    proxy_port: "1630",
    dashboard_port: "1631",
    max_retries: "3",
    timeout_ms: "30000",
    rate_limit_per_minute: "60",
    log_level: "info",
    load_balancing_method: "round_robin",
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);
  const providerStatsApi = useApi<{ data: ProviderStats[] }>(fetchProviders, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );
  const providerStatsMap = useMemo(() => {
    const map = new Map<string, ProviderStats>();
    for (const row of providerStatsApi.data?.data || []) {
      map.set(row.provider, row);
    }
    return map;
  }, [providerStatsApi.data]);

  async function load() {
    const res = (await fetchSettings()) as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
    setDirty(false);
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "round_robin"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(form);
      setSavedAt(new Date());
      setDirty(false);
      setMessage("Settings saved.");
      providerStatsApi.refetch();
    } finally {
      setSaving(false);
    }
  }

  const globalMethod = form.load_balancing_method || "round_robin";
  const overrideCount = providers.filter(isOverride).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Settings</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Configure proxy and application settings
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-xs text-amber-400 px-2 py-1 rounded bg-amber-400/10">
              Unsaved changes
            </span>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-2" /> Reload
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            <Save className="w-4 h-4 mr-2" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md bg-green-500/10 p-3 text-sm text-green-400">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="border-[var(--border)]">
            <CardHeader>
              <CardTitle className="text-base">General</CardTitle>
              <CardDescription>
                Basic proxy configuration. Runtime ports are currently controlled by .env / bun start.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Proxy Port</label>
                  <Input
                    value={form.proxy_port || ""}
                    onChange={(e) => setValue("proxy_port", e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Dashboard Port</label>
                  <Input
                    value={form.dashboard_port || ""}
                    onChange={(e) => setValue("dashboard_port", e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Max Retries</label>
                  <Input
                    value={form.max_retries || ""}
                    onChange={(e) => setValue("max_retries", e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Timeout (ms)</label>
                  <Input
                    value={form.timeout_ms || ""}
                    onChange={(e) => setValue("timeout_ms", e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-[var(--border)]">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="w-4 h-4 text-[var(--primary)]" />
                Provider Settings
              </CardTitle>
              <CardDescription>
                Global default applies to all providers unless individually overridden.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
                <label className="text-sm font-medium text-[var(--foreground)]">
                  Global Load Balancing Method
                </label>
                <select
                  value={form.load_balancing_method || "round_robin"}
                  onChange={(e) => setValue("load_balancing_method", e.target.value)}
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
                >
                  <option value="round_robin">Round Robin</option>
                  <option value="sequential">Sequential</option>
                </select>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {globalMethod === "sequential"
                    ? "Uses accounts in order, moves to next only when current is exhausted."
                    : "Distributes requests evenly across all active accounts."}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--foreground)]">
                    Per-Provider Override
                  </span>
                  {providerListApi.loading && (
                    <span className="text-xs text-[var(--muted-foreground)]">Loading...</span>
                  )}
                </div>

                {providers.length === 0 && !providerListApi.loading && (
                  <p className="text-xs text-[var(--muted-foreground)]">
                    No providers configured.
                  </p>
                )}

                <div className="space-y-2">
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--secondary)] border border-transparent hover:border-[var(--border)] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2">
                            {labelFor(provider)}
                            {overriden && (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                                override
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-[var(--muted-foreground)]">
                            Active: {effective === "sequential" ? "Sequential" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 text-[var(--muted-foreground)]/70">
                                (inherits global)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            className="h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
                          >
                            <option value="">Inherit global</option>
                            <option value="round_robin">Round Robin</option>
                            <option value="sequential">Sequential</option>
                          </select>
                          {overriden && (
                            <button
                              type="button"
                              onClick={() => setValue(key, "")}
                              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1 rounded hover:bg-[var(--secondary)]"
                              title="Clear override"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-[var(--border)]">
            <CardHeader>
              <CardTitle className="text-base">Advanced</CardTitle>
              <CardDescription>Advanced proxy configuration stored in database.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">
                  Rate Limit (requests/min)
                </label>
                <Input
                  value={form.rate_limit_per_minute || ""}
                  onChange={(e) => setValue("rate_limit_per_minute", e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Log Level</label>
                <select
                  value={form.log_level || "info"}
                  onChange={(e) => setValue("log_level", e.target.value)}
                  className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
                >
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </CardContent>
          </Card>
        </div>

        <aside className="lg:col-span-1">
          <div className="lg:sticky lg:top-4 space-y-4">
            <Card className="border-[var(--border)]">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[var(--primary)]" />
                  Live Status
                </CardTitle>
                <CardDescription className="text-xs">
                  Snapshot of pool state with current settings.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Global method</span>
                  <span className="font-medium text-[var(--foreground)]">
                    {globalMethod === "sequential" ? "Sequential" : "Round Robin"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Last saved</span>
                  <span className="font-medium text-[var(--foreground)]">
                    {savedAt ? savedAt.toLocaleTimeString() : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Overrides</span>
                  <span className="font-medium text-[var(--foreground)]">
                    {overrideCount} / {providers.length}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card className="border-[var(--border)]">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Server className="w-4 h-4 text-[var(--primary)]" />
                  Pool Status
                </CardTitle>
                <CardDescription className="text-xs">
                  Active accounts per provider.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {providers.length === 0 && (
                  <p className="text-xs text-[var(--muted-foreground)]">
                    No providers available.
                  </p>
                )}
                {providers.map((provider) => {
                  const stats = providerStatsMap.get(provider);
                  const active = stats?.activeAccounts || 0;
                  const total = stats?.totalAccounts || 0;
                  const method = lbMethodFor(provider);
                  return (
                    <div
                      key={provider}
                      className="flex items-center justify-between gap-2 py-2 border-b border-[var(--border)] last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-[var(--foreground)] truncate">
                          {labelFor(provider)}
                        </p>
                        <p className="text-[10px] text-[var(--muted-foreground)]">
                          {method === "sequential" ? "Sequential" : "Round Robin"}
                          {isOverride(provider) && (
                            <span className="text-[var(--primary)]"> · override</span>
                          )}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-medium">
                          <span
                            className={
                              active > 0
                                ? "text-green-400"
                                : "text-[var(--muted-foreground)]"
                            }
                          >
                            {active}
                          </span>
                          <span className="text-[var(--muted-foreground)]"> / {total}</span>
                        </p>
                        <p className="text-[10px] text-[var(--muted-foreground)]">active</p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        </aside>
      </div>
    </div>
  );
}
