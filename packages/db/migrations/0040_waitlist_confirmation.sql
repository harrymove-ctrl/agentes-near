ALTER TABLE "waitlist_entries" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "confirm_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "confirm_sends" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_confirm_token" ON "waitlist_entries" USING btree ("confirm_token_hash");