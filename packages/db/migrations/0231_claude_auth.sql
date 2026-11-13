CREATE TABLE "claude_auth_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"method" text DEFAULT 'setup_token' NOT NULL,
	"rollout" text DEFAULT 'selected' NOT NULL,
	"org_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"changed_at" timestamp with time zone,
	CONSTRAINT "claude_auth_settings_one_row" CHECK ("claude_auth_settings"."id" = 1),
	CONSTRAINT "claude_auth_settings_method" CHECK ("claude_auth_settings"."method" in ('cli_login', 'setup_token')),
	CONSTRAINT "claude_auth_settings_rollout" CHECK ("claude_auth_settings"."rollout" in ('selected', 'all')),
	CONSTRAINT "claude_auth_settings_org_ids" CHECK (coalesce(cardinality("claude_auth_settings"."org_ids"), 0) <= 500)
);
--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "auth_method" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "status_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "provider_org_id" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "last_failure_cause" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD CONSTRAINT "machine_accounts_auth_method" CHECK ("machine_accounts"."auth_method" in ('cli_login', 'setup_token', 'api_key'));