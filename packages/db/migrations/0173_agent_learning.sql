ALTER TYPE "public"."proposal_target" ADD VALUE 'skill';--> statement-breakpoint
CREATE TABLE "agent_learning_days" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"day" date NOT NULL,
	"jobs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_learning_days_agent_id_day_pk" PRIMARY KEY("agent_id","day")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "origin" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_learning_days" ADD CONSTRAINT "agent_learning_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_learning_days_org_id_index" ON "agent_learning_days" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;