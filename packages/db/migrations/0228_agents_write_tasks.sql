-- New agents write tasks by default; existing ones get the same. Left out: an agent that held `issues:write` and lost it
-- (an audited save of its access listed it, or an approved card turned it on, and the row is gone now) and one whose
-- card asking for it was refused. Those are the only traces of "turned off on purpose": a row that was never there
-- reads the same as one a person removed. The right hand's tools are fixed in code, so it gets no row.
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, 'issues:write', now()
FROM "agents" a
WHERE a."deleted_at" IS NULL
  AND a."builtin" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "audit_log" l
    WHERE l."org_id" = a."org_id" AND l."action" = 'agent.access_changed' AND l."target_id" = a."id"::text
      AND l."details"->'scopes' @> '"issues:write"'::jsonb
  )
  AND NOT EXISTS (
    SELECT 1 FROM "approvals" p
    WHERE p."agent_id" = a."id" AND p."tool" = 'request_permission' AND p."params"->>'permission' = 'issues:write'
      AND p."status" IN ('approved', 'refused')
  )
ON CONFLICT DO NOTHING;
