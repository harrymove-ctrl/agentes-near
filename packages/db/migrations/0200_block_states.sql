CREATE TABLE "block_states" (
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_states_artifact_id_version_pk" PRIMARY KEY("artifact_id","version")
);
--> statement-breakpoint
ALTER TABLE "block_states" ADD CONSTRAINT "block_states_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "block_states" ADD CONSTRAINT "block_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "block_states_org_id_index" ON "block_states" USING btree ("org_id");
