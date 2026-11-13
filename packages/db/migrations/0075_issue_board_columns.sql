CREATE TABLE "issue_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage" "issue_status" NOT NULL,
	"name" text,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "column_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "board_rank" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_columns" ADD CONSTRAINT "issue_columns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_columns_org_id_stage_position_index" ON "issue_columns" USING btree ("org_id","stage","position");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_column_id_issue_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."issue_columns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "issues" SET "board_rank" = -extract(epoch from "updated_at") * 1000;
