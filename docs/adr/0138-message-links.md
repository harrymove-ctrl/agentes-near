# 0138. Message links: one permalink, a pill in messages, agents that cite where they were asked

- Status: Accepted (built)
- Date: 2026-11-03
- Extends: ADR 0017 (what an agent's explicit reads may see), ADR 0043 (tools on demand)
- Code: `packages/tokens/src/message-links.ts` (`messagePath`, `parseMessageLink`); engine `message-links.ts`
  (`setMessageLinkBase`, `messageLink`, `messageIdOf`, `describeMessages`, `messageCard`), `context/tools.ts`
  (`read_conversation`, `search_context` lines, `originReadable`), `chat-tools.ts` (`origin` in `send_dm` and
  `post_message`), `context.ts` (`originNotes`, the link line), `tools/directory.ts` (`RARE_TOOLS`); server
  `start.ts` (`applyBootSwitches`), `routes/app/chat.ts` (`GET …/messages/{messageId}/card`); client
  `lib/message-links.ts`, `api/*` (`chat.messageCard`, `useMessageCard`); web `chat/MessageRef.tsx`,
  `lib/markdown.tsx`, `components/MessageMore.tsx`, `pages/ChannelPage.tsx`; phone `features/chat/MessageRefText.tsx`,
  `MessageSpans.tsx`, `sheets.tsx`

## Context

An agent told a person in a DM "Bia asked me to send you the accesses". Asked "where did she ask?", it could only say
"in #general": the DM it sent kept who asked and the channel, not the message, and nothing showed that message to its
later runs. Agents could search messages, but a hit named neither who wrote it nor where, and no tool read a channel's
history. People had "Copiar link" on the web, but a reply's link pointed at its channel (whose timeline holds no
replies), a DM's at a route that lists no DMs, the phone had none, and a pasted link was a plain link to a new tab.

## Decision

1. **One permalink.** `/org/<org>/c/<channel>?m=<id>` for every message, a DM's included;
   `/org/<org>/threads/<thread>?m=<id>` for a thread's reply. The web opens either at the message (paging back,
   scrolling to it, highlighting it); a DM's `/c/` link redirects to that DM's own page. The phone's app links already
   map both. "Copiar link da mensagem" copies it, on the web and in the phone's message sheet.
2. **A pasted link is a pill.** A link to a message on this server (a path, or a full address on this server only)
   renders like a `#channel` reference: "# general › 💬", "@Ana › 💬" in a DM, "# general › Thread › 💬" for a reply,
   our own pill style. A click opens it in the app, never a new tab; it is a real link, so it takes keyboard focus,
   and its accessible name says whose message and where ("Mensagem de João em #eng").
3. **The pill names nothing it shouldn't.** Where a message is and who wrote it come from
   `GET …/messages/{id}/card`, with the `#channel` card's rule for a channel (public, or private and visible to me) and
   membership for a DM. Anything else is a 404, and the pill reads "Mensagem sem acesso" without the channel's name.
   The card never carries the message's text.
4. **Agents write the URL.** Tools return each message's full link (`PUBLIC_URL` + the permalink, set at boot), and
   the prompt says to paste a message's link to point to it. A full URL still works when copied outside the app, so
   there is no new token format.
5. **`read_conversation`** (`context:read`, on demand in the "More of the conversation" group to keep every run's
   prompt the same size): one message by id or link with those around it, or a channel's (by name) or a thread's
   messages, the latest or around a time, or by default the run's conversation. Each comes with who wrote it, where,
   when and its link, inside the untrusted envelope. It reads what `search_context` reads (ADR 0017: the run's channel
   and the agent's public channels; in the agents' DM, only what was said for the same person).
6. **Where the agent was asked.** `send_dm` (in `meta.agentDm`) and `post_message` (in `meta.postedFrom`) keep the
   message that asked (`fromMessageId`, `fromThreadId`). The agent's later runs where it sent them read one line under
   each: "[Why you sent it]: Bia asked in #general: "…" <link>", the request cut to 300 characters. The quote and the
   link show only when the person this run answers is in that conversation and, unless it is a public channel, so is
   every person where the agent now speaks (the reply is read by all of them: asked in a private channel to post in
   #general, the agent never quotes the private request in #general); otherwise the line names who asked, and the
   channel only when it is public, never a private conversation's name.
7. **The one exception to ADR 0017.** From the conversation where it sent such a message, `read_conversation` opens
   that origin message even outside the agent's search channels, when the person behind the run is in its channel
   and so is everyone in the conversation it reads from (point 6's rule); only that message, never the rest of that
   conversation. A person behind the run who isn't in a public channel the agent reads still gets it quoted: a public
   channel is open to the whole workspace, as `search_context` already treats it.
8. **Same conversation.** A pill to a message of the conversation already open changes only `?m=`; the open page
   jumps to it (paging back as for any `?m=`). On the phone, a pill to another workspace's message opens through
   `/link`, which switches to that workspace first.

## Consequences

- "Where did she ask?" gets the request itself and a link the person can tap.
- A list-channels tool was left out: the prompt names the agent's channels and `post_message` resolves names.
- `read_conversation` costs one `find_tools` step before its first use in a run; the provenance line needs none.
