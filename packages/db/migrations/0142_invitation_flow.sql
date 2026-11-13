ALTER TABLE "organization_invitations" ADD COLUMN "channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN "suggested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_suggested_by_user_id_users_id_fk" FOREIGN KEY ("suggested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
