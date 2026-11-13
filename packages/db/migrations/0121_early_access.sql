CREATE TABLE "early_access_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text DEFAULT 'pt-BR' NOT NULL,
	"token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sends" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"user_id" text,
	"workspace_created_at" timestamp with time zone,
	"workspace_id" uuid
);
--> statement-breakpoint
CREATE TABLE "signup_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'invite' NOT NULL,
	"changed_at" timestamp with time zone,
	CONSTRAINT "signup_settings_one_row" CHECK ("signup_settings"."id" = 1),
	CONSTRAINT "signup_settings_mode" CHECK ("signup_settings"."mode" in ('invite', 'open'))
);
--> statement-breakpoint
ALTER TABLE "early_access_invitations" ADD CONSTRAINT "early_access_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_access_invitations" ADD CONSTRAINT "early_access_invitations_workspace_id_organizations_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "early_access_invitations_email" ON "early_access_invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "early_access_invitations_token" ON "early_access_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "early_access_invitations_user" ON "early_access_invitations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "early_access_invitations_created" ON "early_access_invitations" USING btree ("created_at","id");