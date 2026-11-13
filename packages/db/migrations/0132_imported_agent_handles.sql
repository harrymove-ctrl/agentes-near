-- Agents an import named after their OpenBot.run id (`agent-` and a UUID, cut to 32 characters) get a handle from
-- their name, as imports name them now (`handleFromName` in packages/engine/src/imports.ts): its letters and digits
-- without accents (Latin-1 ones), up to 32. One still named "New agent" (or by its id), or whose name has none of
-- them, takes them from its role, else from the first sentence of its instructions, else it is "newagent". A handle
-- another agent of the workspace (archived ones too) or a person there has gets the next number after a dash
-- ("newagent-2"). Only agents an import made: a handle someone chose stays. Messages keep their text; their mentions
-- are stored by agent id.
DO $$
DECLARE
  a record;
  candidate text;
  base text;
  wanted text;
  n integer;
BEGIN
  FOR a IN
    SELECT g."id", g."org_id", g."name", g."role", g."instructions"
    FROM "agents" AS g
    WHERE g."handle" ~ '^agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f-]*$'
      AND EXISTS (
        SELECT 1 FROM "import_items" AS i
        WHERE i."org_id" = g."org_id" AND i."kind" = 'agent' AND i."target_id" = g."id"
      )
    ORDER BY g."org_id", g."created_at", g."id"
  LOOP
    base := '';
    FOREACH candidate IN ARRAY ARRAY[
      CASE
        WHEN lower(btrim(a."name")) = 'new agent' OR a."name" ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' THEN ''
        ELSE a."name"
      END,
      a."role",
      substring(a."instructions" from ('^[^.!?' || chr(10) || ']*')),
      'New agent'
    ] LOOP
      base := left(
        regexp_replace(
          lower(translate(
            coalesce(candidate, ''),
            'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿ',
            'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy'
          )),
          '[^a-z0-9]', '', 'g'
        ),
        32
      );
      EXIT WHEN base <> '';
    END LOOP;
    IF length(base) < 2 THEN
      base := rpad(base, 2, '0');
    END IF;
    wanted := base;
    n := 2;
    WHILE EXISTS (SELECT 1 FROM "agents" WHERE "org_id" = a."org_id" AND "handle" = wanted AND "id" <> a."id")
      OR EXISTS (SELECT 1 FROM "organization_members" WHERE "org_id" = a."org_id" AND "handle" = wanted)
    LOOP
      wanted := regexp_replace(left(base, 31 - length(n::text)), '[-_]+$', '') || '-' || n;
      n := n + 1;
    END LOOP;
    UPDATE "agents" SET "handle" = wanted WHERE "id" = a."id";
  END LOOP;
END $$;
