# 0065. The agent's computer in one dialog; screens stay on

- Status: Accepted (2026-10-25). Superseded in part by ADR 0077 (2026-10-28): §2's `computer_start` and `computer_stop`, which no computer offers anymore; `computer_status` stays
- Date: 2026-10-25
- Amends: ADR 0058 §1 (a desktop starts the first time it is needed and stays on; only a lack of room parks one), §6 (no terminal view; its backend goes in a later change) and §13 (one dialog in the apps); ADR 0056 §10 (the ready time, when the wait began, the ready email, no pairing with external provisioning, no approval step); ADR 0060 §3 (no server's own computer with external provisioning)
- Builds on: ADR 0025 (connected computers), ADR 0040 (the agent browser), ADR 0057 (system mode), ADR 0059 (AI accounts), ADR 0062 (desktop computer use)

## Context

People saw an agent's computer as three cards (its browser, its desktop, its terminal), turned its desktop on and off, and waited for the workspace's own computer with a step but no time. Most of them aren't developers: a terminal means nothing to them, and on a computer that is always on, "off" and "turns on when needed" only confuse. The workspace's own computer takes seconds when a ready one is handed over and about ten minutes when one is made from nothing; a wait that long needs the time left, and a way to leave the page without missing the end.

## Decision

### 1. One entry and one dialog per agent

- Each agent has one entry, "Desk's computer": a status line and one button (Open, or Help when the agent asks this person), on its page, in its DM header and on its computer's page. Open shows its computer in a dialog: watch, take control, hand back, full screen.
- A computer with screens shows the agent's screen, where its browser is a window; one without (a Mac) shows the agent's page. Whoever helps with a browser request gets the page, never the whole screen. *Amended 2026-11-04:* whoever may drive the screen the request's window is on (the owner, and admins who manage agents, ADR 0059 §8) helps on the whole screen, the request's banner on top, so their keys, paste and copy go through the screen (ADR 0040 §16); the page stays for whoever may drive only the browser, and for a computer without screens. The page itself looks like a browser: an address bar always at its top (back, forward, reload, the address to edit) and the page edge to edge, no grey frame (ADR 0040 §15).
- Whoever may drive the agent's browser but not its whole computer (`drivesComputer`: on the Cloud, an admin while the agent thinks with its owner's plan, ADR 0059 §8) is offered the browser by name, never under "Take control" (amended 2026-11-03). *Amended again 2026-11-03:* admins who manage agents now drive the whole screen on the owner's plan (ADR 0059 §8), so they get "Take control" of the screen like anywhere else. The browser by name is left where it is really the only option: someone who controls computers without managing agents on the owner's plan (`owner_plan`, whose reason now says the owner and admins who manage agents drive the whole computer), and anyone but the person who connected a computer outside system mode (`pairer`). `GET …/agents/{id}/desktop` says why beside `canControl` (`controlRefusal`: `owner_plan`, `pairer`, `not_allowed`); the button reads "Take over the browser" with the reason, and in control the page shows under a line saying it is the browser, not the whole computer, and why.
- No terminal view: in control, the screen's own Terminal app is there for whoever wants it. The terminal's backend (`/api/terminal`, the runner's terminal and its switch) goes in a later change; the machine protocol isn't bumped for it, since those fields were optional.
- `?computer=1` opens the dialog; `?browser=1`, `?desktop=1` and `?terminal=1` keep working for older links. The links the server makes (`agentBrowserLink`: the desktop app's tray, notifications) say `?computer=1`.

### 2. A screen starts the first time it is needed, then stays on

- An agent's screen starts the first time it is needed: its first screen or browser command, or the first time someone opens it (1.3 s on a 4-CPU, 8 GB computer, creating the agent's OS user included). Nothing stops it for being idle afterwards, so what a person left open on it is still there later. Only the agent's browser window closes after 15 unused minutes, as before, with its sign-ins kept.
- Opening a stream starts a screen that isn't running, for a watcher too: the server asks for it (`stream.open` with `start`) and the runner runs `ensure` first. Not on a paused computer, and not for a held agent or in a workspace on hold: starting a screen is new work (its session runs as the agent, with whatever the agent set to start there), so the server leaves `start` out, the runner answers `desktop_off`, and the viewer's close says `held`. A held agent's screen that runs may still be watched. An older runner ignores `start` and answers `desktop_off`; the server then sends `desktop.session.start` (refused for a held agent like any new work) and opens once more.
- Nothing turns a screen on or off: `POST …/agents/{id}/desktop/start` and the screen's `…/desktop/stop` are gone (the browser's stop stays). `GET …/agents/{id}/desktop` drops `canStart` and `terminal`, and says `held`: the agent is held or its workspace is on hold, so people may watch and nobody takes control.
- What stops a screen: its agent leaving the computer (archived, or moved to another one: the runner stops the screens of agents missing from the server's list of the computer's agents), its workspace being suspended (`stopOrgWork` ends the screens with what runs on them, as it ends runs and tasks), a reboot, and parking. A hold stops none: held, an agent starts nothing, while what runs goes on, as its tasks do, and people may watch it.
- Parked only when room runs short. Before a screen or a headed Chrome starts, the runner reads `MemAvailable` (`/proc/meminfo`), and before a screen starts it looks for a free display (50 slots). Under 1.5 GiB, or with every display taken, it parks screens, least recently used first, among those nobody watches, whose agent doesn't use them, and that nothing touched for an hour (an open request touches its screen every 5 minutes, the agent's browser on it each minute it is in use); it stops once there is room, and with nothing left to park it refuses `desktop_busy`. A parked screen starts again like a first time. This replaces the count of desktops per machine (7 on 8 GB). Brain turns start under the same floor (ADR 0025 §5, admission), in place of the runner's count of requests. Without `/proc/meminfo` there are no screens, and the browser keeps its count.

