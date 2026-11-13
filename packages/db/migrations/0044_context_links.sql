ALTER TABLE "context_items" ADD COLUMN "related_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "context_items" ADD COLUMN "disputed" boolean DEFAULT false NOT NULL;
