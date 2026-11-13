-- A task's conversation (ADR 0145). Its old comments move into it at boot (moveIssueComments): Postgres can't use a
-- new enum value ('task') in the transaction that adds it.
ALTER TYPE "public"."channel_kind" ADD VALUE 'task';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "conversation_root_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_conversation_channel_id_channels_id_fk" FOREIGN KEY ("conversation_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_conversation_channel_id_index" ON "issues" USING btree ("conversation_channel_id");