CREATE TABLE "calendar_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attendee_type" text NOT NULL,
	"attendee_id" text NOT NULL,
	"status" text DEFAULT 'needs_action' NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "calendar_attendees_eventId_attendeeType_attendeeId_unique" UNIQUE("event_id","attendee_type","attendee_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"recurrence" text DEFAULT 'none' NOT NULL,
	"rrule" text,
	"channel_id" uuid,
	"issue_id" uuid,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "calendar_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"requester_user_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD CONSTRAINT "calendar_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_attendees_org_id_attendee_id_index" ON "calendar_attendees" USING btree ("org_id","attendee_id");--> statement-breakpoint
CREATE INDEX "calendar_events_org_id_start_at_index" ON "calendar_events" USING btree ("org_id","start_at");--> statement-breakpoint
CREATE INDEX "calendar_proposals_org_id_requester_user_id_status_index" ON "calendar_proposals" USING btree ("org_id","requester_user_id","status");