# 0030. Isolation on connected computers: an environment per agent, scoped git, optional OS sandbox

- Status: Proposed (to build after missions, ADR 0029)
- Date: 2026-10-16
- Extends: ADR 0025 (connected computers), ADR 0024 (git proxy), ADR 0027 (secrets to agent computers)

## Context

On a connected machine the runner runs commands as the OS user that runs it. What isolates agents today:

- each agent has its own folder in the workspace (`<handle>-<id8>`), the `cwd` of its commands;
- the file tools refuse `..`, absolute paths and symlinks that leave the workspace;
- secrets live per agent outside the workspace and are redacted from output (ADR 0027);
- `--no-exec` turns commands off.

A shell command still reaches anything that user can: `~/.gitconfig`, `~/.ssh`, the owner's GitHub login, other agents' folders, the whole network. Two consequences:

- **Git.** The git proxy (ADR 0024) does not apply, and we never rewrite a person's global git config. An agent that needs git either uses the owner's identity and credentials or can't push. Commits look like the owner's.
- **Approvals.** With the owner's credentials on the machine, the executor can merge to the default branch itself. "Merge needs approval" (ADR 0015, 0029) is then a policy in the instructions, not a guarantee.

## Decision

Three levels. Level 1 is the default for every connected machine; level 2 is a choice per agent on machines that support it; level 3 is how the owner sets up the machine.

### Level 1: an environment per agent (cross-platform)

The runner builds each command's environment for the requesting agent, without touching the owner's files:

- **Git config:** `GIT_CONFIG_GLOBAL=<agent folder>/.agentes/gitconfig`. A `configure_git` op (from a tool) writes that file: name and email of the agent, a credential helper, `insteadOf` rules. The owner's `~/.gitconfig` is never read for writing and never changed.
- **Authorship:** commits are authored as the agent (`Dev (agentes.chat) <dev+<org>@agents.agentes.chat>`) with a `Co-authored-by` trailer for the person who started the work.
- **GitHub access, preferred:** a short-lived token minted by our server from the org's GitHub connection (GitHub App installation token, ADR 0016/0024), scoped to the repos the agent may use, delivered to the runner per task through the credential helper (`agentes-runner git-credential`), never written to disk in plaintext. The policy lives server-side, like the git proxy: push only to `agentes/{handle}/*` and mission branches, no force push to protected refs, no direct push to the default branch. Merges go through our GitHub connector after an approval card. This makes approvals binding.
- **GitHub access, fallback:** a token the person hands over with `request_secret` (ADR 0027), stored in the agent's secrets, used through the same credential helper.
- **SSH:** if a remote needs it, an agent-only key under the agent's secrets via `GIT_SSH_COMMAND="ssh -i … -o IdentitiesOnly=yes"`.
- **Not changed:** `HOME`. The executor's own sign-in (`~/.claude`, `~/.codex`) must keep working, so isolation is by targeted variables, not by a fake home.

### Level 2: OS sandbox ("modo protegido", optional)

