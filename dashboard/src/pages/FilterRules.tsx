import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Filter, Plus, Trash2, Power, PowerOff, Pencil, X } from "lucide-react";
import { fetchApi, getWsBase } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface FilterRule {
  id: number;
  ruleId: string;
  pattern: string;
  replacement: string;
  isActive: boolean;
  isRegex: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

interface FilterListResponse {
  count: number;
  activeCount: number;
  rules: FilterRule[];
}

interface RuleFormState {
  id: number | null;
  pattern: string;
  replacement: string;
  isRegex: boolean;
  isActive: boolean;
}

const emptyForm: RuleFormState = { id: null, pattern: "", replacement: "", isRegex: true, isActive: true };

export default function FilterRules() {
  const [data, setData] = useState<FilterListResponse>({ count: 0, activeCount: 0, rules: [] });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<RuleFormState | null>(null);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const load = useCallback(async () => {
    try {
      const result = await fetchApi<FilterListResponse>("/api/filters");
      setData(result);
    } catch {
      setData({ count: 0, activeCount: 0, rules: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const ws = new WebSocket(`${getWsBase()}/ws`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === "filter_rules_updated") load();
      } catch { /* ignore */ }
    };
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [load]);

  const handleToggle = async (rule: FilterRule) => {
    try {
      await fetchApi(`/api/filters/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to toggle rule");
    }
  };

  const handleDelete = async (rule: FilterRule) => {
    if (!confirm(`Delete rule "${rule.ruleId}"?`)) return;
    try {
      await fetchApi(`/api/filters/${rule.id}`, { method: "DELETE" });
      setMessage("Rule deleted");
      load();
    } catch (e: any) {
      setMessage(e.message || "Failed to delete rule");
    }
  };

  const handleSave = async () => {
    if (!form) return;
    if (!form.pattern.trim()) {
      setMessage("Pattern is required");
      return;
    }
    try {
      if (form.id == null) {
        await fetchApi("/api/filters", {
          method: "POST",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        setMessage("Rule created");
      } else {
        await fetchApi(`/api/filters/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            pattern: form.pattern,
            replacement: form.replacement,
            isRegex: form.isRegex,
            isActive: form.isActive,
          }),
        });
        setMessage("Rule updated");
      }
      setForm(null);
      load();
    } catch (e: any) {
      setMessage(e.message || "Save failed");
    }
  };

  const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Filter Rules</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Pre-request sanitizer rules to strip patterns that trigger upstream content moderation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">
            {data.activeCount}/{data.count} active
          </span>
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="w-3 h-3 mr-1" />
            Add Rule
          </Button>
        </div>
      </div>

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      {form && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="w-4 h-4" />
              {form.id == null ? "New Rule" : "Edit Rule"}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">Pattern</label>
              <textarea
                className="w-full h-[80px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                placeholder={form.isRegex ? "regex pattern (case-insensitive)" : "exact string to match"}
                value={form.pattern}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">Replacement</label>
              <textarea
                className="w-full h-[60px] px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                placeholder="(empty to remove the matched text)"
                value={form.replacement}
                onChange={(e) => setForm({ ...form, replacement: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isRegex}
                  onChange={(e) => setForm({ ...form, isRegex: e.target.checked })}
                />
                Regex
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSave}>Save</Button>
              <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Rules ({data.count})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
          ) : data.rules.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No rules. Click Add Rule to create one.</p>
          ) : (
            <div className="space-y-2">
              {data.rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between px-4 py-3 rounded-md bg-[var(--secondary)]"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-xs text-[var(--muted-foreground)] shrink-0 w-8">
                      #{rule.sortOrder}
                    </span>
                    <span className="font-mono text-xs text-[var(--muted-foreground)] shrink-0 w-32 truncate">
                      {rule.ruleId}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                        rule.isRegex ? "bg-blue-500/10 text-blue-500" : "bg-purple-500/10 text-purple-500"
                      }`}
                    >
                      {rule.isRegex ? "regex" : "string"}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                        rule.isActive ? "bg-green-500/10 text-green-500" : "bg-gray-500/10 text-gray-500"
                      }`}
                    >
                      {rule.isActive ? "active" : "off"}
                    </span>
                    <span className="font-mono text-sm truncate text-[var(--foreground)]" title={rule.pattern}>
                      {truncate(rule.pattern)}
                    </span>
                    {rule.replacement && (
                      <span className="font-mono text-xs text-[var(--muted-foreground)] truncate shrink-0" title={rule.replacement}>
                        → {truncate(rule.replacement, 30)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggle(rule)}
                      title={rule.isActive ? "Disable" : "Enable"}
                    >
                      {rule.isActive ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setForm({
                          id: rule.id,
                          pattern: rule.pattern,
                          replacement: rule.replacement,
                          isRegex: rule.isRegex,
                          isActive: rule.isActive,
                        })
                      }
                      title="Edit"
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(rule)}
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
