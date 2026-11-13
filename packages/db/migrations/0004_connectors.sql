CREATE TABLE "connector_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"label" text NOT NULL,
	"server_url" text NOT NULL,
	"auth_type" text NOT NULL,
	"secret_ciphertext" text,
	"wrapped_data_key" text,
	"kek_id" text,
	"token_expires_at" timestamp with time zone,
	"account_label" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"server_url" text,
	"return_to" text DEFAULT '/' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_stateHash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_one_active" ON "connector_connections" USING btree ("org_id","connector") WHERE "connector_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "connector_connections_org_id_index" ON "connector_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "oauth_states_org_id_index" ON "oauth_states" USING btree ("org_id");