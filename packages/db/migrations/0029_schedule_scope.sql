INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, 'schedule:write', now()
FROM "agents" a
WHERE a."archived_at" IS NULL
ON CONFLICT DO NOTHING;