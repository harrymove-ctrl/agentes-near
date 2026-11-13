-- ADR 0032 §5: the computer a run waits for (no model credential to fall back on), found by an index when it reconnects.
ALTER TABLE "agent_runs" ADD COLUMN "waiting_machine_id" uuid;--> statement-breakpoint
CREATE INDEX "agent_runs_waiting_machine_idx" ON "agent_runs" USING btree ("waiting_machine_id") WHERE "agent_runs"."waiting_machine_id" is not null;--> statement-breakpoint
-- Runs already waiting for their computer (the machine was only in the transcript).
UPDATE "agent_runs" SET "waiting_machine_id" = ("transcript"->'waitingForBrain'->>'machineId')::uuid WHERE "status" = 'waiting_input' AND "transcript"->'waitingForBrain'->>'machineId' ~ '^[0-9a-fA-F-]{36}$';
