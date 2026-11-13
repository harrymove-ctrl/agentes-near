ALTER TABLE "routines" ADD COLUMN "rule" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "rule" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "exdates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "override_of" uuid;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "original_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD COLUMN "rule" jsonb;