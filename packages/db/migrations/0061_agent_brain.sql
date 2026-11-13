-- ADR 0032: who thinks for an agent (model | claude_code | codex, validated in code), its model, and the fallback to the API.
ALTER TABLE "agents" ADD COLUMN "brain" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "brain_model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "brain_fallback" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "brain" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "brain_model" text;
