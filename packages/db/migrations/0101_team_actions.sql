CREATE TABLE "team_action_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"message_id" uuid,
	"tool" text NOT NULL,
	"targets" text[] DEFAULT '{}'::text[] NOT NULL,
	"matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text DEFAULT 'held' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"channel_id" uuid,
	"source" text NOT NULL,
	"tool" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"targets" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "action_check" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "team_action_checks" ADD CONSTRAINT "team_action_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_actions" ADD CONSTRAINT "team_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_action_checks_run_id_index" ON "team_action_checks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "team_action_checks_org_id_message_id_index" ON "team_action_checks" USING btree ("org_id","message_id");--> statement-breakpoint
CREATE INDEX "team_actions_org_id_created_at_index" ON "team_actions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "team_actions_targets_idx" ON "team_actions" USING gin ("targets");--> statement-breakpoint
CREATE INDEX "team_actions_org_id_ref_index" ON "team_actions" USING btree ("org_id","ref");