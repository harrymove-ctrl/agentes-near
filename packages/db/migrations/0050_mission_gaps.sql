CREATE TYPE "public"."mission_join_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "mission_join_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "mission_join_status" DEFAULT 'pending' NOT NULL,
	"role" "mission_role",
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "recent_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "mission_join_requests" ADD CONSTRAINT "mission_join_requests_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_join_requests" ADD CONSTRAINT "mission_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_join_requests" ADD CONSTRAINT "mission_join_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_join_requests_one_pending" ON "mission_join_requests" USING btree ("mission_id","user_id") WHERE "mission_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "mission_join_requests_mission_id_status_index" ON "mission_join_requests" USING btree ("mission_id","status");
