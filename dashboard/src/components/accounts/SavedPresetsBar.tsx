import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Bookmark, Save, Trash2, Check } from "lucide-react";
import {
  type AccountFilterPreset,
  type AccountFilterState,
  listPresets,
  savePreset,
  deletePreset,
} from "@/lib/account-presets";

interface SavedPresetsBarProps {
  scope: AccountFilterPreset["scope"];
  /** Current filter state — gets snapshotted when user saves. */
  currentState: AccountFilterState;
  /** Apply a preset by replacing the parent's filter state. */
  onApply: (state: AccountFilterState) => void;
}

/**
 * Compact dropdown for saving / loading / deleting filter presets.
 *
 * Storage is localStorage-only and scoped (per-provider vs global) so the
 * same name can exist twice without colliding.
 */
export function SavedPresetsBar({ scope, currentState, onApply }: SavedPresetsBarProps) {
  const [presets, setPresets] = useState<AccountFilterPreset[]>([]);
  const [open, setOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    setPresets(listPresets(scope));
  }, [scope, open, saveOpen]);

  function handleSave() {
    if (!name.trim()) return;
    try {
      savePreset(name.trim(), scope, currentState);
      setName("");
      setSaveOpen(false);
      setPresets(listPresets(scope));
    } catch {
      /* ignore — save errors are silent */
    }
  }

  function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    deletePreset(id);
    setPresets(listPresets(scope));
  }

  function handleApply(p: AccountFilterPreset) {
    onApply(p.state);
    setOpen(false);
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => { setOpen((v) => !v); setSaveOpen(false); }}
        className="h-8"
      >
        <Bookmark className="mr-1 h-3.5 w-3.5" /> Presets
        {presets.length > 0 && (
          <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
            ({presets.length})
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[240px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
            <span>Saved filters</span>
            <button
              type="button"
              onClick={() => setSaveOpen((v) => !v)}
              className="flex items-center gap-1 rounded text-[var(--primary)] hover:underline"
            >
              <Save className="h-3 w-3" /> Save current
            </button>
          </div>

          {saveOpen && (
            <div className="flex items-center gap-1 border-t border-[var(--border)] px-3 py-2">
              <input
                type="text"
                placeholder="Preset name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                autoFocus
                className="h-7 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 text-xs"
              />
              <Button size="sm" onClick={handleSave} disabled={!name.trim()} className="h-7 px-2">
                <Check className="h-3 w-3" />
              </Button>
            </div>
          )}

          {presets.length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-[var(--muted-foreground)]">
              No presets yet.
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto border-t border-[var(--border)]">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => handleApply(p)}
                    className="group flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-[var(--muted)]"
                  >
                    <span className="flex-1 truncate font-medium">{p.name}</span>
                    <span
                      onClick={(e) => handleDelete(p.id, e)}
                      role="button"
                      className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 hover:bg-[var(--error)]/10 hover:text-[var(--error)] group-hover:opacity-100"
                      title="Delete preset"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
