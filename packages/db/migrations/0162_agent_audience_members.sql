-- People no longer in the workspace leave the agents' "only some people" lists (removing a member kept them there).
UPDATE "agents" AS a
SET "audience_user_ids" = coalesce(
  (SELECT array_agg(u.id ORDER BY u.n) FROM unnest(a."audience_user_ids") WITH ORDINALITY AS u(id, n)
   WHERE EXISTS (SELECT 1 FROM "organization_members" m WHERE m."org_id" = a."org_id" AND m."user_id" = u.id)),
  '{}'::text[]
)
WHERE EXISTS (
  SELECT 1 FROM unnest(a."audience_user_ids") AS u(id)
  WHERE NOT EXISTS (SELECT 1 FROM "organization_members" m WHERE m."org_id" = a."org_id" AND m."user_id" = u.id)
);
