ALTER TABLE "routines" ADD COLUMN "monthly_budget_nano_usd" bigint;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "deleted_at" timestamp with time zone;