# 0132. The OpenCode brain: agents think with OpenCode's CLI, its free tier or an OpenCode key

- Status: Accepted (2026-11-02). Amended 2026-11-03: §7 (free variants beside their paid models, and where they run). Amended 2026-11-06: §6 (the free tier is a choice, never a listed sign-in)
- Date: 2026-11-02
- Extends: ADR 0032 (computer brains), ADR 0041 (accounts per agent), ADR 0053 §3 (permission profiles), ADR 0059 (AI accounts belong to people), ADR 0114 (the Cursor brain, which this mirrors), ADR 0118 (long work pauses near a limit)

## Context

OpenCode serves its Zen models, and among them a free tier (`big-pickle`, `beam-free`, `deepseek-v4.1-flash-free`, `flint-40b-free`, `glm-5.3-flash-free`, `jev-1.13-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free` as of 2026-11-02), only to its own CLI: "Free-tier chat models require OpenCode" (opencode.ai/docs/zen). OpenCode Go already thinks through Claude Code as a coding plan (its Anthropic endpoint and an `oc_sk_` key), but the free tier and Zen's pay-as-you-go models can't reach an agent that way. The owner decided on a fifth computer brain that runs OpenCode's CLI itself, like Claude Code, Codex and Cursor.

What the CLI does, read in its source at the `v1.19.5` tag (`packages/opencode/src/cli/cmd/run.ts`, `…/models.ts`, `…/config/config.ts`, `…/provider/provider.ts`, `…/auth/index.ts`) and opencode.ai/docs/cli, …/config, …/mcp-servers, …/permissions (2026-11-02):

- `opencode run --format json [--model provider/model] [--session <id>]` prints one JSON object per line: `step_start`, `text` (a whole text part, once it ends: no smaller deltas), `tool_use` (a tool part `completed` or `error`, with `tool`, `callID`, `state.input`, `state.output` or `state.error`), `step_finish` (`part.tokens`: `input`, `output`, `reasoning`, `cache.read`, `cache.write`, and `part.cost`), `error` (`error.data.message`); every line carries `sessionID`. A failure exits 1. A piped standard input becomes the message (or is appended to the argument).
- In `run`, a permission that would ask is rejected and the model is told to go on without it (`--auto` approves instead); explicit `deny` always holds.
- `opencode models` prints `provider/model`, one per line, OpenCode's providers first. With no key for the `opencode` provider, the CLI keeps only its models with no input cost and calls them with the key `public`: the free tier needs no sign-in.
- Config is merged in order: global (`$XDG_CONFIG_HOME/opencode`), `OPENCODE_CONFIG`, the project's `opencode.json` and `.opencode/` folders, `~/.opencode` and `OPENCODE_CONFIG_DIR` (each read for settings, `{plugin,plugins}/*.{ts,js}`, agents, modes, tools and commands), `OPENCODE_CONFIG_CONTENT`, then the managed config folder, `OPENCODE_PERMISSION` and an OpenCode console organization's remote config. The merge is deep and plugin lists are joined, so a later config never removes what an earlier one added. `OPENCODE_DISABLE_PROJECT_CONFIG` skips the project's files and folders. `{env:NAME}` is substituted in all of them. Sign-ins live in `$XDG_DATA_HOME/opencode/auth.json`; `provider.opencode.options.apiKey` in the config is an OpenCode key too.
- MCP servers: `mcp.<name>` with `type: "local"` (`command` as an array, `environment`) or `type: "remote"` (`url`, `headers`); their tools are named `<name>_<tool>`.
- OpenCode has no sandbox: its permissions (`edit`, `bash`, `task`, `external_directory`, `*`…) are all that hold it.

`opencode serve` (an HTTP server with server-sent events) streams finer deltas and takes messages mid-turn, but would need a process per agent kept alive, a port and a password on the agent's computer.

## Decision

### 1. A fifth computer brain, `opencode`

