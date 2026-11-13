ALTER TABLE "agent_runs" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_runs_issue_id_created_at_index" ON "agent_runs" USING btree ("issue_id","created_at");