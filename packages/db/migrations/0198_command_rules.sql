ALTER TABLE "approval_rules" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_no_connection" ON "approval_rules" USING btree ("agent_id","tool","action") WHERE "approval_rules"."connection_id" is null;--> statement-breakpoint
-- Catalog sign-ins made before the scopes were kept asked for the catalog's scopes of that time.
UPDATE "connector_connections" SET "oauth_scopes" = CASE "connector"
  WHEN 'github' THEN 'repo read:org workflow'
  WHEN 'linear' THEN 'read write'
  WHEN 'sentry' THEN 'org:read project:read event:read event:write'
END
WHERE "auth_type" = 'oauth' AND "oauth_client_id" IS NULL AND "connector" IN ('github', 'linear', 'sentry');
