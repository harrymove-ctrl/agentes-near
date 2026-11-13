ALTER TABLE "machines" ADD COLUMN "host_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "machines_host_org" ON "machines" USING btree ("org_id") WHERE "machines"."kind" = 'host';