CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"waiting" boolean DEFAULT false NOT NULL,
	"group_key" text NOT NULL,
	"actors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_inbox" ON "notifications" USING btree ("org_id","user_id","updated_at") WHERE "notifications"."done_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_open_group" ON "notifications" USING btree ("org_id","user_id","group_key") WHERE "notifications"."done_at" is null and "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_group" ON "notifications" USING btree ("org_id","group_key");--> statement-breakpoint
CREATE INDEX "notifications_snoozed" ON "notifications" USING btree ("snoozed_until") WHERE "notifications"."snoozed_until" is not null and "notifications"."done_at" is null;
