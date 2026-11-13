ALTER TABLE "secret_requests" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "secret_requests" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "previous_secrets" jsonb DEFAULT '[]'::jsonb NOT NULL;