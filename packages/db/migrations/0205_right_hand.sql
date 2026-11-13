ALTER TABLE "agents" ADD COLUMN "builtin" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_right_hand" ON "agents" USING btree ("org_id") WHERE "agents"."builtin" = 'right_hand';