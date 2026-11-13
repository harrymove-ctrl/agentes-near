# 0091. GIFs and stickers in chat, and agents that send them

- Status: Proposed (built on the server, the web and the phone app). Addendum 2026-10-31: the GIPHY key from Settings, off agentes.chat's own servers. Addendum 2026-11-09: a routine's message with a GIF
- Date: 2026-10-31
- Code: `packages/engine/src/media.ts`, `packages/engine/src/agent-media.ts`, `packages/engine/src/media-tools.ts`, `packages/adapters/src/gifs.ts`, `apps/server/src/routes/app/gifs.ts`, `packages/ui` (`AgentSticker`, the composer's picker, `media-grid.ts`), `packages/client/src/lib/media.ts`, `apps/mobile/src/features/chat/MediaPickerSheet.tsx`, `apps/mobile/src/agent/StickerCanvas.tsx`, `apps/mobile/src/features/settings/MediaSettingsScreen.tsx`

## Context

People wanted to answer with a GIF, and agents had no light way to show they were glad, grateful or done: only text and emoji reactions (`react`). Two questions came with it: where GIFs come from without breaking the rule that a self-hosted server needs only Postgres, and how an agent decides to send one without making every reply's prompt longer or leaving it to each model's taste.

## Decision

### 1. One picker, three tabs

- The composer's emoji button opens one picker: Emojis (unchanged), GIFs and Stickers. One click sends. The reaction picker stays emoji-only.
- On the phone, emojis stay on the system keyboard: a button at the empty field's end opens a short sheet with the two other tabs, each only where it can work, and no button where neither can. One tap sends, through the same optimistic path as any message. A person's DM or a channel with no agents offers the whole team's stickers; elsewhere, the conversation's agents'.
- A message may have media and no text. `messages.meta.media` is `{ kind: "gif", provider: "giphy", id, title, width, height }` or `{ kind: "sticker", agentId, mood }` (`mediaOf`). A GIF is stored without a URL.
- A GIF or a sticker alone is like a reaction: it routes to nobody, starts no run, doesn't reach a run in progress (nor answers its question) and reopens no thread; agents read it in the conversation later.
- `POST …/channels/{channelId}/messages` takes `media: { kind: "gif", id } | { kind: "sticker", agentId, mood }`. The server looks a GIF up again (`gifs.get` at the workspace's rating) and stores what the provider says, never what the app sent; a sticker's agent must be the workspace's.

### 2. GIFs are optional and go through the server

- GIF search is an adapter (`GifProvider`), GIPHY when `GIPHY_API_KEY` is set. Without it the GIFs tab doesn't show and nothing else changes.
- `GET /api/app/organizations/{orgId}/gifs` searches (free text, a category, or trending) at the workspace's rating, members only, rate-limited per person. `GET …/gifs/{gifId}/media?size=preview|full|still` sends the file: browsers and the phone app load every GIF from our server, so a viewer's address never reaches the provider, and the key never leaves the server.
- Categories are a closed list (`GIF_CATEGORIES`: celebrate, thanks, ok, applause, wow, coffee, good morning, bye, friday, oops, thinking), each searched with its own English query. The picker shows them as chips; agents pick among them (§4).
- The picker credits the provider, as its terms ask.

### 3. Stickers are the agents' own

- Every agent has seven stickers, one per mood (`STICKER_MOODS`: celebrate, love, deal, thinking, wow, dizzy, wave; wave added 2026-11-04, first drawn for the right hand's hello in ADR 0137), drawn by each app from the agent's look with the agent engine (`packages/ui/src/agent/engine.js`). Nothing is uploaded or stored but the agent and the mood, a new agent has its stickers at once, and a changed look changes them.
- They animate while on screen, and stand still with reduced motion.
- On the phone, a frame is a recording of the engine's drawing replayed on Skia, on the JS thread, so only a few play: the newest three rows in view of a conversation (from the list's viewability), the first eight of the picker, none under a sheet, on a screen that isn't showing or in the background. All of them run on the app's one frame clock, at half its rate (`useFrameTime` with `fps`, `STICKER_FPS`), and the others hold their still frame.

### 4. Agents send them in a second step, not in their prompt

- The agent's prompt and tools don't change for this step (since 2026-10-31 agents also have tools to send one when asked: addendum below). After an agent's reply is posted, a job (`agent-media.ts`) decides whether to follow it with a sticker or a GIF.
- Code decides first, for free: the workspace's level is not `never`, the agent's own switch is on, the reply is the final answer of a run a person started (not a routine, a background run, another agent, a mission card, an approval, a fast reply or an email), in a chat channel or a person's DM, short and with no code, table or chart; no agent media in the conversation's last 8 messages, none from this agent in the channel in the last 15 minutes, and nothing newer in the conversation.
- Then one judgment by Jev (`judge.ts`, `calibrated`): a `noul` on whether a light visual reaction fits right after this reply among teammates, a `choice` of mood, and a `choice` of GIF category when a GIF may go. The level sets the threshold (`sometimes` 0.8, `often` 0.6, tuned by `bun run eval:media`). Without a Jev key nothing is sent: a calibrated probability is what the level means, and a cosmetic touch isn't worth the workspace's own model on every reply.
- A GIF goes only where people already send GIFs (a person's GIF in the conversation lately); otherwise the agent's own sticker. Jev picks a category, never a search: it doesn't write text.
- The sticker or GIF is a message of its own from the same agent, right after the reply, with `meta.mediaAfter` (the reply's id). It is silent: it starts no run, routes to nobody and notifies nobody.

### 5. Settings

- Workspace (admins): GIFs on or off, their rating (`g` for any age, the default, or `pg`), the agents' stickers on or off, and how often agents send one on their own (`never`, `sometimes`, the default, or `often`; only this step's, addendum below): `organization_settings.gifs`, `gif_rating`, `agent_stickers`, `agent_media`. Per agent: `agents.media_replies`.
- The settings say what the server can't do (no GIF provider, no Jev key) instead of offering switches that do nothing.
- The phone app has the same section (Workspace › GIFs and stickers) with native rows, read-only for who can't configure the workspace. The server's GIPHY key (addendum below) is set up on the web only.

### 6. What the agents read

- In an agent's context a GIF is a short line with its title as outside text (`untrustedBlock`), and a sticker is the agent and the mood, so agents understand what was sent and what they sent.

## Consequences

- A self-hosted server without the two keys still has stickers for people; agents send nothing on their own, and their stickers when asked.
- GIF files cost the server's bandwidth; browsers keep them (`immutable`), and the media route checks membership.
- Two stickers side by side on the phone can differ: one plays while another, past the limit of §3, holds its still frame. A conversation stays smooth instead.
- Uploading the workspace's own stickers is left for later.

## Addendum (2026-10-31): the GIPHY key from Settings

People who run the server on their own computer (the desktop app runs one) or host it themselves don't edit environment files, so on a server that isn't agentes.chat's own the key of §2 can also come from Settings, as Jev's does (ADR 0073). Code: `packages/engine/src/gif-key.ts`, `createKeyedGifs` and `checkGiphyKey` in `packages/adapters/src/gifs.ts`, `apps/server/src/routes/app/gif-key.ts`, `apps/web/src/components/GifKeyCard.tsx`.

- **Who and where:** the installation's pinned owner adds, replaces or removes it in Settings › GIFs and stickers (`/api/app/gif-key`: `GET`, `PUT`, `DELETE`); anyone else, and everyone on agentes.chat, whose key stays in its environment, gets 404. `GIPHY_API_KEY` wins: the key then shows read-only, and saving or removing one answers 409 `gif_key_env`.
- **Kept like the Jev key:** sealed in `instance_secrets` (`name` `giphy`, bound to `instance-secret|giphy`), never returned, its last 4 shown. Every save and removal writes one audit row in each organization (`gif.key_saved`, `gif.key_removed`), since every workspace's GIFs go through it, and saves take 10 a minute per person. Deleting the pinned owner's account deletes the key, as ADR 0073 §7 does with Jev's: their GIPHY key would otherwise go on serving every workspace, with nobody left who could remove it.
- **Checked before it is kept:** one trending GIF is asked of GIPHY with it (5 s at most). A key GIPHY refuses (401, 403), or one that isn't printable ASCII with no spaces, is not stored (422 `gif_key_invalid`). No answer, a limit or an outage stores it.
- **Read on every call:** off agentes.chat the server's GIF provider is always there and follows the key, one GIPHY client per key, so a saved key works without a restart and another replica sees a change within a minute. Whether GIFs exist now is `GifProvider.available()`: the settings' `gifsAvailable`, the GIF routes, a person's GIF message and the agents' GIFs all read it.
- **Its state** is `off`, `ok`, or `invalid` for a saved key this server can't open (another `AGENTES_SECRET`) or one in `GIPHY_API_KEY` that can't be a key. GIPHY's answers to searches don't change it: a key GIPHY stops taking still shows on, and searches answer 502 `gifs.unavailable`.
- Agents still send nothing on their own without a Jev key (§4): while the server has none, the card points to Jev's.

## Addendum (2026-10-31): agents send one when asked

A person asked two agents for good-morning GIFs, and both answered that they couldn't send real ones: §4's step only follows a reply on its own, and agents had no way to send one. Now they have two tools of their own. Code: `packages/engine/src/media-tools.ts` (`createMediaToolSource`), `Transcript.mediaSent` in the executor.

- **`send_gif`** takes a short search in English (`search`, six words at most: the provider matches English best, whatever the conversation's language), searches at the workspace's rating, takes one of the first five results, past the GIFs sent in the conversation lately, looks it up again (`gifs.get`) and stores it as §1 does, without a URL. Its answer to the model is "GIF sent.": the title reaches a model only as §6 says, through `untrustedBlock`. **`send_sticker`** takes one of the six moods and sends the calling agent's own sticker.
- **When:** their descriptions say it: someone asks for one, or a light moment clearly invites it (a greeting, a celebration, thanks); never in serious work; usually one per turn. Built in like `react`: no scope, in the conversation's group that is always listed (ADR 0043).
- **Listed only where they can send:** `send_sticker` with the workspace's stickers on, `send_gif` with a GIF provider that is `available()` and the workspace's GIFs on, both with the agent's own switch (`agents.media_replies`) and in a chat channel or a DM with a person, never two agents' DM. Without GIFs, an agent asked for one sends its sticker: `send_sticker`'s description says so, and never to say it can't send GIFs.
- **The level is only §4's step.** `never`, `sometimes` and `often` say how often agents send one on their own; the tools don't read it, and the settings say so. The per-agent switch covers both, so it stays usable at `never`.
- **Part of the answer:** a message of the run (the agent, its run and hop) where it answers, with no text and no `meta.mediaAfter`. Like any GIF or sticker alone it routes to nobody and starts no run (§1); unlike §4's it notifies whoever is behind the run and counts as unread, and previews say what it was. An empty final reply after it posts nothing, as after `react` (`data.mediaSent`); text after it posts as usual, and a computer brain is told the same (`computerMediaNote`). The apps show the call as "Mandou um GIF" or "Mandou uma figurinha" among the run's tools.
- **Limits:** three per run (`MEDIA_PER_RUN_MAX`, counted under a lock; past it the tool says stop). A routine's background run is refused, like a reaction (run policy: `here`). §4's step stays out of a run that already sent one this way (`tool_media`) and out of a reply that is itself a GIF or a sticker (`media_reply`).

## Addendum (2026-11-05): a GIF in another channel

Asked in a DM for a "good night" GIF in #general, an agent had no way to send it there: `send_gif` posts only where the run answers, and `post_message` took only text and files, so it posted a link to the GIF's page and said its GIF tool couldn't pick a channel. Now `post_message` takes `gif` (the same short English search as `send_gif`), and the GIF goes in the same message as the text, or alone. Code: `packages/engine/src/chat-tools.ts` (`gifToPost`), `agentGifSearch` in `media-tools.ts`.

- **Offered where `send_gif` would be:** a GIF provider that is `available()`, the workspace's GIFs on and the agent's switch on (`agentGifSearch`), never to background work; the call checks again. Without them `post_message` has no `gif`, so a call with one fails validation.
- **For a person's request only:** a routine posting with `post_message` gets no GIF, as its run gets no `send_gif` (run policy: `here`).
- **Found and kept as `send_gif` does:** the workspace's rating, one of the first results, looked up again, stored as §1 says without a URL; the answer says "with a GIF", never its title (§6). The search runs before any file is copied or anything posted, so a failed search posts nothing and the model hears why.
- **The apps draw it as they draw any message with text and a GIF.** It isn't part of the run's answer where it works, so it doesn't count toward `MEDIA_PER_RUN_MAX`; `post_message`'s own checks (who may post where, the agent in a private channel) are unchanged. `send_gif`'s description points to `post_message` for another channel.

## Addendum (2026-11-09): a routine's message with a GIF

Good-morning GIF routines posted links to a GIF site's search pages instead of a GIF: a routine's run speaks only through `hand_off` (ADR 0053 §4), which took only text, and the run policy refuses it `send_gif` (nobody is in its room) and, by the addendum above, `post_message`'s `gif`. Now the routine's own message can carry one. Code: `packages/engine/src/hand-off.ts` (`handOffGif`, `deliverRoutineReport`'s `gif`), `AgentGifPoster` in `media-tools.ts`, `gifToPost` in `chat-tools.ts`.

- **`hand_off` takes `gif`** (the same short English search as `send_gif`), listed where `send_gif` would be for a person: a GIF provider that is `available()`, the workspace's GIFs on and the agent's switch on (`AgentGifPoster.offered`); the call checks again. Its description says when (the routine asks for one, or the message is a light one: a greeting, a celebration; never with a report of work) and never to paste a link to a GIF site instead.
- **One message:** the GIF goes in `meta.media` of the routine's message, under its text, next to `meta.routine`, stored as §1 says without a URL; the answer says "Posted with a GIF.", never its title (§6). The apps already draw a message with text and a GIF.
- **Found before anything posts:** outside the delivery's transaction (the provider may take seconds and the run's row is locked there), after the resourcefulness hold (ADR 0109). A failed search posts nothing and tells the model to try other words or hand off without `gif`. Not with `wake_me`: a note to the agent itself isn't posted as-is, so a GIF with it is refused before anything is searched.
- **Not yesterday's GIF:** the search skips the GIFs among the last messages where the routine reports (`deliverTo`), as `send_gif` does where it answers, so a daily routine's GIF changes from day to day while the search has others. `post_message`'s GIF now skips the recent ones of the channel it posts in too.
- **`post_message` from a routine takes `gif` too:** it posts where its creator can post, as itself (ADR 0053 §2), and its creator asked for its posts. This replaces the addendum above's "for a person's request only": a run nobody asked for (no person behind it and no routine) still gets no GIF.
- **Unchanged:** the run policy still refuses a routine `send_gif` and `send_sticker` (its room is read by nobody; the refusal now points to `hand_off`'s `gif`), and a routine has no sticker of its own in its message. A GIF in a routine's message counts toward no `MEDIA_PER_RUN_MAX`: it is the routine's one message.
- **Eval:** `routine-good-morning-gif` (`bun run eval:behavior`) checks that the routine hands off with `gif` (`mustCall` `hand_off+gif`: a `+key` names an input the call must carry) and no link.
