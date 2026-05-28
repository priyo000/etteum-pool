CREATE TABLE "filter_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"pattern" text NOT NULL,
	"replacement" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_regex" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "filter_rules_rule_id_unique" UNIQUE("rule_id")
);
--> statement-breakpoint
CREATE TABLE "image_studio_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_prompt" text,
	"options" jsonb DEFAULT '[]'::jsonb,
	"assist_model" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "image_studio_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer,
	"prompt" text NOT NULL,
	"type" text DEFAULT 'image' NOT NULL,
	"aspect_ratio" text DEFAULT '1:1' NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	"urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credits_used" real DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "accounts_provider_status_enabled_idx";--> statement-breakpoint
ALTER TABLE "image_studio_results" ADD CONSTRAINT "image_studio_results_chat_id_image_studio_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."image_studio_chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filter_rules_sort_order_idx" ON "filter_rules" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "image_studio_chats_updated_at_idx" ON "image_studio_chats" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "image_studio_results_created_at_idx" ON "image_studio_results" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "image_studio_results_chat_idx" ON "image_studio_results" USING btree ("chat_id");