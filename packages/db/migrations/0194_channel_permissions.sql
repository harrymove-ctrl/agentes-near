CREATE TABLE "channel_permission_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"role_id" uuid,
	"user_id" text,
	"allow" text[] DEFAULT '{}'::text[] NOT NULL,
	"deny" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_permission_overrides_channelId_roleId_unique" UNIQUE("channel_id","role_id"),
	CONSTRAINT "channel_permission_overrides_channelId_userId_unique" UNIQUE("channel_id","user_id"),
	CONSTRAINT "channel_permission_overrides_one_target" CHECK (("channel_permission_overrides"."role_id" is null) <> ("channel_permission_overrides"."user_id" is null)),
	CONSTRAINT "channel_permission_overrides_keys" CHECK (not ("channel_permission_overrides"."allow" && "channel_permission_overrides"."deny") and "channel_permission_overrides"."allow" <@ array['post', 'talk_to_agents', 'manage_channels']::text[]
        and "channel_permission_overrides"."deny" <@ array['post', 'talk_to_agents', 'manage_channels']::text[])
);
--> statement-breakpoint
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_org_id_channel_id_channels_org_id_id_fk" FOREIGN KEY ("org_id","channel_id") REFERENCES "public"."channels"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_org_id_role_id_org_roles_org_id_id_fk" FOREIGN KEY ("org_id","role_id") REFERENCES "public"."org_roles"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_permission_overrides" ADD CONSTRAINT "channel_permission_overrides_org_id_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;