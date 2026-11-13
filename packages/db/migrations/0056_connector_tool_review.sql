ALTER TABLE "custom_tools" ADD COLUMN "suggestion_source" text;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD COLUMN "suggestion_reason" text;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD COLUMN "sensitive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_tools" ADD COLUMN "confirmed_at" timestamp with time zone;
