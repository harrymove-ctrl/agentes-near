-- Tasks an agent made in a DM or a private channel went to the whole workspace. Those whose receipt says where they
-- were made go back to that conversation, and a step made in a private task's own conversation to that task's. Left
-- as they are: tasks someone outside the conversation already works on (assigned, acted on or wrote in), who would
-- lose them, and tasks with no receipt, whose origin nothing records.
WITH made AS (
  SELECT DISTINCT i."id", CASE WHEN c."kind" = 'task' THEN p."channel_id" ELSE c."id" END AS "scope"
  FROM "issues" i
  JOIN "agent_actions" r ON r."org_id" = i."org_id" AND r."target_id" = i."id"::text AND r."kind" = 'issue.created'
  JOIN "channels" c ON c."id" = r."channel_id"
  LEFT JOIN "issues" p ON c."kind" = 'task' AND p."conversation_channel_id" = c."id"
  WHERE i."channel_id" IS NULL
    AND i."created_by_type" = 'agent'
    AND (c."kind" IN ('dm', 'task') OR (c."kind" = 'channel' AND c."visibility" = 'private'))
), tied AS (
  SELECT m."id", m."scope"
  FROM made m
  JOIN "issues" i ON i."id" = m."id"
  WHERE m."scope" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "channel_members" cm WHERE cm."channel_id" = m."scope" AND cm."user_id" IS NOT NULL)
    AND (i."assignee_type" IS DISTINCT FROM 'person' OR EXISTS (
      SELECT 1 FROM "channel_members" cm WHERE cm."channel_id" = m."scope" AND cm."user_id" = i."assignee_id"
    ))
    AND NOT EXISTS (
      SELECT 1 FROM "issue_activity" a
      WHERE a."issue_id" = i."id" AND a."author_type" = 'person' AND NOT EXISTS (
        SELECT 1 FROM "channel_members" cm WHERE cm."channel_id" = m."scope" AND cm."user_id" = a."author_id"
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM "messages" w
      WHERE w."channel_id" = i."conversation_channel_id" AND w."author_user_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "channel_members" cm WHERE cm."channel_id" = m."scope" AND cm."user_id" = w."author_user_id"
      )
    )
), moved AS (
  UPDATE "issues" i SET "channel_id" = t."scope" FROM tied t WHERE i."id" = t."id" RETURNING i."id", i."channel_id"
)
UPDATE "search_documents" d SET "channel_ids" = ARRAY[m."channel_id"]
FROM moved m
WHERE d."kind" = 'issue' AND d."source_id" = m."id";
