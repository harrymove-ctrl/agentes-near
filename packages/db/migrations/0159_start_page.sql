ALTER TABLE "organization_members" ADD COLUMN "start_page" text DEFAULT 'home' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "start_channel_id" uuid;