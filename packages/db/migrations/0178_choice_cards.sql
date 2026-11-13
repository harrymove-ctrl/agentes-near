ALTER TYPE "public"."artifact_kind" ADD VALUE 'choices';--> statement-breakpoint
CREATE TABLE "choice_answers" (
	"artifact_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"picks" integer[] NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "choice_answers" ADD CONSTRAINT "choice_answers_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_answers" ADD CONSTRAINT "choice_answers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "choice_answers_org_id_index" ON "choice_answers" USING btree ("org_id");