# 0025. Connected computers, provider-agnostic computers, and binary files in the Drive

- Status: Accepted. Superseded in part by ADR 0077 (2026-10-28): §1's lifecycle half of `SandboxProvider`, §2's server-side upload fallback and, in §6, a null `agents.machine_id` as the cloud computer (now no computer), the `cloud` target, the organization's network mode and the tools only with Daytona
- Date: 2026-10-15

## Context

An agent's computer (ADR 0021) is always a Daytona sandbox we create. People want agents to work on machines they already have (a VM in any cloud, a server at the company, a laptop), with their own tools installed (for example Claude Code signed in to a personal plan), and to bring what they produce into the Drive. The Drive only stores text kinds (`document`, `table`, `diff`, `html`, `diagram`) and `export_file` reads at most 5 MB through the model's tool path.

## Decision

### 1. A computer is a lifecycle plus a channel

`SandboxProvider` is split in two contracts (`packages/adapters/src/sandbox.ts`):

- **`ComputerLifecycle`**: `create`, `get`, `ensureStarted`, `stop`, `destroy`, `setNetwork`.
- **`ComputerChannel`**: `exec`, `execStream?`, `writeFile`, `readFile`, `listFiles`, and the new `pushFile?`.

`SandboxProvider = ComputerLifecycle & ComputerChannel` keeps Daytona and the fake unchanged. Tools receive the computer they act on as `{ id, provider }`, never a single global provider, so one server can serve Daytona computers and connected machines at once.

Combinations:

| Computer | Lifecycle | Channel |
|---|---|---|
| Daytona (today) | Daytona API | Daytona toolbox API |
| Connected machine (this ADR) | none: it is on when its runner is online | our runner over WebSocket |
| A VM in any cloud (later) | that cloud's API (start/stop) | our runner, baked into the image and paired once |
| E2B, Modal, Fly… (later) | their API | their API |

A new provider is a lifecycle adapter; the runner already covers the channel.

### 2. `pushFile`: the machine sends the bytes, the model never sees them

`pushFile(id, path, target)` asks the computer to send a file (or a folder, zipped) straight to a one-time upload URL of ours. `target` is `{ url, uploadId, maxBytes }`; the runner authenticates the PUT with its own machine token, so no storage credential ever leaves the server.

Channels without `pushFile` (Daytona) fall back on the server: a folder is zipped inside the computer with `python3 -m zipfile`, then the server reads the file with `readFile` and stores it itself. Both paths end in the same `completeUpload`.

### 2a. `pullFile`: the machine fetches the bytes (protocol 47)

Addendum 2026-11-05. Chat and the Drive take files up to 50 MB, while a `write` carries 5 MB (base64 in one JSON frame), so a file people could send couldn't reach the agent's computer. Past that size the computer now fetches the file itself, the mirror of `pushFile`.

- **Who decides.** The tool's own read check runs first. `copyToComputer` (`file-pulls.ts`) then makes a `machine_file_pulls` row naming that machine, that stored object (so that version) and an expiry of 5 minutes, and sends op `pull` with the URL, size and SHA-256. Small files stay on `write`. Every stored file goes through it: `import_file`, `read_skill_file`, `run_skill_script`.
- **One fetch.** `GET /api/machines/pulls/{id}` takes the machine token and deletes the row as it answers, in one statement, so it holds across replicas and a second fetch finds nothing. A row names its own object: nothing in the request can point at another file, and used, expired, unknown and another machine's pulls get the same 404.
- **Storage.** The answer streams from `BlobStore.stream` (S3 and disk). Postgres storage has no stream and is read whole, as its downloads are. The server streams from S3 rather than handing out a signed URL, so a computer only ever talks to our host, which it can always reach.
- **On the computer.** `write`'s path rules are one function (`writeTarget`), so `pull` can't drift from them. The bytes go to a temporary file beside the target and rename over it once the size and hash match, so a cut connection leaves the target as it was. The limit is 10 minutes, which 50 MB fits at about 0.7 Mbit/s. A skill's file has no recorded hash and is checked by size.
- **System mode (ADR 0057).** As with `push`, no worker holds the token: root makes the request, to the URL in the server's request and never one a worker names, and the bytes cross the link in pieces, each waiting for the one before it to leave for the worker's pipe. Root's request also takes the host's own route, so it doesn't pass through whatever the workspace routes agents' traffic through, and doesn't count as theirs.
- **Older runners.** `pullRefusal` reads the protocol. Up to 5 MB nothing changes. Past that the agent reads the cause and the way out, and `run_skill_script` still runs, naming what stayed behind.
- **What a failure says.** The agent reads why a pull stopped, never a fetch's own words or a proxy's page: those name the server's address.
- `read_file` keeps its 5 MB: what it reads goes into a model's context.

