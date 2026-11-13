-- The previous version, still serving during a deploy (or after a rollback), inserts connections without
-- `tool_prefix`: this fills it as 0155's backfill does, numbered past the names a live connection holds.
CREATE FUNCTION "connector_connections_fill_tool_prefix"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
  n int := 2;
BEGIN
  IF NEW."tool_prefix" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  base := CASE WHEN NEW."connector" LIKE 'custom:%' THEN coalesce(nullif(left(trim(both '_' from regexp_replace(lower(NEW."label"), '[^a-z0-9]+', '_', 'g')), 24), ''), 'mcp') ELSE NEW."connector" END;
  NEW."tool_prefix" := base;
  WHILE EXISTS (
    SELECT 1 FROM "connector_connections"
    WHERE "org_id" = NEW."org_id" AND "revoked_at" IS NULL AND "tool_prefix" = NEW."tool_prefix"
  ) LOOP
    NEW."tool_prefix" := base || '_' || n;
    n := n + 1;
  END LOOP;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "connector_connections_fill_tool_prefix" BEFORE INSERT ON "connector_connections"
  FOR EACH ROW EXECUTE FUNCTION "connector_connections_fill_tool_prefix"();--> statement-breakpoint
-- deploy-safe: 0155 filled every row (in the same migrate transaction), and the trigger fills the previous version's inserts
ALTER TABLE "connector_connections" ALTER COLUMN "tool_prefix" SET NOT NULL;