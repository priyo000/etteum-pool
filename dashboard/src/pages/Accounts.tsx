import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogTrigger,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Plus, Upload, RefreshCw, Play, RotateCcw } from "lucide-react";
import {
  createAccount,
  fetchAccounts,
  fetchAuthQueue,
  fetchWarmupQueue,
  importAccounts,
  loginAccounts,
  loginAllAccounts,
  warmupAllAccounts,
} from "@/lib/api";

type Provider = "kiro" | "codebuddy" | "canva";

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["kiro", "codebuddy", "canva"];

function labelProvider(provider: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);

  const [addForm, setAddForm] = useState({ email: "", password: "", provider: "kiro" as Provider });
  const [bulkText, setBulkText] = useState("");
  const [bulkProviders, setBulkProviders] = useState<Provider[]>(["kiro", "codebuddy", "canva"]);
  const [bulkHeadless, setBulkHeadless] = useState(true);
  const [bulkConcurrency, setBulkConcurrency] = useState(2);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [accountsRes, queueRes, warmupQueueRes] = await Promise.all([
        fetchAccounts() as Promise<{ data: Account[] }>,
        fetchAuthQueue().catch(() => null),
        fetchWarmupQueue().catch(() => null),
      ]);
      setAccounts(accountsRes.data || []);
      setQueue(queueRes);
      setWarmupQueue(warmupQueueRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const active = Number(warmupQueue?.active || 0) + Number(queue?.active || 0);
    if (active === 0) return;
    const interval = setInterval(() => load(), 2000);
    return () => clearInterval(interval);
  }, [warmupQueue?.active, queue?.active]);

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleAdd() {
    try {
      await createAccount(addForm);
      showSuccess("Account added and bot login started.");
      setAddForm({ email: "", password: "", provider: "kiro" });
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleBulkImport() {
    if (bulkProviders.length === 0) { showError(new Error("Pilih minimal 1 provider.")); return; }
    try {
      const res = await importAccounts(bulkText, bulkProviders, { headless: bulkHeadless, concurrency: bulkConcurrency }) as any;
      showSuccess(res.message || "Bulk import queued.");
      setBulkText("");
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleLoginAll() {
    try { const res = await loginAllAccounts() as any; showSuccess(res.message || "Login all queued."); await load(); navigate("/bot-logs"); } catch (err) { showError(err); }
  }

  async function handleWarmupProvider(provider: Provider) {
    try {
      const res = await warmupAllAccounts({ providers: [provider], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || `${labelProvider(provider)} WarmUp queued.`);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleRetryErrors(provider: Provider) {
    const ids = accounts.filter((a) => a.provider === provider && a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} ${labelProvider(provider)} error accounts for retry.`);
    await load();
  }

  function toggleBulkProvider(provider: Provider) {
    setBulkProviders((c) => c.includes(provider) ? c.filter((p) => p !== provider) : [...c, provider]);
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
      };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Manage provider accounts</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleLoginAll}>
            <Play className="w-4 h-4 mr-2" /> Login Pending
          </Button>

          {/* Bulk Add */}
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm"><Upload className="w-4 h-4 mr-2" /> Bulk Add</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DTitle>Bulk Add Accounts</DTitle>
                <DialogDescription>Paste email|password lines, choose providers.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Providers</label>
                  <div className="flex gap-2 mt-2 flex-wrap">
                    {providers.map((p) => (
                      <button key={p} type="button" onClick={() => toggleBulkProvider(p)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium border ${bulkProviders.includes(p) ? "border-[var(--primary)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--muted-foreground)]"}`}
                      >{labelProvider(p)}</button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 rounded-md border border-[var(--border)] bg-[var(--secondary)] p-3 md:grid-cols-2">
                  <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                    <input type="checkbox" checked={bulkHeadless} onChange={(e) => setBulkHeadless(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                    Run browser headless
                  </label>
                  <div>
                    <label className="text-sm text-[var(--foreground)]">Parallel browsers</label>
                    <select value={bulkConcurrency} onChange={(e) => setBulkConcurrency(Number(e.target.value))} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                      {[1, 2, 3, 4, 5, 6, 7, 8].map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <p className="md:col-span-2 text-xs text-[var(--muted-foreground)]">Semakin banyak parallel browsers, butuh CPU/RAM lebih kuat.</p>
                </div>
                <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                  className="w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  placeholder="email@example.com|password123&#10;another@example.com|pass456" />
              </div>
              <div className="flex justify-end gap-2">
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button onClick={handleBulkImport}>Import & Queue Login</Button>
              </div>
            </DialogContent>
          </Dialog>

          {/* Add Account */}
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 mr-2" /> Add Account</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DTitle>Add Account</DTitle>
                <DialogDescription>Add a single provider account to the pool.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-[var(--foreground)]">Email</label>
                  <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" className="mt-1" />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Password</label>
                  <Input value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })} type="password" placeholder="********" className="mt-1" />
                </div>
                <div>
                  <label className="text-sm text-[var(--foreground)]">Provider</label>
                  <select value={addForm.provider} onChange={(e) => setAddForm({ ...addForm, provider: e.target.value as Provider })} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                    {providers.map((p) => <option key={p} value={p}>{labelProvider(p)}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
                <Button onClick={handleAdd}>Add Account</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
          {message || error}
        </div>
      )}

      {/* Queue status */}
      {(Number(queue?.active || 0) > 0 || Number(queue?.queued || 0) > 0 || Number(warmupQueue?.active || 0) > 0 || Number(warmupQueue?.queued || 0) > 0) && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-xs text-[var(--muted-foreground)]">
          Login: {Number(queue?.active || 0)} running, {Number(queue?.queued || 0)} queued
          {" | "}
          WarmUp: {Number(warmupQueue?.active || 0)} running, {Number(warmupQueue?.queued || 0)} queued
        </div>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providerStats.map((stat) => (
          <Card
            key={stat.provider}
            className="border-[var(--border)] cursor-pointer hover:border-[var(--primary)]/50 transition-colors"
            onClick={() => navigate(`/accounts/${stat.provider}`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{labelProvider(stat.provider)}</CardTitle>
                <span className="text-xs text-[var(--muted-foreground)]">{stat.total} accounts</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status grid */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-green-400">{stat.active}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Active</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-yellow-400">{stat.exhausted}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Exhausted</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-orange-400">{stat.pending}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Pending</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-red-400">{stat.error}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Error</p>
                </div>
              </div>

              {/* Buttons */}
              <div className="grid grid-cols-2 gap-2" onClick={(e) => e.stopPropagation()}>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleWarmupProvider(stat.provider)} disabled={stat.provider === "canva"}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Warmup All
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleRetryErrors(stat.provider)} disabled={stat.error === 0}>
                  <RotateCcw className="mr-2 h-4 w-4" /> Retry Errors
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
