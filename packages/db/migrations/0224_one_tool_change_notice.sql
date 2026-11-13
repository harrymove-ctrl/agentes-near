-- One waiting notice per connected server whose approved tools changed (ADR 0117), and only while something waits.
-- Before a server kept one, every change added a row, so the inbox showed the same "changed tools" card several
-- times; and a notice settled before it was resolved on settling kept asking with nothing left to review. Open
-- notices of a server with no pending tool are resolved; then each person's older open rows of a server where a newer
-- one is open; the open ones name their server, which the group key carries (`connector_tool_changed:<connection>:…`).
UPDATE "notifications" AS n SET "done_at" = now()
WHERE n."kind" = 'connector_tool_changed' AND n."done_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "connector_tool_pins" AS p
    WHERE p."org_id" = n."org_id" AND p."connection_id"::text = split_part(n."group_key", ':', 2)
      AND p."pending_fingerprint" IS NOT NULL
  );--> statement-breakpoint
UPDATE "notifications" AS n SET "done_at" = now()
WHERE n."kind" = 'connector_tool_changed' AND n."done_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "notifications" AS m
    WHERE m."org_id" = n."org_id" AND m."user_id" = n."user_id" AND m."kind" = 'connector_tool_changed'
      AND m."done_at" IS NULL AND split_part(m."group_key", ':', 2) = split_part(n."group_key", ':', 2)
      AND (m."updated_at", m."id") > (n."updated_at", n."id")
  );--> statement-breakpoint
UPDATE "notifications" SET "source" = "source" || jsonb_build_object('connectionId', split_part("group_key", ':', 2))
WHERE "kind" = 'connector_tool_changed' AND "done_at" IS NULL AND split_part("group_key", ':', 2) <> ''
  AND NOT ("source" ? 'connectionId');
