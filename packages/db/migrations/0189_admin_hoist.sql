-- Each workspace's built-in Admin (the one created with it, holding `administrator`) is listed apart in the members
-- column, as a new workspace's is. No screen set `hoist` before, so this overrides no one's choice.
UPDATE "org_roles" SET "hoist" = true WHERE "kind" = 'custom' AND "name" = 'Admin' AND 'administrator' = ANY("permissions");
