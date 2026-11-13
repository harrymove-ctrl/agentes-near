# 0164. One card to create an agent

- Status: Accepted (the web app; the phone app keeps its screens for now)
- Date: 2026-11-10
- Amends: ADR 0155 §1 (the two steps become one card), ADR 0159 §3 (a personal workspace's "New agent" opens the card
  instead of asking the right hand in one sentence)
- Extends: ADR 0155 §2 (the agent's checklist reads what its card chose)

## Context

Creating an agent had four ways in and three designs. In a personal workspace, "New agent" asked for one sentence and
sent it to the right hand, which needs an AI before anything exists: without one the person met a silent agent and no
new one. The page at `/agents/new` had steps it skipped but still counted ("step 3 of 4" on the second screen), the team
templates had their own dialog, and choosing an app left the flow for Settings, which suggested apps for teams. Once
made, the agent's chat opened with an extra "open profile" link and a Connect AI window over the checklist, and the
greeting sometimes ended with doubled punctuation. Each door asked differently for the same few things: who the agent
is, what it does, what it uses.

## Decision

### 1. One dialog for every way in

`NewAgentDialog` (`apps/web/src/components/new-agent/`) is mounted once for the workspace (`NewAgentProvider` in the
org layout) and opened by `useNewAgent().open({ channelId? })`: the sidebar's "New agent" (both modes, and the team's
agents section), the Team page, Members, a channel's "add an agent" (the channel comes ticked), the team plan's "from
scratch" link and the desktop app's menu (through the `agentes:new-agent` window event, since the menu bar is mounted
outside the provider). Someone who may not create agents still gets the page's own words about it.