`BrainKind`, `AccountKind` and `access.tools` gain `opencode` (no migration: `agents.brain`, `agent_runs.brain` and `machine_accounts.kind` are text checked in code). The engine's `OpencodeBrain` is the Codex brain with OpenCode's checks (`CliBrainSpec`, as Cursor's): runner protocol 39 (`OPENCODE_PROTOCOL`), the CLI reported in `hello.executors.opencode`, its switch on (§5). The request, the bridge token, the agent's checkouts, the permission profile and the events are shared with Codex and Cursor.

### 2. The runner: one `opencode run` per turn (`apps/server/runner/brain-opencode.ts`)

- `opencode run --format json [--model m] [--session s]`, an argv with no prompt in it; the message goes on standard input, so there is no argument limit. A new session's message leads with the engine's context (OpenCode has no system prompt flag). The `model` must be `provider/model` (the runner refuses anything else, the engine too).
- Our session → OpenCode's session (`sessionID`) lives in `<runner home>/brain/opencode-sessions.json`, per account, like Codex's threads. A runner that lost it starts a new session, with the context again.
- Everything we set rides on `OPENCODE_CONFIG_CONTENT`: our MCP server (`agenteschat_agentes`, stdio `agentes-runner mcp --run {env:AGENTES_MCP_RUN}` with the token, socket and runner home as `{env:…}`, or the bridge's URL with the token as a bearer), the permissions (§4), `share: "disabled"`, `autoupdate: false`, and an account's key as `provider.opencode.options.apiKey: "{env:OPENCODE_API_KEY}"`. `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps a checkout's (or an earlier turn's) `opencode.json`, agents and plugins out (ADR 0117's egress half), and `OPENCODE_DISABLE_AUTOUPDATE=1` keeps a turn from updating the CLI. Since our config can't take away what another adds, the others are kept empty, as Claude Code loads none of the owner's settings (`settingSources: ""`, ADR 0117): the global config folder (`XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR`) is `<runner home>/brain/opencode-config`, emptied before each turn of everything but OpenCode's own packages (`node_modules`, `package.json`, `bun.lock`), so what a `work` turn writes there never reaches a later (`plan`) turn; `OPENCODE_PERMISSION`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` aren't inherited; a `~/.opencode` holding settings, plugins, agents, modes or tools refuses the turn with a message saying what to move (only a person should remove it). `GH_CONFIG_DIR` keeps pointing at the user's own `gh` folder, since the agent's commands inherit `XDG_CONFIG_HOME`. Left as they are: the computer's managed config folder (root's) and a console organization's config (only with a console sign-in on the computer). Nothing is written in the person's folders.
- A session OpenCode no longer has (`--session` answers "Session not found", say after an agent's home was reset; its sessions live in the agent's or the account's data folder, our map in the runner home) is dropped from the map and the turn runs once more as a new session, with the context.
- Events: each `text` part is a `text_delta` (a paragraph apart from the one before); a `tool_use` that ended is an executed `tool_call` for the transcript, ours left out (the engine ran them); the `step_finish` tokens add up to one `usage` at the end, the input with the cache read and written; `error` fails the turn. A usage or rate limit, a 429, too little balance is `limit` then `plan_limit`; a 401 or a refused key `not_logged_in` (the account reads as signed out); anything else `opencode_failed`, retryable; the CLI missing `opencode_missing`. A clean exit with no error is `done` with the text streamed.
- No live steering: `brain.steer` answers `unsupported` for an OpenCode turn, so a person's messages wait for its end (as `codex exec` and Cursor's). Not on Windows yet.
- Detection: `opencode --version` (semver, else it isn't OpenCode's) and `opencode models`, at most 60, `free` on the free tier (§7).

### 3. Usage and limits (Model Gateway, ADR 0118)

A turn's usage is recorded like every computer brain's: tokens on the run with `org_id` and `agent_id`, `source: "plan"`, cost zero for us. The free tier costs nobody anything; a key's spend is billed by OpenCode to the person's console, never to the workspace's budget. A `plan_limit` marks the account (or the computer's own OpenCode) limited until its reset, and long work pauses near it as ADR 0118 says; OpenCode reports no usage windows, so only a refused turn says it.

### 4. Permission profiles (ADR 0053 §3)

`plan` is `{ "*": "allow", edit: "deny", bash: "deny", task: "deny", external_directory: "deny" }`: reads, searches and our tools. `work` is `{ "*": "allow", external_directory: "deny" }`: everything inside the turn's folder, with no sandbox (the agent's OS user in system mode is the boundary, as for its commands). The command policy of ADR 0053 doesn't see OpenCode's own commands. A folder outside the turn's isn't reachable, so the shared folder (ADR 0115) isn't offered to an OpenCode agent's prompt, as for Cursor.

### 5. The computer's switch

`access.tools.opencode` (protocol 39), on wherever commands are at pairing. Access stored before it has no switch: OpenCode follows Codex's there, on the runner (`effectiveAccess`, `accessToStore`) and on the server, so no computer gains a coding CLI its owner turned off. `agentes-runner tools enable|disable opencode` works as for the others; a computer's Tools in the web app lists it. The desktop app's Preferences have no OpenCode row yet.

### 6. Accounts: a sealed OpenCode key, or none

- An OpenCode account is its key alone: `begin` with `provider: "zen"` makes the folder and the key pair, the browser seals the key the person made in OpenCode's console (opencode.ai/console), and `opencode-key.json` (600) keeps it. There is no browser sign-in: `opencode auth login` only asks for the same key. A key thinks for several of its owner's agents (`loginPerAgent`), is signed in until a turn's provider refuses it, and never reaches our server.
- The account's folder is all of OpenCode's XDG folders for its turns (data, config, cache, state: sessions and sign-ins apart per account); no other OpenCode key reaches the CLI (`OPENCODE_API_KEY` and `OPENCODE_AUTH_CONTENT` join the stray sign-ins removed from its environment).
- With no account, the computer's own OpenCode thinks: whatever its owner signed in there, or the free tier with nothing. On a computer someone connected, that is theirs and thinks only for their agents (ADR 0059 §3). On a computer nobody connected (a Cloud computer), nobody signs in at its terminal, so its OpenCode is the free tier alone and thinks for anyone's agents: the engine skips both own-sign-in checks there for OpenCode, and the AI accounts list shows it as ready there. To keep it the free tier, the engine marks such a turn `freeTier` and sends it only with an `opencode/…` model (another is `not_logged_in`); the runner refuses another model, removes every stray key from the CLI's environment (the runner service's own `ANTHROPIC_API_KEY` and the like) and adds `enabled_providers: ["opencode"]`, so no key the computer holds thinks for anyone's agent.
- *Amended 2026-11-06:* the free tier needs no sign-in, so `/ai-accounts` no longer reports it under `own`: on every computer with the CLI, that read as a connected account ("Seus planos", the phone's "Pensam com"). `brains.opencode` with `canAdd` says where it can think. In "Quem pensa" and Connect an AI it stays a choice, named "OpenCode's free models", never an account; only a real OpenCode key (or OpenCode Go, on Claude Code) lists as the person's.
- OpenCode picks nobody: `brain.route` stays Claude Code's and Codex's.
- Provider keys (Anthropic's, OpenAI's…) through OpenCode are not offered: the workspace's own keys already think through the Model Gateway, and a computer's owner can still sign the CLI in to any provider on their own computer.
- OpenCode Go stays a coding plan on Claude Code (`provider: "opencode"`).

### 7. Models

"Quem pensa" offers what `opencode models` listed on the agent's computer (`provider/model`), the free tier first with a "Free" mark, else, when it listed nothing, OpenCode's free tier from a static list (`OPENCODE_FREE_MODELS`, `isOpencodeFreeModel`: `opencode/…-free`, or listed). With none chosen the CLI's own default runs (`defaultBrainModel` is null); any `provider/model` is taken as typed (a key's paid Zen models, which the computer's own CLI may not list).

*Amended 2026-11-03:* a listing with a key holds OpenCode's paid models and their free variants (`opencode/glm-5.3-flash` and `opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash` and `opencode/deepseek-v4.1-flash-free`, as OpenCode's console shows them). Each free variant now sits right after its paid model (the `-free` id of a listed model), the other free ones still first; ids and labels stay OpenCode's, each free one marked "Free" and, like every computer brain's turn, recorded at zero cost (§3). They answer only OpenCode's CLI, so OpenCode Go's key, which thinks through Claude Code, never lists them: its models' picker (the agent's page on the web and the phone, Quem pensa's Automático row of the plan) says in one line that other free models run through OpenCode on the agent's computer (`brain.opencodeFreeHint`). Go's own free models (`beam-free`, `iceman-contributor-free`, in Go's live list) stay on Go's list.

