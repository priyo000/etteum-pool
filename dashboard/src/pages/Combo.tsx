import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Layers, Plus, Trash2, Power, PowerOff, Pencil, X, GripVertical, ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComboStep {
  provider: string;
  model: string;
}

interface ComboRule {
  id: number;
  name: string;
  modelId: string;
  triggerModel: string;
  matchType: "exact" | "contains" | "prefix";
  steps: ComboStep[];
  maxRetries: number;
  retryOn: string[];
  enabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string | null;
}

interface ComboListResponse {
  data: ComboRule[];
  enabled: boolean;
}

interface AvailableModels {
  data: Record<string, { id: string; name: string }[]>;
}

interface ComboStatsResponse {
  data: Array<{
    ruleName: string;
    total: number;
    success: number;
    error: number;
    avgDurationMs: number;
    steps: Array<{ step: string; count: number }>;
  }>;
  recent: any[];
}

interface FormState {
  id: number | null;
  name: string;
  modelId: string;
  triggerModel: string;
  matchType: "exact" | "contains" | "prefix";
  steps: ComboStep[];
  maxRetries: number;
  retryOn: string[];
  enabled: boolean;
  priority: number;
}

const RETRY_OPTIONS = [
  { value: "quota_exhausted", label: "Quota Exhausted" },
  { value: "rate_limit", label: "Rate Limited (429)" },
  { value: "error", label: "Server Error" },
  { value: "timeout", label: "Timeout" },
];

