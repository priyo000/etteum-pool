/**
 * Canva team-join orchestrator.
 *
 * Bulk-joins Canva accounts into a team via an invite link. Spawns
 * `scripts/auth/canva_join_team.py` per account, reuses stored cookies,
 * captures the new `cb` (canva-brand) token, and updates `accounts.tokens`.
 *
 * Wire-up:
 *   1. POST /api/accounts/canva/join-team queues a job here.
 *   2. We iterate accounts sequentially (Canva is slow + we want fewer
 *      concurrent browser sessions to avoid IP-based detection).
 *   3. Per account, broadcast WS `canva_join_progress` so the dashboard
 *      can show live progress.
 *
 * Behavior on existing team membership:
 *   - "switch": always join, switching brand to the new team
 *   - "skip":   skip if account is currently in any team
 *   - "add":    Canva does not support multi-team membership for free
 *              accounts; behaves like "switch" but marks `warning`.
 */
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { config } from "../config";
import type { Account } from "../db/schema";

export type OnExistingTeam = "switch" | "skip" | "add";

export interface JoinTeamInput {
  email: string;
  password: string;
  tokens: Record<string, unknown>;
  invite_url: string;
  on_existing: OnExistingTeam;
  headless: boolean;
}

export interface JoinTeamOutput {
  ok: boolean;
  new_tokens?: Record<string, string>;
  previous_brand_id?: string;
  brand_id?: string;
  brand_name?: string;
  action?: "joined" | "switched" | "skipped" | "already_member";
  warning?: string;
  error?: string;
  /**
   * The brand id that actually ended up active after the join (and any
   * auto-preferred switch). Equals `brand_id` unless we auto-switched
   * to a strictly better brand the user already belonged to.
   */
  effective_brand_id?: string;
  code?:
    | "input_invalid"
    | "session_expired"
    | "invite_invalid"
    | "join_failed"
    | "timeout"
    | "browser_error";
}

const JOIN_TIMEOUT_MS = 120_000; // 2 minutes per account
const LIST_TEAMS_TIMEOUT_MS = 30_000;

const SCRIPT_PATH = (() => {
  // canva_join_team.py lives next to login.py
  // config.authScriptPath points to login.py; replace the basename.
  return config.authScriptPath.replace(/login\.py$/, "canva_join_team.py");
})();

const LIST_TEAMS_SCRIPT_PATH = (() => {
  return config.authScriptPath.replace(/login\.py$/, "canva_list_teams.py");
})();

const SWITCH_BRAND_SCRIPT_PATH = (() => {
  return config.authScriptPath.replace(/login\.py$/, "canva_switch_brand.py");
})();

const SWITCH_BRAND_TIMEOUT_MS = 40_000;

/**
 * Plan-rank table used to decide which brand offers the best quota.
 * Codes observed in `brandPlanDescription` from findbyuser:
 *   A = Free / Personal
 *   L = Limited (free Team)
 *   P = Pro / paid Team
 *   E = Enterprise
 * Higher number = better plan.
 */
const PLAN_RANK: Record<string, number> = { P: 4, E: 4, L: 2, A: 1 };

function planRank(plan: string | undefined | null): number {
  if (!plan) return 0;
  return PLAN_RANK[String(plan).toUpperCase()] ?? 0;
}

export interface SwitchBrandOutput {
  ok: boolean;
  previous_brand_id?: string;
  brand_id?: string;
  new_tokens?: Record<string, string>;
  error?: string;
  code?:
    | "input_invalid"
    | "session_expired"
    | "switch_failed"
    | "timeout"
    | "browser_error";
}

export interface CanvaBrand {
  id: string;
  brandname: string;
  displayName: string;
  personal: boolean;
  memberCount: number;
  plan: string;
}

export interface ListTeamsOutput {
  ok: boolean;
  brands?: CanvaBrand[];
  error?: string;
  code?: "input_invalid" | "session_expired" | "browser_error" | "timeout";
}

