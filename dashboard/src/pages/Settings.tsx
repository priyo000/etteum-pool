import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, RefreshCw } from "lucide-react";
import { fetchSettings, updateSettings } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    proxy_port: "1630",
    dashboard_port: "1631",
    max_retries: "3",
    timeout_ms: "30000",
    rate_limit_per_minute: "60",
    log_level: "info",
    provider_kiro_enabled: "true",
    provider_codebuddy_enabled: "true",
    provider_canva_enabled: "true",
  });
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  async function load() {
    const res = await fetchSettings() as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    await updateSettings(form);
    setMessage("Settings saved to PostgreSQL.");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Settings</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Configure proxy and application settings
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-4 h-4 mr-2" /> Reload
        </Button>
      </div>

      {message && <div className="rounded-md bg-green-500/10 p-3 text-sm text-green-400">{message}</div>}

      <div className="grid gap-6 max-w-2xl">
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base">General</CardTitle>
            <CardDescription>Basic proxy configuration. Runtime ports are currently controlled by .env / bun start.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Proxy Port</label>
                <Input value={form.proxy_port} onChange={(e) => setValue("proxy_port", e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Dashboard Port</label>
                <Input value={form.dashboard_port} onChange={(e) => setValue("dashboard_port", e.target.value)} className="mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Max Retries</label>
                <Input value={form.max_retries} onChange={(e) => setValue("max_retries", e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Timeout (ms)</label>
                <Input value={form.timeout_ms} onChange={(e) => setValue("timeout_ms", e.target.value)} className="mt-1" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base">Provider Settings</CardTitle>
            <CardDescription>Only Kiro, CodeBuddy, and Canva are supported.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {["kiro", "codebuddy", "canva"].map((provider) => {
              const key = `provider_${provider}_enabled`;
              const checked = form[key] !== "false";
              return (
                <div key={provider} className="flex items-center justify-between p-3 rounded-lg bg-[var(--secondary)]">
                  <div>
                    <p className="text-sm font-medium text-[var(--foreground)] capitalize">{provider === "codebuddy" ? "CodeBuddy" : provider}</p>
                    <p className="text-xs text-[var(--muted-foreground)]">Load balancing: Round Robin</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={checked} onChange={(e) => setValue(key, String(e.target.checked))} className="sr-only peer" />
                    <div className="w-9 h-5 bg-[var(--muted)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--primary)]"></div>
                  </label>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base">Advanced</CardTitle>
            <CardDescription>Advanced proxy configuration stored in database.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm text-[var(--foreground)]">Rate Limit (requests/min)</label>
              <Input value={form.rate_limit_per_minute} onChange={(e) => setValue("rate_limit_per_minute", e.target.value)} className="mt-1" />
            </div>
            <div>
              <label className="text-sm text-[var(--foreground)]">Log Level</label>
              <select value={form.log_level} onChange={(e) => setValue("log_level", e.target.value)} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warning</option>
                <option value="error">Error</option>
              </select>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save}>
            <Save className="w-4 h-4 mr-2" /> Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
