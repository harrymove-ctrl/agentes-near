CREATE TABLE "vault_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text,
	"label" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"audience_everyone" boolean DEFAULT false NOT NULL,
	"audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"all_agents" boolean DEFAULT false NOT NULL,
	"agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"error_code" text,
	"synced_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"connection_id" uuid,
	"external_ref" text,
	"owner_user_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"website" text,
	"match" text DEFAULT 'exact' NOT NULL,
	"username" text,
	"key_name" text,
	"key_hint" text,
	"secret_ciphertext" text,
	"wrapped_data_key" text,
	"kek_id" text,
	"secret_version" integer DEFAULT 0 NOT NULL,
	"access_from_connection" boolean DEFAULT false NOT NULL,
	"audience_everyone" boolean DEFAULT false NOT NULL,
	"audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"all_agents" boolean DEFAULT false NOT NULL,
	"agent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_uses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"action" text NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"on_behalf_of_user_id" text,
	"run_id" uuid,
	"routine_id" uuid,
	"origin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "code_digits" smallint;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_connections" ADD CONSTRAINT "vault_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_connection_id_vault_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."vault_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_connections_org_id_index" ON "vault_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vault_items_org_id_kind_index" ON "vault_items" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_items_connection_id_external_ref_index" ON "vault_items" USING btree ("connection_id","external_ref");--> statement-breakpoint
CREATE INDEX "vault_uses_item_id_created_at_index" ON "vault_uses" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_uses_org_id_created_at_index" ON "vault_uses" USING btree ("org_id","created_at");--> statement-breakpoint
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, s."scope", now()
FROM "agents" a CROSS JOIN (VALUES ('vault:read'), ('vault:write')) AS s("scope")
WHERE a."archived_at" IS NULL
ON CONFLICT DO NOTHING;