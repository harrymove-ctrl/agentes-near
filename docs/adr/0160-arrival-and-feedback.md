# 0160. The arrival after the onboarding, and feedback by email

- Status: Accepted
- Date: 2026-11-09
- Code: web `components/arrival/*` (`Arrival`, `BetaDialog`, `TeamScene`, `ConnectChoices`, `FeedbackDialog`,
  `FeedbackMark`), `components/ConnectAi.tsx` (`ConnectAiRequest.arrival`), `pages/OnboardingPage.tsx`
  (`?arrival=1`); server `routes/app/feedback.ts` (`POST /api/app/feedback`, `…/feedback/files`, `GET /api/feedback-files/{token}`), `auth.ts` (`auth-config.feedback`);
  engine `feedback.ts` (jobs `feedback.send`, `feedback.file.purge`), `feedback-tools.ts` (`send_feedback`, `offer_feedback`), `feedback-offers.ts` (`decideFeedbackOffer`, `APP_FAULT_HINT`); server `POST …/feedback/offers/{messageId}`; web `components/FeedbackOffer.tsx`, phone `features/chat/FeedbackOffer.tsx`; config `FEEDBACK_EMAIL`; web
  `lib/feedback.ts`, `lib/context-menu.ts` (`setMenuReporter`); table `feedback_files` (migration 0246)

## Context

A new workspace's owner landed in the right hand's conversation with a checklist, and nothing said two things they
need to know at once: the product is in beta, and their agents answer nothing until an AI is connected. Connect an AI
was a row among five, opening a picker of two controls made for people who already know what a plan and a key are.

There was also no way to tell us what went wrong. The product is open source and one image serves every server
(ADR 0002), so a feedback channel must not send anything to agentes.chat from a server someone else runs, must work
with Postgres alone, and must not need a third-party widget in the apps.

## Decision

1. **The arrival is asked for by the address.** The onboarding's last step opens the workspace with `?arrival=1`.
   `Arrival` reads it once and drops it, so a reload or Back shows nothing again. Nothing is stored: a person who
   joins by invitation, or who closes the tab before it opens, doesn't get it. That is acceptable for a notice.

2. **First the beta notice, then Connect an AI.** The notice says the product is in beta and what that means, and,
   only where the server takes feedback, where to send it. Every way out of it goes on. Connect an AI follows for a
   person who has one to connect (`useMayConnectAi`) while some agent has none. After the onboarding's AI step, or a
   plan left for later, the onboarding asks for the notice alone (`?arrival=beta`, ADR 0162 amended 2026-11-10).

3. **Connect an AI gets a stage, not a second flow.** Opened with `arrival`, the same dialog (ADR 0061) shows the
   workspace's agents asleep under a night sky beside the choices, and the sky turns to day as they wake once an AI
   is connected. Its first screen is one card per choice, in words: Claude, ChatGPT, the other plans, an API key
   (for whoever may add one), and OpenCode's free models as the way in without a subscription. A pick opens that
   plan's own steps (`PlanPanel`, `KeyPanel`) unchanged, with Back to the cards. A billing hold keeps its own notice,
   without the stage.

4. **One sky for the three.** `TeamScene` draws night and day on the shared sky engine and the agents with the
   living avatar (`sleeping`, `writing`, an expression). It is decorative everywhere: what it says is also said in
   words.

5. **Feedback is an email to whoever runs the server.** `FEEDBACK_EMAIL` names the address. Unset, which is the
   default, the apps show no form and the route answers 404: a self-hosted server sends nothing anywhere unless its
   operator asks for it. agentes.chat sets it to its own address.

