ALTER TABLE "messages" ADD COLUMN "stretch_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "stretch_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_runs_org_id_stretch_id_index" ON "agent_runs" USING btree ("org_id","stretch_id") WHERE "agent_runs"."stretch_id" is not null;