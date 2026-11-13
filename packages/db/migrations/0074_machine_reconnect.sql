ALTER TABLE "machine_device_codes" ADD COLUMN "previous_machine_id" uuid;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "previous_agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;