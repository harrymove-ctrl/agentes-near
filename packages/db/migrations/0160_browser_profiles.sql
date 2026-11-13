CREATE TABLE "browser_profile_grants" (
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_profile_grants_profile_id_agent_id_pk" PRIMARY KEY("profile_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "browser_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"held_by_run_id" uuid,
	"held_by_agent_id" uuid,
	"held_by_user_id" text,
	"held_until" timestamp with time zone,
	"held_since" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "browser_profiles_orgId_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "browser_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "browser_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "browser_profile_own" boolean;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "browser_profile_turn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_profile_grants" ADD CONSTRAINT "browser_profile_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_grants" ADD CONSTRAINT "browser_profile_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_grants" ADD CONSTRAINT "browser_profile_grants_org_id_profile_id_browser_profiles_org_id_id_fk" FOREIGN KEY ("org_id","profile_id") REFERENCES "public"."browser_profiles"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_grants" ADD CONSTRAINT "browser_profile_grants_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_profile_grants_agent_id_index" ON "browser_profile_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profiles_name" ON "browser_profiles" USING btree ("org_id",lower("name")) WHERE "browser_profiles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "browser_profiles_held_by_run_id_index" ON "browser_profiles" USING btree ("held_by_run_id");