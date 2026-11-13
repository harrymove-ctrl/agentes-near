ALTER TYPE "public"."proposal_target" ADD VALUE 'agent_settings';--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "requested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;