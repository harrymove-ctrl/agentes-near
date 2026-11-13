-- The defaults fill the workspaces already here: each counts as set up, so nobody is sent back to an onboarding.
ALTER TABLE "organizations" ADD COLUMN "onboarding_step" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarded_at" timestamp with time zone DEFAULT now();