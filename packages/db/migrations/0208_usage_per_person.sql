CREATE TABLE "person_usage_months" (
	"org_id" uuid NOT NULL,
	"person_id" text NOT NULL,
	"period_start" date NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"raised_limit_nano_usd" bigint,
	"raised_by_user_id" text,
	"requested_at" timestamp with time zone,
	"reached_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_usage_months_org_id_person_id_period_start_pk" PRIMARY KEY("org_id","person_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "person_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "person_usage_months" ADD CONSTRAINT "person_usage_months_org_id_person_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_records_org_id_person_id_created_at_index" ON "usage_records" USING btree ("org_id","person_id","created_at");