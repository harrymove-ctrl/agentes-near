DROP INDEX "browser_handoffs_one_open";--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD COLUMN "screen" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_one_open" ON "browser_handoffs" USING btree ("agent_id","screen") WHERE "browser_handoffs"."status" in ('pending', 'active');