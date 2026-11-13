-- deploy-safe: the new check allows all the old one did, and the previous version writes only 'typesafe'
ALTER TABLE "instance_secrets" DROP CONSTRAINT "instance_secrets_name";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "media_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "gifs" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "gif_rating" text DEFAULT 'g' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "agent_stickers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "agent_media" text DEFAULT 'sometimes' NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_secrets" ADD CONSTRAINT "instance_secrets_name" CHECK ("instance_secrets"."name" in ('typesafe', 'giphy'));