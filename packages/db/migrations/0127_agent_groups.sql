CREATE TABLE "agent_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "group_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_groups_org_id_position_index" ON "agent_groups" USING btree ("org_id","position");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_group_id_agent_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE set null ON UPDATE no action;