- **macOS:** commands run under Seatbelt (`sandbox-exec` with a generated profile): writes only to the agent folder, the task worktrees and a temp dir; reads of the owner's home limited to what the executor needs; network off, all, or an allowlist.
- **Linux:** the same with bubblewrap (or landlock where bubblewrap is missing).
- **Windows:** not available; level 1 only, and the pairing screen says so.
- **Executor sandbox:** when the executor has its own sandbox (Claude Code's sandbox settings), the runner turns it on through the settings it already passes, as a second layer. To be confirmed against the executor's docs when built.
- **Per agent, not per machine.** The machine reports whether it supports the sandbox (macOS/Linux, runner version); each agent has protected mode on or off (`agents.protected`) on its page. Pairing with `--protected` sets the default for agents that start using the machine. On one machine, one agent can run protected while another is not.
- An agent given the owner's real desktop (ADR 0031) can't be protected: driving the screen escapes any process sandbox. Choosing one turns the other off.
- Protected mode limits what that agent reaches; it doesn't hide its folder from an unprotected agent on the same machine.
- The agent's `computer_status` says which mode it is in.

### Level 3: real separation (documented)

- A dedicated OS user for the runner (the install guide already recommends it), or
- the runner executing commands inside a container or VM the owner provides.
- The agent then has full freedom inside, and the owner's machine stays out. We document and detect it (`computer_status`), we don't manage the container.

## Order

1. Level 1 git: `GIT_CONFIG_GLOBAL`, agent authorship, credential helper with `request_secret` tokens.
2. Short-lived GitHub tokens from our connector with server-side branch policy; merges only through the connector after approval.
3. Level 2 on macOS and Linux, chosen per agent.
4. Level 3 docs and detection.

## Consequences

- Agents get a git identity of their own and the owner's config stays untouched.
- With connector tokens, "merge needs approval" holds on connected machines too, not only in the cloud.
- Level 2 trades convenience for safety (some tools break without network or home access); it stays opt-in.
- Windows machines get level 1 only.

## Addendum: browser start page and network options

The agent browser opens an offline agentes.chat new tab. Its language follows the agent's responsible person
(Portuguese or English, with English as the fallback). The clock uses the computer's time zone. No external
font, image or page request is needed. System installs keep the extension files outside agent-owned homes,
under `/opt/agentes-runner/browser/start/<uid>`; a regular install uses the runner's own home. Existing profiles
and sign-ins are kept. A running browser picks up changed names and observed addresses every 30 seconds.

Only a workspace’s managed computer reports its public address in settings and the screen footer. Personal
and server-hosted computers do not measure or report it. A server-authorized managed system runner
asks this server's `/api/machines/ip` without credentials every 30 seconds; configure `TRUSTED_PROXIES` for your
reverse proxy as for other IP-based features. Private LAN and tailnet addresses are hidden, and three failed
observations clear the display. A country mark appears only when the response includes a recognized country.

A Linux system runner can optionally set `networkLauncher` in its root-owned `config.json` to an absolute
executable path. The helper receives `<uid> -- <command> [arguments...]`, prepares or enters the network
context synchronously, then executes the command. Root network diagnostics and the agent's `runuser` launch
use the same helper. The executable and every parent must be root-owned, with no symlinks or group/other write
permissions. A failed helper prevents the process from starting. No helper is configured by default. Apply
changes through the root configuration; an existing process keeps its network context until it ends. The
host loopback firewall remains active for existing processes. Helpers must preserve access to the runner's
filesystem sockets and the read-only start-page directory. With this option, Chrome also disables non-proxied
WebRTC UDP through its launch flag; no managed browser policy is installed.

A deployment whose trusted routing hook redirects foreign traffic through loopback can set the root runner
config's optional `networkMark` to one unsigned 32-bit packet bit. No exception is installed when it is absent.
The mark must be distinct from the local-service ownership tag (`0x41000000`). The loopback guard exempts
marked traffic only when it has no destination NAT and an unmarked FIB address-type lookup says the destination
is not local. Host-owned public addresses and wildcard listeners therefore keep their normal protection.
The deployment must filter private destinations before marking packets and prevent agent processes from gaining
`CAP_NET_ADMIN` or `CAP_NET_RAW` (including through file capabilities). The mark never replaces those filters.
Changes reconcile the local guard atomically. The shared guard for `managedBy: host` does not use per-runner marks.

When `networkMark` is configured, `systemLauncher` runs `setpriv --no-new-privs --bounding-set=-net_admin,-net_raw` immediately before `runuser`, after the optional network launcher.
This also covers deployments using marked routing without a namespace launcher. The kernel bind self-check
uses the same restriction. Existing processes must be drained or restarted before relying on it.

With no-new-privileges enabled, Chrome needs a working user-namespace sandbox; verify it during Linux acceptance.

Without `networkDrainSeconds`, network changes do not reconnect the machine or cancel foreground work. Workers with requests, background tasks,
secret installs, handoffs, browser streams or desktop leases finish those before they retire. Every launch for
one UID keeps its previous network while that worker, desktop (including startup) or terminal still exists.
Linux also retains that context while any other process runs as the UID, including daemonized services.
Only the launch wrapper's first UID-owned worker is excluded from that process hold; an incomplete process
scan keeps the transition pending. Once all those scopes drain, the next launch uses the new settings.
Existing desktops and terminals keep running. The root service atomically writes `network-state.json`
in its runner home (0600): version 1, PID and Linux `/proc` start ticks, observation time, active
`networkLauncher`/`networkMark` (null when absent), `pendingUids` for old workers and tracked scopes, and
`uidNetworks` pins saved before launch (only held or imminent contexts; inactive pins are removed).
The observation is bounded to 4 MiB; an oversized new launch is refused before creating a process.
Pins survive a daemon restart while its desktops remain. Existing processes
without a saved pin are adopted only after proving they share the runner's host namespace; otherwise new work
waits for those old processes to end. Every directory containing this root observation must be root controlled.
An integrator must verify process identity, root ownership, the actual firewall rule, and live process namespace
membership before declaring a migration complete; the file describes launch defaults, not proof that every
process moved. External routing must preserve already established connections during a change. Keep an installed
routing mark until connections using it have drained before removing its exception.


For a finite transition an administrator may set `networkDrainSeconds` (30–3600). New work waits whenever its
UID still has the prior network context. Existing sessions get a visible deadline, then the runner closes only
its own workers, desktops and terminals. The root routing integrator must block stale host-UID egress at that
deadline and retain the pending status until all old processes are gone; unknown processes require operator
attention. The persisted `transitions` array in `network-state.json` exposes the per-UID deadline and state.
Reapplying the same network settings or restarting the daemon does not extend it.

An optional `networkRevision` (default 0) identifies the isolation implementation. Increase it when the
network helper changes behavior at the same path; existing UID contexts then follow the same bounded drain.
