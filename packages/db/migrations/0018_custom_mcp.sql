CREATE TABLE "custom_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"read_only_hint" boolean,
	"access" text,
	"label" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "custom_tools_connectionId_name_unique" UNIQUE("connection_id","name")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_ciphertext" text,
	"wrapped_data_key" text,
	"kek_id" text,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "oauth_client_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "oauth_client_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD CONSTRAINT "custom_tools_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_tools_org_id_index" ON "custom_tools" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_org_issuer" ON "oauth_clients" USING btree ("org_id","issuer");