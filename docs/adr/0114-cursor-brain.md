# 0114. The Cursor brain: agents think with a person's Cursor plan

- Status: Accepted (2026-11-01)
- Date: 2026-11-01
- Extends: ADR 0032 (computer brains), ADR 0041 (accounts per agent), ADR 0053 §3 (permission profiles), ADR 0059 (AI accounts belong to people; its "fourth CLI brain" amendment)

## Context

Agents already think with a person's Claude plan (Claude Code) and ChatGPT plan (Codex) on the agent's computer. People with a Cursor plan asked for the same. Cursor ships a CLI (`agent`, formerly `cursor-agent`) with a headless print mode. As of 2026-11-01 its documentation says (cursor.com/docs/cli/reference/parameters, …/output-format, …/authentication, …/permissions, …/configuration, cursor.com/docs/mcp):

- `agent -p --output-format stream-json --stream-partial-output` streams one JSON object per line: `system`/`init` (with the chat's `session_id` and the model), `assistant` lines (with partial output, the deltas carry `timestamp_ms` and no `model_call_id`; the other two kinds repeat them), `tool_call` `started`/`completed` keyed by tool (`readToolCall`, `writeToolCall`, `function`…), and a terminal `result` with the whole answer. A failure exits non-zero, writes to stderr and may end with no `result`.
- `--resume <chatId>` resumes a chat; `--model`, `--workspace <path>`, `--mode ask|plan`, `-f/--force`, `--sandbox enabled|disabled`, `--approve-mcps` and `--trust` (headless) exist; `agent models` lists the account's models.
- Sign-in: `agent login` in a browser (`NO_OPEN_BROWSER=1` prints the link), or `CURSOR_API_KEY`. `agent status` and `agent logout`. `CURSOR_CONFIG_DIR` moves the config folder.
- MCP: `.cursor/mcp.json` in the project and its parents, then `~/.cursor/mcp.json`; `${env:NAME}` interpolation in `command`, `args`, `env`, `url` and `headers`.
- Cursor plans include some models (Grok's, as of this date); other models are billed at API prices.

Nothing documents mid-turn input in print mode, a prompt on standard input, usage counts in `result`, or where the sign-in is kept (a community reading says `$XDG_CONFIG_HOME/cursor/auth.json` on Linux and the Keychain on macOS unless `AGENT_CLI_CREDENTIAL_STORE=file`).

## Decision

### 1. A fourth computer brain, `cursor`

`BrainKind` gains `cursor` (no migration: `agents.brain`, `agent_runs.brain` and `machine_accounts.kind` are text checked in code). The engine's `CursorBrain` is the Codex brain with Cursor's checks (`CodexBrain` takes the CLI it drives): runner protocol 36 (`CURSOR_PROTOCOL`), the CLI reported in `hello.executors.cursor`, Cursor's tool switch on (§5). The request, the bridge token, the agent's checkouts (`prepareAgentCode`), the permission profile and the events are shared. A background run keeps nothing alive anyway: each turn is one process.

### 2. The runner: one `agent -p` per turn (`apps/server/runner/brain-cursor.ts`)

- `agent -p --output-format stream-json --stream-partial-output --workspace <cwd> --trust --disable-auto-update --approve-mcps [--model m] [--resume <chat>] <prompt>`, an argv, nothing through a shell. The CLI documents no prompt on standard input, so the prompt is the last argument; the first turn of a chat leads it with the engine's context (Cursor has no system prompt flag), cut in its middle past 120,000 characters (Linux refuses one argument past 128 KiB).
- Our session → Cursor's chat id (`system`/`init`'s `session_id`) lives in `<runner home>/brain/cursor-chats.json`, per account like Codex's threads. A runner that lost it starts a new chat, with the context again.
- Events: the deltas become `text_delta`; a completed Cursor tool call becomes an executed `tool_call` for the transcript (MCP calls are left out: the engine ran ours); `result` ends the turn (its whole answer sent as one delta when nothing streamed, a CLI without partial output); `usage` when `result` carries it, as the plan's (`source: "plan"`, cost zero). A usage limit in the failure is `limit` then `plan_limit`; a sign-in that ended is `not_logged_in` (the account reads as signed out); anything else `cursor_failed`, retryable.
- No live steering: `brain.steer` answers `unsupported` for a Cursor turn, so a person's messages wait for its end, as with `codex exec`.
- Not on Windows yet, like Codex.

### 3. Our tools through Cursor's MCP config

Cursor reads `.cursor/mcp.json` from the workspace and its parents, so the agent's own folder holds our server's entry (`agenteschat_agentes`), rewritten every turn with ours alone: a work turn can write that file, and a server it added would otherwise start on the next turn, outside Cursor's sandbox and outside `--mode ask`. Every value that changes per turn is an `${env:…}` reference: `agentes-runner mcp --run ${env:AGENTES_MCP_RUN}` with the token, socket and runner home from the turn's environment (stdio), or the bridge's URL with `Authorization: Bearer ${env:AGENTES_MCP_TOKEN}` (HTTP). Two turns of one agent in two threads share the file and never race on it. `--approve-mcps` loads it without a prompt, but it approves every server Cursor finds, so it goes only when the turn's folder is the agent's own folder or under it with no other `.cursor/mcp.json` on the way. A turn in a granted folder elsewhere runs without it: no server loads unapproved in print mode, so that turn has neither our tools nor the folder's own servers. `agent mcp enable <name>` approves one server, but where that approval is kept (and whether it is per workspace) is undocumented; the probe on a real machine decides whether our server can be approved alone, and a turn in a granted folder then gets our tools through a per-turn config.

The same rewrite removes `.cursor/hooks.json` and `.cursor/cli.json` from the agent's folder (ADR 0117's egress half: a planted hook or allow rule would run outside Cursor's sandbox and our checks, the class Claude Code's `settingSources: ""` closes). Which project files Cursor's CLI loads in print mode, and whether a checkout's own `.cursor/hooks.json`, `.cursor/rules` and AGENTS.md reach it as instructions rather than data, is left to the same probe; a checkout's files are the person's, so nothing removes them.

