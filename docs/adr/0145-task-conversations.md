# 0145. A task's conversation is a chat thread of its own

- Status: Accepted (built)
- Date: 2026-11-04
- Extends: ADR 0009 (messages partitioning), 0022 (a channel per forum topic; the forum was removed on 2026-11-04), 0029 (threads), 0071 (agent replies notify), 0121 (long work and the Tasks board)
- Code: engine `packages/engine/src/task-conversation.ts` (`ensureTaskConversation`, `moveIssueComments`, `taskConversationSummaries`, `taskConversationOf`), `task-access.ts` (`taskReaderSql`, `admitTaskAgents`), `channels.ts` (`requireChannelAccess`, `readableChannelIds`), `artifacts.ts` (a task channel's files), `messages.ts` (`postPersonMessage` admits mentioned agents), `issues.ts` (`commentIssue`, `askAgentToImplement`, `mirrorReplyToIssue`, `openTaskConversation`, `announceTaskConversation`, `IssueView.conversation`, `canSee`, `openTasksBrief`), `issue-work.ts` (`issueWorkBrief`), `context.ts`, `jobs.ts`, `notification-producers.ts` (`notifyTaskMessage`), `thread-assess.ts`; server `routes/app/issues.ts` (`POST …/issues/{id}/conversation`, `conversation` on `Issue`), `start.ts` (the boot move); client `api/queries.ts` (`useTaskConversation`), `lib/issues.ts` (`conversationLine`, `taskConversationOf`), `lib/notifications.ts`; ui `DetailsDialog` (`side`); web `components/TaskConversation.tsx`, `TaskConversationHeader.tsx`, `pages/IssuePage.tsx`, `IssuesPage.tsx` (card line), `ThreadPage.tsx`, `ChannelPage.tsx`; phone `features/issues/IssueScreen.tsx`, `logic.ts` (`taskConversationHref`), `features/chat/ChatScreen.tsx`, `features/links/logic.ts`; migration `0214_task_conversations.sql`

## Context

A task's "Discussão" was `issue_activity` rows of kind `comment`: saved apart from chat, shown newest first under a box that locked while sending, notifying people and never starting an agent. An `@theo` there did nothing, though the box said "use @ para chamar um agente". "Pedir ao Theo" was the only way to put an agent on a task, and its work lived in a thread of the requester's DM, so the rest of the team followed it only through the comments the agent chose to post (`comment_issue`) and its final reply, mirrored as one more comment.

Everything people expect from talking to an agent (the mention, receipts, the working bar, stop, "Ver", reactions, files, quoting) exists in chat only. Rebuilding it for comments would be a second chat.

## Decision

### 1. Model: a channel of kind `task` per task, and one thread in it

Each task gets, on first use, its own channel (`channels.kind = 'task'`, `visibility = 'private'`, named `task-<number>-<id tail>`, never listed) and one root message in it (`meta.taskConversation = { issueId, number, title }`, by the task's creator, at the task's time). The conversation is that thread's replies. `issues.conversation_channel_id` (unique, `on delete set null`) and `issues.conversation_root_id` point at them.

Why not a thread in a channel the task belongs to: most tasks belong to no channel (`issues.channel_id` null, seen by the whole workspace), and a task made from a DM or a private channel would put its root in that conversation's timeline. A channel per task is the model ADR 0022 used for the forum's topics (posts are its messages), so runs, context, tools, approvals, live events and the thread screens work unchanged; and a new kind keeps it out of every list that reads `kind = 'channel'` or `'dm'` (sidebars, the channel browser, the Threads page, unread counts, search over joined channels).

Why a thread inside it, not the channel's timeline: the web's and the phone's thread screens (header, replies oldest first, the composer bound to the thread, the live runs scoped to it) are the components to reuse, and an agent asked in a thread answers in it.

### 2. Who reads it: whoever sees the task, checked every time

People are never members of a `task` channel. `requireChannelAccess`, the one check for reading a channel over HTTP and the WebSocket, lets a person into a `task` channel when they see its task (`taskReaderSql`: the task is the workspace's, or of a channel they are in, or of a public channel), in the same round trip as the rest of the check. `readableChannelIds` and the files' rules (`personCanRead`, `personReadableChannels`) use the same rule. Since there are no member rows, losing access to the task's channel (or "Mostrar para todos", which clears it) changes who reads the conversation at once, with nothing to keep in sync.

Agents are members, because a mention resolves among a channel's members. They join when they can see the task: a person's `@handle` there (`admitTaskAgents` in `postPersonMessage`, before the message is written, so the mention wakes the agent in the same statement), the task's agent assignee (on assignment, on "Pedir ao", when the conversation is made), and an agent writing there with `comment_issue`. An agent mentioned there that can't see the task (a private channel's task, the agent not in it) doesn't join, so the mention reaches nobody, as in any channel it isn't in. Members join with `auto_reply` on: a follow-up without `@` goes to the router like in any channel, so a person can keep talking to the agent working there.

An agent's run in the conversation sees the task (`canSee` with the task's conversation channel), lists it among its open tasks (`openTasksBrief`), and gets the task's brief in its context from the root (`issueWorkBrief`): "Your task" for the assignee, "This conversation: task #N" for another agent called in. The brief no longer quotes comments: the conversation is the thread the run reads.

### 3. Writing: the chat's own path

- The web and the phone post with the chat's routes (`POST …/channels/{conversation}/messages` with `threadId` = the root), so `insertMessageWithRuns` writes the message, its mentions and the runs in one statement. Receipts, the working bar, stop, "Ver", reactions, files, quotes and "Parar e mandar" work as anywhere.
- `commentIssue` (`POST …/issues/{id}/comments`, kept for older apps and the agent's `comment_issue` tool) posts in the conversation: a person's through `postPersonMessage`, an agent's as its own message (hop 1). Nothing is written to `issue_activity` for a comment any more; its events stay there as the task's Histórico. Files posted in the conversation are linked to the task (its Anexos) by `announceTaskConversation`.
- **"Pedir ao <agente>" works in the task's conversation**, not in the requester's DM: its start line ("Please implement issue #N", `meta.issueWorkStart`, shown in each person's language) is posted in the thread and its run starts there. It is simpler (one place for the work) and consistent (whoever sees the task follows the agent and can talk to it). `mirrorReplyToIssue` now posts an agent's reply to a task it was asked to implement in the conversation only when the run is elsewhere (an older work thread in a DM); in the conversation the reply already is there, so nothing is mirrored twice. The `agent_asked` event points at the conversation (`inConversation`).
- The root routes to nobody (`message.posted` returns early on `meta.taskConversation`), is never drawn (web and phone filter it), and isn't assessed for a title (`thread-assess` skips `task` channels).

### 4. Notifications

`notifyMessage` hands a `task` channel's messages to `notifyTaskMessage`: who it @mentions gets a `mention`, the task's followers (its creator, its person assignee, who acted on it, and everyone who wrote in the conversation) an `issue_comment` merged per task, always by who sees the task (`visibleOnIssue`), never by channel membership. The source carries the task (`issueId`, `issueNumber`) and the message (`messageId`): the web opens `/issues/{n}?m=<id>` and the phone `/issues/{n}?m=<id>`, which open the task with its conversation at that message. A routine's line notifies nobody there.

Unread follows the threads' model (ADR 0029): a person named there who sees the task is in the message's `mentioned_user_ids` like a channel member (`insertMessageWithRuns`), and `unreadTaskConversations` (`GET …/unread-tasks`) counts, per task they see now, the replies after their `thread_reads` mark: every one where they follow the conversation (its root is the creator's, so the creator does), else only those that mention them. The web shows the mentions as the red count on Tarefas in the sidebar, the task's card and list row and "Conversa"; a reply they follow lights "Conversa". The phone shows them on Tarefas in Você, the board's card and the conversation row. Reading the thread clears them.

### 5. The board and the dialog read it in one query

`IssueView.conversation` (`taskConversationSummaries`, one statement for the whole list): `channelId`, `rootId`, `count` (replies, quiet notices left out), `lastAt`, `participants` (the first five to write, oldest first) and `working` (a live run in the conversation). `listIssues` builds it once per board, not per card. A reply's `notifications.message` job announces `issue.updated` for the task, so open boards update their card; the web also lights "Trabalhando" from the live runs it already follows.

`POST …/issues/{id}/conversation` makes the conversation on first use and returns `{ channelId, rootId }` (`openTaskConversation`, for whoever sees the task); a task nobody opened or wrote in has none, and its card shows no line.

### 6. Apps (variant B of the approved concept)

- **Web**: "Conversa N" on the task dialog's top bar toggles the app's own thread panel (`ThreadPage` in panel mode) as a right column the dialog's full height (`DetailsDialog` `side`); the details keep their width beside it and the dialog's own close gives way to the panel's. Below 960 px the panel takes the dialog. Its header is the task's ("Conversa da tarefa", who took part, "N mensagens", when); its composer is the chat's ("Comentar · use @ para chamar um agente"), never locked while sending; "@" offers the whole workspace as one list. Where "Discussão" was, one line opens it (who, "6 mensagens", "Trabalhando" or when; "Conversar sobre a tarefa" when empty). The task's own page has the same column. `?m=<message>` on either opens the conversation at that message. A board card with a conversation ends with the chat's thread line (who, "N mensagens", "Trabalhando" in the agent's color, else when).
- **Phone**: the task screen gets a conversation row (the same line) and "Conversar" in its menu, both opening the phone's thread screen for the conversation (`/chat/<channel>?thread=<root>`), titled "Conversa da tarefa" with "#N · title" under it and no root row. The comment box at the bottom of the task screen is gone: the thread screen's composer is the chat's. `/issues/N?m=<id>` opens the conversation at that message.

### 7. Migration 0215 and the old comments

Migration `0215_task_conversations.sql` adds `task` to `channel_kind` and the two columns. Postgres can't use an enum value in the transaction that adds it (Drizzle applies every pending migration in one), so the comments move in code, right after: `moveIssueComments` runs off the boot path (like `ensureRightHands`), one query once every task has moved, and `ensureTaskConversation` moves a task's comments itself when it makes its conversation first. Each comment becomes a reply with its own id and time, its author when still there (a person or an agent gone: no author, the text stays) and its files (`meta.artifacts`, `meta.movedFromIssue`); the moved rows leave `issue_activity` in the same transaction. Moved messages are inserted directly, so nobody is notified again and no agent is woken.

## Consequences

- A task's conversation is chat: an @mention there wakes the agent, which answers in that thread, with everything chat has.
- One more channel row and one root message per task someone talked about; nothing for the others.
- People are never members of a task's conversation: lists, unread counts and search that read membership don't show it, by design. It is read from the task, and its unread and mentions come from the task (§4). A task conversation's messages are not in the person's search results yet (search reads joined channels); the task itself is.
- `requireChannelAccess` adds one `exists` to its single query, evaluated only for a `task` channel.
- Older work threads in DMs keep working: their root (`meta.issueWork`) still gives the brief, and their replies reach the task's conversation.

## Addendum (2026-11-06): who sees a task

ADR 0151 replaces §2's "the workspace's, or of a channel they are in": a task may be limited to a list of people, and administrators always see it, so `taskReaderSql` reads `taskSeenSql`. A task tied to a DM or a private channel stays tied. "Mostrar para todos" is `setIssueAudience` with `everyone`, for anyone who sees the task.
