import { Hono } from "hono";
import { loginQueue } from "./queue";
import { warmupQueue } from "./warmup-queue";
import { loginAllProviders } from "./runner";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../utils/crypto";
import { clearAuthLogs, getAuthLogs } from "./logs";

export const authRouter = new Hono();

/**
 * POST /api/auth/login/:id - Login a specific account
 */
authRouter.post("/login/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ headless?: boolean }>().catch(() => ({}));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  loginQueue.enqueue(id, { headless: body.headless });
  return c.json({ message: "Login queued", accountId: id });
});

/**
 * POST /api/auth/login-all - Login all pending accounts
 */
authRouter.post("/login-all", async (c) => {
  const body = await c.req.json<{ headless?: boolean }>().catch(() => ({}));
  const count = await loginQueue.queueAllPending({ headless: body.headless });
  return c.json({ message: `Queued ${count} accounts for login`, count });
});

/**
 * POST /api/auth/login-bulk - Login specific accounts by IDs
 */
authRouter.post("/login-bulk", async (c) => {
  const body = await c.req.json<{ accountIds: number[]; headless?: boolean }>();

  if (!body.accountIds || !Array.isArray(body.accountIds)) {
    return c.json({ error: "accountIds array is required" }, 400);
  }

  loginQueue.enqueueBulk(body.accountIds, { headless: body.headless });
  return c.json({
    message: `Queued ${body.accountIds.length} accounts for login`,
    count: body.accountIds.length,
  });
});

/**
 * POST /api/auth/bulk-add - Bulk add accounts and queue login
 * Body: { accounts: [{ email, password }], providers?: ["kiro","codebuddy","canva"] }
 *
 * This creates DB entries for each email × provider combination,
 * then queues them all for login via the enowxai bot.
 */
authRouter.post("/bulk-add", async (c) => {
  const body = await c.req.json<{
    accounts: Array<{ email: string; password: string }>;
    providers?: string[];
    headless?: boolean;
    concurrency?: number;
  }>();

  if (!body.accounts || !Array.isArray(body.accounts) || body.accounts.length === 0) {
    return c.json({ error: "accounts array is required" }, 400);
  }

  const providers = body.providers || ["kiro", "codebuddy", "canva"];

  // Validate providers
  const validProviders = providers.filter((p) =>
    ["kiro", "codebuddy", "canva"].includes(p)
  );

  if (validProviders.length === 0) {
    return c.json({ error: "At least one valid provider is required (kiro, codebuddy, canva)" }, 400);
  }

  const items = body.accounts.map((a) => ({
    email: a.email,
    password: a.password,
    providers: validProviders,
  }));

  const result = await loginQueue.bulkAdd(items, { headless: body.headless, concurrency: body.concurrency });

  return c.json({
    message: `Created ${result.created} accounts, queued ${result.queued} for login`,
    ...result,
    providers: validProviders,
  });
});

/**
 * POST /api/auth/import - Import accounts from text (email|password format)
 * Body: { text: "email1|pass1\nemail2|pass2\n...", providers?: [...] }
 *
 * Supports formats:
 *   email|password
 *   email:password
 *   email password
 */
authRouter.post("/import", async (c) => {
  const body = await c.req.json<{
    text: string;
    providers?: string[];
    headless?: boolean;
    concurrency?: number;
  }>();

  if (!body.text || !body.text.trim()) {
    return c.json({ error: "text field is required" }, 400);
  }

  const providers = (body.providers || ["kiro", "codebuddy", "canva"]).filter((p) =>
    ["kiro", "codebuddy", "canva"].includes(p)
  );

  const lines = body.text.trim().split("\n");
  const parsed: Array<{ email: string; password: string }> = [];
  const errors: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Try different separators: | : space/tab
    let email = "";
    let password = "";

    if (trimmed.includes("|")) {
      const parts = trimmed.split("|");
      email = parts[0]?.trim() || "";
      password = parts[1]?.trim() || "";
    } else if (trimmed.includes(":")) {
      const parts = trimmed.split(":");
      email = parts[0]?.trim() || "";
      password = parts.slice(1).join(":").trim(); // password might contain ':'
    } else {
      const parts = trimmed.split(/\s+/);
      email = parts[0]?.trim() || "";
      password = parts[1]?.trim() || "";
    }

    if (!email || !password) {
      errors.push(`Invalid line: ${trimmed.slice(0, 50)}`);
      continue;
    }

    if (!email.includes("@")) {
      errors.push(`Invalid email: ${email}`);
      continue;
    }

    parsed.push({ email, password });
  }

  if (parsed.length === 0) {
    return c.json({ error: "No valid accounts found", errors }, 400);
  }

  const items = parsed.map((a) => ({
    email: a.email,
    password: a.password,
    providers,
  }));

  const result = await loginQueue.bulkAdd(items, { headless: body.headless, concurrency: body.concurrency });

  return c.json({
    message: `Imported ${parsed.length} accounts → created ${result.created}, queued ${result.queued}`,
    imported: parsed.length,
    ...result,
    providers,
    errors: errors.length > 0 ? errors : undefined,
  });
});

