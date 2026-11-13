ALTER TABLE "connector_connections" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "refreshing_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "token_auth_method" text;