### 3. Binary files in the Drive

A new artifact kind `file` (migration adds the enum value): any bytes, with the original name, MIME type, size and SHA-256 in the version row.

- Limit: 50 MB per file version (`ARTIFACT_LIMITS.fileBytes`).
- Always `untrusted`: downloaded as an attachment with `nosniff`, never rendered on the app's origin. The app previews only raster images (`png`, `jpeg`, `gif`, `webp`) and PDF from a download URL, and plays videos (`mp4`, `webm`, `mov`) in its own player straight from the download, which answers `Range` requests (a media element never runs the file as a page); `svg` and everything else is download-only.
- Search indexes the title and file name only.
- `read_artifact` returns the metadata (and the text of small UTF-8 text files); `import_file` copies the bytes back into a computer.
- Versions work like other kinds (`upload_file` with `artifact_id`).

### 4. `upload_file` tool

`upload_file(path, title?, artifact_id?, note?)`, scope `sandbox:run` (same as `export_file`). A file goes as is; a folder becomes `<name>.zip`. The tool creates an `artifact_uploads` row (pending, bound to org, agent, run and computer, expires in 10 minutes), asks the channel to push, waits for completion (pub/sub signal plus a database poll, so it works across replicas) and answers with the artifact id and version. `export_file` stays for text that should become a native kind.

### 5. Connected machines and the runner

**Runner.** `apps/server/runner` (inside the server package, so no new workspace changes the frozen lockfile): one JavaScript bundle (`agentes-runner.mjs`) that runs on Node 22+ or Bun on Linux, macOS and Windows. It is built with the web app and served at `/runner/agentes-runner.mjs`; `GET /api/machines/install.sh` installs it.

- `pair --server <url> --code <code> [--dir <workspace>] [--no-exec]` trades a pairing code for a machine token and writes `~/.agentes-runner/config.json` (mode 600).
- `start` connects and stays connected (reconnects with backoff). `service` installs a systemd user unit or a launchd agent.

**Pairing.** A member creates a pairing (`POST …/machines/pairings`, a name): a code `XXXX-XXXX`, single use, 10 minutes, stored hashed. `POST /api/machines/pair` (no session, rate limited) trades it for a machine row and a token `agm_<32 random bytes, base64url>`, stored as SHA-256. Deleting the machine revokes the token and closes its socket at once.

**Connection.** Outbound WebSocket to `/api/machines/connect`: no public IP, port or tunnel on the machine. The first frame is `hello` with the token (not a header: Node's WebSocket client can't set one); no valid `hello` in 10 s closes the socket. Then the server sends `welcome`, pings every 25 s, and marks the machine offline when the socket closes. `machine.status { machineId, online }` goes to the organization.

**Protocol.** `packages/adapters/src/machine-protocol.ts` (shared by server and runner): `request { id, op }` with `exec`, `read`, `write`, `list`, `push` (protocol 3 adds `secret`, ADR 0027; protocol 4 adds `task.*`, section 5a; protocol 5 adds `mcp.call`/`mcp.result` for missions, section 5b; protocol 6 adds `task.output`, section 5c); `output` frames while a command runs; `result { id, ok, data | error }`; `cancel { id }`. Files travel base64 inside JSON for `read`/`write` (5 MB); uploads always use `push`.

