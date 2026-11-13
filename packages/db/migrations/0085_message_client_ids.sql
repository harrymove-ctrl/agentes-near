CREATE TABLE "message_client_ids" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_client_ids_org_id_user_id_client_id_pk" PRIMARY KEY("org_id","user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "message_client_ids" ADD CONSTRAINT "message_client_ids_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_client_ids" ADD CONSTRAINT "message_client_ids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_client_ids_created_at_index" ON "message_client_ids" USING btree ("created_at");