6. **What a feedback carries.** The text the person typed; their name and address (the email's reply-to, so the
   answer goes to them); the workspace's name and their role when they are a member of the one the app named; what
   the app knows of where they are (the route's pattern and its ids, the agent open and what it thinks with, the
   connection, the language, the browser, the window, the build and the app's last errors); and what they chose to
   show: the thing they right-clicked, and files. No conversation is sent except the excerpt the form shows, which
   the person can take out. The form doesn't list the rest: it says only who reads the feedback.

7. **Through the outbox, as every email.** The route only queues job `feedback.send`; the job sends one plain email,
   outside the branded templates, since its reader is the operator. The app makes an id per message, so a request
   sent twice goes once. A person sends at most ten an hour.

8. **The way in is a row at the bottom of the sidebar**, "Send feedback" with a Beta mark at its end, shown only
   where the server takes feedback. It is not beside the person's name: a personal workspace has the person, the bell
   and the collapse on one line, with no room for a fourth thing. On the form the right hand stands with an
   envelope, takes notes while the person types and the envelope flies once it is sent. It only illustrates: no
   agent reads or sends what the form sends, and the form's words say who does.

9. **Report a problem here, on every right click.** Every menu a right click opens ends in that entry
   (`openContextMenu` with the click's target; a button's menu has none). It opens the form about the thing clicked:
   a message says who wrote it and what it says, anything else its role, its name and its words (`describeElement`),
   or only the text the person had selected there. Where it sits in the page goes along as a fact, for whoever has
   the code. A message, a card or a dialog with no menu of its own gets one with that entry alone; the page's empty
   space, links, pictures, fields and selected text keep the browser's menu.

10. **Pictures and a video, kept for a while.** A feedback takes up to three pictures of 5 MB and one video of
    50 MB. Each is uploaded as it is added (`POST /api/app/feedback/files`), into the platform's blob store, with a
    row in `feedback_files`. Sent, it gets a link only the email holds (a random token, stored hashed) that works for
    thirty days; pictures also ride inside the email. Never sent, it goes in an hour, or at once when the person
    takes it out or closes the form.

11. **What keeps it from being abused.**
    - A file is what its first bytes say (PNG, JPEG, GIF, WebP, HEIC, MP4, MOV, WebM), never what the upload calls
      itself; nothing a browser would run is among them, nor sound alone in a video's container. Only the start is
      read, so a file that begins as a picture and holds something else is kept as that picture: it is why a file
      is only ever a download of its sniffed type.
    - Sizes are refused by the declared length before a byte is read, and checked again once read.
    - A person adds thirty files an hour, four of them videos, holds six not sent yet, and sends ten feedbacks an
      hour. Only their own files, not sent yet, attach to their feedback.
    - The link answers only as a download (`content-disposition: attachment`, `nosniff`, a sandboxing policy,
      `no-store`), so this origin never shows the file; an address opens sixty a minute.
    - Everything typed or collected is inert in the email: escaped in its HTML, one line per fact, each capped.
    - The hour's limit and the declared size are answered before a byte of the upload is read, and the body is
      read only up to the largest file.
    - A purge job per deadline removes the row and the bytes; an account's deletion removes its rows at once and
      the same job its bytes. A sweep every six hours takes what a job missed: a file an hour past its time, and
      bytes with no row.

11. **An agent sends one when a person asks it to** (added 2026-11-10). `send_feedback` takes the text and queues
    the same email, to the same address, in the name of the person behind the run: their name, their address as the
    reply-to, the workspace and their role. The email says which agent wrote it ("Written by"), and "App: agent".
    It carries the text only: no files, no excerpt, nothing the app collects.
    - Every call asks that person's approval first, with the whole text on the card: it leaves the workspace in
      their name, so only they decide it, not the agent's owner nor an admin.
    - Listed only where the server takes feedback, with no scope, among the tools loaded on demand.
    - A run nobody is behind (a routine's, an agent's own) sends none: the run policy refuses a routine's, and the
      tool refuses any call with no person, or a person who is no longer a member.
    - It counts toward the same ten an hour as the person's form, and one call sends once however often it runs.

12. **An agent offers one when the app itself fails** (added 2026-11-10). `offer_feedback` is the agent's own
    initiative: one of our own tools broke with an internal error, its browser or desktop crashed, it went in circles
    on the same app error, or the person complained that something of the app doesn't work and what the agent saw
    confirms it. Never an outside service's failure, a limit, a missing permission or setting, or the agent's own
    mistake. It takes the problem in a few words (`summary`) and the report (`text`).
    - **It sends nothing and holds nothing.** The report rides on the agent's next reply (`meta.feedbackOffer`) as a
      quiet row under it, of the receipts' family: the problem in a few words, where it goes, "See the report" opening
      the agent's text inside the row, and Send and Not now. No approval, no run waiting: the agent has already
      answered. Only the person it goes in the name of sees the row and decides it
      (`POST /api/app/feedback/offers/{messageId}`), once; decided, its state goes to their other devices
      (`feedback_offer.updated`). Sent, it is the same email as §11's ("Written by" says the agent wrote it on its own
      and the person read it and sent it), one per offer, within the same ten an hour. Put away, the row is gone.
    - **How the agent comes to it.** The tool is among those loaded on demand, under the same words in their label
      as §11's (the prompt grows by nothing), so a complaint about the app leads the judge to that group. When one of
      our own tools breaks with an error nobody wrote for the model (`isUnexpectedError`: not a domain error, not a
      plain `Error` a tool wrote), the Tool Gateway adds one sentence to the result naming the tool (`faultHint`),
      only where the server takes feedback. A connected app's or an MCP server's failure never gets it.
    - **Seldom.** One offer a day in a conversation, and none there for a week after the person put one away. A run
      nobody is behind offers none (the run policy refuses a routine's, the tool any call with no person).
    - **Always send.** On a sent row the person may choose it (`chatPrefs.feedbackAuto`, theirs alone, per
      workspace, on every device). From then on the report is queued in the same transaction as the reply it rides
      on, never before, and the row says it went without asking; opened, it holds "Ask before sending". Past their
      hour's ten the row asks again.
    - **Not here yet.** A run that dies before any reply (the server's own error) has no message for the row to ride
      on, so it offers nothing.

## Consequences

- A server with no `FEEDBACK_EMAIL` has no feedback channel in the apps; its people use whatever its operator gives
  them.
- Whoever has a feedback's email can open its files for thirty days without signing in: the email is the key.
- On a server with neither S3 nor a files folder, a 50 MB video sits in Postgres until it expires.
- The phone app has neither the arrival nor the form yet.
- The arrival's choice cards and the picker (ADR 0061) are two views of the same choices: a plan added to
  `PLAN_CHOICES` shows in both.

## Addendum (2026-11-10): Connect from an agent's conversation, for every agent with no AI

Someone who brought eight agents from another app had to open Connect in each one's conversation: there it was the plain dialog, for that agent alone (ADR 0059 §2), listing what they already had above a second picker that offered the same account again.

- Connect opened from an agent's own conversation (the notice over the composer and the setup card: `ConnectAiRequest.chat`) is a narrow dialog under the arrival's sky, with the agent asleep on it, when the agent is the person's own, whatever it was set to think with and whatever its AI status says (the notice and the card only ask while it can't answer). Anything else (someone else's agent, the right hand, a key asked for by a message) keeps the plain dialog, as do the other ways in.
- What the person already has comes first, to pick and then confirm at the foot ("Usar Claude · Max"): their own accounts, the workspace's keys, then other people's plans under each owner's name (`ConnectHave`, over the same rows and actions as the picker's: `useExistingAi`). A row says how near its limit the plan is, in words and as a bar; the one with most room is picked, one at its limit goes last. Someone else's plan shows that its owner hears of it only when it is the one picked. Past four rows each group shows its best one.
- A new AI is a row under them ("Ou conecte outra") that opens the arrival's choices; with nothing connected yet the dialog opens on them.
- When more agents of the person's have no AI, it opens for all of them ("Para: Todos os agentes"), and the same select narrows it to the agent of the conversation. This supersedes "opened for one agent, it is for that agent alone" for this way in. For all, the list keeps only the accounts that think for all of their owner's agents there, and picking one moves each agent onto it (`PlanPanel`'s `use`). What is decided when the dialog opens is kept while it is open, since connecting changes who has an AI.
- A new sign-in follows the plan's own rule (ADR 0059 §2): one for all where the computer shares it, else one per agent in turn.
- No new strings: the select, the rows, the button and the titles reuse the picker's and the arrival's.
- Not here yet: the phone app.

### For the whole team

Connect opened for several agents or for none (the channel's notice, Settings › AI accounts, the first-run list, a team just made, a receipt or a card that names several agents, the computer-ready link, the onboarding's AI step of ADR 0162) showed the plain dialog: two tabs, a select of plans, "For: All agents" and the agents' names squeezed into chips. It is now the same narrow dialog under the sky, every screen built the same way (`BandDialog`: the sky with who wakes, the title with the way back on its line, one thing in the middle, the footer with a one-line note, the secondary action and the main one).

- It is for every agent of the person's that can't think, on the computer of the first of them, since a plan signs in on one computer; decided once the agents and their AI are known, and kept while the dialog is open. The sky draws four of them and says how many more.
- The team's right hand has no computer, so it never picks the one a plan signs in on and is never the agent a plan's panel reads or signs in for: the computer is the first other agent's, and the right hand wakes with the team by its own AI status. With nobody else to wake it is one agent alone, its own plain dialog.
- A caller that already knows the card (the onboarding's AI step) opens it on that choice's steps (`start`), the API key's included.
- The first screen says for whom on one line (their faces, "N agents without AI") with "Choose", which lists them one per row with a checkbox, all ticked, long names whole on their line; the footer counts them ("N of M checked") and "Use these N" narrows whom the plan's steps are for. Under that line, the accounts the person already has that think for all of them at once (their own, signed in, shared there) come first, with "Connect another AI" under them; otherwise the choices, where a plan that will ask for one login per agent on that computer says so at its card's end. The API key stays a choice for admins.
- One login per agent is one instruction at a time: how far along ("3 of 8"), whose turn ("Sign in to Gemini for Lia"), why it asks again, and every agent's face in order: done with a check, the one now with a ring, those to come dimmed, one whose login didn't end with a mark. The sign-in and its link are the footer's actions, and the first agent's account is the next ones' hint as before. A login that didn't end says so in that place with the reason, and the footer offers skipping that agent beside trying again, the last one too. One sign-in for all, or one key sent to every login, has no faces.
- The end says who woke ("The team is awake", how many, or that nobody did when every agent was skipped), what they think with (the account signed in), who stayed without an AI and why (each one's own reason), with "Connect Lia" to go again for those and counting the whole team across those rounds, and whom they answer: only the person on their subscription, with "Open to the team" turning on "Answers other people" for them under the same rules and the same terms note (ADR 0059 §5), in a seat's own words on a team or enterprise plan. A right hand still without an AI is named apart, and its "Connect" opens its own dialog. The dawn plays as they wake.
- A screen that changes slides in from the side it comes from (deeper screens from the end), its title with it; whose turn moves along the faces and a check pops onto each as it lands; nothing moves for whoever asked for less motion.
- The plain dialog stays for every way in that names one thing or has its own: someone else's agent (locked), one agent alone (the right hand's own AI among them), a plan to sign in to again (`plan`), a key asked for (`intent`) or pasted, an agent still being made, a billing hold, and nobody to wake (no agent of the person's yet, or every one already thinks).
- On a page with no socket (the onboarding) the dialog reads the AI status, the computers and the plans' state again every few seconds while it is open.
- New strings under `connectAi.team`.

### Amended 2026-11-12: the right hand alone, and a program switched off on the computer

Someone on a self-hosted server opened Connect for the team's right hand, the only agent there, and got the plain dialog, whose Claude panel said only that Claude Code was "off" on their computer and to turn it on "there, in the app: Preferences → Tools". They looked for the way for twenty minutes.

- The right hand alone is the narrow dialog too, named for it: opened for it (`agentId`), from its conversation, or as the only one left without an AI. It is everyone's to connect (ADR 0137 §11) and has no computer, so it is never "all agents". This supersedes "one agent alone (the right hand's own AI among them)" in the plain dialog's list above; the rest of that list stays.
- A card already picked (`start`) opens on its steps for one agent as for the team, so the onboarding's AI step sends `start` for the right hand alone as well.
- A plan whose program is switched off on a computer the person connected (`tool_off`, self-host) says what that means (the computer is connected, the program is switched off on it, and it can only be turned on there), then shows the way under the computer's name (`ToolOffSteps`): three plain lines for the app's three clicks (the icon by the clock, Preferences, the switch under Tools), what to look for in bold, the switch drawn at the end of the last one, and on a PC that the icon may be behind the taskbar's arrow. Lines between hairlines, nothing sunken: three small drawings side by side did not fit the narrow dialog. On a computer that may have no app, the command; when the page runs in the app on that very computer, one button to its Tools. The dialog says it waits and changes by itself, which it does, since a computer's switches come back as its own event. The key stays offered under it. The browser's steps on the agent's Work tab are unchanged.