const emptyForm: FormState = {
  id: null,
  name: "",
  modelId: "",
  triggerModel: "",
  matchType: "contains",
  steps: [{ provider: "", model: "" }],
  maxRetries: 3,
  retryOn: ["quota_exhausted", "rate_limit", "error", "timeout"],
  enabled: true,
  priority: 0,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Combo() {
  const [rules, setRules] = useState<ComboRule[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [availableModels, setAvailableModels] = useState<Record<string, { id: string; name: string }[]>>({});
  const [expandedRule, setExpandedRule] = useState<number | null>(null);
  const [stats, setStats] = useState<ComboStatsResponse>({ data: [], recent: [] });
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const load = useCallback(async () => {
    try {
      const [rulesRes, modelsRes, statsRes] = await Promise.all([
        fetchApi<ComboListResponse>("/api/combo"),
        fetchApi<AvailableModels>("/api/combo/models"),
        fetchApi<ComboStatsResponse>("/api/combo/stats"),
      ]);
      setRules(rulesRes.data);
      setGlobalEnabled(rulesRes.enabled);
      setAvailableModels(modelsRes.data);
      setStats(statsRes);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleGlobal() {
    try {
      await fetchApi("/api/combo/toggle", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !globalEnabled }),
      });
      setGlobalEnabled(!globalEnabled);
      setMessage(`Combo ${!globalEnabled ? "enabled" : "disabled"}`);
    } catch {
      setMessage("Failed to toggle combo");
    }
  }

  async function toggleRule(rule: ComboRule) {
    try {
      await fetchApi(`/api/combo/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await load();
    } catch {
      setMessage("Failed to toggle rule");
    }
  }

  async function deleteRule(id: number) {
    if (!confirm("Delete this combo rule?")) return;
    try {
      await fetchApi(`/api/combo/${id}`, { method: "DELETE" });
      await load();
      setMessage("Rule deleted");
    } catch {
      setMessage("Failed to delete rule");
    }
  }

  async function testRule(rule: ComboRule) {
    const model = rule.modelId || rule.triggerModel;
    setTestingModel(model);
    try {
      const res = await fetchApi<any>("/api/combo/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "Reply with OK only.", maxTokens: 32 }),
        timeoutMs: 120_000,
      });
      const used = res.comboInfo ? `${res.comboInfo.usedProvider}/${res.comboInfo.usedModel}` : `${res.provider}/${res.responseModel || model}`;
      setMessage(`Test passed: ${model} → ${used}`);
      await load();
    } catch {
      setMessage(`Test failed for ${model}`);
    } finally {
      setTestingModel(null);
    }
  }

  async function exportRules() {
    try {
      const data = await fetchApi<any>("/api/combo/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `combo-rules-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage("Failed to export rules");
    }
  }

  async function importRules() {
    const raw = prompt("Paste combo export JSON here:");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const replace = confirm("Replace existing combo rules? Click Cancel to merge.");
      const res = await fetchApi<any>("/api/combo/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, replace }),
      });
      setMessage(`Imported ${res.imported || 0} rules`);
      await load();
    } catch {
      setMessage("Failed to import rules");
    }
  }

  async function saveForm() {
    if (!form) return;
    if (!form.triggerModel.trim()) {
      setMessage("Trigger model is required");
      return;
    }
    if (form.steps.length === 0 || form.steps.some((s) => !s.provider || !s.model)) {
      setMessage("All steps must have provider and model");
      return;
    }

    try {
      if (form.id) {
        await fetchApi(`/api/combo/${form.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        setMessage("Rule updated");
      } else {
        await fetchApi("/api/combo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        setMessage("Rule created");
      }
      setForm(null);
      await load();
    } catch {
      setMessage("Failed to save rule");
    }
  }

  function editRule(rule: ComboRule) {
    setForm({
      id: rule.id,
      name: rule.name,
      modelId: rule.modelId || "",
      triggerModel: rule.triggerModel,
      matchType: rule.matchType,
      steps: [...rule.steps],
      maxRetries: rule.maxRetries,
      retryOn: [...rule.retryOn],
      enabled: rule.enabled,
      priority: rule.priority,
    });
  }

  function addStep() {
    if (!form) return;
    setForm({ ...form, steps: [...form.steps, { provider: "", model: "" }] });
  }

  function removeStep(index: number) {
    if (!form || form.steps.length <= 1) return;
    setForm({ ...form, steps: form.steps.filter((_, i) => i !== index) });
  }

  function moveStep(index: number, direction: "up" | "down") {
    if (!form) return;
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= form.steps.length) return;
    const steps = [...form.steps];
    const tmp = steps[index]!;
    steps[index] = steps[target]!;
    steps[target] = tmp;
    setForm({ ...form, steps });
  }

  function updateStep(index: number, field: "provider" | "model", value: string) {
    if (!form) return;
    const steps = [...form.steps];
    steps[index] = { ...steps[index]!, [field]: value };
    // If provider changed, reset model
    if (field === "provider") {
      steps[index]!.model = "";
    }
    setForm({ ...form, steps });
  }

  function toggleRetryOn(value: string) {
    if (!form) return;
    const retryOn = form.retryOn.includes(value)
      ? form.retryOn.filter((v) => v !== value)
      : [...form.retryOn, value];
    setForm({ ...form, retryOn });
  }

  const providerNames = Object.keys(availableModels);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="h-6 w-6" /> Combo Fallback
          </h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Automatically fallback to another provider + model when a request fails
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportRules}>
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={importRules}>
            Import
          </Button>
          <Button
            variant={globalEnabled ? "default" : "outline"}
            size="sm"
            onClick={toggleGlobal}
          >
            {globalEnabled ? <Power className="h-4 w-4 mr-1" /> : <PowerOff className="h-4 w-4 mr-1" />}
            {globalEnabled ? "Enabled" : "Disabled"}
          </Button>
          <Button size="sm" onClick={() => setForm({ ...emptyForm })}>
            <Plus className="h-4 w-4 mr-1" /> New Rule
          </Button>
        </div>
      </div>

      {message && (
        <div className="text-sm px-3 py-2 rounded bg-[var(--accent)] text-[var(--accent-foreground)]">
          {message}
        </div>
      )}

      {stats.data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {stats.data.slice(0, 3).map((s) => (
            <Card key={s.ruleName}>
              <CardContent className="py-3">
                <div className="text-xs text-[var(--muted-foreground)]">{s.ruleName}</div>
                <div className="text-2xl font-semibold">{s.total}</div>
                <div className="text-xs text-[var(--muted-foreground)]">
                  {s.success} success · {s.error} error · avg {s.avgDurationMs}ms
                </div>
                {s.steps[0] && (
                  <div className="text-xs mt-2 font-mono truncate text-blue-400">
                    top: {s.steps[0].step} ({s.steps[0].count})
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Form */}
      {form && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between">
              {form.id ? "Edit Combo Rule" : "New Combo Rule"}
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                <X className="h-4 w-4" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Model ID */}
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)]">Model ID (custom name)</label>
              <Input
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value.replace(/\s/g, '-') })}
                placeholder="e.g. best, fast, auto-opus"
                className="font-mono"
              />
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                The custom model name shown in <code className="bg-[var(--accent)] px-1 rounded">/v1/models</code> and selectable by clients.
                Example: <code className="bg-[var(--accent)] px-1 rounded">best</code>, <code className="bg-[var(--accent)] px-1 rounded">auto-opus</code>
              </p>
            </div>

            {/* Name + Trigger */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">Rule Name</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Opus fallback chain"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">Trigger Model (pattern fallback)</label>
                <Input
                  value={form.triggerModel}
                  onChange={(e) => setForm({ ...form, triggerModel: e.target.value })}
                  placeholder="e.g. opus, kr-claude-sonnet, cb-opus"
                />
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Pattern used to match other models that should also trigger this combo</p>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">Match Type</label>
                <select
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm"
                  value={form.matchType}
                  onChange={(e) => setForm({ ...form, matchType: e.target.value as any })}
                >
                  <option value="contains">Contains</option>
                  <option value="exact">Exact</option>
                  <option value="prefix">Prefix</option>
                </select>
              </div>
            </div>

            {/* Fallback Steps */}
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)] mb-2 block">
                Fallback Chain (in order)
              </label>
              <div className="space-y-2">
                {form.steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-[var(--muted-foreground)] w-6 text-center font-mono">
                      {i + 1}.
                    </span>
                    <div className="flex flex-col">
                      <button
                        type="button"
                        className="h-4 w-5 flex items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] disabled:opacity-20 disabled:cursor-not-allowed"
                        onClick={() => moveStep(i, "up")}
                        disabled={i === 0}
                        title="Move up"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="h-4 w-5 flex items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--accent)] disabled:opacity-20 disabled:cursor-not-allowed"
                        onClick={() => moveStep(i, "down")}
                        disabled={i === form.steps.length - 1}
                        title="Move down"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>
                    <select
                      className="flex-1 h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm"
                      value={step.provider}
                      onChange={(e) => updateStep(i, "provider", e.target.value)}
                    >
                      <option value="">Select provider...</option>
                      {providerNames.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                    <select
                      className="flex-1 h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm"
                      value={step.model}
                      onChange={(e) => updateStep(i, "model", e.target.value)}
                      disabled={!step.provider}
                    >
                      <option value="">Select model...</option>
                      {(availableModels[step.provider] || []).map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeStep(i)}
                      disabled={form.steps.length <= 1}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="mt-2" onClick={addStep}>
                <Plus className="h-3 w-3 mr-1" /> Add Step
              </Button>
            </div>

            {/* Options */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">Max Retries</label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={form.maxRetries}
                  onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })}
                />
                <p className="text-xs text-[var(--muted-foreground)] mt-1">0 = try all steps</p>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--muted-foreground)]">Priority</label>
                <Input
                  type="number"
                  min={0}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                />
                <p className="text-xs text-[var(--muted-foreground)] mt-1">Lower = evaluated first</p>
              </div>
            </div>

            {/* Retry On */}
            <div>
              <label className="text-xs font-medium text-[var(--muted-foreground)] mb-2 block">
                Retry On (conditions that trigger fallback)
              </label>
              <div className="flex flex-wrap gap-2">
                {RETRY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      form.retryOn.includes(opt.value)
                        ? "bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]"
                        : "bg-[var(--background)] text-[var(--muted-foreground)] border-[var(--border)] hover:bg-[var(--accent)]"
                    }`}
                    onClick={() => toggleRetryOn(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button onClick={saveForm}>
                {form.id ? "Update Rule" : "Create Rule"}
              </Button>
              <Button variant="outline" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rules List */}
      {loading ? (
        <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>
      ) : rules.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="h-12 w-12 mx-auto mb-3 text-[var(--muted-foreground)] opacity-40" />
            <p className="text-[var(--muted-foreground)]">No combo rules yet</p>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">
              Create a rule to automatically fallback to another provider when a request fails
            </p>
            <Button size="sm" className="mt-4" onClick={() => setForm({ ...emptyForm })}>
              <Plus className="h-4 w-4 mr-1" /> Create First Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id} className={!rule.enabled ? "opacity-50" : ""}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        rule.enabled && globalEnabled ? "bg-green-500" : "bg-gray-400"
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate flex items-center gap-2">
                        {rule.name || `Rule #${rule.id}`}
                        {(rule.modelId || rule.triggerModel) && (
                          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                            model: {rule.modelId || rule.triggerModel}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)] flex items-center gap-2 mt-0.5">
                        <span className="font-mono bg-[var(--accent)] px-1.5 py-0.5 rounded">
                          {rule.matchType}: {rule.triggerModel}
                        </span>
                        <span>→</span>
                        <span>{rule.steps.length} step{rule.steps.length > 1 ? "s" : ""}</span>
                        <span className="text-[var(--muted-foreground)]">·</span>
                        <span>max {rule.maxRetries || "∞"} retries</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
                    >
                      {expandedRule === rule.id ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => testRule(rule)}
                      disabled={testingModel === (rule.modelId || rule.triggerModel)}
                    >
                      {testingModel === (rule.modelId || rule.triggerModel) ? "Testing..." : "Test"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => toggleRule(rule)}>
                      {rule.enabled ? (
                        <Power className="h-4 w-4 text-green-500" />
                      ) : (
                        <PowerOff className="h-4 w-4" />
                      )}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => editRule(rule)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id)}>
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </div>

                {/* Expanded: show fallback chain */}
                {expandedRule === rule.id && (
                  <div className="mt-4 pt-3 border-t border-[var(--border)]">
                    <div className="text-xs font-medium text-[var(--muted-foreground)] mb-2">
                      Fallback Chain:
                    </div>
                    <div className="space-y-1">
                      {rule.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <span className="text-xs font-mono text-[var(--muted-foreground)] w-5">
                            {i + 1}.
                          </span>
                          <span className="font-medium text-blue-400">{step.provider}</span>
                          <span className="text-[var(--muted-foreground)]">/</span>
                          <span className="font-mono text-xs">{step.model}</span>
                          {i < rule.steps.length - 1 && (
                            <ArrowDown className="h-3 w-3 text-[var(--muted-foreground)] ml-1" />
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {rule.retryOn.map((r) => (
                        <span
                          key={r}
                          className="text-xs px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-foreground)]"
                        >
                          {r.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How Combo Works</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-[var(--muted-foreground)] space-y-2">
          <p>
            Combo automatically tries another provider + model when a request fails.
            For example, if <code className="bg-[var(--accent)] px-1 rounded">cb-opus-4.6</code> on CodeBuddy
            runs out of quota, combo can fallback to{" "}
            <code className="bg-[var(--accent)] px-1 rounded">kr-claude-sonnet-4.5</code> on Kiro.
          </p>
          <p>
            <strong>Trigger Model:</strong> Pattern matched against the model requested by the client.
            <br />
            <strong>Fallback Chain:</strong> Ordered provider+model steps to try when a request fails.
            <br />
            <strong>Retry On:</strong> Error conditions that trigger fallback (quota exhausted, rate limit, etc.).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
