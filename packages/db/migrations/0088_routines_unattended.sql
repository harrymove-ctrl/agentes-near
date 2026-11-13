ALTER TABLE "agent_runs" ADD COLUMN "brain" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "why" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "brain" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "access" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "report" text DEFAULT 'when_new' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "failures_in_row" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routineId_dedupeKey_unique" UNIQUE("routine_id","dedupe_key");--> statement-breakpoint
UPDATE "routine_runs" AS rr SET "status" = CASE ar."status" WHEN 'done' THEN CASE WHEN ar."reply_message_id" IS NOT NULL THEN 'reported' ELSE 'silent' END WHEN 'failed' THEN 'failed' ELSE 'canceled' END, "finished_at" = coalesce(ar."finished_at", ar."updated_at") FROM "agent_runs" AS ar WHERE rr."agent_run_id" = ar."id" AND rr."status" = 'started' AND ar."status" IN ('done', 'failed', 'canceled');--> statement-breakpoint
UPDATE "routine_runs" SET "status" = 'failed', "code" = 'lost', "finished_at" = now() WHERE "status" = 'queued' AND "created_at" < now() - interval '1 day';
