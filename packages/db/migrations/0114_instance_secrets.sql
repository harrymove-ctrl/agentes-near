CREATE TABLE "instance_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"key_hint" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_secrets_name" CHECK ("instance_secrets"."name" in ('typesafe'))
);
--> statement-breakpoint
ALTER TABLE "instance_telemetry" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "instance_secrets" ADD CONSTRAINT "instance_secrets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The installation's owner is pinned: its first account today, so the next oldest never inherits its settings.
UPDATE "instance_telemetry" SET "owner_user_id" = (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1) WHERE "owner_user_id" IS NULL;
