import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface QuotaRangeFilterProps {
  /** Current min (inclusive). undefined = no lower bound. */
  min?: number;
  /** Current max (inclusive). undefined = no upper bound. */
  max?: number;
  onChange: (next: { min?: number; max?: number }) => void;
  /** Display hint for the user — actual data range. */
  dataMin?: number;
  dataMax?: number;
}

/**
 * Two-input numeric range filter for `quotaRemaining`. Either bound may be
 * blank, in which case it's treated as -Infinity / +Infinity respectively.
 *
 * The component keeps a local string state so the user can clear/retype
 * without losing focus on every keystroke; commits up to the parent on
 * blur or Enter.
 */
export function QuotaRangeFilter({ min, max, onChange, dataMin, dataMax }: QuotaRangeFilterProps) {
  const [minStr, setMinStr] = useState(min !== undefined ? String(min) : "");
  const [maxStr, setMaxStr] = useState(max !== undefined ? String(max) : "");

  // Keep local state in sync if parent resets externally (e.g. preset apply)
  useEffect(() => { setMinStr(min !== undefined ? String(min) : ""); }, [min]);
  useEffect(() => { setMaxStr(max !== undefined ? String(max) : ""); }, [max]);

  function commit() {
    const parsedMin = minStr.trim() === "" ? undefined : Number(minStr);
    const parsedMax = maxStr.trim() === "" ? undefined : Number(maxStr);
    onChange({
      min: parsedMin !== undefined && Number.isFinite(parsedMin) ? parsedMin : undefined,
      max: parsedMax !== undefined && Number.isFinite(parsedMax) ? parsedMax : undefined,
    });
  }

  function clear() {
    setMinStr("");
    setMaxStr("");
    onChange({ min: undefined, max: undefined });
  }

  const hasFilter = min !== undefined || max !== undefined;
  const hint = dataMin !== undefined || dataMax !== undefined
    ? `data: ${dataMin?.toFixed?.(1) ?? "—"} – ${dataMax?.toFixed?.(1) ?? "—"}`
    : null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
        Quota
      </span>
      <Input
        type="number"
        placeholder="min"
        value={minStr}
        onChange={(e) => setMinStr(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className="h-8 w-20 text-xs"
      />
      <span className="text-[var(--muted-foreground)]">–</span>
      <Input
        type="number"
        placeholder="max"
        value={maxStr}
        onChange={(e) => setMaxStr(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className="h-8 w-20 text-xs"
      />
      {hasFilter && (
        <Button variant="outline" size="sm" onClick={clear} className="h-8 px-2" title="Clear range">
          <X className="h-3 w-3" />
        </Button>
      )}
      {hint && !hasFilter && (
        <span className="text-[10px] text-[var(--muted-foreground)]">{hint}</span>
      )}
    </div>
  );
}