On the left, the starting points: "Start from scratch" first, then the ready-made agents (a personal workspace's
starters, or a team's roles by area). Each row is a face line: the name's capitals at the face's top, never the face
centred on both lines, and an accessory drawn above the tile moves nothing. Arrow keys move through the list. On the
right, the agent's own card, edited in place. The list and the card's body fade at an edge only while there is more to
scroll that way (`useScrollEdges`, the sidebar's flags and mask).

### 2. The card

- **Its voice:** the agent speaks in a bubble, "Hi! I'm" and the name field, then one sentence of what it will do (the
  starter's, or what the person writes from scratch). Its @ is shown under it and follows the name; a taken one says so
  and takes the next free one.
- **Its look:** the fitting room. Hovering a color, eyes or clothes tries them on the agent; Shuffle spins like a slot
  machine. The agent looks at what the pointer is on.
- **Name ideas** (from scratch): a few names that fit what it does (themes found by words in the sentence, per
  language), each tried on when hovered and taken on a click; a die rolls more.
- **Apps it will use:** only what the workspace has connected, which is what it gets when it is made, each at its
  level (a person's own agent writes; a team's at its role's level, else reads). A starting point's suggestion that
  isn't connected is never on the card; its chat's checklist suggests it. With none, "Nothing yet". The level dialog
  says that sending, deleting and paying always ask the person, at every level. "Another app", at the end of the
  section's label so it is always in sight, opens the catalog as rows (`AppsPickerDialog`): the starting point's apps on top,
  then the connected ones, then the rest, with a search. A connected app is used at once; another runs the usual
  connect flow over the card and lands on it at its level when it connects. Signing in on a provider's page reloads
  the app, so the card waits in the tab (`sessionStorage`, an hour) and opens again as it was on the way back
  (`?newAgent=resume` and the server's `?connected=`).
- **Skills:** the workspace's skills the role suggests come ticked, the others one click away ("Another skill", also
  at the end of its label), each opening a short view of what it is. The section shows only when the workspace has
  skills.
- **Where it works** (a team's workspace).
- **How it works:** its instructions, edited in place as the bubble is (text that becomes a field, up to about eight
  lines before it scrolls): a role's instructions, a personal starter's own, or empty from scratch. The old form's
  helpers ("What to do", "What to avoid", "Who to ask for help") add their line at the end. Enter there is a new line.
  The first tasks are only in the chat's checklist.
- **The footer:** "Bring agents from another app" on its start, and while nothing here can think, "Connect an AI",
  which opens Connect AI for agents still being made over the card (the draft stays; the button goes once an AI is
  there). Connect AI's provider sits above the dialog's in the workspace's layout for that.

"Create" makes the agent with the card's instructions (from scratch with none, what it does), Automatic as its model
and the AI `newAgentStart` picks (the person's plan account or the workspace's default), then each part on its own so
a failure is said without losing the agent: its AI, channels, app levels and skills. The agent's face flies from the card to its row in the sidebar and its chat opens.

### 3. What the card hands to the checklist

`agents.setup` (jsonb, ADR 0155 §2) gains three optional fields: `hello` (the sentence, at most 500 characters),
`starter` (the personal starter it came from) and `apps` (connector ids to levels, at most 12): its starting point's
apps not connected yet, then the card's. The create route
validates them and `setupOf` keeps them. No migration: older rows read as before.

### 4. The agent's chat

- The greeting ends with the agent's `hello`, and the trailing punctuation of an asked line is trimmed before the app
  adds its own.
- A band above the checklist: the agent asleep at night in its sky until it can think, dawn when it can (1.6 s), with
  slots for its AI and up to four of its card's apps, lit as each is ready.
- The apps row names the apps the card chose. One not connected yet reads "Connect" and opens the same connect flow as
  Settings in place, coming back to the chat; the apps dialog suggests the card's apps first.
- In a personal workspace with one member, "who talks to it" and "where" leave the card; "who talks to it" shows as a
  line that isn't counted, and the meter counts only what is left to do.

### 5. Narrow screens

Where the list and the card don't fit side by side (`NEW_AGENT_STEPS_QUERY`, a window under 960px: the dialog is the
window less 32px, a sheet from 640 down, and side by side needs the list's 440 and a card of about 420), the dialog
takes two steps at one height (most of the window; on a phone the kit's sheet at its full height):

1. **The list**, titled "New agent", the same rows, filling the dialog and scrolling with its fades. The footer keeps
   the import and Connect AI; there is no Create. A tap, a click or Enter on a row opens its card; the arrows still
   move through the list.
2. **The card**, titled with the agent's name, a back arrow before it in the dialog's head. The cover and the sections
   scroll as one column, and the footer is Create alone, at the sheet's width. Back returns to the list on the same
   row, with every card's edits kept.

The cover follows the card's own width (a container query): under about 480px the buttons sit on top, the agent under
them and its bubble under the agent at the card's width, never squeezed into a column beside it. The fitting room's
choices wrap to the width. On touch screens a tap picks a name idea, a color or what it wears, each a 40px target; the
hover-only lifts and outlines are left to pointers that hover. The chat's band follows its own width too: a smaller
agent, shorter trails and smaller slots fit an AI and four apps from about 300px, and narrower still the path scrolls
sideways with a fade at the edge that has more. The dialogs it opens (an app's level, a skill, the app picker,
Connect AI) are the kit's dialogs, sheets on a phone, over it.

The cover's sky ends in the color of what it sits on (`agentCoverOptions` takes the surface token: the card's well,
the chat card's face, the page). On a dark surface it is that surface rising into the agent's color, as the app's
other skies are there: the color near the top and as a glow behind the face, the rest melting into the dark card,
instead of the light theme's day sky over a gray slab. The agent page's cover follows the same rule.

New agent's empty face in the sidebar is the agents' own: the sidebar's face tokens (`--sidebar-agent-face`, a
team's message-size face or a personal list's 40, and the rail's `--sidebar-rail-face`), their framed radius and the
gap to their names.

### 6. What stays

`/agents/new` stays for an agent's proposal (`?proposal=`, ADR 0155 §5), the import and old links. The phone app keeps
its screens until it gets the same card.

## Consequences

- The one-sentence ask of ADR 0159 §3 goes away (`NewAgentAsk` and its words): the right hand still proposes agents in
  its chat when asked.
- The starter tasks and greetings are product words in every language; skills are suggested by matching role names to
  the library, which is a best effort.
- The phone app follows later, reading the same `setup` fields.
