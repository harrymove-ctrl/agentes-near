CREATE TABLE "wiki_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"from_page_id" uuid,
	"channel_id" uuid,
	"to_slug" text NOT NULL,
	"to_page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"requested_by_user_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"source" jsonb,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_from_page_id_wiki_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_links" ADD CONSTRAINT "wiki_links_to_page_id_wiki_pages_id_fk" FOREIGN KEY ("to_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_links_from_type_from_id_to_slug_index" ON "wiki_links" USING btree ("from_type","from_id","to_slug");--> statement-breakpoint
CREATE INDEX "wiki_links_org_id_to_slug_index" ON "wiki_links" USING btree ("org_id","to_slug");--> statement-breakpoint
CREATE INDEX "wiki_links_to_page_id_index" ON "wiki_links" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "wiki_links_from_page_id_index" ON "wiki_links" USING btree ("from_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_versions_page_id_version_index" ON "wiki_page_versions" USING btree ("page_id","version");--> statement-breakpoint
CREATE INDEX "wiki_page_versions_org_id_index" ON "wiki_page_versions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_org_slug" ON "wiki_pages" USING btree ("org_id","slug") WHERE "wiki_pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "wiki_pages_org_id_updated_at_index" ON "wiki_pages" USING btree ("org_id","updated_at");--> statement-breakpoint
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, s.scope, now()
FROM "agents" a CROSS JOIN (VALUES ('wiki:read'), ('wiki:write')) AS s(scope)
WHERE a."archived_at" IS NULL
ON CONFLICT DO NOTHING;