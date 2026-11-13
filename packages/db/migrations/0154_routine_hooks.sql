CREATE TABLE "routine_hook_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"status" integer NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"routine_run_id" uuid,
	"idempotency_key" text,
	"test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_hooks" (
	"routine_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"secret_ciphertext" text,
	"secret_wrapped_key" text,
	"secret_kek_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_hooks_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "routine_hook_calls" ADD CONSTRAINT "routine_hook_calls_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_hooks" ADD CONSTRAINT "routine_hooks_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_hook_calls_routine_id_created_at_index" ON "routine_hook_calls" USING btree ("routine_id","created_at");--> statement-breakpoint
CREATE INDEX "routine_hook_calls_routine_id_idempotency_key_index" ON "routine_hook_calls" USING btree ("routine_id","idempotency_key");