### 4. Permission profiles (ADR 0053 §3)

`plan` is `--mode ask` (reads only). `work` is `--force` inside Cursor's sandbox (`--sandbox enabled`). Print mode asks nobody mid-turn, so what the sandbox refuses stays refused, as with `codex exec`: the command policy of ADR 0053 doesn't see Cursor's own commands, only its sandbox holds them. A folder granted outside the turn's workspace isn't writable there.

### 5. The computer's switch

`access.tools.cursor` (protocol 36), on wherever commands are at pairing. Access stored before it has no switch: Cursor follows Codex's there (`effectiveAccess`), and the server reads a missing switch the same way, so no computer gains a coding CLI its owner turned off. `agentes-runner tools enable|disable cursor` works as for the others. The desktop app's Preferences › Tools has no Cursor row yet: there Codex's switch decides both.

### 6. Accounts: a sign-in, or a sealed API key (ADR 0041, ADR 0059)

- An account folder `accounts/cursor/<id>` is Cursor's config folder for its turns (`CURSOR_CONFIG_DIR`, plus `XDG_CONFIG_HOME` and `AGENT_CLI_CREDENTIAL_STORE=file`, so two accounts never share a sign-in in the Keychain); no other key reaches the CLI (`CURSOR_API_KEY` joins the stray sign-ins removed from its environment).
- Sign-in on the computer: `agent login` with `NO_OPEN_BROWSER=1` prints a cursor.com link, the app opens it, and the computer finishes by itself (no code to paste); `agent status` then decides, with the email when it names one.
- Or a Cursor API key: `begin` with `provider: "cursor"` makes the folder and the key pair, the browser seals the key the person made in Cursor's dashboard, and `cursor-key.json` (600) keeps it; turns get it as `CURSOR_API_KEY`. Like a coding plan's key it is signed in until a turn's endpoint refuses it, may think for several of its owner's agents (`loginPerAgent`), and never reaches our server.
- A Cursor sign-in thinks for one agent per account (`LOGIN_PER_AGENT.cursor = false`) until several logins of one account are seen to hold; in system mode it is lent like ChatGPT's.
- Cursor picks nobody: `brain.route` stays Claude Code's and Codex's, and the router never tries a Cursor account.
- Cursor's CLI reports no plan usage to look up: the AI accounts page shows what its turns said, and the computer's own Cursor sign-in has no usage probe.