### 8. In the apps

OpenCode is a plan choice (`zen`, not to clash with the coding plan `opencode`) next to Claude, ChatGPT and Cursor: in Connect an AI and "Quem pensa" where a computer runs it (or the agent thinks with it), with no "Testing" label (no provider carries one); in New agent's list on such a computer. Its mark is OpenCode's own. Adding an account is the key steps (its console, the key), with a line that the free models need none. Web and phone; every new string in all fourteen languages. The engine portrait reuses Codex's terminal.

### 9. Installing the CLI

Nothing installs a coding CLI in the core: whoever runs a computer installs OpenCode's (`npm install -g opencode-ai@1.19.5`, or opencode.ai/install); `SELF_HOSTING.md` says so. In system mode the CLI must be where every agent's user can run it. The Cloud image's manifest (in the private Cloud repository) pins it system-wide: the `v1.19.5` release asset `opencode-linux-x64.tar.gz` (`sha256:588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a`; `opencode-linux-arm64.tar.gz`, `sha256:fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b`, on arm64) from github.com/anomalyco/opencode, its `opencode` binary installed as `/usr/local/bin/opencode` (0755, owned by root), with a runner on protocol 39. The CLI fetches more at run time into each agent's home, so the image also needs: `ripgrep` from the distribution's packages on the PATH (else OpenCode downloads its own `rg` from GitHub); nothing for language servers, since every turn sets `OPENCODE_DISABLE_LSP_DOWNLOAD=1`. Still fetched, unpinned: `@opencode-ai/plugin` (bun, into the runner's OpenCode config folder, kept between turns) and models.dev's model list (kept on: with `OPENCODE_DISABLE_MODELS_FETCH` the CLI would know only its built-in list and refuse newer Zen models that `opencode models` offered).

