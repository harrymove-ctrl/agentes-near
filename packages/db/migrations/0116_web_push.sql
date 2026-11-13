CREATE TABLE "instance_push" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"vapid_public_key" text,
	"vapid_private_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_push_one_row" CHECK ("instance_push"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "web_keys" jsonb;