CREATE TABLE "machine_file_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_file_pulls" ADD CONSTRAINT "machine_file_pulls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_file_pulls" ADD CONSTRAINT "machine_file_pulls_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_file_pulls_machine_id_expires_at_index" ON "machine_file_pulls" USING btree ("machine_id","expires_at");--> statement-breakpoint
CREATE INDEX "machine_file_pulls_org_id_index" ON "machine_file_pulls" USING btree ("org_id");