ALTER TABLE "sandboxes" ADD COLUMN "git_token_gen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "git_token_issued_at" timestamp with time zone;