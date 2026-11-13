CREATE TABLE "push_relay_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone,
	CONSTRAINT "push_relay_instances_secretHash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "instance_push" ADD COLUMN "relay_url" text;--> statement-breakpoint
ALTER TABLE "instance_push" ADD COLUMN "relay_instance_id" text;--> statement-breakpoint
ALTER TABLE "instance_push" ADD COLUMN "relay_secret" text;