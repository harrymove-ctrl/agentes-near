ALTER TABLE "missions" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "base_sha" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "worktree_path" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "worktree_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "worktree_error" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "worktree_fail_reason" text;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "start_sha" text;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "end_sha" text;--> statement-breakpoint
ALTER TABLE "machine_tasks" ADD COLUMN "start_request" jsonb;