### 7. Models

The runner lists what `agent models` says for the computer's own sign-in (in `hello.executors.cursor.models`, at most 60, ids as short words), with `inPlan` only where a line says the plan includes it. "Quem pensa" offers them, the plan's own first; with none chosen the CLI's default runs (`defaultBrainModel` is null), and any model name is taken as typed. Where the CLI said which the plan includes, each model reads "In your Cursor plan" or "Billed by Cursor at API prices"; where it said nothing, nothing is claimed. "Automático" leaves the model to the CLI.

### 8. In the apps

Cursor is a plan next to Claude and ChatGPT everywhere a plan is chosen (`PLAN_CHOICES`: Claude, ChatGPT, Cursor, then the coding plans): Connect an AI and the setup's AI step always (dimmed, with why, where it can't run), New agent's plan cards and "Quem pensa" on the agent's page where a computer runs it (or the agent already thinks with it), marked "Testing" like ChatGPT. Its sign-in steps open Cursor's page and wait; "Use a Cursor API key instead" turns them into the key steps. Cursor's official cube (cursor.com/brand) is its mark wherever it is named, in the ink of the theme, as the brand draws it. Both languages, both themes. The engine portrait reuses Codex's terminal until Cursor gets a drawing of its own.

### 9. Installing the CLI

Nothing installs Claude Code or Codex in the core: whoever runs a computer installs them, and the Cloud's image does for its computers. Cursor's CLI is the same: `curl https://cursor.com/install -fsS | bash` (it lands in `~/.local/bin`). `SELF_HOSTING.md` says so. On a Cloud computer the runner runs in system mode, each agent its own system user, so a per-user `~/.local/bin` install is either invisible to the agents' workers or not readable by them. The Cloud image's manifest (in the private Cloud repository) must install it system-wide instead: the installer run with a shared `HOME` (for example `/opt/cursor`), the folder readable by all (`chmod -R a+rX`), and `agent` linked into `/usr/local/bin`. Its runner must be one with protocol 36.

## Risks we accept

- The flags, the stream and the account folder rest on Cursor's documentation and one community reading, not yet a run on a real machine with a real plan: a probe on a Cloud computer comes before the brain leaves "Testing". Where the sign-in isn't kept in the folder after all, two accounts on one computer could share one.
- `--disable-auto-update` keeps a turn from downloading the CLI's self-updates into each agent's home (`CURSOR_CONFIG_DIR`). It is a hidden flag found by reading the CLI's bundle, not documented: it needs confirming on a real machine with that probe. `agent models` and `agent status` run without it until the probe shows whether they check for updates too.
- `--force` inside the sandbox replaces the command policy for Cursor's own commands.
- A first turn's context loses its middle past the argument limit.
- Cursor's plan terms, like the others', make answering other people a gray area; the same switch and words apply (ADR 0059 §5).

## Consequences

- Runner protocol 36; the server never sends `kind: "cursor"` (turns or accounts) to an older runner.
- A computer whose runner is older shows Cursor as "Update the agentes.chat program".
- Tests: a fake Cursor CLI (`apps/server/test/runner/fake-cursor.mjs`) for the runner's turns, sign-ins and keys; the engine's brain, availability and options against a fake link.

## Alternatives considered

- **Cursor's ACP server mode (`agent acp`)**, which might take input mid-turn: hidden in the CLI's help and undocumented; print mode first.
- **Cursor's cloud agents through its API**: hands whole tasks to Cursor's machines, not a turn on the agent's computer with our tools; a separate decision.
- **Writing the context into a rules file per chat** instead of the prompt: avoids the argument limit but leaves files in the person's repositories; kept as the upgrade if real contexts reach the limit.
