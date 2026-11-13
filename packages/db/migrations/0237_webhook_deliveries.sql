ALTER TABLE "webhook_endpoints" ADD COLUMN "last_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "last_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_set_at" timestamp with time zone;--> statement-breakpoint
-- GitHub webhooks set up by hand before deliveries were tracked count as working: their routines kept running.
UPDATE "webhook_endpoints" SET "last_delivery_at" = "created_at" WHERE "provider" = 'github' AND "revoked_at" IS NULL;