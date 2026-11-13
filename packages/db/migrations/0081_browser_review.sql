ALTER TABLE "agents" ADD COLUMN "browser_machine_id" uuid;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "site" text;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_one_open" ON "browser_handoffs" USING btree ("agent_id") WHERE "browser_handoffs"."status" in ('pending', 'active');