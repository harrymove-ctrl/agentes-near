CREATE TABLE "autonomy_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"signature" text,
	"title" text DEFAULT '' NOT NULL,
	"channel_id" uuid,
	"run_id" uuid,
	"message_id" uuid,
	"state" text,
	"decided_by_user_id" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "autonomy_brakes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomy_signals" ADD CONSTRAINT "autonomy_signals_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autonomy_signals_org_id_agent_id_signature_created_at_index" ON "autonomy_signals" USING btree ("org_id","agent_id","signature","created_at");--> statement-breakpoint
CREATE INDEX "autonomy_signals_org_id_agent_id_kind_created_at_index" ON "autonomy_signals" USING btree ("org_id","agent_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "autonomy_signals_kind_index" ON "autonomy_signals" USING btree ("kind") WHERE "autonomy_signals"."done_at" is null;