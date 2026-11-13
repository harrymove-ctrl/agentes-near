ALTER TABLE "machine_accounts" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "key_hint" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "org_name" text;--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "usage" jsonb;--> statement-breakpoint
UPDATE "machine_accounts" AS ma SET "created_by" = m."paired_by_user_id" FROM "machines" AS m WHERE ma."created_by" IS NULL AND m."org_id" = ma."org_id" AND m."id" = ma."machine_id";--> statement-breakpoint
UPDATE "agents" AS a SET "brain_account_id" = NULL WHERE a."brain_account_id" IS NOT NULL AND a."archived_at" IS NULL AND EXISTS (SELECT 1 FROM "agents" AS b WHERE b."org_id" = a."org_id" AND b."brain_account_id" = a."brain_account_id" AND b."archived_at" IS NULL AND (b."updated_at" > a."updated_at" OR (b."updated_at" = a."updated_at" AND b."id" > a."id")));--> statement-breakpoint
CREATE UNIQUE INDEX "agents_brain_account_unique" ON "agents" USING btree ("org_id","brain_account_id") WHERE "agents"."brain_account_id" is not null and "agents"."archived_at" is null;
