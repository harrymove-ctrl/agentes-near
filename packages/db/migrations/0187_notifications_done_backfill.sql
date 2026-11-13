-- "Concluídas" before done_by_user existed: these kinds are only ever closed by the person ("Concluir"), never
-- auto-resolved, so a done row of them from the last 30 days was theirs. Left out: the kinds a source closes
-- (answered questions, decided approvals, read agent replies, unassigned issues, forum turns, failed runs and
-- routines, handoffs, secrets, join requests, changed connector tools) and org_standing, whose agent holds close
-- when the agent is let go.
UPDATE "notifications" SET "done_by_user" = true
WHERE "kind" IN (
    'mention', 'thread_reply', 'dm', 'reaction', 'issue_comment', 'issue_status', 'forum_synthesis',
    'mission_finished', 'mission_stopped', 'routine_finished', 'agent_unreached', 'plan_reset_unknown',
    'machine_connected', 'computer_ready', 'invitation_accepted', 'composio_limit', 'browser_profile_request',
    'computer_disk_full', 'app_created'
  )
  AND "done_at" IS NOT NULL
  AND NOT "done_by_user"
  AND "done_at" > now() - interval '30 days';
