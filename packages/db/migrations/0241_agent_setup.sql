-- The setup checklist at the top of a new agent's chat (ADR 0155 §2). Null for the agents made before: they show none.
ALTER TABLE "agents" ADD COLUMN "setup" jsonb;--> statement-breakpoint
-- The right hand's first-run checklist (ADR 0155 §6) for the workspaces that have no agent besides it yet.
UPDATE "agents" AS rh SET "setup" = '{"role":null,"done":[]}'::jsonb
WHERE rh."builtin" = 'right_hand' AND rh."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "agents" a
    WHERE a."org_id" = rh."org_id" AND a."id" <> rh."id" AND a."builtin" IS NULL AND a."deleted_at" IS NULL
  );
