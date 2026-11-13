# 0135. Dashboards and widgets: numbers agents keep up to date, on boards people share

- Status: Accepted
- Date: 2026-11-03
- Extends: ADR 0053 (routines and unattended work: a widget is redone by a routine of its own), 0085 (roles and permissions: who sees a board), 0108 (Home: "My Home" is its board), 0113 (live blocks: what is pinned is a chart, not a live block), 0125 (an audience by role, the same model), 0071 (notifications: alerts and requests wait on the person)
- Code: `packages/db/src/schema/dashboards.ts` (`dashboards`, `dashboard_widgets`, `dashboard_widget_updates`), migration `0199_dashboards.sql`; `packages/ui/src/widgets/spec.ts` (`@agenteschat/ui/widgets/spec`: `WidgetSpec`, `validateWidgetSpec`, `chartBlockToWidgetSpec`, schedules, sizes, caps); `packages/engine/src/dashboards/*` (`access.ts`, `service.ts`, `pin.ts`, `cost.ts`, `suggestions.ts`, `refresh.ts`, `proposals.ts`, `tools.ts`, `events.ts`, `types.ts`), `routines.ts` and `routine-ledger.ts` (the `widget` target), `tools/run-policy.ts` (a widget's refresh run), `notifications.ts` (`widget_alert`, `widget_failed`, `dashboard_proposal`); server `routes/app/dashboards.ts`, `dashboard-schemas.ts`; client `packages/client/src/dashboards/*`; web `packages/ui/src/widgets/*`, `pages/HomePage.tsx` (the mural), `pages/DashboardsPage.tsx`, `pages/DashboardPage.tsx`, `components/dashboards/*`; phone `app/(app)/dashboards.tsx` (pushed from `src/features/chats/DashboardsEntry.tsx` on the home), `src/features/dashboards/*`

## Context

Agents already answer with numbers and charts: a ```chart block in a message is drawn as a chart (bars, a line, a
pie, one big number) with a fine dither in the agent's tones, and routines run their work on a schedule. What people
ask next is to keep that number where they look every morning, kept up to date without anyone asking again, and to
put a few of them together for a team: "today's sales vs. yesterday", "open tickets", "pull requests waiting for
review". Today that is a routine that posts the same chart in a channel every hour, which buries the conversation and
leaves the latest number somewhere in its scroll.

Three questions shape the design: what keeps a widget fresh without filling the chat, who sees data that an agent
fetched with its own connections, and how an agent can build such a page for someone without showing it to more
people than asked.

## Decision

1. **A widget is a block, the agent that looks after it and a routine that redoes it in place.** Its data is a
   `WidgetSpec` of one of six kinds: `kpi` (one number with its move, a note and a small trend), `goal` (progress to a
   goal), `bars`, `line`, `list` (rows with a word each, `ok` or `warn`) and `text` (a few sentences). The spec is data
   only, checked by one function every package shares (`validateWidgetSpec` in `@agenteschat/ui/widgets/spec`): the
   kind's fields, text trimmed and clipped at a word's end, numbers finite, one value per label, at most 24 points,
   8 rows, 6 sentences; a `note` is one short sentence of at most 140 characters (§17).
   The person asks for a kind or `auto` (the agent picks). A chat chart reads as a widget (`chartBlockToWidgetSpec`:
   `number` → kpi, `bar` and `pie` → bars, `line` → line). Big numbers use the app's sans font, bold, tabular figures;
   charts are the chat's own drawing (a clean stroke in the agent's deep tone over a 2-pixel dither in its light tone).
2. **A dashboard is a board of widgets.** Four columns on the web, two on the phone; a widget is S (1×1), M (2×1) or L
   (2×2), and its place is one order on the board (`position`), packed by the grid. "Organize" drags to reorder and
   changes sizes; the phone shows a 2-wide widget across the row. A board holds at most 24 widgets; a workspace at most
   200 boards (people's home boards apart).
3. **Where a widget comes from.** "+ Widget" (beside "Organize", one pill in the board's head): the dialog is the
   widget itself, and the card is the form. What to follow is written in its body (with three suggestions per agent,
   asked once a day of the workspace's cheap model from the agent's role and the connections it may read); the
   agent's face in its footer opens a dialog of the agents the person can talk to (each with its role and the
   connectors it reads with); beside it how often it updates; the bell in its head an alert on or off with its
   condition ("drops 20% below yesterday"); S/M/L its size; the format a dropdown; the board under the card. Nothing
   shows example data: Test builds the card in place (§16). "Pin" on a chart an agent sent (on the chart in the message, or "Pin from chat" in the dialog): the
   widget keeps the chart's data as it was and the message's agent looks after it; updating it is optional ("No, just
   pin" is `manual`). Agents make widgets too (§10).
4. **The routine that redoes it is a routine.** A widget that updates has its own row in `routines` (made the first
   time it needs one: a schedule, its first build, "Update now") with the target
   `{ type: "widget", widgetId, dashboardId }`: its name is the widget's title, its instructions what the person asked,
   its creator whoever asked (accountable, never behind its run, ADR 0053 §1). Everything ADR 0053 built holds as is:
   firing with `FOR UPDATE SKIP LOCKED`, one run at a time, a computer away, the ledger closed on every ending, the
   failure streak that pauses after five, the standing checks, the budget and plan pauses. Its background run works in
   the routine's own room; its `deliverTo` is its creator's DM with the agent, only for the rare card it may raise.
   Widget routines show in Routines while they update on a schedule, tagged with their widget and opening it (their
   schedule and instructions change from the widget), and don't count in the 20 active routines an agent may have: the workspace's cap on scheduled widgets
   holds them (§7). Deleting the routine leaves the widget updating only when asked. A dedicated scheduler was
   considered and dropped: it would have repeated the firing rules, the ledger and every pause and recovery path for
   one more kind of background run.
5. **It speaks only through `update_widget`; nothing goes to the chat.** A widget's refresh run is read-only: it reads
   (built-in reads, connections' reads, the web, the browser's reads) and hands its data to `update_widget` (`data`,
   a one-line `summary`, the `sources` it read, an `alert` when the condition was met, or `failed` with why in the
   person's words). Everything else is refused by the run policy with why, `hand_off` included: a refresh posts nothing,
   ever. The call is checked (`validateWidgetSpec`), applied once per run, closes the routine run as `reported` and
   changes the widget in place. The kind changes only on a first build with `auto` or when a person asked for a change.
   A run that ends without the call fails the widget (`no_update`); a failed run carries its routine code
   (`budget_exceeded`, `waiting_computer`, `creator_left`…). "Ask for a change" queues a run with the person's words; it
   may change the title, the kind and the standing instructions.
6. **States, history, alerts.** A widget is `building` (its first run), `ok`, `updating` (a run is redoing it; the last
   data stays on screen) or `failed` (a human reason and "Resolve", which runs it again, takes the routine over when its
   creator can no longer run it, and resumes it when it paused itself: failures, its creator gone or out of the board).
   A routine a person paused on purpose in Routines stays paused: "Update now", "Resolve" and "Ask for a change" run
   once, and only Resume in Routines brings the schedule back. Each update or failure is kept with what it
   showed (`dashboard_widget_updates`, the latest 20), shown in the widget's panel. When the alert is on and the agent
   says its condition was met, the person who set the alert hears it in "Waiting on you" (`widget_alert`, waiting, one
   row per widget merging while open); never in the chat. A widget that stops updating tells its creator once per
   failure streak (`widget_failed`, inbox only), resolved by its next good update.
7. **Schedules, the floor, the cap and the cost.** Every 30 minutes (`half`), every hour, every day at 08:00, every
   Monday at 08:00 (in the time zone of whoever set it up), or only when asked (`manual`): never more often than every
   30 minutes, so the 15-minute floor of routines never binds. A workspace keeps at most 60 widgets updating on a
   schedule (`widget.scheduled_cap`; manual ones don't count): a sane ceiling for a team's boards that bounds what
   unattended refreshes cost. The estimate (`GET …/widget-cost`) is runs a day × the agent's average cost of a routine
   run in its last 30 days (at least three runs), else its model's price for a typical refresh (8,000 tokens in, 1,000
   out), "≈ US$ X a day of <agent>'s budget" (a week for weekly ones); on a computer brain's plan it says the plan
   pays. The New widget dialog lists only the schedules, without it: a price beside each choice read as a bill for a
   choice that is the agent's budget either way.
   The Model Gateway's budget check still holds every run, and usage is recorded with the agent and the workspace as
   for any run.
8. **Who sees and who edits a board.** `workspace` (every member), `roles` (whoever holds one of its roles at the time,
   ADR 0085, the model of ADR 0125) or `private` (its owner alone). Admins (`administrator`) see every board but private
   ones, and may edit, share, pin and delete what they see; a private board and a home board are their owner's alone,
   admins included. Who edits (`edit_policy`): `viewers` (whoever sees it), `owner` (its owner and admins) or `roles`
   (besides its owner and admins, whoever sees it and holds one of `edit_role_ids` at the time, ADR 0085). Editing isn't
   seeing: an edit role whose people don't see the board gives them nothing, so the apps offer such a role disabled
   ("Doesn't see this dashboard"), and narrowing who sees it drops the edit roles that no longer see it (none left:
   `owner`). Edit roles are checked like the audience's (1 to 100 custom roles), a deleted role leaves them as it leaves
   the audience (none left: `owner`), and choosing who edits never needs `post`. The apps pick it from one dropdown (the
   web) or a row with a pick menu and a pushed screen for the roles (the phone), named by what is picked ("Sales and
   Board", "3 roles"). Editing is the board's title and description, its widgets, their order and sizes, refreshing them
   and asking for changes; sharing, pinning first and deleting are its owner's and admins'. Showing a board to others
   needs `post` (who may speak to the workspace may show it something); a private one needs only membership. A `roles`
   board with no role left (a role deleted) is its owner's alone until shared again.
9. **"My Home".** Every person has a home board (`kind` `home`, always private, made the first time it is read): the
   widgets of their Home. On the web Home shows it as a mural of four columns where "Waiting on you" and "Working
   now" are fixed tiles among the widgets (`home_tiles`), moved and resized with them in Organize.
10. **Agents make boards and widgets.** Built-in tools, listed for every agent like the chat's own: `list_dashboards`,
    `create_dashboard`, `create_widget` (on a board the person behind the run edits, by default the one they asked it
    to build or their home, with data at once when the agent has it) and `share_dashboard`. A board an agent makes is
    owned by the person it is for (the person behind the run, else the routine's creator or the agent's owner), shown
    as "created by <agent>", and starts private. `create_dashboard` and `share_dashboard` also set who edits (`edit`,
    `edit_roles` by name), at once: editing isn't seeing, so it never waits on the person (§11). New dashboard makes
    an empty board and says an agent builds one when asked in a chat: asking happens there, not in the dialog.
11. **An agent never shows a board to more people by itself.** When it would show a board to more people than whoever
    asked (a wider audience on `create_dashboard` or `share_dashboard`, any widening by a routine's or an unattended
    run), the board keeps its audience and the request waits on the person it was made for: a banner on the board and
    a row in "Waiting on you" (`dashboard_proposal`): "Theo wants to publish the dashboard “Black Friday” to the
    workspace", with Publish and Keep only for me. Only that person decides (publishing needs `post`); narrowing
    applies at once. The request is kept on the board (`dashboards.proposal`), not as an approval: nothing waits on it,
    so the agent's run goes on and the person decides when they look.
12. **What whoever sees a board sees.** A widget shows what its agent fetched with its own connections, scopes and
    credentials. Whoever sees the board sees that data, even without access to the account it came from: that is what
    a dashboard is for. The apps say so where an audience is chosen (Share, New dashboard), and an agent's widening
    always asks the person first (§11). Pinning a chart from a private conversation onto a wider board is the
    person's choice, made where they see the audience.
13. **Live.** Ids only go out (`dashboard.changed`, `dashboard.widget` with the widget's status): a private or home
    board's events to its owner alone, any other's to the workspace, and a change that took a board away from people
    to everyone; the apps fetch what they may see again.
14. **On the web.** Home shows "My Home" as the mural (§9) with Organize and "+" (a new widget) in its header; a
    board has no add tile of its own. "Dashboards" is always in the sidebar's "More" menu, like the task manager (no
    fixed row; the open page shows under "More" while you are on it), and in ⌘K; it opens the Dashboards page: "My
    Home", then the boards grouped "Workspace", "Your roles" and "Only yours", each with a dithered thumbnail of its
    widgets' tones, and "New dashboard" (with only "My Home", a line under it points there instead of an empty
    state). A board's page has its back link, title, Share, Organize and "+", a line with who sees it, who made it,
    how many widgets and when it was updated, an agent's request (§11), the grid and an empty state with "Add
    widget". A widget opens in a side panel: the widget big, how it updates (its routine and next run, its alert,
    what the agent reads), its latest updates, remove, and a composer to ask its agent for a change. Removing a
    widget, from anywhere, asks first: its routine stops and its history goes. Charts in messages get "Pin".
15. **On the phone.** Dashboards open from the home screen: at the top of Chats, what Início shows (My Home, or the
    board chosen for it, §18) heads a strip of its widgets, small and side by side, that scrolls sideways (with none
    yet, one card asks for a widget), and "See all" at its end pushes the list, `/dashboards`. The tab bar is unchanged (Chats, Threads,
    Agents, Activity and Search): a sixth tab would push search out of Android's bar, which holds five at most. The
    list shows "My Home" first, then the same groups. Everything is a pushed screen with a back button, never a sheet:
    the list, a board (two columns, a 2-wide widget across the row), a widget (big, how it updates, history, remove,
    ask for a change), a new widget (preview on top, text and suggestions, agent, format, schedule, alert, board),
    share and a new board.
16. **Test before creating.** "+ Widget" asks the agent first and creates after: "Test" makes a draft
    (`dashboard_widgets.draft`) that its agent builds at once with real data, through the same refresh run as any
    widget (`update_widget`, a history row, failure reasons, its cost recorded); the card shows it building in place,
    then the real result (the ask folds into one line that opens it again), or why it failed with "Try again". Only
    when it worked
    does "Create widget" confirm it (`POST …/widgets/{id}/confirm`; `widget.not_tested`, 409, before that): it goes
    first on the board chosen then, with the size, schedule and alert chosen then, keeping the tested data and its
    history (no second build), and its routine gets its schedule. Changing the ask, the agent or the format makes the
    test stale; schedule, alert, size and board don't. A draft is on no board, under no cap, in no list (boards, Home,
    Routines, the agents' tools), raises no alert or notice, and is its creator's alone: anyone else gets
    `widget.not_found`, and its events go to the creator's own topic. Its routine never has a schedule. Testing again or
    closing the dialog deletes it with its routine and stops its run; a person keeps five at most (the oldest go), and
    the server's workers delete those nobody confirmed within a day. Pinning a chart needs no test: its data is
    already real. Agents' `create_widget` is unchanged.
17. **Who names a widget, and notes that fit.** The ask is never the title. The agent names the widget on its first
    build (a draft's test included): `update_widget` requires a short `title` then (at most 40 characters, sentence
    case, in the person's language, no period at the end) and refuses a longer one rather than cutting it; it may rename
    it again only on a change request, and never once a person named it (`dashboard_widgets.title_set_by_user`: a title
    given on create, a different title on confirm, or Rename). Until it is named the apps show a generic "New widget".
    A `note` longer than one short sentence (140 characters) is a tool error the agent fixes; the apps clamp a note to
    two lines with an ellipsis instead of cutting characters, and text the server keeps is clipped only at a word's end.
18. **A board on Início.** "Use on Home" in any board's menu shows that board on the person's Início instead of My
    Home, for them alone (`organization_members.home_dashboard_id`, `PUT …/dashboards/home-choice`); seeing the board
    is enough, since Início only shows it. The fixed tiles stay (they are My Home's), the board's widgets follow them,
    and "+" and Organize change that board when the person edits it. The choice has no foreign key: a board deleted or
    no longer shown to them reads as none, and Início is My Home again. Meanwhile My Home opens as a board page of its
    own (Dashboards' first card), whose menu brings Início back to it; the chosen board's card says "On Home". Home's
    head says "See all", which opens Dashboards, on the web and the phone.
19. **A build says what it is doing.** While a widget is `building` or `updating`, its page (`GET …/widgets/{id}`,
    under the same access check, so a draft's is its creator's alone) carries `step`: the tool call its run is in (the
    name, the connected app's label and service, when it started; never the input), null between calls. The apps say it
    in the chat's own words for a call, never a tool's name, with the time it has taken and a Stop that deletes the
    draft and keeps the ask; the draft's poll and its events refresh it. The run starts with what it needs in hand:
    on Claude Code, whose ToolSearch holds our tools back by default, the bridge's list marks `update_widget`, the web
    and the connected apps' reads (60 at most) to be listed from the first round (`widgetUpFront`), and its prompt
    forbids arithmetic and waiting in a shell.

## Consequences

- One more kind of routine: Routines lists widget routines with their widget, and the routine code paths branch on the
  `widget` target in a few places (firing, the ledger's end, the agent's routine tools, which refuse to change them).
- A widget's refresh costs the agent's budget like any routine run; the cap of 60 scheduled widgets per workspace and
  the 30-minute floor bound it, and the Model Gateway checks the budget before every run.
- Data an agent fetched reaches whoever sees the board (§12). Agents can't widen that by themselves (§11), and a
  routine never does.
- No new permission: showing a board needs `post`, deciding everything else follows the board's own rules and
  `administrator`.
- Someone leaving the workspace loses their home board and private boards (their widgets' routines are deleted);
  boards others see stay, and admins manage them. Widget routines whose creator left pause (`creator_left`) until an
  editor presses Resolve.
- Migration 0199 adds the three tables, with `draft` and `title_set_by_user` on widgets (§16, §17) and
  `edit_role_ids` on dashboards (§8); notifications gain three kinds.
- Live blocks (ADR 0113) are not pinnable: they are for using now, and run code a board shouldn't keep running.

## Alternatives considered

- **A scheduler of its own on `dashboard_widgets`.** Simpler to read in isolation, but a second copy of firing, the
  ledger, the pauses for a computer, a plan or a budget, and the failure streak (§4).
- **The widening as an approval (ADR 0015).** An approval holds the agent's run and expires in 24 hours; a board can
  wait days for its owner to look, and nothing needs to wait for it (§11).
- **Posting the refreshed chart in a channel.** What people do today, and what this replaces: the latest number gets
  buried, and the conversation fills with reports nobody asked to read.
