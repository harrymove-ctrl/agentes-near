# 0044. One worktree per mission: items in sequence, prepared once, recorded on the mission

- Status: Proposed
- Date: 2026-10-21
- Revises: ADR 0029 §4 (background tasks: one worktree and branch per item) and "Missions as built" (item branches under `agentes/<id>/`, `work/<item>/` for folders without git)
- Extends: ADR 0032 (missions on the engine), ADR 0030 (agent environment on the computer)

## Context

Today every item of a mission (`start_task`, `packages/engine/src/mission-mcp.ts`) gets its own branch under `missionBranchPrefix` and its own worktree at `<agent folder>/.worktrees/<taskId>` (`createWorktree`, `apps/server/runner/tasks.ts`). The main session runs in the person's project (`missions.repo_dir`). Comparing with Orca (Stably's agent development environment, which is built around one worktree per agent) showed where this hurts on long coding work:

- **Nothing prepares a worktree.** Only `.agentes/` is linked in (`linkMissionFiles`). Files git ignores (`.env`) are missing and dependencies aren't installed, so an item that runs tests or a dev server starts broken, or spends its turn installing.
- **Parallel items that write collide later.** Each item branches from the same point; their branches have to be merged at the end, which is where parallel agents usually turn into conflicts. Orca has the same weakness: it is a tool for independent work.
- **Full slots fail the item** (`task.no_slot`); there is no queue.
- **The mission doesn't know its own code state.** There is no "what the mission changed" from a fixed base, and no record of what each item changed.

Most long coding tasks are sequential anyway (step 2 builds on step 1). What runs well in parallel is reading: research, analysis, review.

## Decision

### One worktree and one branch per mission

- At Start, the runner creates the mission's worktree: `git worktree add -b <branch> <agent folder>/.worktrees/m-<short id> <base_sha>` (`.worktrees/` stays in `info/exclude`, as today).
- The branch is `agentes/<short id>/<slug of the title>`, still under `missionBranchPrefix`, so the push rules that only allow the mission's prefix don't change.
- The base is the branch checked out in `repo_dir` at Start (its tip becomes `base_sha`). The plan card shows it ("a partir de main").
- The main session and every item work in this folder. The person's project (`repo_dir`) is never written by a mission.
- `.agentes/` (mission.md, decisions.md, notes.md) lives inside the mission's worktree and stays out of git (`info/exclude`). The server stays the source of truth (`syncMissionFiles`).
- A folder without git has no worktree: the mission works in `repo_dir` itself, items still one writer at a time, with no commits.

### Recorded on the mission, not in the agent's memory

New columns (new migration):

