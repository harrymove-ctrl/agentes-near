CREATE TYPE "public"."channel_kind" AS ENUM('channel', 'dm');--> statement-breakpoint
ALTER TYPE "public"."agent_run_trigger" ADD VALUE 'dm';--> statement-breakpoint
CREATE TABLE "channel_reads" (
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_reads_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "kind" "channel_kind" DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "dm_key" text;--> statement-breakpoint
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_orgId_dmKey_unique" UNIQUE("org_id","dm_key");