ALTER TABLE "issues" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;