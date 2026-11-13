ALTER TABLE "agents" ADD COLUMN "operator_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "operator_hold_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blocked_reason" text;