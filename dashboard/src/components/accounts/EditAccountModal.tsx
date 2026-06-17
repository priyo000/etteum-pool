import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { updateAccount, type AccountPatch } from "@/lib/api";

export interface EditAccountTarget {
  id: number;
  email: string;
  provider: string;
  status: string;
  enabled?: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  errorMessage?: string | null;
}

interface EditAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: EditAccountTarget | null;
  onSaved?: () => void;
  onError?: (err: unknown) => void;
}

const STATUSES: AccountPatch["status"][] = ["active", "exhausted", "error", "pending"];

const STATUS_DOT: Record<string, string> = {
  active:    "bg-[var(--success)]",
  exhausted: "bg-[var(--warning)]",
  error:     "bg-[var(--error)]",
  pending:   "bg-[var(--muted-foreground)]",
};

/**
 * Inline edit modal for a single account. Fields are sent as a PATCH
 * partial — empty fields are omitted from the request body. Email is
 * intentionally NOT editable because it is part of a unique index.
 */
export function EditAccountModal({ open, onOpenChange, account, onSaved, onError }: EditAccountModalProps) {
  const [status, setStatus] = useState<string>(account?.status || "active");
  const [enabled, setEnabled] = useState<boolean>(account?.enabled ?? true);
  const [password, setPassword] = useState("");
  const [quotaLimit, setQuotaLimit] = useState<string>("");
  const [quotaRemaining, setQuotaRemaining] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [clearError, setClearError] = useState(false);
  const [saving, setSaving] = useState(false);

  function syncFromAccount(a: EditAccountTarget | null) {
    setStatus(a?.status ?? "active");
    setEnabled(a?.enabled ?? true);
    setPassword("");
    setQuotaLimit(a?.quotaLimit !== undefined && a.quotaLimit !== null ? String(a.quotaLimit) : "");
    setQuotaRemaining(a?.quotaRemaining !== undefined && a.quotaRemaining !== null ? String(a.quotaRemaining) : "");
    setErrorMessage(a?.errorMessage || "");
    setClearError(false);
  }

  if (account && account.id !== (window as any).__lastEditTarget) {
    (window as any).__lastEditTarget = account.id;
    syncFromAccount(account);
  }

  async function handleSave() {
    if (!account) return;
    setSaving(true);

    const patch: AccountPatch = {};
    if (status && status !== account.status) {
      patch.status = status as AccountPatch["status"];
    }
    if (enabled !== account.enabled) {
      patch.enabled = enabled;
    }
    if (password.trim()) {
      patch.password = password;
    }
    if (quotaLimit.trim() !== "") {
      const n = Number(quotaLimit);
      if (Number.isFinite(n) && n !== account.quotaLimit) patch.quotaLimit = n;
    }
    if (quotaRemaining.trim() !== "") {
      const n = Number(quotaRemaining);
      if (Number.isFinite(n) && n !== account.quotaRemaining) patch.quotaRemaining = n;
    }
    if (clearError) {
      patch.errorMessage = null;
    } else if (errorMessage.trim() !== "" && errorMessage !== account.errorMessage) {
      patch.errorMessage = errorMessage;
    }

    if (Object.keys(patch).length === 0) {
      setSaving(false);
      onOpenChange(false);
      return;
    }

    try {
      await updateAccount(account.id, patch);
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      onError?.(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-[var(--foreground)]">Edit account</DialogTitle>
          <DialogDescription className="text-xs text-[var(--muted-foreground)]">
            {account ? (
              <span className="font-mono">{account.email} · {account.provider}</span>
            ) : (
              "Select an account first."
            )}
          </DialogDescription>
        </DialogHeader>

        {account && (
          <div className="space-y-4 py-1">

            {/* Status */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Status
              </label>
              <div className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s as string)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors",
                      status === s
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                        : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                    )}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STATUS_DOT[s ?? ""] ?? "bg-[var(--muted-foreground)]")} />
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-[var(--border)]" />

            {/* Enabled toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Enabled
              </label>
              <button
                type="button"
                onClick={() => setEnabled((v) => !v)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                  enabled
                    ? "bg-[var(--success)]/15 text-[var(--success)] hover:bg-[var(--success)]/25"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:bg-[var(--muted-foreground)]/20"
                )}
                aria-pressed={enabled}
                title={enabled ? "Click to disable" : "Click to enable"}
              >
                {enabled
                  ? <CheckCircle2 className="w-3.5 h-3.5" />
                  : <XCircle className="w-3.5 h-3.5" />
                }
                {enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="border-t border-[var(--border)]" />

            {/* Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Password
              </label>
              <Input
                type="password"
                placeholder="Leave blank to keep unchanged"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="text-xs"
              />
            </div>

            <div className="border-t border-[var(--border)]" />

            {/* Quota */}
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Quota
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-[var(--muted-foreground)]">Limit</label>
                  <Input
                    type="number"
                    placeholder="e.g. 1000"
                    value={quotaLimit}
                    onChange={(e) => setQuotaLimit(e.target.value)}
                    className="text-xs h-8"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-[var(--muted-foreground)]">Remaining</label>
                  <Input
                    type="number"
                    placeholder="e.g. 750"
                    value={quotaRemaining}
                    onChange={(e) => setQuotaRemaining(e.target.value)}
                    className="text-xs h-8"
                  />
                </div>
              </div>
            </div>

            {/* Error message (only if account has one) */}
            {(account.errorMessage || errorMessage) && (
              <>
                <div className="border-t border-[var(--border)]" />
                <div className="space-y-2">
                  <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    Error Message
                  </label>
                  <Input
                    type="text"
                    placeholder="Error message"
                    value={errorMessage}
                    onChange={(e) => setErrorMessage(e.target.value)}
                    className="text-xs font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setClearError((v) => !v)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors",
                      clearError
                        ? "border-[var(--error)]/50 bg-[var(--error)]/10 text-[var(--error)]"
                        : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--error)]/40"
                    )}
                    aria-pressed={clearError}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", clearError ? "bg-[var(--error)]" : "bg-[var(--muted-foreground)]")} />
                    Clear stored error message
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !account}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
