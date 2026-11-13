CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"via" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"external_account_id" text,
	"preset" text,
	"imap_host" text,
	"imap_port" integer,
	"smtp_host" text,
	"smtp_port" integer,
	"username" text,
	"secret_ciphertext" text,
	"wrapped_data_key" text,
	"kek_id" text,
	"sent_folder" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail_agent_policies" (
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folders" text[] DEFAULT '{}'::text[] NOT NULL,
	"senders" text[] DEFAULT '{}'::text[] NOT NULL,
	"window_days" integer,
	"allowed_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"daily_send_cap" integer DEFAULT 25 NOT NULL,
	"send_without_asking" boolean DEFAULT false NOT NULL,
	"from_address" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_agent_policies_agent_id_account_id_pk" PRIMARY KEY("agent_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "mail_seen" (
	"org_id" uuid NOT NULL,
	"watch_id" uuid NOT NULL,
	"message_key" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_seen_watch_id_message_key_pk" PRIMARY KEY("watch_id","message_key")
);
--> statement-breakpoint
CREATE TABLE "mail_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"recipients" text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"provider_message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_watches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_trigger_id" text,
	"last_uid" bigint,
	"uid_validity" bigint,
	"last_checked_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_watches_routineId_unique" UNIQUE("routine_id")
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_agent_policies" ADD CONSTRAINT "mail_agent_policies_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_seen" ADD CONSTRAINT "mail_seen_watch_id_mail_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."mail_watches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_watches" ADD CONSTRAINT "mail_watches_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_watches" ADD CONSTRAINT "mail_watches_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_accounts_org_id_index" ON "mail_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_one_active_address" ON "mail_accounts" USING btree ("org_id","address") WHERE "mail_accounts"."revoked_at" is null and "mail_accounts"."address" <> '';--> statement-breakpoint
CREATE INDEX "mail_agent_policies_org_id_index" ON "mail_agent_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mail_seen_org_id_index" ON "mail_seen" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mail_seen_seen_at_index" ON "mail_seen" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "mail_sends_agent_id_account_id_sent_at_index" ON "mail_sends" USING btree ("agent_id","account_id","sent_at");--> statement-breakpoint
CREATE INDEX "mail_sends_org_id_index" ON "mail_sends" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mail_watches_account_id_index" ON "mail_watches" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_watches_org_id_index" ON "mail_watches" USING btree ("org_id");