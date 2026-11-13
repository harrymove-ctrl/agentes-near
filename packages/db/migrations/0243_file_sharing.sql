ALTER TABLE "artifacts" ADD COLUMN "share" text DEFAULT 'conversation' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "share_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "share_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;