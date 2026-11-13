CREATE TABLE "instance_telemetry" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"host_load" jsonb,
	CONSTRAINT "instance_telemetry_one_row" CHECK ("instance_telemetry"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "size" jsonb;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "load" jsonb;