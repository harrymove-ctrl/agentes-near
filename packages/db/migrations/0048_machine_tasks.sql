CREATE TYPE "public"."machine_task_status" AS ENUM('queued', 'running', 'interrupted', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "machine_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"run_id" uuid,
	"requested_by_user_id" text,
	"title" text NOT NULL,
	"executor" text NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"prompt" text,
	"session_id" text,
	"branch" text,
	"cwd" text,
	"status" "machine_task_status" DEFAULT 'queued' NOT NULL,
	"exit_code" integer,
	"signal" text,
	"seconds" integer,
	"last_line" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text,
	"canceled_by" text,
	"resumed_from_id" uuid,
	"resumed_task_id" uuid,
	"resume_count" integer DEFAULT 0 NOT NULL,
	"woke_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "resume_tasks" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD CONSTRAINT "machine_tasks_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD CONSTRAINT "machine_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD CONSTRAINT "machine_tasks_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_tasks_machine_id_status_index" ON "machine_tasks" USING btree ("machine_id","status");--> statement-breakpoint
CREATE INDEX "machine_tasks_org_id_agent_id_created_at_index" ON "machine_tasks" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "machine_tasks_org_id_channel_id_thread_root_id_index" ON "machine_tasks" USING btree ("org_id","channel_id","thread_root_id");
