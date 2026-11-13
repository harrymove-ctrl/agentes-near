CREATE TYPE "public"."usage_kind" AS ENUM('agent', 'router', 'embedding', 'summary');--> statement-breakpoint
ALTER TYPE "public"."agent_run_trigger" ADD VALUE 'router';--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"default_credential_id" uuid,
	"router_model" text,
	"summary_model" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_budget_periods" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_nano_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_budget_periods_agent_id_period_start_pk" PRIMARY KEY("agent_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"amount_nano_usd" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_members" ADD COLUMN "auto_reply" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "kind" "usage_kind" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "partial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_default_credential_id_provider_credentials_id_fk" FOREIGN KEY ("default_credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_periods" ADD CONSTRAINT "agent_budget_periods_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_agent_id_expires_at_index" ON "budget_reservations" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_id_created_at_index" ON "usage_records" USING btree ("org_id","created_at");--> statement-breakpoint
DROP TYPE "public"."model_provider";--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"needs_agent_score" real,
	"selected_agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reason" text,
	"error" text,
	"usage_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_decisions_messageId_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE INDEX "routing_decisions_org_id_created_at_index" ON "routing_decisions" USING btree ("org_id","created_at");