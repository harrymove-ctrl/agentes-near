CREATE TYPE "public"."context_kind" AS ENUM('thread_summary', 'period_summary', 'decision', 'fact', 'preference', 'open_question', 'entity_profile', 'note', 'lesson');--> statement-breakpoint
CREATE TYPE "public"."context_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'stale');--> statement-breakpoint
CREATE TYPE "public"."proposal_target" AS ENUM('agent_instructions', 'org_context');--> statement-breakpoint
CREATE TYPE "public"."context_trust" AS ENUM('high', 'low');--> statement-breakpoint
CREATE TABLE "context_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "context_kind" NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"agent_id" uuid,
	"subject_key" text DEFAULT '' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"trust" "context_trust" DEFAULT 'high' NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.7 NOT NULL,
	"relevance" real DEFAULT 0.5 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"recurrence" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"status" "context_status" DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"covers_until" timestamp with time zone,
	"created_by_kind" text DEFAULT 'job' NOT NULL,
	"created_by_id" text,
	"proposed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"target" "proposal_target" NOT NULL,
	"agent_id" uuid,
	"base_hash" text NOT NULL,
	"proposed_text" text NOT NULL,
	"diff" text NOT NULL,
	"rationale" text NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_usage" (
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_usage_run_id_item_id_pk" PRIMARY KEY("run_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reaction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_reaction_pk" PRIMARY KEY("message_id","user_id","reaction")
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"step_seq" integer,
	"kind" text NOT NULL,
	"polarity" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"channel_id" uuid,
	"thread_root_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED,
	"embedding" vector(1024),
	"embedding_model" text,
	"source_created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_kind_sourceId_unique" UNIQUE("kind","source_id")
);
--> statement-breakpoint
CREATE TABLE "thread_reflections" (
	"org_id" uuid NOT NULL,
	"thread_root_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"covered_until" timestamp with time zone,
	"last_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "context_items" ADD CONSTRAINT "context_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_items" ADD CONSTRAINT "context_items_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_proposals" ADD CONSTRAINT "context_proposals_org_id_agent_id_agents_org_id_id_fk" FOREIGN KEY ("org_id","agent_id") REFERENCES "public"."agents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_items_org_id_kind_status_index" ON "context_items" USING btree ("org_id","kind","status");--> statement-breakpoint
CREATE INDEX "context_items_org_id_scope_type_scope_id_index" ON "context_items" USING btree ("org_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "context_items_agent_id_status_index" ON "context_items" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "context_items_org_id_subject_key_index" ON "context_items" USING btree ("org_id","subject_key");--> statement-breakpoint
CREATE INDEX "context_proposals_org_id_status_index" ON "context_proposals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "context_usage_item_id_index" ON "context_usage" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "message_reactions_org_id_message_id_index" ON "message_reactions" USING btree ("org_id","message_id");--> statement-breakpoint
CREATE INDEX "outcomes_org_id_agent_id_created_at_index" ON "outcomes" USING btree ("org_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "outcomes_org_id_subject_index" ON "outcomes" USING btree ("org_id","subject");--> statement-breakpoint
CREATE INDEX "search_documents_org_id_kind_index" ON "search_documents" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_documents_embedding_idx" ON "search_documents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "thread_reflections_org_id_index" ON "thread_reflections" USING btree ("org_id");