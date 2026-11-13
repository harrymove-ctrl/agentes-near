CREATE TABLE "right_hand_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"new_agents" boolean DEFAULT true NOT NULL,
	"agent_changes" boolean DEFAULT true NOT NULL,
	"budget_cap_nano_usd" bigint DEFAULT 20000000000 NOT NULL,
	"guidance" text DEFAULT '' NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "right_hand_approvals_orgId_userId_unique" UNIQUE("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "right_hand_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"for_user_id" text NOT NULL,
	"right_hand_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_id" uuid NOT NULL,
	"proposed_by_agent_id" uuid,
	"outcome" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"called" boolean DEFAULT false NOT NULL,
	"budget_added_nano_usd" bigint DEFAULT 0 NOT NULL,
	"target_agent_id" uuid,
	"undone_at" timestamp with time zone,
	"undone_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "right_hand_decisions_orgId_messageId_unique" UNIQUE("org_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "right_hand_approvals" ADD CONSTRAINT "right_hand_approvals_org_id_user_id_organization_members_org_id_user_id_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "right_hand_decisions" ADD CONSTRAINT "right_hand_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "right_hand_decisions_org_id_for_user_id_created_at_index" ON "right_hand_decisions" USING btree ("org_id","for_user_id","created_at");