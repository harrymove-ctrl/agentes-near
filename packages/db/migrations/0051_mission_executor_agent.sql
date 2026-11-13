ALTER TABLE "machines" ADD COLUMN "executors" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "waiting_for" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "idle_wakeups" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_tasks_live_session" ON "machine_tasks" USING btree ("mission_id","session_id") WHERE "machine_tasks"."mission_id" is not null and "machine_tasks"."session_id" is not null and "machine_tasks"."ended_at" is null;
