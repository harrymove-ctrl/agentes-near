CREATE TABLE "agent_works" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"home_thread_id" uuid,
	"anchor_message_id" uuid NOT NULL,
	"own_thread" boolean NOT NULL,
	"title" text NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue_id" uuid,
	"status" text NOT NULL,
	"how" text NOT NULL,
	"requested_by_user_id" text,
	"update_seq" integer DEFAULT 0 NOT NULL,
	"last_update_at" timestamp with time zone NOT NULL,
	"last_update_text" text,
	"next_update_at" timestamp with time zone,
	"result_message_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_works_anchorMessageId_unique" UNIQUE("anchor_message_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "work_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "blocked" jsonb;--> statement-breakpoint
ALTER TABLE "agent_works" ADD CONSTRAINT "agent_works_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_works" ADD CONSTRAINT "agent_works_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_works_org_id_status_index" ON "agent_works" USING btree ("org_id","status") WHERE "agent_works"."status" in ('queued', 'live');--> statement-breakpoint
CREATE INDEX "agent_works_agent_id_status_index" ON "agent_works" USING btree ("agent_id","status") WHERE "agent_works"."status" in ('queued', 'live');--> statement-breakpoint
CREATE INDEX "agent_works_issue_id_index" ON "agent_works" USING btree ("issue_id") WHERE "agent_works"."issue_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_id_agent_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."agent_works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_work_idx" ON "agent_runs" USING btree ("work_id") WHERE "agent_runs"."work_id" is not null;