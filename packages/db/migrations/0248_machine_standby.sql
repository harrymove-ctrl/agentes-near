ALTER TABLE "machines" ADD COLUMN "standby_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "wanted_at" timestamp with time zone;