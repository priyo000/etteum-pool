CREATE TABLE IF NOT EXISTS "proxy_pool" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"type" text DEFAULT 'http' NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp,
	"last_checked_at" timestamp,
	"error_message" text,
	"success_count" integer DEFAULT 0,
	"fail_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vcc_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"exp_month" text NOT NULL,
	"exp_year" text NOT NULL,
	"cvv" text NOT NULL,
	"name" text DEFAULT 'John Doe',
	"status" text DEFAULT 'active' NOT NULL,
	"used_by_account_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vcc_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"card_last4" text NOT NULL,
	"card_brand" text,
	"amount" real,
	"currency" text DEFAULT 'usd',
	"status" text NOT NULL,
	"stripe_charge_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vcc_cards" ADD CONSTRAINT "vcc_cards_used_by_account_id_accounts_id_fk" FOREIGN KEY ("used_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vcc_transactions" ADD CONSTRAINT "vcc_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proxy_pool_status_idx" ON "proxy_pool" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vcc_cards_status_idx" ON "vcc_cards" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vcc_transactions_account_idx" ON "vcc_transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vcc_transactions_status_idx" ON "vcc_transactions" USING btree ("status");
