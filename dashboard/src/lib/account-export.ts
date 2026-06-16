/**
 * CSV / JSON export helpers for accounts.
 *
 * Always strips secrets (password, encryption-key fields, raw cookies,
 * tokens object) before exporting. The exported shape is a stable, flat
 * snapshot suitable for spreadsheet review or backup, not re-import.
 */

export interface ExportableAccount {
  id: number;
  email: string;
  provider: string;
  status: string;
  enabled?: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  // Anything else is allowed but won't be exported by default.
  [key: string]: unknown;
}

/** Columns to emit in CSV, in order. */
const CSV_COLUMNS: readonly (keyof ExportableAccount)[] = [
  "id",
  "email",
  "provider",
  "status",
  "enabled",
  "quotaLimit",
  "quotaRemaining",
  "lastUsedAt",
  "lastLoginAt",
  "errorMessage",
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCSV(accounts: readonly ExportableAccount[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = accounts.map((a) =>
    CSV_COLUMNS.map((col) => csvEscape(a[col])).join(","),
  );
  return [header, ...rows].join("\r\n");
}

/** Strip secrets defensively even if caller forgot. */
function sanitize(a: ExportableAccount): ExportableAccount {
  const clone: Record<string, unknown> = { ...a };
  delete clone.password;
  delete clone.tokens;
  delete clone.metadata; // may contain auth state
  return clone as ExportableAccount;
}

export function toJSON(accounts: readonly ExportableAccount[]): string {
  return JSON.stringify(accounts.map(sanitize), null, 2);
}

/** Trigger a browser download. */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari/Firefox have time to fire the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function exportAccountsCSV(accounts: readonly ExportableAccount[], baseName = "accounts"): void {
  const cleaned = accounts.map(sanitize);
  download(`${baseName}-${timestamp()}.csv`, toCSV(cleaned), "text/csv;charset=utf-8");
}

export function exportAccountsJSON(accounts: readonly ExportableAccount[], baseName = "accounts"): void {
  download(`${baseName}-${timestamp()}.json`, toJSON(accounts), "application/json");
}