/**
 * GET /api/auth/queue - Get queue status
 */
authRouter.get("/queue", (c) => {
  return c.json(loginQueue.getStatus());
});

/**
 * GET /api/auth/logs - Get bot login progress logs
 */
authRouter.get("/logs", (c) => {
  const limit = Number(c.req.query("limit")) || 200;
  return c.json({ data: getAuthLogs(limit) });
});

/**
 * DELETE /api/auth/logs - Clear bot login progress logs
 */
authRouter.delete("/logs", (c) => {
  clearAuthLogs();
  return c.json({ success: true });
});

/**
 * DELETE /api/auth/queue - Clear the queue
 */
authRouter.delete("/queue", (c) => {
  loginQueue.clear();
  return c.json({ message: "Queue cleared" });
});

/**
 * PUT /api/auth/queue/concurrency - Set concurrency level
 */
authRouter.put("/queue/concurrency", async (c) => {
  const body = await c.req.json<{ concurrency: number }>();
  if (!body.concurrency || body.concurrency < 1 || body.concurrency > 10) {
    return c.json({ error: "concurrency must be between 1 and 10" }, 400);
  }
  loginQueue.setConcurrency(body.concurrency);
  return c.json({ message: `Concurrency set to ${body.concurrency}` });
});

/**
 * POST /api/auth/warmup/:id - WarmUp / health-check a specific account without login
 */
authRouter.post("/warmup/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!account) return c.json({ error: "Account not found" }, 404);

  warmupQueue.enqueue(id);
  return c.json({ message: "WarmUp queued", accountId: id });
});

/**
 * POST /api/auth/warmup-bulk - WarmUp specific accounts by IDs
 */
authRouter.post("/warmup-bulk", async (c) => {
  const body = await c.req.json<{ accountIds: number[] }>();
  if (!body.accountIds || !Array.isArray(body.accountIds)) {
    return c.json({ error: "accountIds array is required" }, 400);
  }

  warmupQueue.enqueueBulk(body.accountIds);
  return c.json({ message: `Queued ${body.accountIds.length} accounts for WarmUp`, count: body.accountIds.length });
});

/**
 * POST /api/auth/warmup-all - WarmUp active/exhausted/error Kiro and CodeBuddy accounts
 */
authRouter.post("/warmup-all", async (c) => {
  const body = await c.req.json<{ providers?: string[]; statuses?: string[]; includePending?: boolean }>().catch(() => ({}));
  const count = await warmupQueue.queueAll(body);
  return c.json({ message: `Queued ${count} accounts for WarmUp`, count });
});

/**
 * GET /api/auth/warmup-queue - Get WarmUp queue status
 */
authRouter.get("/warmup-queue", (c) => {
  return c.json(warmupQueue.getStatus());
});

authRouter.get("/warmup-events", (c) => {
  const logs = getAuthLogs(Number(c.req.query("limit")) || 300).filter((log) => log.type.startsWith("warmup_"));
  return c.json({ data: logs });
});

/**
 * DELETE /api/auth/warmup-queue - Clear WarmUp queue
 */
authRouter.delete("/warmup-queue", (c) => {
  warmupQueue.clear();
  return c.json({ message: "WarmUp queue cleared" });
});

/**
 * PUT /api/auth/warmup-queue/concurrency - Set WarmUp concurrency
 */
authRouter.put("/warmup-queue/concurrency", async (c) => {
  const body = await c.req.json<{ concurrency: number }>();
  if (!body.concurrency || body.concurrency < 1 || body.concurrency > 20) {
    return c.json({ error: "concurrency must be between 1 and 20" }, 400);
  }
  warmupQueue.setConcurrency(body.concurrency);
  return c.json({ message: `WarmUp concurrency set to ${body.concurrency}` });
});
