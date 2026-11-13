ALTER TABLE "organization_members" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "mentioned_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
WITH base AS (
  SELECT m."org_id", m."user_id",
    coalesce(nullif(regexp_replace(translate(lower(split_part(trim(u."name"), ' ', 1)), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '', 'g'), ''), 'pessoa') AS slug,
    m."created_at"
  FROM "organization_members" m JOIN "users" u ON u."id" = m."user_id"
), numbered AS (
  SELECT "org_id", "user_id", slug, row_number() OVER (PARTITION BY "org_id", slug ORDER BY "created_at", "user_id") AS n FROM base
)
UPDATE "organization_members" om SET "handle" = CASE WHEN nb.n = 1 THEN nb.slug ELSE nb.slug || '-' || nb.n END
FROM numbered nb WHERE om."org_id" = nb."org_id" AND om."user_id" = nb."user_id" AND om."handle" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_handle" ON "organization_members" USING btree ("org_id","handle");