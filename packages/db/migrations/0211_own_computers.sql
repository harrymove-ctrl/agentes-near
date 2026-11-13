-- ADR 0085 §12: what a member reaches of the agents' computers became a choice per role. Any member could use the
-- whole computer of an agent they own or of a computer they connected, and the browser when asked for help or behind
-- the run: `everyone` keeps that as `own_computers`. Roles holding `control_computers` keep it, and with it the rest.
UPDATE "org_roles" SET "permissions" = array_append("permissions", 'own_computers') WHERE "kind" = 'everyone' AND NOT ('own_computers' = ANY("permissions"));
