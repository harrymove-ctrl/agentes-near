CREATE TYPE "public"."artifact_kind" AS ENUM('document', 'table', 'diff', 'html', 'diagram');--> statement-breakpoint
CREATE TYPE "public"."storage_kind" AS ENUM('s3', 'google_drive', 'onedrive');--> statement-breakpoint
CREATE TYPE "public"."storage_migration_status" AS ENUM('running', 'failed', 'done');--> statement-breakpoint
CREATE TYPE "public"."storage_status" AS ENUM('tested', 'failed', 'active', 'inactive');--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"note" text,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_artifactId_version_unique" UNIQUE("artifact_id","version")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"title" text NOT NULL,
	"channel_id" uuid,
	"thread_id" uuid,
	"untrusted" boolean DEFAULT false NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"key" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "storage_kind" NOT NULL,
	"options" jsonb NOT NULL,
	"secret_ciphertext" text,
	"wrapped_data_key" text,
	"kek_id" text,
	"access_key_hint" text DEFAULT '' NOT NULL,
	"secret_hint" text DEFAULT '' NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "storage_status" NOT NULL,
	"last_error" text,
	"verified_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_migrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"to_storage_config_id" uuid,
	"status" "storage_migration_status" DEFAULT 'running' NOT NULL,
	"copied" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"cursor" uuid,
	"error" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_configs" ADD CONSTRAINT "storage_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_configs" ADD CONSTRAINT "storage_configs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_versions_org_id_storage_config_id_index" ON "artifact_versions" USING btree ("org_id","storage_config_id");--> statement-breakpoint
CREATE INDEX "artifacts_org_id_updated_at_index" ON "artifacts" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "artifacts_channel_id_index" ON "artifacts" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_id_created_at_index" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "blobs_org_id_index" ON "blobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_configs_org_id_status_index" ON "storage_configs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_configs_one_active" ON "storage_configs" USING btree ("org_id") WHERE "storage_configs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "storage_migrations_org_id_created_at_index" ON "storage_migrations" USING btree ("org_id","created_at");