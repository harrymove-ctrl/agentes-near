ALTER TABLE "approvals" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "run_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "approvals_routine_id_run_at_index" ON "approvals" USING btree ("routine_id","run_at") WHERE "approvals"."run_at" is not null;