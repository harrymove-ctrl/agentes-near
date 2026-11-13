-- A Claude account that kept its automatic name, the maker and the plan ("Claude Max", "Claude Team 2"), is named
-- "Claude", numbered among its owner's automatic names ("Claude 2"), oldest first: the apps show the plan beside the
-- name, and a plan changes while the name stays (Anthropic renamed Max 20x to Ultra). The logins of one account (the
-- same owner, computer and email) keep one name, and a name someone chose stays.
WITH "named" AS (
  SELECT "org_id", "id", "created_by", "machine_id", lower(coalesce("email", "id"::text)) AS "who", "created_at"
  FROM "machine_accounts"
  WHERE "kind" = 'claude_code' AND "provider" IS NULL AND "status" IN ('active', 'signed_out')
    AND "label" ~ '^Claude( (Pro|Max|Team|Enterprise))?( [0-9]+)?$'
), "accounts" AS (
  SELECT "org_id", "created_by", "machine_id", "who",
    row_number() OVER (PARTITION BY "org_id", "created_by" ORDER BY min("created_at"), "machine_id", "who") AS "n"
  FROM "named"
  GROUP BY "org_id", "created_by", "machine_id", "who"
)
UPDATE "machine_accounts" AS m
SET "label" = CASE WHEN a."n" = 1 THEN 'Claude' ELSE 'Claude ' || a."n" END
FROM "named" AS r
JOIN "accounts" AS a ON a."org_id" = r."org_id" AND a."created_by" IS NOT DISTINCT FROM r."created_by"
  AND a."machine_id" = r."machine_id" AND a."who" = r."who"
WHERE m."org_id" = r."org_id" AND m."id" = r."id";
