CREATE TABLE "machine_access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_id" uuid,
	"run_id" uuid,
	"requested_by_user_id" text,
	"path" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scope" text,
	"decided_at" timestamp with time zone,
	"woke_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_device_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"os" text DEFAULT 'other' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"runner_version" text DEFAULT '' NOT NULL,
	"protocol" integer,
	"workspace" text,
	"exec_allowed" boolean,
	"requester_ip" text DEFAULT '' NOT NULL,
	"approx_location" text,
	"confirmed_by_user_id" text,
	"machine_id" uuid,
	"last_polled_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_device_codes_deviceCodeHash_unique" UNIQUE("device_code_hash")
);
--> statement-breakpoint
DROP TABLE "machine_pairings" CASCADE;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "access" jsonb;--> statement-breakpoint
ALTER TABLE "machine_access_requests" ADD CONSTRAINT "machine_access_requests_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_access_requests" ADD CONSTRAINT "machine_access_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_access_requests" ADD CONSTRAINT "machine_access_requests_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_device_codes" ADD CONSTRAINT "machine_device_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_device_codes" ADD CONSTRAINT "machine_device_codes_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_access_requests_machine_id_status_index" ON "machine_access_requests" USING btree ("machine_id","status");--> statement-breakpoint
CREATE INDEX "machine_access_requests_org_id_agent_id_created_at_index" ON "machine_access_requests" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_device_codes_pending_user_code" ON "machine_device_codes" USING btree ("user_code") WHERE "machine_device_codes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "machine_device_codes_requester_ip_created_at_index" ON "machine_device_codes" USING btree ("requester_ip","created_at");
