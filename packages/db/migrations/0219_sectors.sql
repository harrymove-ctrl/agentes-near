ALTER TABLE "agent_groups" ADD COLUMN "color" text DEFAULT 'graphite' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD COLUMN "icon" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD COLUMN "lead_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD COLUMN "backup_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_backup_user_id_users_id_fk" FOREIGN KEY ("backup_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;