CREATE TABLE "app_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"client_id" text,
	"display_kind" text NOT NULL,
	"display_name" text NOT NULL,
	"display_host" text,
	"brand" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "app_grants_kind" CHECK ("app_grants"."kind" in ('oauth', 'token'))
);
--> statement-breakpoint
CREATE TABLE "app_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"parent_id" uuid,
	"request_id" uuid,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_tokens_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "app_tokens_kind" CHECK ("app_tokens"."kind" in ('access', 'refresh', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "oauth_app_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"redirect_uris" text[] NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_app_clients_kind" CHECK ("oauth_app_clients"."kind" in ('dcr', 'cimd'))
);
--> statement-breakpoint
CREATE TABLE "oauth_app_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"resource" text,
	"user_id" text,
	"decided_at" timestamp with time zone,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_requests_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_grants" ADD CONSTRAINT "app_grants_client_id_oauth_app_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_app_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sends" ADD CONSTRAINT "app_sends_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_sends" ADD CONSTRAINT "app_sends_grant_id_app_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."app_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tokens" ADD CONSTRAINT "app_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tokens" ADD CONSTRAINT "app_tokens_grant_id_app_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."app_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_requests" ADD CONSTRAINT "oauth_app_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_requests" ADD CONSTRAINT "oauth_app_requests_client_id_oauth_app_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_app_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_requests" ADD CONSTRAINT "oauth_app_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_grants_oauth_unique" ON "app_grants" USING btree ("user_id","org_id","client_id") WHERE "app_grants"."kind" = 'oauth';--> statement-breakpoint
CREATE INDEX "app_grants_active_idx" ON "app_grants" USING btree ("org_id","user_id") WHERE "app_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "app_sends_org_id_user_id_created_at_index" ON "app_sends" USING btree ("org_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_sends_message_id_index" ON "app_sends" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "app_tokens_grant_id_index" ON "app_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "app_tokens_family_id_index" ON "app_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "app_tokens_request_id_index" ON "app_tokens" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "oauth_app_clients_kind_last_used_at_index" ON "oauth_app_clients" USING btree ("kind","last_used_at");--> statement-breakpoint
CREATE INDEX "oauth_app_requests_expires_at_index" ON "oauth_app_requests" USING btree ("expires_at");