On an 8 GB computer (7.8 GB visible, 2 GiB of it kept for the system and the AI command-line tools) a screen takes 0.15–0.19 GB idle, and its browser about 0.6 GB more while open:

| Agents | Their screens, always on | Left for open browsers | Browsers open at once |
| --- | --- | --- | --- |
| 3 | 0.6 GB | 5.2 GB | all 3 |
| 10 | 1.9 GB | 3.9 GB | 6 |
| 20 | 3.8 GB | 2.0 GB | 3; a 4th parks screens untouched for an hour |
| about 30 | 5.7 GB | none | the least used are parked, and start again when needed |

- The agents' tools: `computer_start` and `computer_stop` are offered only for a Daytona sandbox; on any other computer `computer_status` says where the agent is, and that the workspace's own computer is always on.

### 3. The wait: a ready time, and the seconds left

- The provisioner reports `expectedReadyAt` with `preparing` (`PUT /orgs/{orgId}/provisioning`, ISO, at most 7 days ahead). One wait counts down to the earliest time it was told: a part running past its estimate moves the provisioner's time later with the clock, so a later time is kept out and the apps say "a little longer than expected" once the time is past, until it is ready, never a countdown that goes back up. Another state, a removal or a hold starts a new wait. "Almost ready" belongs to the last step, connecting it to the workspace. An older provisioner's `etaSeconds` reads as that many seconds from now, and its `reason: approval` as `capacity`: there is no approval step.
- `machine_provisioning` gains `expected_ready_at`, `requested_at` and `email_when_ready`; `eta_seconds` goes, with the pending times copied. `requested_at` is when people started waiting: written only when the computer is taken away, kept by every later report, and read as the workspace's creation when null, so making a workspace writes nothing.
- `GET …/computer-setup` and `machine.provisioning` add `requestedAt`, `expectedReadyAt`, `secondsLeft` and `secondsWaited` (both counted by the server when it answers, so a wrong clock on someone's device doesn't matter, also for "a wait over a minute") and `notifyByEmail` (the server sends email).
- Taking the computer away (`DELETE …/machines/{machineId}`) leaves a `preparing` row from that moment instead of none, so the next wait counts from it.

### 4. The ready email

- When the workspace's computer becomes ready, its owners get one email each in their language (one per language group), once per ready (the notification's key, `computer_ready:{machineId}:{readyAt}`), through the email outbox. Only from a server that sends email, and only when a report had promised it (a ready time over a minute ahead, `waiting` or `problem`: `email_when_ready`) or the wait took over a minute. A ready computer handed over in seconds sends none.
- It is queued in the transaction that makes the computer ready: people who were told "we'll email you" and closed the page get it, or the computer isn't ready yet and its next hello does both. None goes to a workspace that isn't active (on hold or suspended while its computer was being made): its agents can't take the first task it suggests.
- It says what the computer is (its size, when known, and a user of its own for each agent), and numbers the next steps it shows: connect an AI (only while no agent has one), give a first task in #general (create an agent instead, when there is none), and watch them work from an agent's page.

### 5. No pairing with external provisioning

With `MACHINE_PROVISIONING=external` every workspace has its own computer, so people connect none: `POST /api/machines/device` and `POST …/organizations/{orgId}/machines/device/{userCode}/confirm` answer 403 `machine.pairing_off`, and a runner pointed at the server stops at once instead of showing a code nobody can confirm. The workspace's own computer never asks for a code: it redeems the one it was issued at `POST /api/machines/device/token`. Nor does the server's own computer join (ADR 0060 §3): it refuses to start with both `MACHINE_PROVISIONING=external` and `HOST_COMPUTER_TOKEN`.

### 6. Words by edition

The apps read the edition from `computer-setup`'s `mode` (`external` or `pair`), never from `/api/health`. With external provisioning nothing names an "off", turning on or off, "your computer", pairing or "the cloud"; "always on" is the one power word. On a self-hosted server the computers are "This server's computer" and "Other computers". A test keeps the list of keys each edition shows and the words they may not use.

## Consequences

- Memory, not a count, decides how many screens run. A busy 8 GB computer with many agents browsing at once may close what was left open on its least-used screens.
- What a person left on a screen lasts until the computer restarts: a reboot ends the screens, and each starts again at its next use. Whoever watches later sees it too: a window someone left open after taking control, or a site they signed in to, stays in view of every later watcher for days where it used to close after 15 idle minutes. Closing what they opened is up to them.
- Older runners keep working: the server starts their screen before opening it. Older provisioners keep working too, and one that sends times gets the overrun right.
- People on a server with external provisioning can't bring a computer of their own.
