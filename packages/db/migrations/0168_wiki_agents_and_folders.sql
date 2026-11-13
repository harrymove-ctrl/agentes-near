CREATE TABLE "wiki_folder_audiences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"agents_limited" boolean DEFAULT false NOT NULL,
	"audience_agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "agents_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "audience_agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "audience_folder" text;--> statement-breakpoint
ALTER TABLE "wiki_folder_audiences" ADD CONSTRAINT "wiki_folder_audiences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_folder_audiences_org_id_folder_index" ON "wiki_folder_audiences" USING btree ("org_id","folder");