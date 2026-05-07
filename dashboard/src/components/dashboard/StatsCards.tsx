import { Users, Activity, CheckCircle, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface StatsData {
  accounts: { active: number; total: number };
  requests: number;
  successRate: number;
  uptime: string;
}

interface StatsCardsProps {
  data?: StatsData;
}

const defaultData: StatsData = {
  accounts: { active: 0, total: 0 },
  requests: 0,
  successRate: 0,
  uptime: "0ms",
};

export default function StatsCards({ data = defaultData }: StatsCardsProps) {
  const stats = [
    {
      label: "Accounts",
      value: `${data.accounts.active}/${data.accounts.total}`,
      subtitle: `${data.accounts.active} active`,
      icon: Users,
      color: "text-blue-400",
      bgColor: "bg-blue-400/10",
    },
    {
      label: "Requests",
      value: data.requests.toLocaleString(),
      subtitle: "Last 24h",
      icon: Activity,
      color: "text-purple-400",
      bgColor: "bg-purple-400/10",
    },
    {
      label: "Success Rate",
      value: `${data.successRate}%`,
      subtitle: "All time",
      icon: CheckCircle,
      color: "text-green-400",
      bgColor: "bg-green-400/10",
    },
    {
      label: "Uptime",
      value: data.uptime,
      subtitle: "Last 30 days",
      icon: Clock,
      color: "text-orange-400",
      bgColor: "bg-orange-400/10",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="border-[var(--border)]">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wide">
                  {stat.label}
                </p>
                <p className="text-2xl font-bold mt-1 text-[var(--foreground)]">
                  {stat.value}
                </p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                  {stat.subtitle}
                </p>
              </div>
              <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`w-5 h-5 ${stat.color}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
