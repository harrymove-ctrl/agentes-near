CREATE TABLE "forum_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"seat_type" text NOT NULL,
	"seat_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" uuid,
	"message_id" uuid,
	"length" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forum_participants" ADD COLUMN "seat" integer;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "format" text DEFAULT 'decision' NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "origin_kind" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "origin_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "origin_routine_id" uuid;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "suggested_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "waiting_user_id" text;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "stall" jsonb;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "reopened_by_user_id" text;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "round_speakers" jsonb;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "syntheses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD COLUMN "created_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parent_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "forum_turns" ADD CONSTRAINT "forum_turns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_turns" ADD CONSTRAINT "forum_turns_topic_id_forum_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."forum_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forum_turns_topic_id_round_index" ON "forum_turns" USING btree ("topic_id","round");--> statement-breakpoint
CREATE INDEX "forum_turns_org_id_index" ON "forum_turns" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forum_topics_origin_issue_id_index" ON "forum_topics" USING btree ("origin_issue_id");--> statement-breakpoint
CREATE INDEX "issues_parent_issue_id_index" ON "issues" USING btree ("parent_issue_id");--> statement-breakpoint
ALTER TABLE "forum_topics" DROP COLUMN "budget_nano_usd";--> statement-breakpoint
UPDATE "forum_topics" SET "origin_kind" = 'agent' WHERE "created_by_type" = 'agent' AND "origin_channel_id" IS NOT NULL;