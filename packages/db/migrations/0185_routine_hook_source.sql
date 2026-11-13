-- A connector event behind a routine's address (ADR 0130): the connection, the event, its filter, the provider's webhook.
ALTER TABLE "routine_hooks" ADD COLUMN "source" jsonb;
