CREATE TABLE "db_agent_policies" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tables" text[] DEFAULT '{}'::text[] NOT NULL,
	"hidden_columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"daily_query_cap" integer,
	"timeout_seconds" integer DEFAULT 15 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "db_agent_policies_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "db_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"provider" text DEFAULT 'other' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"database" text NOT NULL,
	"username" text NOT NULL,
	"sslmode" text DEFAULT 'require' NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"can_write" boolean DEFAULT false NOT NULL,
	"off_actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"suggested_hidden" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"statement" text NOT NULL,
	"row_count" integer,
	"duration_ms" integer,
	"error" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "db_agent_policies" ADD CONSTRAINT "db_agent_policies_connection_id_db_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."db_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_connections" ADD CONSTRAINT "db_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_connections" ADD CONSTRAINT "db_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_queries" ADD CONSTRAINT "db_queries_connection_id_db_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."db_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "db_agent_policies_org_id_index" ON "db_agent_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "db_connections_org_id_index" ON "db_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "db_queries_agent_id_connection_id_ran_at_index" ON "db_queries" USING btree ("agent_id","connection_id","ran_at");--> statement-breakpoint
CREATE INDEX "db_queries_org_id_index" ON "db_queries" USING btree ("org_id");