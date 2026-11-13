ALTER TABLE "organization_settings" ADD COLUMN "agents_improve_skills" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "skill_path" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "agents_improve" boolean;