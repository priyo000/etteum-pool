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
import { Loader2 } from "lucide-react";
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

/**
 * Inline edit modal for a single account. Fields are sent as a `PATCH`
 * partial — empty fields are omitted from the request body. Email is
 * intentionally NOT editable because it's part of a unique index.
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

  // Reset form when target changes
  function syncFromAccount(a: EditAccountTarget | null) {
    setStatus(a?.status ?? "active");
    setEnabled(a?.enabled ?? true);
    setPassword("");
    setQuotaLimit(a?.quotaLimit !== undefined && a.quotaLimit !== null ? String(a.quotaLimit) : "");
    setQuotaRemaining(a?.quotaRemaining !== undefined && a.quotaRemaining !== null ? String(a.quotaRemaining) : "");
    setErrorMessage(a?.errorMessage || "");
    setClearError(false);
  }

  // Sync when account prop changes (parent passed new target)
  // Use object identity so re-opening with same id refreshes state.
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
          <DialogTitle>Edit account</DialogTitle>
          <DialogDescription>
            {account ? (
              <span className="font-mono text-xs">{account.email} · {account.provider}</span>
            ) : (
              "Select an account first."
            )}
          </DialogDescription>
        </DialogHeader>

        {account && (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Status
              </label>
              <div className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s as string)}
                    className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                      status === s
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--foreground)]"
                        : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--primary)]/50"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="edit-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--border)] accent-[var(--primary)]"
              />
              <label htmlFor="edit-enabled" className="text-xs">
                Enabled (account is part of the load-balancer pool)
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Quota Limit
                </label>
                <Input
                  type="number"
                  placeholder={account.quotaLimit !== undefined && account.quotaLimit !== null ? String(account.quotaLimit) : "0"}
                  value={quotaLimit}
                  onChange={(e) => setQuotaLimit(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Quota Remaining
                </label>
                <Input
                  type="number"
                  placeholder={account.quotaRemaining !== undefined && account.quotaRemaining !== null ? String(account.quotaRemaining) : "0"}
                  value={quotaRemaining}
                  onChange={(e) => setQuotaRemaining(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                New Password (optional)
              </label>
              <Input
                type="password"
                placeholder="Leave blank to keep current"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Error Message
              </label>
              <Input
                placeholder={account.errorMessage || "—"}
                value={errorMessage}
                onChange={(e) => setErrorMessage(e.target.value)}
                disabled={clearError}
                className="h-9 text-xs font-mono"
              />
              {account.errorMessage && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                  <input
                    type="checkbox"
                    checked={clearError}
                    onChange={(e) => setClearError(e.target.checked)}
                    className="h-3 w-3 rounded border-[var(--border)] accent-[var(--primary)]"
                  />
                  Clear stored error message
                </label>
              )}
            </div>
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
