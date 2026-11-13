CREATE TABLE "agent_repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_repositories_agentId_repo_unique" UNIQUE("agent_id","repo")
);
--> statement-breakpoint
ALTER TABLE "agent_repositories" ADD CONSTRAINT "agent_repositories_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Repository limits used to be grants (`github:git.repo:owner/name`): they move here, in the order they were granted.
INSERT INTO "agent_repositories" ("id", "org_id", "agent_id", "repo", "position", "created_at")
SELECT gen_random_uuid(), "org_id", "agent_id", substr("scope", 17),
	(row_number() OVER (PARTITION BY "agent_id" ORDER BY "created_at", "scope"))::int - 1, "created_at"
FROM "agent_scopes" WHERE "scope" LIKE 'github:git.repo:%'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "agent_scopes" WHERE "scope" LIKE 'github:git.repo:%';
