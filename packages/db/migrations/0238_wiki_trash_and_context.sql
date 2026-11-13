ALTER TABLE "wiki_page_reads" ADD COLUMN "kind" text DEFAULT 'context' NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "agent_context" boolean DEFAULT false NOT NULL;