-- The forum is removed (ADR 0022, owner decision 2026-11-04): every topic, its channel (`channels.kind = 'forum'`) and
-- everything in or pointing at it go; its tables stay for one release (see the end). On a database without forum data
-- each statement matches nothing.
-- The enum values `channel_kind.forum` and `agent_run_trigger.forum` stay, unused: Postgres drops an enum value only by
-- recreating the type, which rewrites `channels` and `agent_runs` under a lock.
DELETE FROM "notifications" WHERE "kind" IN ('forum_turn', 'forum_synthesis') OR "source"->>'topicId' IS NOT NULL
  OR "source"->>'channelId' IN (SELECT "id"::text FROM "channels" WHERE "kind" = 'forum') OR "source"->>'routineId' IN (SELECT "id"::text FROM "routines" WHERE "target"->>'type' = 'forum')
  OR "source"->>'messageId' IN (SELECT "id"::text FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')));--> statement-breakpoint
DELETE FROM "message_reactions" WHERE "message_id" IN (SELECT "id" FROM "messages" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum')) OR "message_id" IN (SELECT "id" FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')) AND "channel_id" NOT IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum'));--> statement-breakpoint
DELETE FROM "message_pins" WHERE "message_id" IN (SELECT "id" FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')) AND "channel_id" NOT IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum'));--> statement-breakpoint
DELETE FROM "search_documents" WHERE "kind" IN ('forum_topic', 'forum_reply')
  OR ("kind" <> 'issue' AND "channel_ids" && ARRAY(SELECT "id" FROM "channels" WHERE "kind" = 'forum'))
  OR ("kind" = 'message' AND "source_id" IN (SELECT "id" FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')) AND "channel_id" NOT IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum')))
  OR ("kind" = 'file' AND "source_id" IN (SELECT "id" FROM "artifacts" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum') OR "id" IN (SELECT "synthesis_artifact_id" FROM "forum_topics" WHERE "synthesis_artifact_id" IS NOT NULL)))
  OR ("kind" = 'context_item' AND "source_id" IN (SELECT "id" FROM "context_items" WHERE "channel_ids" && ARRAY(SELECT "id" FROM "channels" WHERE "kind" = 'forum')));--> statement-breakpoint
UPDATE "search_documents" SET "channel_ids" = ARRAY(SELECT c FROM unnest("channel_ids") c WHERE c <> ALL(ARRAY(SELECT "id" FROM "channels" WHERE "kind" = 'forum')))
  WHERE "kind" = 'issue' AND "channel_ids" && ARRAY(SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "context_items" WHERE "channel_ids" && ARRAY(SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
-- Its files (the syntheses among them) become tombstones older than the trash keeps, so the files' purge takes their
-- contents; the issues they were linked to let go of them.
UPDATE "issues" SET "artifact_ids" = ARRAY(SELECT a FROM unnest("artifact_ids") WITH ORDINALITY u(a, n) WHERE a NOT IN (SELECT "id" FROM "artifacts" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum') OR "id" IN (SELECT "synthesis_artifact_id" FROM "forum_topics" WHERE "synthesis_artifact_id" IS NOT NULL)) ORDER BY n)
  WHERE "artifact_ids" && ARRAY(SELECT "id" FROM "artifacts" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum') OR "id" IN (SELECT "synthesis_artifact_id" FROM "forum_topics" WHERE "synthesis_artifact_id" IS NOT NULL));--> statement-breakpoint
UPDATE "artifacts" SET "deleted_at" = now() - interval '31 days' WHERE "id" IN (SELECT "id" FROM "artifacts" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum') OR "id" IN (SELECT "synthesis_artifact_id" FROM "forum_topics" WHERE "synthesis_artifact_id" IS NOT NULL));--> statement-breakpoint
DELETE FROM "issue_activity" WHERE "event" IN ('forum_opened', 'forum_evaluated')
  OR ("kind" = 'comment' AND "author_type" = 'agent' AND "text" LIKE 'The forum evaluated this issue:%');--> statement-breakpoint
UPDATE "issues" SET "source" = '{"type":"manual"}'::jsonb WHERE "source"->>'type' = 'forum';--> statement-breakpoint
UPDATE "issues" SET "channel_id" = NULL WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
UPDATE "calendar_events" SET "channel_id" = NULL WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
-- The forum's cards in other conversations (a suggestion, a topic opened or concluded, its summary on a task): gone,
-- or emptied as a deleted message where people replied in their thread.
DELETE FROM "messages" m WHERE m."id" IN (SELECT "id" FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')) AND "channel_id" NOT IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum'))
  AND NOT EXISTS (SELECT 1 FROM "messages" r WHERE r."org_id" = m."org_id" AND r."thread_id" = m."id");--> statement-breakpoint
UPDATE "messages" SET "deleted_at" = coalesce("deleted_at", now()), "body" = '',
  "meta" = "meta" - 'forumSuggestion' - 'forumConcluded' - 'forumTopicId' - 'forumTopic' - 'bodyCode' - 'bodyParams' - 'artifacts'
  WHERE "id" IN (SELECT "id" FROM "messages" WHERE ("meta"->'forumSuggestion' IS NOT NULL OR "meta"->'forumConcluded' IS NOT NULL OR "meta"->'forumTopicId' IS NOT NULL OR "meta"->'forumTopic' IS NOT NULL OR ("author_type" = 'agent' AND "body" LIKE 'The forum evaluated this issue:%')) AND "channel_id" NOT IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum'));--> statement-breakpoint
DELETE FROM "outcomes" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "thread_reflections" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "agent_works" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "autonomy_signals" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "routing_decisions" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "agent_actions" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "machine_access_requests" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "machine_tasks" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "secret_requests" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "artifact_uploads" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "team_actions" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "wiki_links" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "wiki_page_reads" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "calendar_proposals" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "app_sends" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "approvals" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
DELETE FROM "agent_runs" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum') OR "trigger" = 'forum';--> statement-breakpoint
-- messages is partitioned (ADR 0009): through the parent table.
DELETE FROM "messages" WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE "kind" = 'forum');--> statement-breakpoint
-- Members, reads, pins, follows, threads and the topics (their seats and turns) go with their channels.
DELETE FROM "channels" WHERE "kind" = 'forum';--> statement-breakpoint
DELETE FROM "routines" WHERE "target"->>'type' = 'forum';--> statement-breakpoint
DELETE FROM "agent_scopes" WHERE "scope" = 'forum:write';--> statement-breakpoint
DELETE FROM "outbox" WHERE "kind" = 'forum.advance' OR "payload"->>'topicId' IS NOT NULL
  OR ("kind" LIKE 'search.%' AND "payload"->>'kind' IN ('forum_topic', 'forum_reply'));--> statement-breakpoint
DELETE FROM "audit_log" WHERE "action" LIKE 'forum.%';--> statement-breakpoint
UPDATE "organization_members" SET "sidebar_items" = "sidebar_items" - 'forum' WHERE "sidebar_items"->'forum' IS NOT NULL;--> statement-breakpoint
UPDATE "organization_members"
  SET "sidebar_items" = jsonb_set("sidebar_items", '{tools}', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements("sidebar_items"->'tools') x WHERE x <> '"forum"'::jsonb), '[]'::jsonb))
  WHERE jsonb_typeof("sidebar_items"->'tools') = 'array' AND "sidebar_items"->'tools' @> '["forum"]'::jsonb;--> statement-breakpoint
-- Pages saved from a synthesis stay the wiki's own; their history says what happened without the forum.
UPDATE "wiki_pages" SET "source" = NULL WHERE "source"->>'type' = 'forum_topic';--> statement-breakpoint
UPDATE "wiki_page_versions" SET "note" = 'added a passage' WHERE "note" = 'saved the forum synthesis';--> statement-breakpoint
UPDATE "wiki_page_versions" SET "note" = 'created the page' WHERE "note" = 'created from the forum synthesis';--> statement-breakpoint
-- The PM template's weekly forum line, in every language the app wrote it in.
UPDATE "agents" SET "instructions" = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace("instructions", chr(10) || 'Every Friday, posts the week''s summary on the forum.', ''), chr(10) || 'Toda sexta, posta no fórum o resumo da semana.', ''), chr(10) || 'Postet jeden Freitag die Zusammenfassung der Woche im Forum.', ''), chr(10) || 'Cada viernes publica en el foro el resumen de la semana.', ''), chr(10) || 'Chaque vendredi, publie le résumé de la semaine sur le forum.', ''), chr(10) || 'Setiap Jumat, memposting ringkasan minggu itu di forum.', ''), chr(10) || 'Ogni venerdì pubblica nel forum il riepilogo della settimana.', ''), chr(10) || '毎週金曜日に、その週の要約をフォーラムに投稿します。', ''), chr(10) || '매주 금요일 포럼에 한 주 요약을 올려요.', ''), chr(10) || 'Post elke vrijdag de samenvatting van de week op het forum.', ''), chr(10) || 'W każdy piątek publikuje na forum podsumowanie tygodnia.', ''), chr(10) || 'Каждую пятницу публикует на форуме итоги недели.', ''), chr(10) || 'Her cuma haftanın özetini foruma yazar.', ''), chr(10) || '每周五在论坛上发布本周摘要。', '')
  WHERE "instructions" LIKE '%Every Friday, posts the week''s summary on the forum.%' OR "instructions" LIKE '%Toda sexta, posta no fórum o resumo da semana.%' OR "instructions" LIKE '%Postet jeden Freitag die Zusammenfassung der Woche im Forum.%' OR "instructions" LIKE '%Cada viernes publica en el foro el resumen de la semana.%' OR "instructions" LIKE '%Chaque vendredi, publie le résumé de la semaine sur le forum.%' OR "instructions" LIKE '%Setiap Jumat, memposting ringkasan minggu itu di forum.%' OR "instructions" LIKE '%Ogni venerdì pubblica nel forum il riepilogo della settimana.%' OR "instructions" LIKE '%毎週金曜日に、その週の要約をフォーラムに投稿します。%' OR "instructions" LIKE '%매주 금요일 포럼에 한 주 요약을 올려요.%' OR "instructions" LIKE '%Post elke vrijdag de samenvatting van de week op het forum.%' OR "instructions" LIKE '%W każdy piątek publikuje na forum podsumowanie tygodnia.%' OR "instructions" LIKE '%Каждую пятницу публикует на форуме итоги недели.%' OR "instructions" LIKE '%Her cuma haftanın özetini foruma yazar.%' OR "instructions" LIKE '%每周五在论坛上发布本周摘要。%';
-- forum_topics, forum_participants and forum_turns stay for one release: the previous version still reads them during
-- a deploy or after a rollback. A later migration drops them.
