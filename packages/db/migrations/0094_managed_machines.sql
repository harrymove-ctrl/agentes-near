CREATE TABLE "machine_provisioning" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"step" text,
	"reason" text,
	"eta_seconds" integer,
	"specs" jsonb,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "kind" text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_provisioning" ADD CONSTRAINT "machine_provisioning_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machines_managed_org" ON "machines" USING btree ("org_id") WHERE "machines"."kind" = 'managed';