# 0113. Live blocks and polls: what an agent shows to be used, not kept

- Status: Accepted
- Date: 2026-11-01 (blocks as parts the apps draw: 2026-11-06)
- Code: `packages/ui/src/blocks/spec.ts` (`parseBlockSpec`, `viewBlock`, `dryRunBlock`) and `expr.ts` (the formula language), `packages/engine/src/blocks.ts` (`show_block`, `start_poll`, `votePoll`, `closePoll`, `replyToBlock`, `BLOCK_MANUAL`), `packages/engine/src/block-state.ts` (`setBlockState`, `drawBlock`, `blockStateNotes`, `blockShows`), `packages/db/src/schema/storage.ts` (`artifacts.in_drive`, `polls`, `poll_votes`, `block_states`), `packages/client/src/api/queries.ts` (`useSharedBlock`, `useBlockValues`), `packages/client/src/lib/block-kit.ts` (the kit), `packages/client/src/lib/blocks.ts` (the page, what a frame may say), `packages/client/src/lib/isolated-page.ts`, web `apps/web/src/components/blocks/*` (`SpecBlock.tsx`), phone `apps/mobile/src/features/blocks/*` (`SpecBlock.tsx`)

## Context

An agent can answer with text, a table, a chart or a file. A file is the wrong shape for "what if I move 20 thousand to Google?": it goes to the Drive, opens elsewhere and goes one way. People asking that want to move something, see the result and go on talking. ADR 0019 already lets an agent save a page, and a page already shows as a card in the message, but it stays a document to open.

Two questions decide the design: how something an agent wrote can run in the conversation without being able to do harm, and how it can look like part of the app without the agent spending thousands of tokens on CSS.

## Decision

**A file is for keeping; a block is for using now.** A block lives in its message, not in the Drive, unless a person keeps it. It is one subject and fits the conversation. It wears the app's theme, font and controls. It goes both ways: what the person picks reaches the agent.

**The agent decides, with no permission to ask for.** `show_block` and `start_poll` have no scope, like `react` and `ask_user`, and need no approval: they speak only in the agent's own conversation (`HERE` in `tools/run-policy.ts`, so never in a routine's room) and a block can reach nothing. A real action that follows still goes through its approval.

**A block is parts the app draws, described as data.** The agent sends `spec`: JSON with the block's parts (sliders, choices, fields, switches, numbers, a result, progress, charts in the chart style of messages, tables, cards that can be a choice, details that open, rows, buttons), its fixed data, the starting values of its state, and formulas for whatever follows from them. The web and the phone draw it with their own components, so nothing the agent wrote runs anywhere: its words reach the screen only as text, and no part can draw a login form, reach a network or take over a click. It needs no frame: it draws with the message, at its own height, scrolls with the conversation, and any number of them fit on a phone, which a web view each couldn't. The same check runs on the server and in the apps (`@agenteschat/ui/blocks/spec`), so a block is refused with the place that is wrong (`parts[2].value: there is no value "lucro"`) and the agent fixes it in the same turn; a block is also drawn once from its own data before it is shown, so a formula that fails on it comes back too.

**Formulas in a language of our own.** A margin from a price, a projection month by month or a filtered list need computing, and code is what a part-only format would otherwise send back in. So formulas are text in a small language read by our interpreter (`expr.ts`): arithmetic, comparisons, `a ? b : c`, lists and records, and a fixed set of functions (`sum`, `map`, `filter`, `range`, `round`…), some taking a step (`x => x.price * x.qty`). It reads only the block's own values: no globals, no prototypes (a record's own fields only), no way to define a function or loop but the list functions. Every evaluation has a step budget and lists and texts have a ceiling, so a formula can be wrong but never endless. A model writes it like a spreadsheet formula or a JavaScript expression, which it already knows.

**The agent's own page is the way out, and waits for a click.** What no part covers (a game, a free drawing, an animation) can still be short HTML over the kit (`html` instead of `spec`), in the sandboxed frame below. It doesn't run by itself: the block shows what it is and "Open block", and the page starts only when the person presses it (opening a block large counts). The manual sends the agent to `spec` first and says why. A block is one or the other, never both; when a model sends both, the parts win.

**A page looks like the app too.** What an agent writes by hand drifts: colors that break in the other theme, tinted boxes, a native select. So the kit carries the design language in three layers. Plain HTML wears the app's look at no CSS weight, which an agent's own CSS always beats. Parts cover what agents kept inventing (`ac-card`, `ac-result`, `ac-actions`). The agent's six tones are `--s1` to `--s6`, set for each theme, and a test keeps the tokens the kit shares with the app equal to the app's. The parts drawn by the apps have the same look, from the app's own components and tokens.

**Stored as an artifact, kept out of the Drive.** Kinds `block` and `poll`, `in_drive = false`. That reuses channel visibility, versions, `meta.artifacts` on the reply, events and trash. Being out of the Drive also keeps them out of `listArtifacts` and search. The message only points at the block, so its code doesn't weigh on the conversation's history. "Guardar no Drive" sets the flag and indexes it.

