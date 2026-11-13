ALTER TABLE "outbox" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reminded_at" timestamp with time zone;