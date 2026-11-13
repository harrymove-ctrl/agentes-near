CREATE TABLE "operator_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"org_id" uuid,
	"user_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"xact_id" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operator_events_xact_id_id_index" ON "operator_events" USING btree ("xact_id","id");--> statement-breakpoint
CREATE INDEX "operator_events_created_at_index" ON "operator_events" USING btree ("created_at");