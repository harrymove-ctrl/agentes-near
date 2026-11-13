ALTER TABLE "agents" ADD COLUMN "audience_mode" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;