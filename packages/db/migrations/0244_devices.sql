CREATE TABLE "device_access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid,
	"phone_id" uuid,
	"requester_user_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_connect_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"kind" text DEFAULT 'server' NOT NULL,
	"device_code_id" uuid,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_connect_links_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "machine_phones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid,
	"platform" text NOT NULL,
	"serial" text NOT NULL,
	"kind" text DEFAULT 'device' NOT NULL,
	"name" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"os_version" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"reason" text,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"holder" jsonb,
	"owner_user_id" text,
	"follows_host" boolean DEFAULT false NOT NULL,
	"audience_mode" text DEFAULT 'owner' NOT NULL,
	"audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "machine_phones_platform" CHECK ("machine_phones"."platform" in ('android', 'ios')),
	CONSTRAINT "machine_phones_kind" CHECK ("machine_phones"."kind" in ('device', 'emulator', 'simulator'))
);
--> statement-breakpoint
ALTER TABLE "machine_device_codes" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "audience_mode" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "belongs_to_workspace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_access_requests" ADD CONSTRAINT "device_access_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_access_requests" ADD CONSTRAINT "device_access_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_access_requests" ADD CONSTRAINT "device_access_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_connect_links" ADD CONSTRAINT "machine_connect_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_connect_links" ADD CONSTRAINT "machine_connect_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_phones" ADD CONSTRAINT "machine_phones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_phones" ADD CONSTRAINT "machine_phones_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_access_requests_org_id_requester_user_id_status_index" ON "device_access_requests" USING btree ("org_id","requester_user_id","status");--> statement-breakpoint
CREATE INDEX "device_access_requests_org_id_machine_id_index" ON "device_access_requests" USING btree ("org_id","machine_id");--> statement-breakpoint
CREATE INDEX "machine_connect_links_org_id_created_at_index" ON "machine_connect_links" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_phones_serial" ON "machine_phones" USING btree ("org_id","platform","serial");--> statement-breakpoint
CREATE INDEX "machine_phones_org_id_machine_id_index" ON "machine_phones" USING btree ("org_id","machine_id");--> statement-breakpoint
UPDATE "machines" SET "audience_mode" = 'everyone' WHERE "kind" <> 'connected' OR "executors"->>'mode' = 'system';