**On the machine.**
- Every path is relative to the workspace folder chosen at pairing (default `~/agentes`); `..` and absolute paths are refused, and symlinks that leave the workspace are refused for reads, writes and uploads.
- Each agent works in its own folder of the workspace, `<handle>-<first 8 of id>` (protocol 2: every request carries `agent: { id, handle }`). The runner creates it on first use, treats it as that request's workspace (`/workspace` for the agent, `cwd` of its commands), and finds it by the id suffix after a rename. Many agents can share one computer without seeing each other's files through the file tools; a shell command can still `cd` anywhere the OS user can. The server refuses tools on runners older than protocol 2 (they would ignore `agent`), and `agentes-runner update` replaces the bundle and restarts the service without pairing again.
- Commands on a connected computer may run up to an hour (`machineMaxTimeoutSeconds`; ours stay at 10 min): it costs us nothing and tools like Claude Code take minutes. `run_code` tells the agent to drive Claude Code with one session per conversation (`claude -p --session-id <thread id>` the first time, `--resume <thread id>` after), so it keeps context across turns; sessions are per folder, so each agent's are its own.
- Commands run as the user that runs the runner, with `cwd` in the workspace. A shell command can reach anything that user can, so the install guide recommends a dedicated OS user. `--no-exec` turns commands off (files and uploads only); `run_code` then says so.
- The runner never receives secrets from us. Whatever the machine already has (a Claude Code login, SSH keys) stays there and is used under the machine owner's responsibility.
- **Admission** (added 2026-10-27). A brain turn starts only while the computer has room for one more: `MemAvailable` (`/proc/meminfo`, the reader desktops use), less 0.6 GB for each turn admitted in the last 30 s (a new CLI takes seconds to grow, so the reading doesn't show it yet), must leave 1.5 GiB free, the floor desktops and headed browsers keep (ADR 0065 §2). The floor is above the biggest thing a turn grows into (a computer-use agent, about 1.4 GB with its screen and browser), so the turn admitted last still fits whole. A turn without room is refused `no_slot` ("short of memory"), and the server waits for room (ADR 0032, "Busy computer"). Where the memory isn't known (macOS, Windows) at most 8 turns run at once. Every other request counts only toward a ceiling of 128 per connection (`busy` beyond it, never for a person's view of an agent: `stream.open`, `desktop.session.status`, `desktop.session.stop`), which bounds a flood; a turn's own tool calls never wait for room. Background tasks keep their own count (`maxConcurrentTasks`, 5a): a mission item refused for room would wait in its queue, which moves when a task ends or the computer comes back, never when room frees.
  - This replaces 8 requests at once per connection, from the runner's first version (people's own computers, quick commands). A brain turn held its request for the whole turn, so 8 turns filled a computer of any size, and their own tool calls were refused. Now a bigger computer takes more turns at once; with nothing else running (its base about 0.9 GB):

    | Computer | Coding turns at once (0.6 GB each) | Computer-use agents at once (1.4 GB each) |
    | --- | --- | --- |
    | 8 GB | about 9 | about 4 |
    | 16 GB | about 22 | about 10 |
    | 32 GB | about 48 | about 21 |

  - No protocol change: the Claude Code brain of older servers already read `no_slot` on a turn as `busy`, and newer servers read an older runner's `busy` the same way.
  - The runner keeps no order and doesn't know who started a turn: the engine keeps the line (people first, agents' turns spaced, only the head asks again; ADR 0032, "Calm waits", 2026-11-02). No protocol change.
  - **Idle memory is given back first** (added 2026-11-02). Warm Claude Code processes waiting between turns (110–210 MB each, plus a 14 MB MCP bridge) used to count against room while nothing closed them for a turn. Now a turn without room first closes idle warm CLIs, one at a time, least recently used first, and checks room again after each one exits, for at most 5 s (`RECLAIM_MS`). Only then is it refused `no_slot`. The waiting turn's own session closes last, only when nothing else can (the turn would start it again at once), and a turn canceled while it waits stops closing at once. A CLI in the middle of a turn, or one holding the agent's work, never closes this way. "Holding work" means a task in the background (a dev server or a watcher, from Claude Code's `task_*` events) or a turn the CLI runs on its own. In system mode root first asks every worker which CLI it would close and when that one was last used (`brain.reclaim` with `peek` / `brain.reclaimed`, link frames only), then asks them to close in that order, oldest first, until one did: one CLI per round across all agents, not one per agent. Where memory isn't known, room is a count of turns, so nothing is closed. The server protocol doesn't change.

**Across replicas.** The replica holding the socket executes requests. Another replica writes the request to `machine_rpc` and signals the holder through pub/sub; the reply comes back the same way (Postgres `NOTIFY` payloads are too small for file bodies). Live output streaming works only on the replica holding the socket; elsewhere the command reports its output at the end.

### 5a. Protocol 4: background tasks

Runner protocol 4 (`TASKS_PROTOCOL`, runner 0.4.0) adds work that outlives a request, the socket and the runner itself (ADR 0029 sections 4 and 5):

- **Ops.** `task.start { taskId, agent, executor: claude | codex | shell, command? | prompt?, session?, resume?, cwd?, branch?, maxSeconds? }` → `{ taskId, pid, startedAt, cwd, branch?, command }`; `task.status { taskId? }` (this agent's tasks when omitted); `task.cancel { taskId }`. Runner → server: `task.event { taskId, kind: line | files | progress, line?, files?, seconds? }` (throttled to one line every 2 s, a progress beat every 30 s) and `task.done { taskId, exitCode | null, signal?, seconds, result?, lastLine?, files?, canceled?, timedOut?, interrupted?, session? }`. Server → runner: `task.ack { taskId }`. `hello` carries `tasks: [{ taskId, agentId, status: running | done | interrupted, pid?, startedAt, endedAt?, exitCode?, seconds?, lastLine?, files? }]` from the journal. The server refuses task ops on older runners ("update it with `agentes-runner update`") and the agent gets no task tools there.
- **Detached under a wrapper.** The runner writes `<runner home>/tasks/wrap.mjs` (plain JavaScript) and starts it with its own runtime, `detached` (own process group) and `unref()`ed, with the agent's secret env (ADR 0027) in its environment only. The wrapper starts the command through the platform shell, with stdout and stderr appended to `tasks/<taskId>/stdout.log` and `stderr.log` and the prompt (for executors) as stdin (`stdin.txt`), so no prompt is ever quoted for a shell. It touches `alive` every 15 s, enforces `maxSeconds` (default 4 h, cap 24 h), stops the command's whole group on SIGTERM or when a `cancel` file appears (the way that also works on Windows, through `taskkill /T /F`), and writes `exit.json` (atomically) with the exit code, signal and reason (`canceled`, `timeout`). A pid alone can't say "still running" after a reboot (pids are reused); a pid that answers plus a fresh `alive` can. No `exit.json` and the wrapper gone means **interrupted**.
- **Journal.** `tasks/journal.json` (written whole, then renamed) lists every task (agent, executor, command, folder, pid, state, last line, files, the `task.done` payload and whether the server acknowledged it). A new runner process loads it, keeps watching running tasks, and finishes the ones that ended meanwhile. `task.done` is sent once and again after each reconnect until `task.ack`; acknowledged tasks are forgotten (with their logs) after 7 days.
- **Executors.** `claude -p --output-format stream-json --verbose --permission-mode acceptEdits` plus `--session-id <s>` or `--resume <s>`: the runner resumes when Claude Code has that session in the task's folder (`~/.claude/projects/<folder with every non-alphanumeric as ->/<s>.jsonl`, or `$CLAUDE_CONFIG_DIR`), and uses the server's hint when it can't tell. The watcher turns its events into a human last line ("Editing src/app.ts", "Running: npm test", the first line of a message), the files its edit tools touched, and the final `result`. Codex runs as `codex exec --json` (see ADR 0029, "Codex"); its JSONL events become the same lines, files and result. `shell` sends its last plain lines. Everything that leaves the machine is redacted like exec output.
- **Worktrees.** With `branch`, the folder must be a git repository: `git worktree add -b <branch> <agent folder>/.worktrees/<taskId>`, with `.worktrees/` added to the repository's `info/exclude`.
- **Slots and sleep.** At most `maxConcurrentTasks` (config, default 3) running per machine: beyond that `no_slot` (the tool says `task.no_slot`). On macOS a `caffeinate -i -w <runner pid>` child holds off idle sleep while at least one task runs.
- **Services.** The systemd unit has `KillMode=process` and the launchd agent `AbandonProcessGroup`, so `agentes-runner update` (a service restart) doesn't kill running tasks.

### 5b. Protocol 5: the `agentes` MCP server of mission tasks

Runner protocol 5 (`MISSION_PROTOCOL`, runner 0.5.0) lets a task work for a mission (ADR 0029):

- **`task.start { …, mission: { id, rules } }`.** For an executor task the runner makes a random per-task token (in the journal and `tasks/<taskId>/mcp-token`, mode 600) and gives the executor our MCP server. Claude Code: `--mcp-config tasks/<taskId>/mcp.json` (one stdio server `agentes`: this runtime running `agentes-runner mcp --task <taskId>`, with `AGENTES_MCP_TOKEN` and `AGENTES_MCP_SOCKET` in its env), `--allowedTools mcp__agentes` (`-p` can't ask for permission) and `--append-system-prompt <rules>`. No `--strict-mcp-config`: the person's own MCP servers stay. Codex: repeatable `-c mcp_servers.agenteschat_agentes.*` overrides (token, socket and runner home passed by name through `env_vars`, never on the command line), and the rules as `developer_instructions` on the first turn (ADR 0029, "Codex"). The rules and paths are single shell arguments (plain characters only for the rules).
- **`agentes-runner mcp --task <id>`**: a small stdio MCP server (JSON-RPC lines; `initialize`, `tools/list`, `tools/call`, `ping`; no SDK). Each call goes over a local endpoint of the running daemon: `<runner home>/mcp.sock` (a named pipe `\\.\pipe\agentes-runner-<hash>` on Windows), one JSON line per request with `{ taskId, token, tool, args }`. The daemon checks the token against the task (constant-time), that the task still runs, and the tool name, then relays.
- **Frames.** Runner → server `mcp.call { callId, taskId, tool, args }` (args ≤ 64 KB); server → runner `mcp.result { callId, ok, text | error }`. Calls in flight fail when the connection drops (the executor may retry); a call waits at most 6 minutes (uploads).
- **Server.** The replica holding the socket runs the call without blocking other frames: the task must be this machine's and belong to an open mission on this machine; the input is validated against the tool's JSON Schema (`MISSION_MCP_TOOLS` in `machine-protocol.ts`, shared). Older runners get no mission features ("run agentes-runner update").

### 5c. Protocol 6: a task's output

Runner protocol 6 (`TASK_OUTPUT_PROTOCOL`, runner 0.6.0) adds what "Ver saída" needs (ADR 0029):

- **`task.output { taskId, tail }`** → `{ lines, truncated }`: the last `tail` (≤ 200) human lines of the task, read from the end of `stdout.log` (512 KB) and then `stderr.log`, parsed like the watcher does (Claude Code's `stream-json` becomes "Editing src/app.ts", never raw JSON) and redacted with the agent's secrets. Only the request's agent's tasks.
- **`task.event { …, prUrl? }`**: the first pull (or merge) request URL the task's output shows (a Claude Code tool result such as `gh pr create`, its answer, a plain line), sent once.
- **Compatibility.** A runner ignores a request whose op it doesn't know (no reply), so the server asks `task.output` only of runners at protocol 6 or later; older ones get the lines the server kept (`machine_tasks.recent_lines`).

### 5d. Protocol 7: coding CLIs and the permission profile

Runner protocol 7 (`EXECUTORS_PROTOCOL`, runner 0.7.0):

- **`hello.executors`**: `{ claude?: { version }, codex?: { version } }`, the CLIs on the runner's PATH (`<cli> --version`, first line, best effort, cached 10 min; empty with `--no-exec`). The server keeps it in `machines.executors` with `detectedAt`; missions offer only what the computer has (ADR 0029, "Executor agent").
- **`task.start.mission.mode`** (`plan | work`) and **`branchPrefix`**: Claude Code gets a generated `--settings` file with what it may run without asking (`plan`: read only, `--permission-mode dontAsk`; `work`: git on the mission's branches, tests and builds; merges, other pushes and deploys denied). Older servers send no mode: `work`.
- **MCP calls** carry arguments with the agent's secrets masked, and paths resolved against the task's folder (`@folder/…` for elsewhere in the agent's folder; outside: refused).
- The systemd unit sets `Environment=PATH=` from the install-time PATH, like the launchd plist.

### 6. Which computer an agent uses

`agents.machine_id` (nullable). Null: the Daytona computer (when the server has one). Set: that connected machine.

- Who sets it: an admin (`manage_agents`), or the agent's owner when they also paired that machine.
- `GET …/agents/{id}/computer` adds `target: { kind: "cloud" } | { kind: "machine", machineId, name, online }`.
- A connected machine costs us nothing: no `usage_records`, no daily minutes, no budget check. Commands and uploads are audited (`machine.exec`, `artifact.uploaded`).
- The org's network mode and the git proxy setup (ADR 0024) do not apply: we don't control that network, and we never rewrite a person's global git config. `computer_status` tells the agent it is on "<name>" (online or offline).
- Offline machine: tools fail with "the computer <name> is offline" and the agent tells the people. We can't power on a machine we don't control (a cloud lifecycle adapter will).
- Tools exist when the server has Daytona or when the agent has a machine, so a self-hosted server without Daytona can still give agents computers.

### 7. API

- `GET /organizations/{orgId}/machines`: id, name, online, lastSeenAt, hostname, os, arch, runner version, exec allowed, paired by, agents using it.
- `POST …/machines/pairings` `{ name }` → `{ code, expiresAt, installCommand }`.
- `PATCH …/machines/{id}` `{ name }`; `DELETE …/machines/{id}` (the person who paired it or an admin).
- `PUT …/agents/{agentId}/computer/target` `{ machineId: uuid | null }`.
- No session (machine token or code): `POST /api/machines/pair`, WebSocket `/api/machines/connect`, `PUT /api/machines/uploads/{uploadId}`, `GET /api/machines/pulls/{pullId}`, `GET /api/machines/install.sh`.

## Consequences

- Agents can run anything installed on a machine people trust, and their files land in the Drive without passing through the model.
- Every cloud with an API can become a provider with only a lifecycle adapter.
- Shell commands on a connected machine are as powerful as that OS user; isolation is the machine owner's choice (dedicated user, container, VM).
- A pending upload that never completes expires; the tool times out with a clear message and nothing is stored.
