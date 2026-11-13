CREATE TABLE "voice_clips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_id" uuid,
	"user_id" text,
	"client_id" text NOT NULL,
	"reply_to" uuid,
	"storage_config_id" uuid,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"peaks" jsonb NOT NULL,
	"language" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" uuid,
	"engine" text,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"audio_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- deploy-safe: the new check allows all the old one did, and the previous version never writes 'speech'
ALTER TABLE "instance_secrets" DROP CONSTRAINT "instance_secrets_name";--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "voice_messages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_clips" ADD CONSTRAINT "voice_clips_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_clips" ADD CONSTRAINT "voice_clips_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_clips" ADD CONSTRAINT "voice_clips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_clips_org_id_user_id_client_id_index" ON "voice_clips" USING btree ("org_id","user_id","client_id");--> statement-breakpoint
CREATE INDEX "voice_clips_org_id_created_at_index" ON "voice_clips" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_clips_user_id_created_at_index" ON "voice_clips" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_clips_created_at_index" ON "voice_clips" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "instance_secrets" ADD CONSTRAINT "instance_secrets_name" CHECK ("instance_secrets"."name" in ('typesafe', 'giphy', 'speech'));