/** Tail a ReadableStream<Uint8Array> line-by-line, calling onLine for each. */
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) onLine(line);
    }
  }
  const tail = decoder.decode();
  if (tail) {
    full += tail;
    buffer += tail;
  }
  if (buffer.trim()) onLine(buffer);
  return full;
}

/**
 * Spawn the Python join script for ONE account and parse its result.
 *
 * Streams stderr line-by-line via the optional `onLog` callback so the
 * dashboard can render a live progress feed instead of just a spinner.
 * Lines tagged `[STEP] ...` are user-facing; everything else is debug.
 */
async function runJoinScript(
  input: JoinTeamInput,
  onLog?: (line: string, level: "step" | "debug") => void,
): Promise<JoinTeamOutput> {
  const proc = Bun.spawn([config.pythonPath, SCRIPT_PATH], {
    cwd: config.authScriptCwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BATCHER_PROXY_URL: config.proxyUrl,
      BATCHER_CAMOUFOX_HEADLESS: input.headless ? "true" : "false",
    },
  });

  // Write input JSON to stdin
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();

  // Stream stderr line-by-line WHILE the process runs so the dashboard sees
  // log lines arrive in real time. Without this, all stderr lands at exit.
  const stderrPromise = streamLines(proc.stderr, (line) => {
    if (!onLog) return;
    const isStep = line.includes("[STEP]");
    onLog(line, isStep ? "step" : "debug");
  });

  // Wait with timeout
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      reject(new Error("join timeout"));
    }, JOIN_TIMEOUT_MS);
  });

  try {
    await Promise.race([proc.exited, timeoutPromise]);
  } catch {
    return { ok: false, code: "timeout", error: "Join script timed out" };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (timedOut) {
    return { ok: false, code: "timeout", error: "Join script timed out" };
  }

  // Wait for stderr drain (so all log lines made it out before we return).
  const stderr = await stderrPromise.catch(() => "");
  const stdout = await new Response(proc.stdout).text();

  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "browser_error",
      error: stderr.trim().slice(0, 300) || "empty stdout",
    };
  }

  // The Python script promises ONE JSON object on stdout. If multiple lines
  // appeared anyway (e.g. accidental print), pick the LAST non-empty line.
  const lastLine = trimmed.split("\n").reverse().find((l) => l.trim()) || trimmed;

  try {
    const parsed = JSON.parse(lastLine);
    return parsed as JoinTeamOutput;
  } catch (err) {
    return {
      ok: false,
      code: "browser_error",
      error: `parse error: ${err instanceof Error ? err.message : String(err)}; stdout=${trimmed.slice(0, 200)}`,
    };
  }
}

/**
 * Merge new tokens from script back into the account row, preserving any
 * fields the script didn't return AND any cookies that would otherwise be
 * lost. This is the LAST LINE OF DEFENSE against the bug that corrupted
 * accounts 109 / 110 — if the Python layer ever regresses and returns a
 * truncated `all_cookies`, this function keeps the original blob.
 *
 * Rules:
 *   1. If `fresh.all_cookies` is missing/empty → keep `existing.all_cookies`
 *   2. If `fresh.all_cookies` is < 50% the size of the existing one AND the
 *      existing one was substantial (>200 chars) → keep existing + only
 *      override individual canonical fields (caz/cb/cau/user_id). This
 *      avoids losing `cf_clearance` etc. when the session jar gets cleared.
 *   3. Otherwise → merge normally.
 */