**A page runs isolated, on every surface.**
- Web: a sandboxed frame with an opaque origin, the policy of ADR 0019 in a fixed prefix, and `frame-src` on our pages.
- Phone: the web view is the sandbox. MCP Apps requires a nested proxy frame only of hosts that are web pages, and hosts on React Native map the rules onto web view props. Ours has no cookies, storage or file access, opens no windows, and refuses every navigation in `onShouldStartLoadWithRequest` with `originWhitelist` open: an address refused by that list would be handed to the system to open, which is itself a way out.
- It doesn't scroll by itself in the list (`scrollEnabled` and `nestedScrollEnabled` off): on Android a web view that takes a drag never gives it back to the list. Its height comes from the page. On its own pushed screen it scrolls.
- No DNS prefetch (`x-dns-prefetch-control` before the policy): a lookup of a name the page made up would leave where the policy doesn't reach.
- What people set is data everywhere it goes: the kit writes it as text, the apps read a frame's messages through `blockEvent`, and the agent reads it inside `untrustedBlock`, with the names people chose. The manual tells agents to write values with `textContent`: a page that used `innerHTML` would run someone else's text, though only inside its own frame.
- A value that looks like a key or a password (`redactCommon`) is refused, because everyone would see it; the manual sends those to `request_secret`.
- At most three frames run at once on the phone (`withLiveBlock`), and a frame the system ended comes back with what the person had set.

**One block for everyone.** A block in a conversation is one thing that everyone in it looks at, like a whiteboard, not a copy each. What a person sets in it (a slider, a field, a pick) goes to the server (`block_states`, one state per version of the block) and reaches everyone looking at once (`block.state`, the newest `rev` wins); whoever opens it later starts from there. A part changes the state only on a person's own act (a drag, a tap, a key), shown at once and sent behind it (`useBlockValues`). In a page, only what the person touched is shared: the kit marks the state `used` after a pointer, a key or an input in the page, so what a page sets as it opens stays in that page. A random pick is the server's (a button's `draw`, or `agentes.draw` in a page): a page drawing with its own random numbers gave each person a different winner. The server draws once among the options, uniformly from the system's random source, and records who asked.

**The agent sees what people see.** The state of each block a message showed is read by the agents right after that message, as outside data (`untrustedBlock`), with who set each value and which ones the server drew. For a block of parts it also reads what the formulas give from that state (`shows`, `blockShows`: plain values, as everyone sees them), computed on the server by the same interpreter. Nothing is sent to the agent and no run starts: the next time it reads the conversation, the block is as people left it. So "it came out Bento, go on" works without anyone pressing a button in the block.

**The block proposes, the person sends.** A block's `send` (or `<ac-send>` in a page) says what it would send, filled with its values; the app shows that text and the button under the block, where a page can't reach. A text a page changed in the last 400 ms doesn't take a click, so a page can't swap it under the pointer. What goes is a normal message of the person's, addressed to the agent that made the block.

**A vote is the app's own card.** Inside a frame, a page could cast a vote for whoever opened it. A vote is an act of the person's, so `poll` is drawn by the apps. `start_poll` closes at the agent's time (24 hours by default, 7 days at most) or when everyone in the conversation has voted, and the agent hears the result as a `poll_result` notice.

## Consequences

- A block of parts can only be what the parts allow. Something new (a map, a calendar) is a part built on the web and on the phone, and on the phone it waits for a release; until then it is a page behind a click.
- The manual for parts and formulas is about 5 KB, read only on the first `show_block` of a run (a call with only `title`).
- A number in a block comes from a formula the model wrote and can be wrong. The manual asks for it to be shown and called an estimate.
- A block is a snapshot of the data it was written with. Newer data means the agent shows it again (`block_id`).
- What anyone sets in a block is stored and seen by everyone in the conversation, as a message is. A block is no place for something private; passwords and keys go through `request_secret`, as before.
- Two people moving the same control at once each see the other's value arrive: the last one in stays.
- A block made before this kept results in the page alone. Those still differ per person until the agent shows them again.
- On the phone, at most three pages run at once; a fourth waits for a tap ("Tap to open"). Blocks of parts have no such limit.
- `webrtc 'block'` is in the policy, but browsers that don't know that directive ignore it. There, a page could still leak a little through a lookup to a STUN or TURN server of its choosing; closing that needs a block at the browser level, which no web page can set.

## Alternatives considered

- **A ```html block in the message.** It streams half-written code, puts the page in the message text and in the history of every later run, and gives it no versions or visibility of its own.
- **Only HTML over the kit, run as it arrives (this ADR's first decision).** One code for both apps and room for anything, but every block ran the agent's code: a page could draw a login form or a "paste your key here", lean on browser bugs, hold a phone's memory (three web views at most) and fight the list for a drag. The kit already was the vocabulary agents used, so the parts kept it and dropped the code.
- **Only parts, no page at all.** The safest, but a game or a free drawing would have no way to be shown. The page stays, behind a click.
- **The Drive card with a bigger preview.** That keeps a document in a frame: no answer comes back, and it doesn't look like the app.
- **A nested proxy frame on the phone.** The spec doesn't ask it of native hosts, and it would add a layer between the frame and the list for no isolation the web view doesn't give.
