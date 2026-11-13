CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_app" text NOT NULL,
	"source_ref" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"target_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"adopted" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_items_source_item" UNIQUE("org_id","created_by_user_id","source_app","source_ref","kind","key")
);
--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;