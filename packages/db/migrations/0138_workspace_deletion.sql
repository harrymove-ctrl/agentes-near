ALTER TABLE "organizations" ADD COLUMN "deletion_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_hold_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_deletion_requested_by_users_id_fk" FOREIGN KEY ("deletion_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_author_user_id_index" ON "messages" USING btree ("author_user_id") WHERE "messages"."author_user_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_author_agent_id_index" ON "messages" USING btree ("author_agent_id") WHERE "messages"."author_agent_id" is not null;