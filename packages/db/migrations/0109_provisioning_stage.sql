ALTER TABLE "machine_provisioning" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "machine_provisioning" ADD COLUMN "delayed_at" timestamp with time zone;