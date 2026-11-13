CREATE TABLE "machine_accounts" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"email" text,
	"plan" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "machine_accounts_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "brain_account_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "brain_effort" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD CONSTRAINT "machine_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD CONSTRAINT "machine_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD CONSTRAINT "machine_accounts_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_accounts_org_id_machine_id_index" ON "machine_accounts" USING btree ("org_id","machine_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_brain_account_id_machine_accounts_org_id_id_fk" FOREIGN KEY ("org_id","brain_account_id") REFERENCES "public"."machine_accounts"("org_id","id") ON DELETE no action ON UPDATE no action;