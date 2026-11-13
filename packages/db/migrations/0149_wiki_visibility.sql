ALTER TABLE "wiki_pages" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;