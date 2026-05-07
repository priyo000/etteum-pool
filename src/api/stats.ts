import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, accounts } from "../db/schema";
import { desc, sql, eq } from "drizzle-orm";
import { pool } from "../proxy/pool";
import { config } from "../config";
import { getAllModels } from "../proxy/router";

export const statsRouter = new Hono();

function normalizeTimeZone(value: string | undefined): string {
  if (!value) return "UTC";
  if (!/^[A-Za-z0-9_+./-]+$/.test(value)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
}

function sqlString(value: string) {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

function usageBucketExpr(grain: "hour" | "day" | "month", timeZone: string) {
  const timeZoneSql = sqlString(timeZone);
  const localCreatedAt = sql`(${requestLogs.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZoneSql}`;
  return sql<string>`to_char(((date_trunc(${sqlString(grain)}, ${localCreatedAt}) AT TIME ZONE ${timeZoneSql}) AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

/**
 * GET /api/stats - Get overall statistics
 */
statsRouter.get("/", async (c) => {
  const [poolStats, requestStats] = await Promise.all([
    pool.getStats(),
    db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)`,
        errors: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
        totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
        promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
        credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
        avgDuration: sql<number>`COALESCE(AVG(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END), 0)`,
      })
      .from(requestLogs),
  ]);

  const stats = requestStats[0];

  return c.json({
    pool: poolStats,
    requests: {
      total: stats?.total || 0,
      success: stats?.success || 0,
      errors: stats?.errors || 0,
    },
    tokens: {
      total: stats?.totalTokens || 0,
      prompt: stats?.promptTokens || 0,
      completion: stats?.completionTokens || 0,
      credits: stats?.credits || 0,
    },
    performance: {
      avgDurationMs: Math.round(stats?.avgDuration || 0),
    },
  });
});

/**
 * GET /api/stats/requests - Get recent request logs
 */
statsRouter.get("/requests", async (c) => {
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;
  const provider = c.req.query("provider");

  const baseQuery = provider
    ? db.select().from(requestLogs).where(eq(requestLogs.provider, provider))
    : db.select().from(requestLogs);

  const logs = await baseQuery
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ data: logs, limit, offset });
});

/**
 * GET /api/stats/requests/:id - Get request log detail
 */
statsRouter.get("/requests/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [log] = await db.select().from(requestLogs).where(eq(requestLogs.id, id));
  if (!log) return c.json({ error: "Request log not found" }, 404);
  return c.json({ data: log });
});

/**
 * GET /api/stats/usage - Get usage over time (last 24h, hourly)
 */
statsRouter.get("/usage", async (c) => {
  const range = c.req.query("range");
  const hours = Number(c.req.query("hours")) || 24;
  const timeZone = normalizeTimeZone(c.req.query("timeZone"));
  const isAll = range === "all";
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Bucket by the user's local timezone, but return the bucket start as a UTC ISO instant.
  // The frontend can parse it consistently and still render labels in the browser timezone.
  const bucketExpr =
    isAll
      ? usageBucketExpr("month", timeZone)
      : hours <= 24
      ? usageBucketExpr("hour", timeZone)
      : hours <= 24 * 30
        ? usageBucketExpr("day", timeZone)
        : usageBucketExpr("month", timeZone);

  const whereExpr = isAll
    ? sql`${requestLogs.status} = 'success' AND COALESCE(${requestLogs.totalTokens}, 0) > 0`
    : sql`${requestLogs.createdAt} >= ${since.toISOString()} AND ${requestLogs.status} = 'success' AND COALESCE(${requestLogs.totalTokens}, 0) > 0`;

  const hourlyUsage = await db
    .select({
      hour: bucketExpr,
      provider: requestLogs.provider,
      model: requestLogs.model,
      count: sql<number>`count(*)`,
      tokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
      avgDuration: sql<number>`COALESCE(AVG(duration_ms), 0)`,
    })
    .from(requestLogs)
    .where(whereExpr)
    .groupBy(bucketExpr, requestLogs.provider, requestLogs.model)
    .orderBy(bucketExpr, requestLogs.provider, requestLogs.model);

  return c.json({ data: hourlyUsage, hours: isAll ? null : hours, range: isAll ? "all" : `${hours}h`, timeZone });
});

/**
 * GET /api/stats/providers - Get per-provider statistics
 */
statsRouter.get("/providers", async (c) => {
  const allowedProviders = new Set<string>(config.providers);
  const requestStats = await db
    .select({
      provider: requestLogs.provider,
      totalRequests: sql<number>`count(*)`,
      successRequests: sql<number>`SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)`,
      errorRequests: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      creditsUsed: sql<number>`COALESCE(SUM(credits_used), 0)`,
      avgDuration: sql<number>`COALESCE(AVG(duration_ms), 0)`,
    })
    .from(requestLogs)
    .groupBy(requestLogs.provider);

  const quotaStats = await db
    .select({
      provider: accounts.provider,
      activeAccounts: sql<number>`SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)`,
      exhaustedAccounts: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
      errorAccounts: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
      pendingAccounts: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
      totalAccounts: sql<number>`count(*)`,
      quotaLimit: sql<number>`COALESCE(SUM(quota_limit), 0)`,
      quotaRemaining: sql<number>`COALESCE(SUM(quota_remaining), 0)`,
    })
    .from(accounts)
    .groupBy(accounts.provider);

  const byProvider = new Map(
    requestStats
      .filter((row) => row.provider && allowedProviders.has(row.provider))
      .map((row) => [row.provider, row])
  );
  for (const quota of quotaStats) {
    if (!allowedProviders.has(quota.provider)) continue;
    const current = byProvider.get(quota.provider) || { provider: quota.provider } as any;
    byProvider.set(quota.provider, { ...current, ...quota });
  }

  const data = config.providers
    .map((provider) => byProvider.get(provider))
    .filter(Boolean);

  return c.json({ data });
});

/**
 * GET /api/stats/models - Get per-model statistics
 */
statsRouter.get("/models", async (c) => {
  const modelMeta = new Map(getAllModels().map((model) => [model.id, model]));
  const modelStats = await db
    .select({
      provider: requestLogs.provider,
      model: requestLogs.model,
      totalRequests: sql<number>`count(*)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens), 0)`,
      promptTokens: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
      credits: sql<number>`COALESCE(SUM(credits_used), 0)`,
      avgDuration: sql<number>`COALESCE(AVG(duration_ms), 0)`,
    })
    .from(requestLogs)
    .where(eq(requestLogs.status, "success"))
    .groupBy(requestLogs.provider, requestLogs.model)
    .having(sql`COALESCE(SUM(total_tokens), 0) > 0 OR COALESCE(SUM(credits_used), 0) > 0`)
    .orderBy(sql`COALESCE(SUM(credits_used), 0) DESC`);

  const data = modelStats.map((row) => {
    const meta = modelMeta.get(row.model || "");
    return {
      ...row,
      creditUnit: meta?.creditUnit || "token",
      creditRate: meta?.creditRate || 1 / 1000,
      creditSource: meta?.creditSource || "estimated",
    };
  });

  return c.json({ data });
});
