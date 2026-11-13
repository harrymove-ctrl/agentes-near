CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid,
	"requested_by_user_id" text,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"undoable_until" timestamp with time zone NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" text,
	"redone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "findings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_actions_org_id_message_id_index" ON "agent_actions" USING btree ("org_id","message_id");--> statement-breakpoint
CREATE INDEX "agent_actions_run_id_index" ON "agent_actions" USING btree ("run_id");