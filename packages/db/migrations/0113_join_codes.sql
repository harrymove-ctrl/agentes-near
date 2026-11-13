CREATE TABLE "organization_join_code_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"mailbox" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_join_codes" (
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text,
	"tries" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_hash" text,
	"verified_until" timestamp with time zone,
	CONSTRAINT "organization_join_codes_org_id_email_pk" PRIMARY KEY("org_id","email")
);
--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_join_codes" ADD CONSTRAINT "organization_join_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_join_code_events_mailbox_at_index" ON "organization_join_code_events" USING btree ("mailbox","at");--> statement-breakpoint
CREATE INDEX "organization_join_code_events_at_index" ON "organization_join_code_events" USING btree ("at");