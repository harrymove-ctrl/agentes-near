-- deploy-safe: every version checks that no other agent has the account before it saves it; the index only stopped two saves at the same moment, which the new version checks under a lock on the account's row
DROP INDEX "agents_brain_account_unique";--> statement-breakpoint
ALTER TABLE "machine_accounts" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;