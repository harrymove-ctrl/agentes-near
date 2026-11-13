ALTER TYPE "public"."artifact_kind" ADD VALUE 'block';--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'poll';--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"option" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "in_drive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_artifact_id_polls_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."polls"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_choice" ON "poll_votes" USING btree ("artifact_id","user_id","option");--> statement-breakpoint
CREATE INDEX "poll_votes_org_id_index" ON "poll_votes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "polls_org_id_index" ON "polls" USING btree ("org_id");