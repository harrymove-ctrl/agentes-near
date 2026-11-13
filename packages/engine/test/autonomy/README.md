# Autonomy scenarios

Scripted end-to-end scenarios that check the autonomy invariants on the real engine (routing, mention wakes, authority, follow-through, consultations, routines), with the fake provider and fake judgments on PGlite. No model and no network.

The rule behind them: agents act and wake by default within their own permissions, and never act when nothing needs them. Each production case so far was a gate that defaulted to "nothing happens". The scenarios state the properties that must hold for every run kind instead, so a new path fails here before a customer sees it.

## The invariants

`invariants.ts` checks these over the rows at the end of **every** scenario, not only the one the scenario is about:

| | Rule | Checked at the end of each scenario |
|---|---|---|
| I1 | A message meant for the agents gets exactly one agent (all of them when it is for everyone); people talking and acks get none. | per scenario (`decisions()`, `runs()`) |
| I2 | No idle end: a turn keeps working, waits on something visible, or is done. | nothing left running or due; `waiting_input` has an open question (or the run is parked on a provider outage), `waiting_approval` a pending card; every done run records its continuation outcome (`decideTurnEnd`, ADR 0097) |
| I3 | Every hand-off is answered or reported back. | no consultation left open; a closed async one was reported back to its asker (its own notice, or rolled up into the answer of the agent that handed it on: `reported_at`) |
| I4 | A turn can do what its agent may do, whoever woke it (except a routine set to only look). | no "nobody asked for this work" refusal; no run outside a routine with nobody behind it |
| I5 | Failures reach someone and work resumes. | every failed run left a notification naming it or its agent |
| I6 | Nothing acts when nothing needs it, and every extra turn is bounded. | no unscripted model call; at most 3 nudges and 5 idle turns in a row per run; at most 2 wakes between the same two agents |
| I7 | What an agent is told about its world is true. | per scenario (prompts, refusals at creation) |

A judgment kind the harness doesn't know, or a person's message with no entry in the scenario's router table, fails the scenario, so neither can pass silently.

## Files

- `harness.ts`: `world()` builds a workspace with agents, people and a channel (or a DM). It answers each agent from its own script by the `You are … (@handle)` line, answers the router step from a table keyed by message body, and answers judgments from a table that maps the controller's words (`done`, `continue`, `ask`) onto main's question. `settle()` drains the outbox to quiescence and retries transient failures at once; `advance(minutes)` is the fake clock.
- `known.ts`: which scenarios fail on main and the branch, or open item (`open:*`), that turns each green.
- One file per area: `addressing`, `turn-end`, `handoffs`, `routines`, `failures`. `pending.test.ts` lists the scenarios that still need a harness piece (a paired fake computer, a mission, a coding CLI brain).

## Known violations

A scenario listed in `KNOWN` runs as `test.failing`. CI stays green while the violation is known, and the scenario fails as soon as it starts passing. When a branch merges, remove its name from `KNOWN`; CI tells you which entries.

```sh
# one file, as CI runs it
bun test packages/engine/test/autonomy/addressing.test.ts
# count branches as merged: their scenarios must pass, the others must still fail
AUTONOMY_BRANCHES=wake-by-default,work-by-default bun test packages/engine/test/autonomy/addressing.test.ts
# every scenario as a plain test, to read each violation's assertion
AUTONOMY_STRICT=1 bun test packages/engine/test/autonomy/handoffs.test.ts
# the whole suite against another branch's engine, in a temporary worktree
packages/engine/test/autonomy/run-against.sh feat/wake-by-default wake-by-default
```

## Adding a scenario

Write it with `scenario(id, title, fn)` in the file of its main invariant. Script every model call each agent makes, assert what the system must do, and end with `assertInvariants(w)`. If it fails on main, add it to `KNOWN` with the branch that fixes it, and run `AUTONOMY_STRICT=1` once to check that it fails for the reason you mean. Use made-up names only: this repo is public.

Only the API brain (`model`) is driven. Brain parity for `claude_code` and `codex` is in `test/conformance`.
