CREATE TYPE "public"."thread_state" AS ENUM('open', 'closed', 'archived');--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"title" text,
	"state" "thread_state" DEFAULT 'open' NOT NULL,
	"created_by" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"archived_by" text,
	"archived_at" timestamp with time zone,
	"context_channel_id" uuid,
	"context_first_message_id" uuid,
	"context_last_message_id" uuid,
	"context_first_at" timestamp with time zone,
	"context_last_at" timestamp with time zone,
	"context_excluded_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"context_moved" boolean DEFAULT false NOT NULL,
	"context_moved_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_orgId_rootMessageId_unique" UNIQUE("org_id","root_message_id")
);
--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_context_channel_id_channels_id_fk" FOREIGN KEY ("context_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_org_id_channel_id_state_index" ON "threads" USING btree ("org_id","channel_id","state");--> statement-breakpoint
CREATE INDEX "messages_channel_id_thread_id_created_at_index" ON "messages" USING btree ("channel_id","thread_id","created_at") WHERE "messages"."thread_id" is not null;
