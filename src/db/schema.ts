import { pgTable, serial, text, real, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(), // kiro | codebuddy | canva
  email: text("email").notNull(),
  password: text("password").notNull(), // encrypted
  status: text("status").notNull().default("pending"), // active | exhausted | error | pending
  tokens: jsonb("tokens"), // { access_token, refresh_token, ... }
  quotaLimit: real("quota_limit").default(0),
  quotaRemaining: real("quota_remaining").default(0),
  quotaResetAt: timestamp("quota_reset_at"),
  lastUsedAt: timestamp("last_used_at"),
  lastLoginAt: timestamp("last_login_at"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"), // extra provider-specific data
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Email must be unique PER provider (same email can exist for kiro + codebuddy + canva)
  uniqueIndex("accounts_provider_email_idx").on(table.provider, table.email),
]);

export const requestLogs = pgTable("request_logs", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").references(() => accounts.id),
  provider: text("provider").notNull(),
  model: text("model"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  creditsUsed: real("credits_used").default(0),
  status: text("status").notNull(), // success | error
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  accountEmail: text("account_email"),
  accountQuotaBefore: real("account_quota_before").default(0),
  accountQuotaAfter: real("account_quota_after").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Type exports
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
