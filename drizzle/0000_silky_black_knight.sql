CREATE TABLE IF NOT EXISTS "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tokens" jsonb,
	"quota_limit" real DEFAULT 0,
	"quota_remaining" real DEFAULT 0,
	"quota_reset_at" timestamp,
	"last_used_at" timestamp,
	"last_login_at" timestamp,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"provider" text NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0,
	"completion_tokens" integer DEFAULT 0,
	"total_tokens" integer DEFAULT 0,
	"credits_used" real DEFAULT 0,
	"status" text NOT NULL,
	"duration_ms" integer,
	"error_message" text,
	"request_body" jsonb,
	"response_body" jsonb,
	"account_email" text,
	"account_quota_before" real DEFAULT 0,
	"account_quota_after" real DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'request_logs_account_id_accounts_id_fk'
  ) THEN
    ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_provider_email_idx" ON "accounts" USING btree ("provider","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_created_at_idx" ON "request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_status_created_at_idx" ON "request_logs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_provider_created_at_idx" ON "request_logs" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_provider_model_status_idx" ON "request_logs" USING btree ("provider","model","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_logs_account_idx" ON "request_logs" USING btree ("account_id");
