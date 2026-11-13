ALTER TABLE "org_sandbox_settings" ADD COLUMN "network" text DEFAULT 'blocked' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "network_applied_at" timestamp with time zone;--> statement-breakpoint
UPDATE "org_sandbox_settings" SET "network" = 'allowlist' WHERE jsonb_array_length("allow_domains") > 0;