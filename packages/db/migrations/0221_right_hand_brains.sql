CREATE TABLE "right_hand_brains" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"brain" text NOT NULL,
	"brain_model" text,
	"brain_account_id" uuid NOT NULL,
	"brain_account_lent_by" text,
	"brain_effort" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "right_hand_brains_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_brain_account_lent_by_users_id_fk" FOREIGN KEY ("brain_account_lent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_org_id_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "right_hand_brains" ADD CONSTRAINT "right_hand_brains_org_id_brain_account_id_machine_accounts_org_id_id_fk" FOREIGN KEY ("org_id","brain_account_id") REFERENCES "public"."machine_accounts"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "right_hand_brains_org_id_brain_account_id_index" ON "right_hand_brains" USING btree ("org_id","brain_account_id");