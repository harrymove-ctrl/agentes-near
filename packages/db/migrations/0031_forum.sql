CREATE TABLE "forum_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_topics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"phase" text DEFAULT 'discussing' NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"budget_nano_usd" bigint,
	"deadline" timestamp with time zone,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"requester_user_id" text,
	"owner_agent_id" uuid,
	"origin_channel_id" uuid,
	"origin_message_id" uuid,
	"current_run_id" uuid,
	"pending_person" boolean DEFAULT false NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"synthesis_artifact_id" uuid,
	"synthesis_version" integer,
	"suggested_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concluded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "forum_participants" ADD CONSTRAINT "forum_participants_topic_id_forum_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."forum_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_topics" ADD CONSTRAINT "forum_topics_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forum_participants_agent" ON "forum_participants" USING btree ("topic_id","agent_id") WHERE "forum_participants"."agent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "forum_participants_user" ON "forum_participants" USING btree ("topic_id","user_id") WHERE "forum_participants"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "forum_participants_org_id_index" ON "forum_participants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forum_topics_org_id_status_last_activity_at_index" ON "forum_topics" USING btree ("org_id","status","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forum_topics_channel_id_index" ON "forum_topics" USING btree ("channel_id");--> statement-breakpoint
ALTER TYPE "public"."channel_kind" ADD VALUE 'forum';--> statement-breakpoint
ALTER TYPE "public"."agent_run_trigger" ADD VALUE 'forum';--> statement-breakpoint
INSERT INTO "agent_scopes" ("id", "org_id", "agent_id", "connection_id", "scope", "created_at")
SELECT gen_random_uuid(), a."org_id", a."id", NULL, 'forum:write', now()
FROM "agents" a
WHERE a."archived_at" IS NULL
ON CONFLICT DO NOTHING;