ALTER TABLE "db_agent_policies" ADD COLUMN "databases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "db_connections" ADD COLUMN "whole_server" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "db_connections" ADD COLUMN "database_prefix" text;--> statement-breakpoint
ALTER TABLE "db_queries" ADD COLUMN "database" text;