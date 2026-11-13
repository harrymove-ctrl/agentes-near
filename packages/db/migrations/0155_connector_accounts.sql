ALTER TABLE "connector_connections" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "tool_prefix" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
-- ADR 0099: tool names stay what they are today. A catalog connector's start with its id, a server's by address
-- with its label as a slug (what `mcp.ts` made of the label until now).
UPDATE "connector_connections" SET "tool_prefix" = CASE WHEN "connector" LIKE 'custom:%' THEN coalesce(nullif(left(trim(both '_' from regexp_replace(lower("label"), '[^a-z0-9]+', '_', 'g')), 24), ''), 'mcp') ELSE "connector" END;--> statement-breakpoint
-- Live connections of a workspace with the same names (two servers with one label): the oldest keeps them, a catalog
-- connector first, and each other one takes the next free number, its tool grants and denials renamed with it.
DO $$
DECLARE
  r record;
  n int;
  fresh text;
BEGIN
  FOR r IN
    SELECT c."id", c."org_id", c."tool_prefix" FROM "connector_connections" c
    WHERE c."revoked_at" IS NULL AND EXISTS (
      SELECT 1 FROM "connector_connections" o
      WHERE o."org_id" = c."org_id" AND o."revoked_at" IS NULL AND o."tool_prefix" = c."tool_prefix"
        AND (o."connector" LIKE 'custom:%', o."created_at", o."id") < (c."connector" LIKE 'custom:%', c."created_at", c."id")
    )
    ORDER BY c."created_at", c."id"
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM "connector_connections"
      WHERE "org_id" = r."org_id" AND "revoked_at" IS NULL AND "tool_prefix" = r."tool_prefix" || '_' || n
    ) LOOP
      n := n + 1;
    END LOOP;
    fresh := r."tool_prefix" || '_' || n;
    UPDATE "connector_connections" SET "tool_prefix" = fresh WHERE "id" = r."id";
    UPDATE "agent_scopes" SET "scope" = substr("scope", 1, 5) || left(fresh || substr("scope", 6 + length(r."tool_prefix")), 64)
    WHERE "connection_id" = r."id" AND substr("scope", 1, 5) IN ('tool:', 'deny:')
      AND substr("scope", 6, length(r."tool_prefix") + 1) = r."tool_prefix" || '_';
  END LOOP;
  -- Names are unique among a workspace's live connections too (ignoring case): the same order keeps a name, each
  -- other one takes "<name> 2", "<name> 3"… as `freeLabel` does.
  FOR r IN
    SELECT c."id", c."org_id", c."label" FROM "connector_connections" c
    WHERE c."revoked_at" IS NULL AND EXISTS (
      SELECT 1 FROM "connector_connections" o
      WHERE o."org_id" = c."org_id" AND o."revoked_at" IS NULL AND lower(o."label") = lower(c."label")
        AND (o."connector" LIKE 'custom:%', o."created_at", o."id") < (c."connector" LIKE 'custom:%', c."created_at", c."id")
    )
    ORDER BY c."created_at", c."id"
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM "connector_connections"
      WHERE "org_id" = r."org_id" AND "revoked_at" IS NULL AND lower("label") = lower(r."label" || ' ' || n)
    ) LOOP
      n := n + 1;
    END LOOP;
    UPDATE "connector_connections" SET "label" = r."label" || ' ' || n WHERE "id" = r."id";
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_tool_prefix" ON "connector_connections" USING btree ("org_id","tool_prefix") WHERE "connector_connections"."revoked_at" is null;
