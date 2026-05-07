import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Cpu, Brain, Sparkles, Image, Copy, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchModels } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  tier?: "standard" | "max";
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

const providerColors: Record<string, string> = {
  kiro: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  codebuddy: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  canva: "bg-teal-500/20 text-teal-400 border-teal-500/30",
};

const tierColors: Record<string, string> = {
  standard: "bg-emerald-500/20 text-emerald-400",
  max: "bg-amber-500/20 text-amber-400",
};

const providerIcons: Record<string, typeof Cpu> = {
  kiro: Cpu,
  codebuddy: Brain,
  canva: Image,
};

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);

  useEffect(() => {
    fetchModels()
      .then((res: { data: ModelData[] }) => {
        setModels(res.data || []);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const providers = ["all", ...new Set(models.map((m) => m.owned_by))];
  const filtered = filter === "all" ? models : models.filter((m) => m.owned_by === filter);

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  // Group by provider
  const grouped = filtered.reduce<Record<string, ModelData[]>>((acc, m) => {
    const key = m.owned_by;
    if (!acc[key]) acc[key] = [];
    acc[key].push(m);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            {models.length} models available across {new Set(models.map((m) => m.owned_by)).size} providers
          </p>
        </div>
        <div className="flex gap-2">
          {providers.map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filter === p
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {Object.entries(grouped).map(([provider, providerModels]) => {
        const Icon = providerIcons[provider] || Cpu;
        const tier = providerModels[0]?.tier;

        return (
          <div key={provider} className="space-y-3">
            <div className="flex items-center gap-3">
              <Icon className="w-5 h-5 text-[var(--muted-foreground)]" />
              <h2 className="text-lg font-semibold text-[var(--foreground)] capitalize">
                {provider}
              </h2>
              {tier && (
                <Badge className={tierColors[tier]}>
                  {tier.toUpperCase()}
                </Badge>
              )}
              <span className="text-xs text-[var(--muted-foreground)]">
                {providerModels.length} model{providerModels.length > 1 ? "s" : ""}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {providerModels.map((model) => (
                <Card key={model.id} className="border-[var(--border)] hover:border-[var(--muted-foreground)]/30 transition-colors">
                  <CardHeader className="pb-2 pt-4 px-4">
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => copyModelId(model.id)}
                        title={`Copy model ID: ${model.id}`}
                        className="group min-w-0 flex-1 text-left"
                      >
                        <CardTitle className="flex items-center gap-2 text-sm font-medium truncate group-hover:text-blue-400 transition-colors">
                          <span className="truncate">{model.id}</span>
                          {copiedModel === model.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                          ) : (
                            <Copy className="w-3.5 h-3.5 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
                          )}
                        </CardTitle>
                      </button>
                      {model.thinking && <Sparkles className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 ml-2" />}
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${providerColors[model.owned_by] || "bg-gray-500/20 text-gray-400"}`}>
                        {model.owned_by}
                      </span>
                      {model.tier && (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tierColors[model.tier]}`}>
                          {model.tier}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                      <div>
                        <p className="text-[var(--muted-foreground)]">Context</p>
                        <p className="text-[var(--foreground)] font-medium">
                          {formatNumber(model.context_window)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[var(--muted-foreground)]">Output</p>
                        <p className="text-[var(--foreground)] font-medium">
                          {formatNumber(model.max_output)}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        );
      })}

      {models.length === 0 && (
        <Card className="border-[var(--border)]">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Cpu className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
            <p className="text-[var(--muted-foreground)]">No models available</p>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">
              Check your API key and server connection
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
