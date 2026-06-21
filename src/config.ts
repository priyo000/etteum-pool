import path from "path";

const projectRoot = path.resolve(import.meta.dir, "..");

export const config = {
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "pool-proxy-secret-key",
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data/poolprox3.db"),
  authScriptPath:
    process.env.AUTH_SCRIPT_PATH ||
    path.join(projectRoot, "scripts/auth/login.py"),
  pythonPath:
    process.env.PYTHON_PATH ||
    path.join(
      projectRoot,
      "scripts/auth/.venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
  authScriptCwd:
    process.env.AUTH_SCRIPT_CWD ||
    path.join(projectRoot, "scripts/auth"),
  proxyUrl: process.env.PROXY_URL || "",
  encryptionKey:
    process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  headless: process.env.HEADLESS !== "false", // default true
  logBodyEnabled: process.env.POOLPROX_LOG_BODY_ENABLED !== "false",
  logBodyFull: process.env.POOLPROX_LOG_BODY_FULL !== "false",
  logBodyRedact: process.env.POOLPROX_LOG_BODY_REDACT === "true",
  logBodyMaxBytes: Number(process.env.POOLPROX_LOG_BODY_MAX_BYTES) || 65536,
  accountCacheTtlMs: Number(process.env.POOLPROX_ACCOUNT_CACHE_TTL_MS) || 3000,
  authProcessTimeoutMs: Number(process.env.POOLPROX_AUTH_PROCESS_TIMEOUT_MS) || 10 * 60 * 1000,
  providerRequestTimeoutMs: Number(process.env.POOLPROX_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000,
  providerQuotaTimeoutMs: Number(process.env.POOLPROX_PROVIDER_QUOTA_TIMEOUT_MS) || 15_000,
  // ── GitLab Duo tunables ──────────────────────────────────────────────────
  // Defaults are tuned to handle the full task spectrum: short Q&A,
  // multi-minute reasoning, AND multi-hour agentic loops (e.g. autonomous
  // build → test → fix → repeat sessions that legitimately run for hours).
  // The principle: timeouts are SAFETY NETS for stuck infra, not caps on
  // legitimate operation. Each one is sized so that a healthy turn — even
  // a 6-hour one — never trips it.
  //
  // SSE heartbeat interval — emits a ": keepalive" comment every N ms so the
  // upstream socket never goes idle long enough for Bun's idleTimeout (255s
  // hard cap) or any intermediate proxy to cut it. Must stay well below 255s.
  // 15s is the de-facto industry standard (matches OpenAI, Anthropic SSE).
  gitlabDuoSseHeartbeatMs: Number(process.env.POOLPROX_GITLAB_DUO_SSE_HEARTBEAT_MS) || 15_000,
  // How long an idle WS session lives after the last activity. This only
  // bites when the WS goes COMPLETELY silent — every upstream frame
  // (checkpoint, action, partial text) refreshes the timer via touchSessionByWs.
  // 4 hours covers truly massive tool chains (cargo build of huge workspace,
  // pytest of monorepo). Past 4h of TOTAL silence we assume the workflow is
  // dead and free the slot to prevent memory pile-up across many clients.
  gitlabDuoSessionIdleMs: Number(process.env.POOLPROX_GITLAB_DUO_SESSION_IDLE_MS) || 4 * 60 * 60 * 1000,
  // REST createWorkflow request timeout (ms). Single fast POST at the start
  // of every fresh workflow — healthy GitLab responds in <2s, so 60s is
  // already a generous safety net for rare API congestion.
  gitlabDuoCreateWorkflowTimeoutMs: Number(process.env.POOLPROX_GITLAB_DUO_CREATE_WORKFLOW_TIMEOUT_MS) || 60_000,
  // WebSocket open handshake timeout (ms). Bun's WS does not enforce one.
  // Healthy handshake is sub-second; 30s catches network blackholes without
  // ever triggering on real traffic.
  gitlabDuoWsOpenTimeoutMs: Number(process.env.POOLPROX_GITLAB_DUO_WS_OPEN_TIMEOUT_MS) || 30_000,
  // Watchdog after an empty INPUT_REQUIRED checkpoint — wait up to N ms for
  // a follow-up RUNNING with real text before forcing turn done. Workaround
  // for an upstream race where the terminal status arrives before the text.
  // Bumped from 5s → 20s after observing real upstream traffic where the
  // RUNNING-with-text checkpoint trails the empty INPUT_REQUIRED by 8–15s
  // on long reasoning turns (Sonnet 4.6 + tool chain). Lower values silently
  // truncated answers and made the stream look like it had "stopped" when it
  // was just about to deliver text.
  gitlabDuoEmptyInputWatchdogMs: Number(process.env.POOLPROX_GITLAB_DUO_EMPTY_INPUT_WATCHDOG_MS) || 20_000,
  // Hard ceiling for upstream silence DURING a single turn. Reset on every
  // upstream frame, so total turn duration is unbounded as long as upstream
  // emits *something* (even a status-only checkpoint) within this window.
  // 30 minutes accommodates the slowest reasoning models on a complex prompt
  // — past that, upstream is almost certainly stuck and we fail over rather
  // than letting the user stare at a blank screen forever. Set to 0 to
  // disable entirely.
  gitlabDuoTurnIdleMs: Number(process.env.POOLPROX_GITLAB_DUO_TURN_IDLE_MS) || 30 * 60 * 1000,
  // Per-request preflight quota check via `direct_access` REST endpoint.
  // Cached per account for this many ms — short enough to catch exhaustion
  // promptly, long enough to absorb burst traffic without hammering the API.
  // Set to 0 to disable preflight entirely (fall back to warmup-only checks).
  gitlabDuoPreflightCacheMs: Number(process.env.POOLPROX_GITLAB_DUO_PREFLIGHT_CACHE_MS) || 30_000,
  gitlabDuoPreflightTimeoutMs: Number(process.env.POOLPROX_GITLAB_DUO_PREFLIGHT_TIMEOUT_MS) || 5_000,
  // Auto-approve PLAN_APPROVAL_REQUIRED + TOOL_CALL_APPROVAL_REQUIRED frames.
  // Default ON — poolprox3 is a transparent proxy and clients (Claude Code,
  // Cline, Roo Code) typically don't expose plan-approval UX. Set to "false"
  // for strict orgs that want every approval surfaced as turn-end.
  gitlabDuoAutoApprove: process.env.POOLPROX_GITLAB_DUO_AUTO_APPROVE !== "false",
  // Whether to let Duo's agent pause workflows mid-task to ask clarifying
  // questions of the user via INPUT_REQUIRED checkpoints. The CLI sets this
  // to true because there's a human at a TTY; the proxy serves chat clients
  // (Cline, Claude Code) where INPUT_REQUIRED translates to finish_reason:
  // "stop", forcing the user to type "lanjut"/"continue" to resume. Default
  // OFF so the agent drives the workflow to FINISHED/FAILED on its own.
  // Set "true" if you actually want the model to pause and ask.
  gitlabDuoAllowAgentPrompts: process.env.POOLPROX_GITLAB_DUO_ALLOW_AGENT_PROMPTS === "true",
  // Diagnostic: log every tool-bridge decision (upstream action kind → the
  // client tool it mapped to, plus the client's declared tools). Use this to
  // confirm WHY a Read shows up as Bash/sed: it means the client didn't
  // declare a Read-like tool, so the bridge fell back to Bash. Off by default.
  gitlabDuoLogToolBridge: process.env.POOLPROX_GITLAB_DUO_LOG_TOOL_BRIDGE === "true",
  // Diagnostic: dump every checkpoint's `ui_chat_log` structure (types,
  // content lengths, 50-char previews) so we can verify upstream protocol
  // assumptions about log scope. Off by default — high-volume on long turns.
  gitlabDuoDebugLog: process.env.POOLPROX_DUO_DEBUG_LOG === "1",
  // Kiro Pro upgrade settings
  kiroProUpgrade: process.env.KIRO_PRO_UPGRADE === "true",
  billingAddress: JSON.parse(process.env.BILLING_ADDRESS || '{"name":"John Doe","country":"US","line1":"123 Main St","city":"New York","state":"NY","postal_code":"10001"}'),
  browserEngine: process.env.BROWSER_ENGINE || "camoufox",
  captchaService: process.env.CAPTCHA_SERVICE || "none",
  captchaApiKey: process.env.CAPTCHA_API_KEY || "",
  // Providers: kiro, kiro-pro, codebuddy, codebuddy-china, canva, codex, qoder, gitlab-duo, gumloop
  providers: ["kiro", "kiro-pro", "codebuddy", "codebuddy-china", "canva", "codex", "qoder", "gitlab-duo", "gumloop"] as const,

  // ── Gumloop ───────────────────────────────────────────────────────────────
  // Firebase project agenthub-dev (public web API key, exposed in Gumloop JS bundle).
  // Used to refresh the user's Firebase ID token after Google OAuth login so the
  // provider can register a client-generated UUID API key via POST /secret.
  // Set via env var GUMLOOP_FIREBASE_API_KEY (see .env.example).
  gumloopFirebaseApiKey: process.env.GUMLOOP_FIREBASE_API_KEY || "",
  gumloopApiBase: process.env.GUMLOOP_API_BASE || "https://api.gumloop.com",
  gumloopChatBase: process.env.GUMLOOP_CHAT_BASE || "https://ws.gumloop.com",
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
