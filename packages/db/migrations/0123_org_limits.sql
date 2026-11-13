ALTER TABLE "organizations" ADD COLUMN "limit_members" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "limit_storage_bytes" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "limit_upload_bytes_per_day" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "limit_platform_nano_usd" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "limits_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "platform_alert_month" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "platform_alert_percent" smallint;