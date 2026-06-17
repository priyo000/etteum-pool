import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Filter, Copy, CheckCircle2, XCircle, Search, Plus, Loader2, Eye, EyeOff } from "lucide-react";
import { filterAccounts, bulkCreateAccounts } from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
  codex: "Codex",
  qoder: "Qoder",
};

export default function AccountFilter() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    totalInput: number;
    totalMissing: number;
    providers: Record<string, Array<{ email: string; password: string }>>;
  } | null>(null);
  const [copiedProvider, setCopiedProvider] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState<string | null>(null);
  const [addedProviders, setAddedProviders] = useState<Record<string, { added: number; failed: number }>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  async function handleFilter() {
    const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setError("Masukkan minimal 1 email:password");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await filterAccounts(lines);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function copyMissing(provider: string) {
    if (!result) return;
    const missing = result.providers[provider] || [];
    const text = missing.map((a) => `${a.email}:${a.password}`).join("\n");
    navigator.clipboard.writeText(text);
    setCopiedProvider(provider);
    setTimeout(() => setCopiedProvider(null), 2000);
  }

  function copyAllMissing() {
    if (!result) return;
    const lines: string[] = [];
    for (const [, accounts] of Object.entries(result.providers)) {
      for (const a of accounts) {
        const line = `${a.email}:${a.password}`;
        if (!lines.includes(line)) lines.push(line);
      }
    }
    navigator.clipboard.writeText(lines.join("\n"));
    setCopiedProvider("__all__");
    setTimeout(() => setCopiedProvider(null), 2000);
  }

  async function handleAddProvider(provider: string) {
    if (!result) return;
    const missing = result.providers[provider] || [];
    if (missing.length === 0) return;

    if (!confirm(`Tambah ${missing.length} akun ke ${PROVIDER_LABELS[provider] || provider}?`)) return;

    setAddingProvider(provider);
    setError(null);
    try {
      const accountsPayload = missing.map((a) => ({
        provider,
        email: a.email,
        password: a.password,
      }));
      const res = await bulkCreateAccounts(accountsPayload);
      setAddedProviders((prev) => ({
        ...prev,
        [provider]: { added: res.success, failed: res.failed },
      }));
      // Remove successfully added emails from missing list
      const successEmails = new Set(
        res.results.filter((r) => r.success).map((r) => r.email.toLowerCase())
      );
      setResult((prev) => {
        if (!prev) return prev;
        const newMissing = (prev.providers[provider] || []).filter(
          (a) => !successEmails.has(a.email.toLowerCase())
        );
        const newProviders = { ...prev.providers, [provider]: newMissing };
        const newTotalMissing = Object.values(newProviders).reduce((sum, arr) => sum + arr.length, 0);
        return { ...prev, providers: newProviders, totalMissing: newTotalMissing };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingProvider(null);
    }
  }

  function togglePassword(provider: string) {
    setShowPasswords((prev) => ({ ...prev, [provider]: !prev[provider] }));
  }

  const inputCount = input.split("\n").filter((l) => l.trim()).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Account Filter</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Cek akun mana yang belum terdaftar di setiap provider
        </p>
      </div>

      {/* Input */}
      <Card className="border-[var(--border)]">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="w-4 h-4 text-[var(--primary)]" />
            Input Accounts
          </CardTitle>
          <CardDescription>
            Paste daftar email:password (satu per baris). Sistem akan mengecek per provider mana yang belum ada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <textarea
            className="w-full h-48 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] font-mono placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] resize-y"
            placeholder={`email1@example.com:password1\nemail2@example.com:password2\nemail3@example.com:password3`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--muted-foreground)]">
              {inputCount} akun dimasukkan
            </span>
            <Button onClick={handleFilter} disabled={loading || inputCount === 0}>
              <Search className="w-4 h-4 mr-2" />
              {loading ? "Checking..." : "Filter Accounts"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 px-4 py-2">
              <p className="text-xs text-[var(--muted-foreground)]">Input</p>
              <p className="text-lg font-bold text-[var(--foreground)]">{result.totalInput}</p>
            </div>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 px-4 py-2">
              <p className="text-xs text-[var(--muted-foreground)]">Total Missing (semua provider)</p>
              <p className="text-lg font-bold text-[var(--warning)]">{result.totalMissing}</p>
            </div>
            <Button variant="outline" size="sm" onClick={copyAllMissing}>
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              {copiedProvider === "__all__" ? "Copied!" : "Copy All Missing (unique)"}
            </Button>
          </div>

          {/* Per-provider results */}
          <div className="grid gap-4 lg:grid-cols-2">
            {Object.entries(result.providers).map(([provider, missing]) => {
              const total = result.totalInput;
              const existing = total - missing.length;
              const allExist = missing.length === 0;

              return (
                <Card key={provider} className={`border-[var(--border)] ${allExist ? "opacity-60" : ""}`}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        {allExist
                          ? <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
                          : <XCircle className="w-4 h-4 text-[var(--warning)]" />}
                        {PROVIDER_LABELS[provider] || provider}
                      </CardTitle>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={allExist ? "success" : "warning"}>
                          {missing.length === 0 ? "Semua ada" : `${missing.length} belum ada`}
                        </Badge>
                        {missing.length > 0 && (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => togglePassword(provider)} title={showPasswords[provider] ? "Hide passwords" : "Show passwords"}>
                              {showPasswords[provider]
                                ? <EyeOff className="w-3.5 h-3.5" />
                                : <Eye className="w-3.5 h-3.5" />}
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => copyMissing(provider)} title="Copy missing">
                              {copiedProvider === provider
                                ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                                : <Copy className="w-3.5 h-3.5" />}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleAddProvider(provider)}
                              disabled={addingProvider === provider || !!addedProviders[provider]}
                              title={`Add ${missing.length} accounts to ${PROVIDER_LABELS[provider] || provider}`}
                              className="text-xs"
                            >
                              {addingProvider === provider ? (
                                <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Adding...</>
                              ) : addedProviders[provider] ? (
                                <><CheckCircle2 className="w-3.5 h-3.5 mr-1 text-[var(--success)]" /> Added {addedProviders[provider].added}</>
                              ) : (
                                <><Plus className="w-3.5 h-3.5 mr-1" /> Add {missing.length}</>
                              )}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {existing}/{total} sudah ada · {missing.length} belum ada
                    </p>
                  </CardHeader>
                  {missing.length > 0 && (
                    <CardContent className="pt-0 space-y-2">
                      {addedProviders[provider] && (
                        <div className="rounded-md bg-[var(--success)]/10 px-3 py-1.5 text-xs text-[var(--success)]">
                          ✅ {addedProviders[provider].added} akun berhasil ditambahkan
                          {addedProviders[provider].failed > 0 && (
                            <span className="text-[var(--error)] ml-2">· {addedProviders[provider].failed} gagal</span>
                          )}
                        </div>
                      )}
                      <div className="max-h-40 overflow-y-auto rounded border border-[var(--border)] bg-[var(--background)]">
                        <div className="divide-y divide-[var(--border)]">
                          {missing.slice(0, 100).map((a, i) => (
                            <div key={i} className="px-3 py-1.5 text-xs font-mono text-[var(--foreground)] truncate">
                              {a.email}
                              {showPasswords[provider] && (
                                <span className="text-[var(--muted-foreground)]">:{a.password}</span>
                              )}
                            </div>
                          ))}
                          {missing.length > 100 && (
                            <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)] text-center">
                              ... dan {missing.length - 100} lainnya
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
