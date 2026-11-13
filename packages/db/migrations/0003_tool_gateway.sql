CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'refused', 'expired');--> statement-breakpoint
ALTER TYPE "public"."agent_run_step_kind" ADD VALUE 'tool_call';--> statement-breakpoint
ALTER TYPE "public"."agent_run_step_kind" ADD VALUE 'tool_result';--> statement-breakpoint
ALTER TYPE "public"."agent_run_step_kind" ADD VALUE 'approval';--> statement-breakpoint
CREATE TABLE "agent_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid,
	"scope" text NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_scopes_agentId_connectionId_scope_unique" UNIQUE NULLS NOT DISTINCT("agent_id","connection_id","scope")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid NOT NULL,
	"message_id" uuid,
	"tool_use_id" text NOT NULL,
	"tool" text NOT NULL,
	"scope" text NOT NULL,
	"connection_id" uuid,
	"params" jsonb NOT NULL,
	"action_hash" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"owner_user_id" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_runId_toolUseId_unique" UNIQUE("run_id","tool_use_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_scopes" ADD CONSTRAINT "agent_scopes_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_org_id_status_created_at_index" ON "approvals" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approvals_expires_at_index" ON "approvals" USING btree ("expires_at") WHERE "approvals"."status" = 'pending';