ALTER TYPE "public"."mission_status" ADD VALUE 'awaiting_close';--> statement-breakpoint
CREATE TABLE "mission_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"task_id" uuid,
	"message_id" uuid,
	"auto" boolean DEFAULT false NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"artifact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"save_to_wiki" boolean DEFAULT false NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission_deliveries" ADD CONSTRAINT "mission_deliveries_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_deliveries" ADD CONSTRAINT "mission_deliveries_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_deliveries_mission_id_status_index" ON "mission_deliveries" USING btree ("mission_id","status");
