CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"agent_run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_runs_routineId_at_unique" UNIQUE("routine_id","at")
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"target" jsonb NOT NULL,
	"trigger_type" text NOT NULL,
	"phrase" text,
	"cron" text,
	"timezone" text,
	"description" text,
	"event" text,
	"active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"kek_id" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_runs_routine_id_created_at_index" ON "routine_runs" USING btree ("routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routines_org_id_index" ON "routines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "routines_active_next_run_at_index" ON "routines" USING btree ("active","next_run_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_id_index" ON "webhook_endpoints" USING btree ("org_id");