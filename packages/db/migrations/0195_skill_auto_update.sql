ALTER TABLE "skills" ADD COLUMN "auto_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "auto_update_user_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_hash" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pending_update" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "update_error" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_update" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_auto_update_user_id_users_id_fk" FOREIGN KEY ("auto_update_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;