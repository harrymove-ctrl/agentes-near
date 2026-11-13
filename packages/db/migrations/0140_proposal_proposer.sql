ALTER TYPE "public"."proposal_target" ADD VALUE 'agent_role';--> statement-breakpoint
ALTER TYPE "public"."proposal_target" ADD VALUE 'agent_access';--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "proposed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD COLUMN "access" jsonb;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;