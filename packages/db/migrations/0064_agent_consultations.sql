CREATE TYPE "public"."agent_consultation_status" AS ENUM('open', 'answered', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "agent_consultations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"asker_run_id" uuid NOT NULL,
	"asker_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"target_run_id" uuid,
	"wait_id" text NOT NULL,
	"question" text NOT NULL,
	"chain" uuid[] NOT NULL,
	"status" "agent_consultation_status" DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_consultations_messageId_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD CONSTRAINT "agent_consultations_asker_run_id_agent_runs_id_fk" FOREIGN KEY ("asker_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD CONSTRAINT "agent_consultations_org_id_asker_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","asker_agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_consultations" ADD CONSTRAINT "agent_consultations_org_id_target_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","target_agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_consultations_asker_run_id_index" ON "agent_consultations" USING btree ("asker_run_id");--> statement-breakpoint
CREATE INDEX "agent_consultations_expires_at_index" ON "agent_consultations" USING btree ("expires_at") WHERE "agent_consultations"."status" = 'open';