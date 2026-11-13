CREATE TABLE "thread_reads" (
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_reads_root_message_id_user_id_pk" PRIMARY KEY("root_message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "channel_reads" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A thread's replies were read with its channel until now: each follower starts from that read, so nothing old turns unread.
INSERT INTO "thread_reads" ("org_id", "channel_id", "root_message_id", "user_id", "last_read_at")
SELECT r."org_id", r."channel_id", r."id", cr."user_id", cr."last_read_at"
FROM "messages" r
JOIN "channel_reads" cr ON cr."channel_id" = r."channel_id"
WHERE r."thread_id" IS NULL
  AND EXISTS (SELECT 1 FROM "messages" x WHERE x."thread_id" = r."id")
  AND (r."author_user_id" = cr."user_id"
    OR EXISTS (SELECT 1 FROM "messages" p WHERE p."thread_id" = r."id" AND p."author_user_id" = cr."user_id")
    OR EXISTS (SELECT 1 FROM "thread_follows" tf WHERE tf."root_message_id" = r."id" AND tf."user_id" = cr."user_id" AND tf."following"))
ON CONFLICT DO NOTHING;