function mergeTokens(
  existing: Record<string, unknown>,
  fresh: Record<string, string>,
): Record<string, unknown> {
  const existingAll = String(existing.all_cookies ?? "");
  const freshAll = String(fresh.all_cookies ?? "");

  // Rule 1: empty incoming → keep what we have.
  if (!freshAll || freshAll.trim().length === 0) {
    const { all_cookies: _drop, ...freshWithoutCookies } = fresh;
    return { ...existing, ...freshWithoutCookies };
  }

  // Rule 2: suspicious shrinkage on an established jar → reject + keep
  // original blob, but still apply the canonical field updates so cb/caz/cau
  // changes do take effect.
  const isShrinkAttack =
    existingAll.length > 200 && freshAll.length < existingAll.length * 0.5;

  if (isShrinkAttack) {
    console.warn(
      `[canva-team] REJECTED suspicious all_cookies shrink (` +
        `existing=${existingAll.length} chars → fresh=${freshAll.length} chars). ` +
        `Keeping existing jar, applying field updates only.`,
    );
    // Mutate the existing jar string in-place so the new CB is honoured
    // even though we're dropping the script's all_cookies.
    let patchedJar = existingAll;
    if (fresh.cb) {
      patchedJar = patchedJar.replace(/(?:^|;\s*)CB=[^;]*/i, "");
      patchedJar = patchedJar
        ? `${patchedJar.trim().replace(/^;|;$/g, "")}; CB=${fresh.cb}`
        : `CB=${fresh.cb}`;
    }
    return {
      ...existing,
      ...fresh,
      all_cookies: patchedJar,
    };
  }

  // Rule 3: normal merge.
  return { ...existing, ...fresh };
}

/**
 * Join a single Canva account into the team referenced by `inviteUrl`.
 * Updates the DB row on success. Returns the script result either way.
 *
 * `opts.onLog` (optional) is invoked for each stderr line emitted by the
 * Python script. Pass it from the bulk runner to forward live progress to
 * the dashboard via WebSocket.
 */
export async function joinCanvaTeam(
  accountId: number,
  inviteUrl: string,
  onExisting: OnExistingTeam,
  opts: {
    headless?: boolean;
    onLog?: (line: string, level: "step" | "debug") => void;
  } = {},
): Promise<JoinTeamOutput & { accountId: number }> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) {
    return { accountId, ok: false, code: "input_invalid", error: "account not found" };
  }
  if (account.provider !== "canva") {
    return { accountId, ok: false, code: "input_invalid", error: "account is not canva" };
  }
  if (!account.tokens) {
    return { accountId, ok: false, code: "session_expired", error: "no tokens stored — login first" };
  }

  // tokens is JSON column; could already be parsed by drizzle, otherwise parse string
  const storedTokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : (account.tokens as Record<string, unknown>);

  let password = "";
  try {
    password = decrypt(account.password);
  } catch {
    // Continue without password — the script can still join via cookies.
  }

  const input: JoinTeamInput = {
    email: account.email,
    password,
    tokens: storedTokens,
    invite_url: inviteUrl,
    on_existing: onExisting,
    headless: opts.headless ?? config.headless,
  };

  const result = await runJoinScript(input, opts.onLog);

  // Track which brand actually ends up active. Defaults to whatever the
  // join itself produced; may get overridden below if we auto-prefer a
  // better brand.
  let effectiveBrandId = result.brand_id;

  // Persist new tokens on success
  if (result.ok && result.new_tokens) {
    const merged = mergeTokens(storedTokens, result.new_tokens);
    await db
      .update(accounts)
      .set({
        tokens: merged as any,
        updatedAt: new Date(),
        // Note: we don't change status. If the account was active, it
        // stays active — only the team/brand context changed.
      })
      .where(eq(accounts.id, accountId));

    // Snapshot the updated team list to the DB so the dashboard can show
    // the account's brand membership without an extra request from the UI.
    // Best effort: failures are non-fatal (action itself already succeeded).
    let teamsResult: ListTeamsOutput | undefined;
    try {
      teamsResult = await listCanvaTeams(accountId, { persist: true });
    } catch (err) {
      console.error("[canva-team] post-join team snapshot failed:", err);
    }

    // Auto-prefer a strictly better brand (higher plan rank) the account
    // already belongs to. Rationale: a user might join a free Limited
    // team but already be a member of a Pro team — we want the Pro one
    // active for quota.
    try {
      if (
        teamsResult?.ok &&
        Array.isArray(teamsResult.brands) &&
        result.brand_id
      ) {
        const joinedBrandId = result.brand_id;
        const joinedBrand = teamsResult.brands.find((b) => b.id === joinedBrandId);
        const joinedRank = planRank(joinedBrand?.plan);

        // Find the best non-personal brand by plan rank.
        let best: CanvaBrand | undefined;
        for (const b of teamsResult.brands) {
          if (!b || !b.id) continue;
          if (b.personal) continue;
          if (planRank(b.plan) > planRank(best?.plan)) {
            best = b;
          }
        }

        if (
          best &&
          best.id !== joinedBrandId &&
          planRank(best.plan) > joinedRank
        ) {
          opts.onLog?.(
            `[STEP] auto-prefer brand ${best.id} (plan=${best.plan}) over joined ${joinedBrandId} (plan=${joinedBrand?.plan ?? "?"})`,
            "step",
          );
          const sw = await switchCanvaBrand(accountId, best.id);
          if (sw.ok && sw.brand_id) {
            effectiveBrandId = sw.brand_id;
            opts.onLog?.(
              `[STEP] auto-prefer SUCCESS: now active brand=${sw.brand_id}`,
              "step",
            );
          } else {
            opts.onLog?.(
              `[STEP] auto-prefer FAILED (${sw.code}): ${sw.error ?? "unknown"} — staying on joined brand`,
              "step",
            );
          }
        }
      }
    } catch (err) {
      console.error("[canva-team] auto-prefer-best-brand failed:", err);
    }
  }

  return { ...result, effective_brand_id: effectiveBrandId, accountId };
}

