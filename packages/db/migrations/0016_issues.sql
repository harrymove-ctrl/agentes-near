CREATE TYPE "public"."issue_priority" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('todo', 'in_progress', 'in_review', 'done', 'canceled');--> statement-breakpoint
CREATE TABLE "issue_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"text" text NOT NULL,
	"event" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_counters" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "issue_status" DEFAULT 'todo' NOT NULL,
	"priority" "issue_priority" DEFAULT 'normal' NOT NULL,
	"assignee_type" text,
	"assignee_id" text,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"due_date" date,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" jsonb DEFAULT '{"type":"manual"}'::jsonb NOT NULL,
	"channel_id" uuid,
	"pull_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_orgId_number_unique" UNIQUE("org_id","number")
);
--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_counters" ADD CONSTRAINT "issue_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_activity_issue_id_created_at_index" ON "issue_activity" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issues_org_id_status_index" ON "issues" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "issues_org_id_due_date_index" ON "issues" USING btree ("org_id","due_date");