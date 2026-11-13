-- Driving a desktop runs anything as the agent: only agents that may already browse and run code get it.
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), b."org_id", b."agent_id", NULL, 'desktop:use', now()
FROM "agent_scopes" b
JOIN "agent_scopes" r ON r."agent_id" = b."agent_id" AND r."connection_id" IS NULL AND r."scope" = 'sandbox:run'
JOIN "agents" a ON a."id" = b."agent_id"
WHERE b."connection_id" IS NULL AND b."scope" = 'browser:use' AND a."archived_at" IS NULL
ON CONFLICT DO NOTHING;
