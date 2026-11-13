ALTER TABLE "wiki_folder_audiences" ADD COLUMN "editors_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_folder_audiences" ADD COLUMN "editor_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_folder_audiences" ADD COLUMN "editor_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_folder_audiences" ADD COLUMN "agent_editors_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_folder_audiences" ADD COLUMN "agent_editor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "editors_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "editor_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "editor_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "agent_editors_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "agent_editor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;