CREATE TABLE "machine_mcp_calls" (
	"machine_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_mcp_calls_machine_id_call_id_pk" PRIMARY KEY("machine_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "machine_mcp_calls" ADD CONSTRAINT "machine_mcp_calls_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_mcp_calls" ADD CONSTRAINT "machine_mcp_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_mcp_calls_created_at_index" ON "machine_mcp_calls" USING btree ("created_at");