- `missions.branch`, `missions.base_branch`, `missions.base_sha`, `missions.worktree_path`.
- `missions.worktree_state`: `none | preparing | ready | failed | removed`, plus `worktree_error` (text, the setup's last lines).
- `machine_tasks.mode`: `write | read`, `machine_tasks.start_sha`, `machine_tasks.end_sha`.

The mission brief (`mission-brief.ts`) gives the main session and every item the folder, branch and base. No item can pick another folder or branch: `start_task` loses its `branch` argument.

### Prepared once

The runner prepares the worktree right after creating it (`worktree_state = preparing`), with the agent's environment (ADR 0030):

1. **Copy local files git ignores** from `repo_dir`: by default the `.env*` files at the root that git ignores (an untracked `.env` git doesn't ignore stays behind: an agent's own `git add -A` would take it). They are copied on the computer only and never sent to the server.
2. **Install dependencies**: by default from the lockfile at the root (`bun.lock` → `bun install`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `package-lock.json` → `npm ci`, `yarn.lock` → `yarn install --frozen-lockfile`); nothing when there is none.
3. **Project override:** an optional `agentes.json` at the repository root, meant to be committed: `{ "copy": [".env", "apps/web/.env.local"], "setup": "bun install && bun run db:generate" }`. Each field present replaces only its own default (`"setup": ""` runs nothing). Files listed there that git doesn't ignore are recorded in the worktree's own git dir and left out of the end-of-item commit; the shared `info/exclude` is never touched for them.

Setup has a 10-minute limit and its output goes to the task journal. On failure the state becomes `failed`, the mission pauses and the thread gets a card ("Não consegui preparar o projeto", the last lines, "Tentar de novo"). No item starts in a broken folder.

Shared `node_modules` through links (Orca's `sharedDirectories`) is left out: one install per mission is cheap enough and links break tools that resolve real paths.

### Items: writes in sequence, reads in parallel

- `start_task` gains `mode`: `write` (default) or `read`.
- **Write items** run one at a time in the mission's folder. From `start_task` until it ends (queued, running or interrupted), the main session's turns are read-only (`permissions.mode: "plan"`), so its edits never end up in the item's commit (Claude Code: plan mode; Codex keeps its usual sandbox, since its read-only one has no network: it is told in its brief that it only reads). A write item never starts while a main-session turn that began before it still runs: it starts when that turn ends. A write item started while another runs is stored as `queued` and starts by itself when the folder is free, in order.
- **Moving the mission** to another computer is refused while any of its tasks is live or queued (`mission.tasks_live`: stop them first). The old copy is removed in the background (best effort; the branch stays).
- **Read items** run in parallel in the same folder with no write access, enforced on the computer (`task.start` `mission.mode: "plan"`: Claude Code's plan rules, Codex's read-only sandbox).
- **Full machine:** any item that finds no slot is `queued` too ("aguardando vaga") instead of failing with `task.no_slot`. The server starts queued items when the runner reports a free slot or the computer comes back.
- **Every write item ends in a commit.** At its end the runner records `start_sha`, commits whatever changed as `agentes: <item title>` (the runner adds " (stopped)" when it failed or was canceled; a commit refused by a hook leaves the changes staged and says why), and records `end_sha`. The folder never carries loose changes from one item to the next, and the main session is told what each item changed (`start_sha..end_sha`).
- **Base drift:** when an item starts, the runner compares the base branch's tip with `base_sha`. If it moved, the main session is told how many commits behind the mission is. Nothing rebases by itself.

### Recovery

When the computer comes back (`onMachineOnline`), and before any item starts, the runner checks the mission's folder (`mission.worktree.ensure { missionId, path, branch }`):

- The folder exists on the right branch: nothing to do.
- The folder is gone but the branch exists: `git worktree prune`, add it again from the branch, prepare again.
- The branch is gone: the mission pauses and the thread says so. It never starts over from the base without telling anyone.
- Loose changes after a crash mid-item: left as they are. The item resumes its session, or the main session is told.

A mission with `worktree_state = none` (including missions opened before this ADR) gets its folder the same way before its next item. There is no separate migration path.

### End

- The delivery card shows the whole change (`base_sha..branch`) and the PR when there is one. Push and PR still go through the existing approvals.
- **Conclude:** once no item of the mission is live (a canceled write item first makes its "(stopped)" commit), the runner removes the folder (`git worktree remove`) and `worktree_state` becomes `removed`. The branch stays.
- **Cancel:** the person chooses whether to keep the branch or delete everything. The branch is only deleted by that explicit choice.
- **Reopen** (`reactivateMission`): the folder is created again from the branch through the same `ensure`.

### UI

- The mission header shows the branch and its base. While the setup runs, the item area says "Preparando o projeto…".
- Items show "Na fila" when queued.
- The delivery card's "O que mudou" uses the mission's whole diff; each session in `MissionSessions.tsx` shows its own.
- The UI never says "worktree"; it says "cópia do projeto". Every text goes through i18n (pt-BR and en).

### Runner protocol

This is a new runner protocol version (`mission.worktree.ensure`, `mode`, queue, commit at the end). Older runners can't start missions; `eligibleMissionAgents` already gives "runner desatualizado" as the reason.

## Consequences

- Setup happens once per mission instead of never (today) or once per item (Orca).
- Write items no longer need dependencies between them or an integration item at the end: their order is the order they ran in.
- A mission can't edit two parts of the code at the same time. Missions that need that are rare; when they show up in real use, a write item could get its own worktree off the mission's branch, merged back by the runner.
- The person can keep working in their project while a mission runs, with no shared files.
- Each item is one commit, so undoing one item is a `git revert`. A tool for that is left for later.
- The mission's branch outlives the folder, so a lost folder costs one setup, never the work.

## Alternatives considered

- **Keep one worktree per item (today, and Orca's model):** parallel writes, but setup per item and conflicts at the end. Rejected for long work.
- **No worktree, work in the person's project:** setup is solved by default, but the mission and the person write to the same files and git state, and undoing is cleaning their project. Rejected.
- **One mission worktree with parallel writes:** items step on each other's files and commits. Rejected.
- **Executor hooks to follow items:** not needed for this. The stream-json events and `task.done` already give start, tools, changes and end.

## Tests

- Engine (PGlite + fakes): `start_task` with `mode`; queueing (write behind write; any item when there are no slots); the next queued item starts on a write item's end and on a free slot; brief carries folder, branch and base; `worktree_state` transitions; pause on setup failure and on a missing branch; reopen asks for `ensure`.
- Runner (`apps/server/test/runner/mission-runner.test.ts`, temporary git repos): create from `base_sha`; copy only untracked `.env*`; setup from the lockfile and from `agentes.json`; the commit at the end of a write item, including a failed one; `start_sha`/`end_sha`; `ensure` in its three cases; remove on conclude, branch kept.
