-- A correction reached the instructions wrapped in the server's English: its lesson can be proposed again, in the
-- person's own words.
UPDATE "context_items"
SET "proposed_at" = NULL
WHERE "id" IN (
  SELECT unnest("item_ids") FROM "context_proposals"
  WHERE "status" = 'pending' AND "diff" ~ '(?n)^\+- A person corrected ".*": '
);
--> statement-breakpoint
-- A refused change was saved as a lesson, and a strong lesson became a new proposal: refusing made more to refuse.
-- Those rows close, and chat cards that name them still read how they ended. One a person accepted stays: it explains
-- the line now in the instructions, and changing that text would turn every open proposal on it stale.
UPDATE "context_proposals"
SET "status" = 'stale', "decided_at" = coalesce("decided_at", now())
WHERE "status" <> 'accepted'
  AND "diff" ~ '(?n)^\+- (A person refused this change; don''t propose it again: |".*" was refused(: | by a person\.)|A person corrected ".*": )';
--> statement-breakpoint
-- Refusing one of those taught a lesson about a lesson: nothing an agent can use.
UPDATE "context_items"
SET "status" = 'archived', "updated_at" = now()
WHERE "status" = 'active'
  AND "content" LIKE 'A person refused this change; don''t propose it again: %A person refused this change; don''t propose it again:%';
--> statement-breakpoint
-- The same change open several times: the newest stays, the others read as out of date. A row whose lines differ is
-- another change and stays open.
WITH keyed AS (
  SELECT p."id", row_number() OVER (
    PARTITION BY p."org_id", p."target", p."agent_id", p."skill_path", (
      SELECT string_agg(d.line, E'\n' ORDER BY d.at)
      FROM unnest(string_to_array(p."diff", E'\n')) WITH ORDINALITY AS d(line, at)
      WHERE d.line ~ '^[+-]' AND btrim(substr(d.line, 2)) NOT IN ('', '## Learned')
    )
    ORDER BY p."created_at" DESC, p."id" DESC
  ) AS "place"
  FROM "context_proposals" p
  WHERE p."status" = 'pending' AND p."target" IN ('agent_instructions', 'org_context', 'agent_role', 'skill')
)
UPDATE "context_proposals" p
SET "status" = 'stale', "decided_at" = now()
FROM keyed k
WHERE k."id" = p."id" AND k."place" > 1;
--> statement-breakpoint
-- Who reviews memory hears of what already waits on an agent's instructions, as they will of each new one, without a
-- push for rows this old. Mirrors `maySql` for `review_memory`; a row with nothing left to decide ends when its list is
-- opened.
INSERT INTO "notifications" ("id", "org_id", "user_id", "kind", "waiting", "group_key", "actors", "count")
SELECT gen_random_uuid(), w."org_id", m."user_id", 'proposal_waiting', true, 'proposals-waiting', w."actors", w."n"
FROM (
  SELECT p."org_id", count(*)::int AS "n",
    (SELECT jsonb_agg(jsonb_build_object('type', 'agent', 'id', x.id))
     FROM (SELECT DISTINCT unnest(array_agg(coalesce(p."proposed_by_agent_id", p."agent_id"))) AS id LIMIT 10) x) AS "actors"
  FROM "context_proposals" p
  JOIN "agents" a ON a."id" = p."agent_id" AND a."archived_at" IS NULL AND a."deleted_at" IS NULL
  WHERE p."status" = 'pending' AND p."target" = 'agent_instructions'
    AND p."base_hash" = encode(sha256(convert_to(a."instructions", 'UTF8')), 'hex')
  GROUP BY p."org_id"
) w
JOIN "organization_members" m ON m."org_id" = w."org_id"
WHERE m."role" = 'owner' OR EXISTS (
  SELECT 1 FROM "org_roles" r
  WHERE r."org_id" = m."org_id"
    AND (r."kind" = 'everyone' OR r."id" IN (
      SELECT mr."role_id" FROM "organization_member_roles" mr
      WHERE mr."org_id" = m."org_id" AND mr."user_id" = m."user_id"))
    AND r."permissions" && ARRAY['review_memory', 'administrator']::text[]
);
