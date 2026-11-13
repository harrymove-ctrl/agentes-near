-- Monthly partitions for "messages" (docs/adr/0009-messages-partitioning.md).
-- Creates the partitions for the current month (UTC) and the next
-- `months_ahead` months. Idempotent and safe to call concurrently; the server
-- calls it on boot and daily. A DEFAULT partition catches rows outside the
-- created ranges (imports, clock skew) so inserts never fail.
CREATE OR REPLACE FUNCTION agenteschat_ensure_message_partitions(months_ahead integer DEFAULT 2)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  first_month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
  month_start timestamp;
  partition_name text;
  created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('agenteschat.message_partitions'));
  FOR i IN 0..months_ahead LOOP
    month_start := first_month + make_interval(months => i);
    partition_name := format('messages_%s', to_char(month_start, 'YYYY_MM'));
    IF to_regclass(partition_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF "messages" FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        (month_start AT TIME ZONE 'UTC'),
        ((month_start + interval '1 month') AT TIME ZONE 'UTC')
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages_default" PARTITION OF "messages" DEFAULT;--> statement-breakpoint
SELECT agenteschat_ensure_message_partitions(2);
