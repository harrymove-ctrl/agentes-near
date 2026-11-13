ALTER TABLE "machine_provisioning" ADD COLUMN "expected_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_provisioning" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_provisioning" ADD COLUMN "email_when_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "machine_provisioning" SET "expected_ready_at" = "updated_at" + make_interval(secs => "eta_seconds") WHERE "eta_seconds" IS NOT NULL AND "state" = 'preparing';
