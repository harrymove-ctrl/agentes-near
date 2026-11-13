CREATE TABLE "notes" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL, "body" text);--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_org_id_index" ON "notes" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TYPE "public"."usage_kind" ADD VALUE 'browser';--> statement-breakpoint
-- Words in comments, text and names are not statements: drop, rename, type, set not null.
UPDATE "notes" SET "body" = 'drop it; rename it; set not null' WHERE "drop" IS NULL;--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "summary";--> statement-breakpoint
DROP TABLE "drafts" CASCADE;--> statement-breakpoint
DROP INDEX "notes_title_index";--> statement-breakpoint
ALTER TABLE "notes" RENAME COLUMN "body" TO "text";--> statement-breakpoint
ALTER TABLE "drafts" RENAME TO "old_drafts";--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "title" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "notes" ALTER "org_id" TYPE text USING "org_id"::text;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "title" DROP DEFAULT;--> statement-breakpoint
-- deploy-safe: no version reads "legacy" since the one before the last.
ALTER TABLE "notes" DROP COLUMN "legacy";
DELETE FROM "notes" WHERE "title" = '';
ALTER TABLE "notes" DROP CONSTRAINT "notes_org_id_fk";
ALTER TABLE "notes" DROP COLUMN "old"; -- deploy-safe: nothing reads "old" since the release before the last
ALTER TABLE "notes" DROP COLUMN "older";--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "note" text;
