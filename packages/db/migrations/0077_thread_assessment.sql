ALTER TABLE "threads" ADD COLUMN "title_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "resolved_suggested_at" timestamp with time zone;