ALTER TYPE "public"."artifact_kind" ADD VALUE 'file';--> statement-breakpoint
CREATE TABLE "machine_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"machine_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_pairings_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "machine_rpc" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"reply" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"paired_by_user_id" text,
	"token_hash" text,
	"hostname" text DEFAULT '' NOT NULL,
	"os" text DEFAULT 'other' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"runner_version" text DEFAULT '' NOT NULL,
	"protocol" integer DEFAULT 1 NOT NULL,
	"workspace" text DEFAULT '' NOT NULL,
	"exec_allowed" boolean DEFAULT true NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"connected_replica" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "machines_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "machines_orgId_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "artifact_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"computer" text NOT NULL,
	"machine_id" uuid,
	"path" text NOT NULL,
	"title" text,
	"note" text,
	"target_artifact_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"max_bytes" integer NOT NULL,
	"artifact_id" uuid,
	"version" integer,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "machine_pairings" ADD CONSTRAINT "machine_pairings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_pairings" ADD CONSTRAINT "machine_pairings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_rpc" ADD CONSTRAINT "machine_rpc_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_paired_by_user_id_users_id_fk" FOREIGN KEY ("paired_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_uploads" ADD CONSTRAINT "artifact_uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_uploads" ADD CONSTRAINT "artifact_uploads_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_pairings_org_id_created_at_index" ON "machine_pairings" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "machine_rpc_created_at_index" ON "machine_rpc" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "machines_org_id_index" ON "machines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "artifact_uploads_org_id_created_at_index" ON "artifact_uploads" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_machine_id_machines_org_id_id_fk" FOREIGN KEY ("org_id","machine_id") REFERENCES "public"."machines"("org_id","id") ON DELETE no action ON UPDATE no action;