/**
 * Bulk-join many accounts. Runs with bounded concurrency (default 1, max 5)
 * and broadcasts WS progress for every account as work happens. Mirrors the
 * worker-pool pattern used by loginQueue / warmupQueue elsewhere.
 *
 * Why low default? Each worker spawns a Camoufox browser (heavy: ~300MB
 * RAM, ~30-60s per join) and Canva is IP-rate-limited — running too many
 * in parallel from the same IP triggers anti-bot heuristics.
 */
export async function bulkJoinCanvaTeam(
  accountIds: number[],
  inviteUrl: string,
  onExisting: OnExistingTeam,
  opts: { headless?: boolean; concurrency?: number } = {},
): Promise<Array<JoinTeamOutput & { accountId: number; email: string }>> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 5));
  const results: Array<JoinTeamOutput & { accountId: number; email: string }> = [];

  broadcast({
    type: "canva_join_started",
    data: {
      total: accountIds.length,
      invite_url: inviteUrl,
      on_existing: onExisting,
      concurrency,
    },
  });

  // Pre-fetch emails up-front so we always have a meaningful label in
  // progress events, even if the row is later deleted mid-run.
  const emailCache = new Map<number, string>();
  if (accountIds.length > 0) {
    const rows = await db.select().from(accounts);
    for (const r of rows) {
      if (accountIds.includes(r.id)) emailCache.set(r.id, r.email);
    }
  }

  // Worker-pool: N workers race for the next index from a shared cursor.
  let cursor = 0;
  let completed = 0;

  async function worker(workerIdx: number) {
    while (true) {
      const i = cursor++;
      if (i >= accountIds.length) return;

      const accountId = accountIds[i];
      const email = emailCache.get(accountId) || `<id:${accountId}>`;

      broadcast({
        type: "canva_join_progress",
        data: {
          index: i,
          total: accountIds.length,
          accountId,
          email,
          status: "running",
          worker: workerIdx,
        },
      });

      const result = await joinCanvaTeam(accountId, inviteUrl, onExisting, {
        ...opts,
        onLog: (line, level) => {
          // Forward each stderr line to the dashboard. Strip the bracketed
          // tags before display — UI just shows the message.
          const display = line
            .replace(/^\[STEP\]\s*/, "")
            .replace(/^\[canva_join\]\s*/, "")
            .trim();
          if (!display) return;
          broadcast({
            type: "canva_join_log",
            data: {
              accountId,
              email,
              level, // "step" | "debug"
              line: display,
              ts: Date.now(),
              worker: workerIdx,
            },
          });
        },
      });
      const enriched = { ...result, email };
      results.push(enriched);
      completed++;

      broadcast({
        type: "canva_join_progress",
        data: {
          index: i,
          total: accountIds.length,
          completed,
          accountId,
          email,
          status: result.ok ? "success" : "failed",
          action: result.action,
          brand_id: result.brand_id,
          brand_name: result.brand_name,
          error: result.error,
          code: result.code,
          warning: result.warning,
          worker: workerIdx,
        },
      });
    }
  }

  // Don't spawn more workers than there are jobs.
  const workerCount = Math.min(concurrency, accountIds.length);
  await Promise.all(
    Array.from({ length: workerCount }, (_, idx) => worker(idx)),
  );

  const summary = {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.action === "skipped").length,
    already_member: results.filter((r) => r.action === "already_member").length,
    concurrency,
  };

  broadcast({
    type: "canva_join_completed",
    data: { ...summary, results },
  });

  return results;
}