## Risks we accept

- The stream, the config merge and the free tier's key-less calls rest on the CLI's source at one tag and its documentation, not yet a run on a real machine: a probe on a Cloud computer is still due. The JSON events are not a documented contract; the pin keeps them stable until the next deliberate upgrade.
- No sandbox: in `work`, OpenCode runs anything as the agent's user inside the turn's folder; `plan` holds only by OpenCode's own permission checks.
- Text arrives a paragraph at a time, not word by word.
- A computer's own OpenCode on a computer someone connected may carry its owner's sign-ins; it thinks only for their agents.
- OpenCode's terms on the free tier (it may train on what it is sent) are the person's and the workspace's to accept; nothing here changes them.

## Consequences

- Runner protocol 39; the server never sends `kind: "opencode"` (turns or accounts) to an older runner, which shows OpenCode as "Update the agentes.chat program".
- Tests: a fake OpenCode CLI (`apps/server/test/runner/fake-opencode.mjs`) for the runner's turns, sessions, keys, limits and redaction; the engine's brain, availability, options and free tier; the clients' plan choice and picker.

## Alternatives considered

- **`opencode serve` with its SSE events**: word-by-word text and messages mid-turn, at the cost of a long-lived server per agent with a port and a password on the computer; `run` first, the server as the upgrade if steering or finer streaming are missed.
- **Zen's API from the Model Gateway**: refused for the free tier (OpenCode-only), and the paid models would bill the workspace rather than the person's console.
- **Writing an `opencode.json` in the agent's folder** (Cursor's way): `OPENCODE_CONFIG_CONTENT` needs no file and wins over any other config.
