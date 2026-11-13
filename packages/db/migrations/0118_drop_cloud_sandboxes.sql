DROP TABLE "sandbox_usage_days" CASCADE;--> statement-breakpoint
DROP TABLE "sandboxes" CASCADE;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "kind" SET DEFAULT 'agent'::text;--> statement-breakpoint
-- Computer time on the cloud computers (ADR 0021, removed by ADR 0077) was the only usage of kind `sandbox`: its rows go with the kind.
DELETE FROM "usage_records" WHERE "kind" = 'sandbox';--> statement-breakpoint
DROP TYPE "public"."usage_kind";--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('agent', 'router', 'embedding', 'summary');--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "kind" SET DEFAULT 'agent'::"public"."usage_kind";--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "kind" SET DATA TYPE "public"."usage_kind" USING "kind"::"public"."usage_kind";--> statement-breakpoint
ALTER TABLE "org_sandbox_settings" DROP COLUMN "allow_domains";--> statement-breakpoint
ALTER TABLE "org_sandbox_settings" DROP COLUMN "network";--> statement-breakpoint
ALTER TABLE "org_sandbox_settings" DROP COLUMN "daily_minutes";