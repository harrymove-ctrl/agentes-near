CREATE TABLE "org_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT 'shield' NOT NULL,
	"color" text DEFAULT 'graphite' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentionable" boolean DEFAULT true NOT NULL,
	"hoist" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_roles_orgId_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "organization_member_roles" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_roles_org_id_user_id_role_id_pk" PRIMARY KEY("org_id","user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD COLUMN "role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN "role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invitations" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organization_invite_links" ALTER COLUMN "role" SET DEFAULT 'member'::text;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organization_members" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
-- ADR 0085: every workspace gets its base role ("everyone", what members could do) and an "Admin" role that
-- holds "administrator"; today's admins hold it, and the role the enum loses becomes "member".
INSERT INTO "org_roles" ("org_id", "kind", "name", "icon", "color", "position", "permissions") SELECT "id", 'everyone', 'everyone', 'audienceEveryone', 'graphite', 0, ARRAY['post', 'create_channels', 'talk_to_agents', 'assign_work', 'pair_computers', 'edit_wiki', 'upload_files']::text[] FROM "organizations";--> statement-breakpoint
INSERT INTO "org_roles" ("org_id", "kind", "name", "icon", "color", "position", "permissions") SELECT "id", 'custom', 'Admin', 'shield', 'indigo', 0, ARRAY['administrator']::text[] FROM "organizations";--> statement-breakpoint
INSERT INTO "organization_member_roles" ("org_id", "user_id", "role_id") SELECT m."org_id", m."user_id", r."id" FROM "organization_members" m JOIN "org_roles" r ON r."org_id" = m."org_id" AND r."kind" = 'custom' AND r."name" = 'Admin' WHERE m."role" = 'admin';--> statement-breakpoint
UPDATE "organization_invitations" i SET "role_ids" = ARRAY[r."id"] FROM "org_roles" r WHERE r."org_id" = i."org_id" AND r."kind" = 'custom' AND r."name" = 'Admin' AND i."role" = 'admin';--> statement-breakpoint
UPDATE "organization_join_requests" j SET "role_ids" = ARRAY[r."id"] FROM "org_roles" r WHERE r."org_id" = j."org_id" AND r."kind" = 'custom' AND r."name" = 'Admin' AND j."role" = 'admin';--> statement-breakpoint
UPDATE "organization_members" SET "role" = 'member' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "organization_invitations" SET "role" = 'member' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "organization_invite_links" SET "role" = 'member' WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "organization_join_requests" SET "role" = 'member' WHERE "role" = 'admin';--> statement-breakpoint
DROP TYPE "public"."member_role";--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint
ALTER TABLE "organization_invitations" ALTER COLUMN "role" SET DATA TYPE "public"."member_role" USING "role"::"public"."member_role";--> statement-breakpoint
ALTER TABLE "organization_invite_links" ALTER COLUMN "role" SET DEFAULT 'member'::"public"."member_role";--> statement-breakpoint
ALTER TABLE "organization_invite_links" ALTER COLUMN "role" SET DATA TYPE "public"."member_role" USING "role"::"public"."member_role";--> statement-breakpoint
ALTER TABLE "organization_join_requests" ALTER COLUMN "role" SET DATA TYPE "public"."member_role" USING "role"::"public"."member_role";--> statement-breakpoint
ALTER TABLE "organization_members" ALTER COLUMN "role" SET DATA TYPE "public"."member_role" USING "role"::"public"."member_role";--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_org_id_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_org_id_role_id_org_roles_org_id_id_fk" FOREIGN KEY ("org_id","role_id") REFERENCES "public"."org_roles"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_everyone" ON "org_roles" USING btree ("org_id") WHERE "org_roles"."kind" = 'everyone';--> statement-breakpoint
CREATE INDEX "org_roles_org_id_position_index" ON "org_roles" USING btree ("org_id","position");--> statement-breakpoint
CREATE INDEX "organization_member_roles_org_id_role_id_index" ON "organization_member_roles" USING btree ("org_id","role_id");