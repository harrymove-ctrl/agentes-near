CREATE TABLE "org_sandbox_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exec_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"daily_minutes" integer DEFAULT 120 NOT NULL,
	"require_approval" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_usage_days" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"status" text NOT NULL,
	"network" text DEFAULT 'blocked' NOT NULL,
	"cpu" integer NOT NULL,
	"memory_gib" integer NOT NULL,
	"disk_gib" integer NOT NULL,
	"disk_used_mib" integer DEFAULT 0 NOT NULL,
	"billed_seconds" integer DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_sandbox_settings" ADD CONSTRAINT "org_sandbox_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_usage_days" ADD CONSTRAINT "sandbox_usage_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_one_live_per_key" ON "sandboxes" USING btree ("org_id","key") WHERE "sandboxes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "sandboxes_org_id_last_used_at_index" ON "sandboxes" USING btree ("org_id","last_used_at");--> statement-breakpoint
ALTER TABLE "sandbox_usage_days" ADD CONSTRAINT "sandbox_usage_days_org_id_day_pk" PRIMARY KEY("org_id","day");--> statement-breakpoint
ALTER TYPE "public"."usage_kind" ADD VALUE 'sandbox';