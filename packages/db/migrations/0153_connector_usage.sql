CREATE TABLE "composio_usage_days" (
	"day" date NOT NULL,
	"toolkit" text NOT NULL,
	"org_id" uuid NOT NULL,
	"action" text NOT NULL,
	"executions" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"connections" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "composio_usage_days_day_toolkit_org_id_action_pk" PRIMARY KEY("day","toolkit","org_id","action")
);
--> statement-breakpoint
CREATE TABLE "connector_usage_days" (
	"day" date NOT NULL,
	"connector" text NOT NULL,
	"via" text NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"approvals_asked" integer DEFAULT 0 NOT NULL,
	"approvals_given" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "connector_usage_days_day_connector_via_org_id_agent_id_tool_pk" PRIMARY KEY("day","connector","via","org_id","agent_id","tool")
);
--> statement-breakpoint
ALTER TABLE "composio_usage_days" ADD CONSTRAINT "composio_usage_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_usage_days" ADD CONSTRAINT "connector_usage_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "composio_usage_days_org_id_index" ON "composio_usage_days" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "connector_usage_days_org_id_index" ON "connector_usage_days" USING btree ("org_id");