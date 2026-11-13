ALTER TABLE "mail_accounts" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "default_from" text;
