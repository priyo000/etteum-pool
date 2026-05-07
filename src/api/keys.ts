import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";

const API_KEY_SETTING = "api_key";
const API_KEY_CACHE_TTL_MS = 5_000;

let activeApiKeyCache: { key: string; expiresAt: number } | null = null;

export const keysRouter = new Hono();

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk-pool-${token}`;
}

export async function getActiveApiKey(): Promise<string> {
  const now = Date.now();
  if (activeApiKeyCache && activeApiKeyCache.expiresAt > now) {
    return activeApiKeyCache.key;
  }

  const [row] = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  const key = row?.value || config.apiKey;
  activeApiKeyCache = { key, expiresAt: now + API_KEY_CACHE_TTL_MS };
  return key;
}

export async function isValidApiKey(token: string): Promise<boolean> {
  if (!token) return false;
  if (token === config.apiKey) return true;
  const active = await getActiveApiKey();
  return token === active;
}

async function saveApiKey(key: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, API_KEY_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value: key, updatedAt: new Date() }).where(eq(settings.key, API_KEY_SETTING));
  } else {
    await db.insert(settings).values({ key: API_KEY_SETTING, value: key });
  }
  activeApiKeyCache = { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS };
}

keysRouter.get("/", async (c) => {
  const key = await getActiveApiKey();
  return c.json({ key, source: key === config.apiKey ? "env" : "database" });
});

keysRouter.post("/regenerate", async (c) => {
  const key = generateApiKey();
  await saveApiKey(key);
  return c.json({ key, source: "database" });
});

keysRouter.post("/set", async (c) => {
  const body = await c.req.json<{ key: string }>();
  if (!body.key || body.key.length < 16) {
    return c.json({ error: "API key must be at least 16 characters" }, 400);
  }
  await saveApiKey(body.key);
  return c.json({ key: body.key, source: "database" });
});

keysRouter.post("/test", async (c) => {
  const body = await c.req.json<{ key: string }>();
  const valid = await isValidApiKey(body.key || "");
  return c.json({ valid });
});
