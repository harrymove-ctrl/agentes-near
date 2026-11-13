-- The names people know: a key that kept its default name "Anthropic" is "Claude", and a ChatGPT account that kept
-- its default "Codex" ("Codex Plus") is "ChatGPT" ("ChatGPT Plus"). A name someone chose stays, and so does an
-- account whose new name its owner already uses (each owner's account names are distinct).
UPDATE "provider_credentials" SET "label" = 'Claude' WHERE "provider" = 'anthropic' AND "label" = 'Anthropic';
--> statement-breakpoint
UPDATE "machine_accounts" AS a SET "label" = 'ChatGPT' || substr(a."label", 6)
WHERE a."kind" = 'codex'
  AND (a."label" = 'Codex' OR a."label" = 'Codex ' || upper(left(a."plan", 1)) || substr(a."plan", 2))
  AND NOT EXISTS (
    SELECT 1 FROM "machine_accounts" AS b
    WHERE b."org_id" = a."org_id"
      AND b."created_by" IS NOT DISTINCT FROM a."created_by"
      AND b."label" = 'ChatGPT' || substr(a."label", 6)
  );
