CREATE TABLE "composio_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"capped_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_states" ALTER COLUMN "verifier_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ALTER COLUMN "wrapped_data_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ALTER COLUMN "kek_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "composio_account_id" text;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "composio_account_id" text;--> statement-breakpoint
ALTER TABLE "composio_usage" ADD CONSTRAINT "composio_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "composio_usage_org_month" ON "composio_usage" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "connector_connections_composio_account_id_index" ON "connector_connections" USING btree ("composio_account_id");--> statement-breakpoint
-- ADR 0107: the native Google Drive connector is gone. Its live rows (only a self-hosted server can have one) are
-- disconnected as `revokeConnection` does: their grants and "Aprovar sempre" rules deleted, `revoked_at` set.
DELETE FROM "agent_scopes" WHERE "connection_id" IN (SELECT "id" FROM "connector_connections" WHERE "connector" = 'drive' AND "revoked_at" IS NULL);--> statement-breakpoint
DELETE FROM "approval_rules" WHERE "connection_id" IN (SELECT "id" FROM "connector_connections" WHERE "connector" = 'drive' AND "revoked_at" IS NULL);--> statement-breakpoint
UPDATE "connector_connections" SET "revoked_at" = now() WHERE "connector" = 'drive' AND "revoked_at" IS NULL;
