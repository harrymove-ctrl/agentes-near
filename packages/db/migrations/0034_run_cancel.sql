ALTER TABLE "agent_runs" ADD COLUMN "pending_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TYPE "public"."agent_run_status" ADD VALUE 'canceled';--> statement-breakpoint
ALTER TYPE "public"."approval_status" ADD VALUE 'canceled';--> statement-breakpoint
ALTER TYPE "public"."agent_question_status" ADD VALUE 'canceled';