-- A workspace that isn't active waits for no computer: what its provisioner last said of one goes, and a ready
-- computer stays. The server now drops it when a workspace is held or suspended; these rows are from before.
DELETE FROM "machine_provisioning" AS p
USING "organizations" AS o
WHERE o."id" = p."org_id" AND o."standing" <> 'active' AND p."state" <> 'ready';
