ALTER TABLE "skills" ADD COLUMN "link_base" jsonb;--> statement-breakpoint
CREATE INDEX "agent_actions_org_id_target_id_index" ON "agent_actions" USING btree ("org_id","target_id");