CREATE TYPE "public"."secret_request_status" AS ENUM('pending', 'delivered', 'declined', 'expired', 'canceled');--> statement-breakpoint
CREATE TABLE "secret_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"message_id" uuid,
	"tool_use_id" text NOT NULL,
	"requested_for_user_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_path" text,
	"machine_id" uuid,
	"public_key" text NOT NULL,
	"status" "secret_request_status" DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_size" integer,
	"removed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_requests_runId_toolUseId_unique" UNIQUE("run_id","tool_use_id")
);
--> statement-breakpoint
ALTER TABLE "secret_requests" ADD CONSTRAINT "secret_requests_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD CONSTRAINT "secret_requests_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_requests_agent_id_status_index" ON "secret_requests" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "secret_requests_expires_at_index" ON "secret_requests" USING btree ("expires_at") WHERE "secret_requests"."status" = 'pending';