-- Missions made before this keep asking for every command ("always"); new ones default to low_risk_auto.
ALTER TABLE "missions" ADD COLUMN "command_approval" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ALTER COLUMN "command_approval" SET DEFAULT 'low_risk_auto';
