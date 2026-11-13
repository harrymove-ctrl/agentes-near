ALTER TABLE "instance_telemetry" ADD COLUMN "host_samples" jsonb;--> statement-breakpoint
ALTER TABLE "instance_telemetry" ADD COLUMN "next_report_at" timestamp with time zone;