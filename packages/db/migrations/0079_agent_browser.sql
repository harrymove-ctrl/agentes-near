CREATE TABLE "browser_handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"machine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_for_user_id" text,
	"controller_user_id" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "browser_allowed_domains" text[];--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_requested_for_user_id_users_id_fk" FOREIGN KEY ("requested_for_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_controller_user_id_users_id_fk" FOREIGN KEY ("controller_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_handoffs_org_id_status_index" ON "browser_handoffs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "browser_handoffs_agent_id_status_index" ON "browser_handoffs" USING btree ("agent_id","status");