ALTER TABLE "organizations" ADD COLUMN "standing" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "standing_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "standing_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "standing_notice" text DEFAULT 'shown' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "standing_changed_at" timestamp with time zone;