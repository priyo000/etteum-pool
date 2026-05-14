import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { modelColor } from "@/lib/utils";

interface UsageChartProps {
  data?: any[];
  period?: string;
  colorsByModel?: Record<string, string>;
}

const defaultData: any[] = [];

function formatTokenCount(value: number) {
  const abs = Math.abs(value);
  const format = (num: number) => Number(num.toFixed(2)).toString();

  if (abs >= 1_000_000) return `${format(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${format(value / 1_000)}K`;
  return value.toString();
}

export default function UsageChart({ data = defaultData, colorsByModel = {} }: UsageChartProps) {
  const models = Object.keys(data[0] || {}).filter((k) => k !== "hour" && k !== "label");
  const colors = Object.fromEntries(models.map((model, index) => [model, colorsByModel[model] || modelColor(model, index)]));

  if (data.length === 0) {
    return (
      <div className="h-[300px] w-full flex items-center justify-center rounded-lg bg-[var(--secondary)] text-sm text-[var(--muted-foreground)]">
        No usage data yet
      </div>
    );
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            {models.map((model) => (
              <linearGradient key={model} id={`gradient-${model}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors[model]} stopOpacity={0.3} />
                <stop offset="95%" stopColor={colors[model]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#2d3748" />
          <XAxis
            dataKey="label"
            stroke="#6b7280"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="#6b7280"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatTokenCount(Number(value))}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const sorted = [...payload].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
              return (
                <div style={{ backgroundColor: "#1a1d27", border: "1px solid #2d3748", borderRadius: "8px", padding: "8px 12px" }}>
                  <p style={{ color: "#9ca3af", marginBottom: 4, fontSize: 12 }}>{label}</p>
                  {sorted.map((entry) => (
                    <p key={entry.name} style={{ color: entry.color, fontSize: 12, margin: "2px 0" }}>
                      {entry.name} : {formatTokenCount(Number(entry.value || 0))}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ color: "#9ca3af", fontSize: "12px" }}
          />
          {models.map((model) => (
            <Area
              key={model}
              type="monotone"
              dataKey={model}
              stroke={colors[model]}
              fill={`url(#gradient-${model})`}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
