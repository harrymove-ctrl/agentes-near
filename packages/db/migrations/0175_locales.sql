ALTER TABLE "early_access_invitations" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "waitlist_entries" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale_auto" boolean DEFAULT true NOT NULL;