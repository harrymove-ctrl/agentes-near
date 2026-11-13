CREATE TABLE "run_tool_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_tool_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "run_tool_tokens" ADD CONSTRAINT "run_tool_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_tokens" ADD CONSTRAINT "run_tool_tokens_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_tokens" ADD CONSTRAINT "run_tool_tokens_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_tokens" ADD CONSTRAINT "run_tool_tokens_task_id_machine_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."machine_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_tool_tokens_run_id_index" ON "run_tool_tokens" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_tool_tokens_task_id_index" ON "run_tool_tokens" USING btree ("task_id");
