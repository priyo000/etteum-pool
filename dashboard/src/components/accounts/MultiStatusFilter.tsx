import { Badge } from "@/components/ui/badge";

export type AccountStatus = "active" | "exhausted" | "error" | "pending" | "disabled";

const ALL_STATUSES: readonly AccountStatus[] = [
  "active",
  "exhausted",
  "error",
  "pending",
  "disabled",
];

export type EnabledFilter = "all" | "enabled" | "disabled";

interface MultiStatusFilterProps {
  /** Selected statuses. Empty array = "all" (no status filter applied). */
  statuses: AccountStatus[];
  onStatusesChange: (next: AccountStatus[]) => void;
  /** Optional secondary filter on the boolean `enabled` column. */
  enabledFilter?: EnabledFilter;
  onEnabledFilterChange?: (next: EnabledFilter) => void;
  /** Counts per status for the summary chip. */
  counts?: Partial<Record<AccountStatus | "all", number>>;
}

const STATUS_COLOR: Record<AccountStatus, string> = {
  active:    "var(--success)",
  exhausted: "var(--warning)",
  error:     "var(--error)",
  pending:   "var(--muted-foreground)",
  disabled:  "var(--muted-foreground)",
};

/**
 * Multi-status filter for AccountList. Replaces the legacy single-status
 * filter — clicking statuses TOGGLES them in/out of the visible set.
 *
 *   - "All" / "None" shortcuts at the start
 *   - Each status chip shows live count
 *   - Optional enabled/disabled radio for the `enabled` boolean column
 */
export function MultiStatusFilter({
  statuses,
  onStatusesChange,
  enabledFilter = "all",
  onEnabledFilterChange,
  counts,
}: MultiStatusFilterProps) {
  const all = statuses.length === 0 || statuses.length === ALL_STATUSES.length;

  function toggleStatus(s: AccountStatus) {
    if (statuses.includes(s)) {
      onStatusesChange(statuses.filter((x) => x !== s));
    } else {
      onStatusesChange([...statuses, s]);
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onStatusesChange([])}
          className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
            all
              ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
          }`}
        >
          All
          {counts?.all !== undefined && (
            <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
              ({counts.all})
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onStatusesChange([...ALL_STATUSES])}
          className="px-2 py-1 text-[10px] rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          title="Select all statuses"
        >
          all+
        </button>

        {ALL_STATUSES.map((s) => {
          const active = statuses.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors ${
                active
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: STATUS_COLOR[s] }}
              />
              {s.charAt(0).toUpperCase() + s.slice(1)}
              {counts?.[s] !== undefined && (
                <span className="text-[10px] text-[var(--muted-foreground)]">
                  ({counts[s]})
                </span>
              )}
            </button>
          );
        })}
      </div>

      {onEnabledFilterChange && (
        <div className="flex items-center gap-1.5 sm:ml-2">
          <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            Toggle
          </span>
          {(["all", "enabled", "disabled"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => onEnabledFilterChange(opt)}
              className={`px-2 py-1 text-[11px] rounded-md border transition-colors ${
                enabledFilter === opt
                  ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
              }`}
            >
              {opt === "all" ? "Any" : opt[0].toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Active selection summary, only when partial */}
      {!all && statuses.length > 0 && (
        <Badge variant="outline" className="text-[10px]">
          {statuses.length} status{statuses.length === 1 ? "" : "es"} active
        </Badge>
      )}
    </div>
  );
}