/**
 * Switch the account's active Canva brand (CB cookie) to `targetBrandId`.
 *
 * Spawns `canva_switch_brand.py`, which hits
 * `GET /login/switch?brand=<id>&redirect=/`, follows the redirect chain,
 * and harvests the freshly-rotated cookie jar (preserving cf_clearance
 * and friends). On success we persist the merged token bundle to the DB
 * — same shape as `joinCanvaTeam`.
 *
 * The caller is responsible for verifying that the account actually
 * belongs to `targetBrandId` (e.g. via `listCanvaTeams`). The server
 * will silently no-op (and we'll report `switch_failed`) if it doesn't.
 */
export async function switchCanvaBrand(
  accountId: number,
  targetBrandId: string,
): Promise<SwitchBrandOutput> {
  if (!targetBrandId || !/^BA[A-Za-z0-9_\-]{8,}$/.test(targetBrandId)) {
    return {
      ok: false,
      code: "input_invalid",
      error: `invalid target_brand_id: ${JSON.stringify(targetBrandId)}`,
    };
  }

  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) {
    return { ok: false, code: "input_invalid", error: "account not found" };
  }
  if (account.provider !== "canva") {
    return { ok: false, code: "input_invalid", error: "account is not canva" };
  }
  if (!account.tokens) {
    return { ok: false, code: "session_expired", error: "no tokens stored — login first" };
  }

  const storedTokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : (account.tokens as Record<string, unknown>);

  const proc = Bun.spawn([config.pythonPath, SWITCH_BRAND_SCRIPT_PATH], {
    cwd: config.authScriptCwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BATCHER_PROXY_URL: config.proxyUrl,
    },
  });

  proc.stdin.write(JSON.stringify({
    tokens: storedTokens,
    target_brand_id: targetBrandId,
  }));
  await proc.stdin.end();

  // Drain stderr in the background so the buffer never fills up; we
  // collect it for diagnostics but don't stream to the UI here (callers
  // who want streaming should plumb through their own onLog).
  const stderrPromise = streamLines(proc.stderr, () => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      reject(new Error("switch timeout"));
    }, SWITCH_BRAND_TIMEOUT_MS);
  });

  try {
    await Promise.race([proc.exited, timeoutPromise]);
  } catch {
    return { ok: false, code: "timeout", error: "switch brand timed out" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    return { ok: false, code: "timeout", error: "switch brand timed out" };
  }

  const stderr = await stderrPromise.catch(() => "");
  const stdout = await new Response(proc.stdout).text();
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "browser_error",
      error: stderr.trim().slice(0, 300) || "empty stdout",
    };
  }

  const lastLine = trimmed.split("\n").reverse().find((l) => l.trim()) || trimmed;
  let parsed: SwitchBrandOutput;
  try {
    parsed = JSON.parse(lastLine) as SwitchBrandOutput;
  } catch (err) {
    return {
      ok: false,
      code: "browser_error",
      error: `parse error: ${err instanceof Error ? err.message : String(err)}; stdout=${trimmed.slice(0, 200)}`,
    };
  }

  // Persist updated tokens on success (mirrors joinCanvaTeam's persist
  // path). We intentionally do NOT refresh the team list snapshot here —
  // brand membership didn't change, only which brand is active. The
  // caller can re-run listCanvaTeams if they care.
  if (parsed.ok && parsed.new_tokens) {
    try {
      const merged = mergeTokens(storedTokens, parsed.new_tokens);
      await db
        .update(accounts)
        .set({
          tokens: merged as any,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
    } catch (err) {
      console.error("[canva-team] switch persist failed:", err);
      // Persistence failed but the in-memory switch succeeded; flag it
      // so the caller can decide whether to retry.
      return {
        ...parsed,
        ok: false,
        code: "browser_error",
        error: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return parsed;
}

/**
 * List the Canva teams (brands) the account is currently a member of.
 *
 * Spawns `canva_list_teams.py`, which calls Canva's
 * `/_ajax/organizationmanagement/brandsandorganizations/findbyuser`
 * endpoint with the stored cookies and returns a normalized list of
 * brands (personal + team).
 *
 * Useful for:
 *   - Showing the user which teams an account is in (UI)
 *   - The bulk join's `on_existing=skip` decision (server side)
 */
export async function listCanvaTeams(
  accountId: number,
  opts: { persist?: boolean } = {},
): Promise<ListTeamsOutput> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) {
    return { ok: false, code: "input_invalid", error: "account not found" };
  }
  if (account.provider !== "canva") {
    return { ok: false, code: "input_invalid", error: "account is not canva" };
  }
  if (!account.tokens) {
    return { ok: false, code: "session_expired", error: "no tokens stored — login first" };
  }

  const storedTokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : (account.tokens as Record<string, unknown>);

  const proc = Bun.spawn([config.pythonPath, LIST_TEAMS_SCRIPT_PATH], {
    cwd: config.authScriptCwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BATCHER_PROXY_URL: config.proxyUrl,
    },
  });

  proc.stdin.write(JSON.stringify({ tokens: storedTokens }));
  await proc.stdin.end();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      reject(new Error("list timeout"));
    }, LIST_TEAMS_TIMEOUT_MS);
  });

  try {
    await Promise.race([proc.exited, timeoutPromise]);
  } catch {
    return { ok: false, code: "timeout", error: "list teams timed out" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    return { ok: false, code: "timeout", error: "list teams timed out" };
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "browser_error",
      error: stderr.trim().slice(0, 300) || "empty stdout",
    };
  }
  // Single JSON line per the script's contract.
  const lastLine = trimmed.split("\n").reverse().find((l) => l.trim()) || trimmed;
  let result: ListTeamsOutput;
  try {
    result = JSON.parse(lastLine) as ListTeamsOutput;
  } catch (err) {
    return {
      ok: false,
      code: "browser_error",
      error: `parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Persist on success ────────────────────────────────────────────────
  // Default behaviour is to cache the snapshot under metadata.canva so the
  // dashboard can show last-known teams without always going through Canva.
  // Callers can pass {persist: false} to suppress (e.g. inside the bulk join
  // worker we already persist via a different code path).
  if (result.ok && (opts.persist ?? true)) {
    try {
      const existingMeta =
        (typeof account.metadata === "string"
          ? JSON.parse(account.metadata)
          : (account.metadata as Record<string, unknown> | null)) || {};
      const canvaMeta = (existingMeta.canva as Record<string, unknown>) || {};
      const newMeta = {
        ...existingMeta,
        canva: {
          ...canvaMeta,
          teams: result.brands || [],
          teams_synced_at: new Date().toISOString(),
        },
      };
      await db
        .update(accounts)
        .set({
          metadata: newMeta as any,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId));
    } catch (err) {
      // Persistence failure is non-fatal — return the data anyway.
      console.error("[canva-team] persist failed:", err);
    }
  }

  return result;
}
