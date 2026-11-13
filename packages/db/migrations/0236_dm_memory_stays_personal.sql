-- A preference said in a DM and saved for "everywhere" read in every run of the agent, other people's too. Those go
-- back to the person who said it. Left as they are: rules, which hold by their giver, and memories with no message
-- behind them.
UPDATE "context_items" i
SET "scope_type" = 'person', "scope_id" = i."created_by_id"
WHERE i."scope_type" = 'agent'
  AND i."kind" <> 'rule'
  AND i."created_by_kind" = 'person'
  AND i."created_by_id" IS NOT NULL
  AND i."channel_ids" = '{}'
  AND EXISTS (
    SELECT 1 FROM "messages" m
    JOIN "channels" c ON c."id" = m."channel_id"
    WHERE m."org_id" = i."org_id" AND m."id" = ANY(i."source_ids") AND c."kind" = 'dm'
  );
