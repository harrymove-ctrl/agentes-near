CREATE TABLE "dashboard_widget_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"widget_id" uuid NOT NULL,
	"routine_run_id" uuid,
	"agent_run_id" uuid,
	"status" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"spec" jsonb,
	"alert" text,
	"failure_code" text,
	"change" text,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'auto' NOT NULL,
	"kind" text,
	"spec" jsonb,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"w" integer DEFAULT 1 NOT NULL,
	"h" integer DEFAULT 1 NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"alert_enabled" boolean DEFAULT false NOT NULL,
	"alert_condition" text DEFAULT '' NOT NULL,
	"alert_user_id" text,
	"routine_id" uuid,
	"status" text DEFAULT 'building' NOT NULL,
	"failure_code" text,
	"failure_detail" text,
	"source_message_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"refreshed_at" timestamp with time zone,
	"last_alert_at" timestamp with time zone,
	"title_set_by_user" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'board' NOT NULL,
	"title" text NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"owner_user_id" text,
	"owner_agent_id" uuid,
	"created_by_run_id" uuid,
	"audience" text DEFAULT 'private' NOT NULL,
	"audience_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"edit_policy" text DEFAULT 'owner' NOT NULL,
	"edit_role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"home_tiles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposal" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dashboard_widget_updates" ADD CONSTRAINT "dashboard_widget_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widget_updates" ADD CONSTRAINT "dashboard_widget_updates_widget_id_dashboard_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."dashboard_widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_alert_user_id_users_id_fk" FOREIGN KEY ("alert_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_widget_updates_widget" ON "dashboard_widget_updates" USING btree ("widget_id","created_at");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_board" ON "dashboard_widgets" USING btree ("dashboard_id","position");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_agent" ON "dashboard_widgets" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_scheduled" ON "dashboard_widgets" USING btree ("org_id") WHERE "dashboard_widgets"."schedule" <> 'manual';--> statement-breakpoint
CREATE INDEX "dashboard_widgets_routine" ON "dashboard_widgets" USING btree ("routine_id") WHERE "dashboard_widgets"."routine_id" is not null;--> statement-breakpoint
CREATE INDEX "dashboard_widgets_drafts" ON "dashboard_widgets" USING btree ("org_id","created_by_user_id") WHERE "dashboard_widgets"."draft" = true;--> statement-breakpoint
CREATE INDEX "dashboards_org_audience" ON "dashboards" USING btree ("org_id","audience") WHERE "dashboards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "dashboards_org_owner" ON "dashboards" USING btree ("org_id","owner_user_id") WHERE "dashboards"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboards_one_home" ON "dashboards" USING btree ("org_id","owner_user_id") WHERE "dashboards"."kind" = 'home' and "dashboards"."deleted_at" is null;