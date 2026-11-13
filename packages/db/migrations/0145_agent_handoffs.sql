CREATE TYPE "public"."agent_consultation_kind" AS ENUM('question', 'note');--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD COLUMN "kind" "agent_consultation_kind" DEFAULT 'question' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_consultations_target_run_id_index" ON "agent_consultations" USING btree ("target_run_id");--> statement-breakpoint
CREATE INDEX "agent_consultations_org_id_asker_agent_id_created_at_index" ON "agent_consultations" USING btree ("org_id","asker_agent_id","created_at");