CREATE TYPE "public"."mission_status" AS ENUM('proposed', 'active', 'paused', 'done', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."mission_role" AS ENUM('decide', 'comment');--> statement-breakpoint
CREATE TYPE "public"."mission_decision_status" AS ENUM('pending', 'provisional', 'taken');--> statement-breakpoint
CREATE TYPE "public"."mission_review_status" AS ENUM('pending', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_root_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" text,
	"machine_id" uuid,
	"machine_lent_by" text,
	"executor" text DEFAULT 'claude' NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" "mission_status" DEFAULT 'proposed' NOT NULL,
	"main_session_id" text NOT NULL,
	"repo_dir" text DEFAULT '' NOT NULL,
	"resume_tasks" boolean DEFAULT true NOT NULL,
	"plan_version" integer DEFAULT 0 NOT NULL,
	"plan_done" integer DEFAULT 0 NOT NULL,
	"plan_total" integer DEFAULT 0 NOT NULL,
	"plan_waiting" integer DEFAULT 0 NOT NULL,
	"inbox" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files_dirty_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_reason" text,
	"wiki_page_id" uuid,
	CONSTRAINT "missions_orgId_threadRootId_unique" UNIQUE("org_id","thread_root_id")
);
--> statement-breakpoint
CREATE TABLE "mission_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "mission_role" NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_participants_missionId_userId_unique" UNIQUE("mission_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "mission_plan_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"source" text DEFAULT 'executor' NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_plan_versions_missionId_version_unique" UNIQUE("mission_id","version")
);
--> statement-breakpoint
CREATE TABLE "mission_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid,
	"session_id" text,
	"message_id" uuid,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"recommendation" text,
	"why" text,
	"impact" text,
	"blocking" boolean DEFAULT true NOT NULL,
	"status" "mission_decision_status" DEFAULT 'pending' NOT NULL,
	"chosen" text,
	"chosen_by" text,
	"chosen_at" timestamp with time zone,
	"opinions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid,
	"session_id" text,
	"message_id" uuid,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"pr_url" text,
	"artifact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "mission_review_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"sha256" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'server' NOT NULL,
	"last_written_sha" text,
	"written_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_files_missionId_name_unique" UNIQUE("mission_id","name")
);
--> statement-breakpoint
CREATE TABLE "mission_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "mission_task_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_machine_lent_by_users_id_fk" FOREIGN KEY ("machine_lent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_participants" ADD CONSTRAINT "mission_participants_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_participants" ADD CONSTRAINT "mission_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_participants" ADD CONSTRAINT "mission_participants_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_plan_versions" ADD CONSTRAINT "mission_plan_versions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_decisions" ADD CONSTRAINT "mission_decisions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_decisions" ADD CONSTRAINT "mission_decisions_chosen_by_users_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reviews" ADD CONSTRAINT "mission_reviews_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_files" ADD CONSTRAINT "mission_files_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD CONSTRAINT "machine_tasks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "missions_org_id_status_index" ON "missions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "missions_machine_id_index" ON "missions" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "mission_participants_org_id_user_id_index" ON "mission_participants" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "mission_decisions_mission_id_status_index" ON "mission_decisions" USING btree ("mission_id","status");--> statement-breakpoint
CREATE INDEX "mission_reviews_mission_id_status_index" ON "mission_reviews" USING btree ("mission_id","status");--> statement-breakpoint
CREATE INDEX "mission_events_mission_id_created_at_index" ON "mission_events" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "machine_tasks_mission_id_index" ON "machine_tasks" USING btree ("mission_id");