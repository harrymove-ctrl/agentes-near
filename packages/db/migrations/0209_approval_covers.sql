CREATE TABLE "approval_covers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"mode" text DEFAULT 'while_out' NOT NULL,
	"risky" boolean DEFAULT false NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_covers_orgId_fromUserId_unique" UNIQUE("org_id","from_user_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "high_risk" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "decided_for_user_id" text;--> statement-breakpoint
ALTER TABLE "approval_covers" ADD CONSTRAINT "approval_covers_org_id_from_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","from_user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_covers" ADD CONSTRAINT "approval_covers_org_id_to_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","to_user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_covers_org_id_to_user_id_index" ON "approval_covers" USING btree ("org_id","to_user_id");