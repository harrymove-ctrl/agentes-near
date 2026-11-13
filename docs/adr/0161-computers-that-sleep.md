# 0161. The workspace's computer sleeps when nobody uses it

- Status: Accepted
- Date: 2026-11-09
- Amends: ADR 0056 (§5: `machine.wake_wanted`; §10: standby, `busy` and `lastUsedAt`), ADR 0032 (a run waits for a
  computer that wakes, as it does for one just gone)

## Context

The workspace's own computer (ADR 0056 §10) costs its operator the same whether anyone uses it or not. The operator can
put it to sleep while nobody does and wake it when it is wanted, but only with the server's help: to the server a
sleeping computer is one that stopped answering. Runs say it is offline, the apps say it isn't answering, it is listed
as disconnected, and nothing asks for it back.

## Decision

### 1. Standby is the operator's word

`machines.standby_at` (migration 0248). The operator says it put the workspace's computer to sleep, or that it no
longer is: `PUT /api/operator/v1/orgs/{orgId}/machines/{machineId}/standby` with `{ standby }` answers `{ standby }`,
404 unless the workspace has that `managed` computer; `true` again keeps the first time. The computer's next hello
clears it, whoever woke it, and so does removing the computer. Only the workspace's own computer is ever in standby
(`inStandby` in `machines.ts`).

### 2. Whatever wants it says so

Through the hub (`MachineCaller.wake`, `wantMachine` in `packages/engine/src/machine-wake.ts`), with why:

- `run`: a run's first turn on the computer (its admission, before its place in the computer's line) and a run's wait
  for it (§3);
- `view`: a person's apps asking for the agent's screen (`GET …/agents/{agentId}/desktop`), which they do every few
  seconds while a view of the computer is open;
- `call`: any request sent to a computer in standby (`hub.call`), so every path that touches it wakes it.

Each writes `machines.wanted_at` (at most every 30 seconds per computer and server process) and, while the computer is
in standby, records `machine.wake_wanted` with `{ machineId, why }` in the events feed (at most every 10 seconds per
computer and process, `recordWakeWanted`). Other computers: nothing.

### 3. A run waits quietly while it wakes

A run that finds its computer in standby asks for it and waits up to `COMPUTER_WAKE_WAIT_MS` (60 seconds), still
working, nothing posted or stored, however long the computer slept (`computerBackSoon`, beside the 30-second wait for a
computer just gone): at its start, and again when it comes back from another wait (a plan's reset, the end of a drop's
grace). The browser's and the desktop's tools (`callWhenBack`) and the sandbox's (`withConnectedMachine`) wait the same
way. Not back by then, something is wrong: the existing path follows (the model brain stands in, or the note and the
wait for the computer's return).

### 4. Nothing is wrong to its people

Each computer in the apps' list carries `standby` (`GET …/machines`; a change comes as `machine.updated`). The
computer's view (the web's dialog, the phone's screen) shows "Opening …'s computer…" while it wakes, never "not
answering"; its status line (`entryState`, on the web and the phone) reads "Available · nobody's using it" unless a
request, someone in control or the agent's work says more; and a computer in standby is never an outage
(`…/machines/outages`).

### 5. What the operator decides with

`GET /orgs/{orgId}/machines` adds `standby`, `busy` and `lastUsedAt` (false, false and null for other computers),
from one query (`machineActivity`):

- `busy`: a run of the workspace queued or running, a run waiting for this computer, a task running on it, someone in
  control of one of its agents' screens, or something wanting it in the last 2 minutes;
- `lastUsedAt`: the latest of the workspace's runs and this computer's tasks created in the last 7 days (each run's end,
  else its last change), `wanted_at`, and its people's last visit.

How the operator uses them is its own: put the computer to sleep while it isn't busy and hasn't been used for a while,
then say `standby: true`; wake it on `machine.wake_wanted`, or when it reads `busy` in standby (something waits for it).

## Consequences

- An open view of the computer keeps it awake, the conversation's side panel showing the agent's screen included.
- A wake longer than a minute reads to the run that waited as the computer not answering (its note), though the run
  goes on by itself once the computer is back.
- The throttles are per server process: with several replicas, each writes and tells on its own.
- A hello clears the standby, so the operator says `true` after the computer is asleep, not before.
