CREATE TYPE "public"."agent_question_status" AS ENUM('open', 'answered', 'expired');--> statement-breakpoint
ALTER TYPE "public"."agent_run_status" ADD VALUE 'waiting_input' BEFORE 'done';--> statement-breakpoint
CREATE TABLE "agent_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"message_id" uuid,
	"tool_use_id" text NOT NULL,
	"text" text NOT NULL,
	"choices" text[],
	"status" "agent_question_status" DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_questions_runId_toolUseId_unique" UNIQUE("run_id","tool_use_id")
);
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_questions_channel_id_status_index" ON "agent_questions" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "agent_questions_expires_at_index" ON "agent_questions" USING btree ("expires_at") WHERE "agent_questions"."status" = 'open';