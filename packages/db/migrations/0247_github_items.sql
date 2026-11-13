CREATE TABLE "github_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"authored" boolean DEFAULT false NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_items_orgId_repo_number_unique" UNIQUE("org_id","repo","number")
);
--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;