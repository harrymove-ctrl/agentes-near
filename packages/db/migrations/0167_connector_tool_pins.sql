CREATE TABLE "connector_tool_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_fingerprint" text,
	"pending_description" text,
	"pending_schema" jsonb,
	"changed_at" timestamp with time zone,
	CONSTRAINT "connector_tool_pins_orgId_connectionId_toolName_unique" UNIQUE("org_id","connection_id","tool_name")
);
--> statement-breakpoint
ALTER TABLE "connector_tool_pins" ADD CONSTRAINT "connector_tool_pins_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_tool_pins_connection_id_index" ON "connector_tool_pins" USING btree ("connection_id");