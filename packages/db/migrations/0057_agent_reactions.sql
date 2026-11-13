-- Agents can react too (the `react` tool): a reaction is by a person or by an agent, never both.
ALTER TABLE "message_reactions" DROP CONSTRAINT "message_reactions_message_id_user_id_reaction_pk";--> statement-breakpoint
ALTER TABLE "message_reactions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_user" ON "message_reactions" USING btree ("message_id","user_id","reaction") WHERE "message_reactions"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_agent" ON "message_reactions" USING btree ("message_id","agent_id","reaction") WHERE "message_reactions"."agent_id" is not null;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_one_reactor" CHECK (("message_reactions"."user_id" is null) <> ("message_reactions"."agent_id" is null));
