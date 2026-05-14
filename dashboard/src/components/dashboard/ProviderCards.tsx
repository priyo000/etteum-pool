import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

interface ProviderData {
  name: string;
  color: string;
  bgColor: string;
  accounts: { active: number; exhausted: number; error: number; total: number };
  credits: { used: number; total: number; remaining?: number };
}

interface ProviderCardsProps {
  providers?: ProviderData[];
}

const defaultProviders: ProviderData[] = [];

export default function ProviderCards({ providers = defaultProviders }: ProviderCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {providers.map((provider) => {
        const usedPercentage = provider.credits.total > 0
          ? Math.round((provider.credits.used / provider.credits.total) * 100)
          : 0;
        const remaining = provider.credits.remaining ?? (provider.credits.total - provider.credits.used);

        return (
          <Card key={provider.name} className="border-[var(--border)]">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: provider.color }}
                  />
                  <CardTitle className="text-base">{provider.name}</CardTitle>
                </div>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {provider.accounts.active}/{provider.accounts.total} accounts
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status badges */}
              <div className="flex gap-2 flex-wrap">
                {provider.accounts.active > 0 && (
                  <Badge variant="success">{provider.accounts.active} active</Badge>
                )}
                {provider.accounts.exhausted > 0 && (
                  <Badge variant="warning">{provider.accounts.exhausted} exhausted</Badge>
                )}
                {provider.accounts.error > 0 && (
                  <Badge variant="error">{provider.accounts.error} error</Badge>
                )}
              </div>

              {/* Credits */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--muted-foreground)]">Credits</span>
                  <span className="text-[var(--foreground)]">
                    {provider.credits.used.toFixed(2)} / {provider.credits.total.toFixed(2)}
                  </span>
                </div>
                <Progress
                  value={usedPercentage}
                  indicatorClassName="rounded-full bg-[var(--progress-color)]"
                  style={{ ["--progress-color" as any]: provider.color }}
                  className="h-2"
                />
                <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
                  <span>{usedPercentage}% used</span>
                  <span>{remaining.toFixed(2)} remaining</span>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {providers.length === 0 && (
        <Card className="border-[var(--border)] col-span-full">
          <CardContent className="p-6 text-sm text-[var(--muted-foreground)]">
            No provider data yet. Add/login accounts to populate this section.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
