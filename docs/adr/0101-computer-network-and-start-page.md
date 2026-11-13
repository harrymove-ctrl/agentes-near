# 0101 — Observed computer networking and the browser start page

Date: 2026-11-01. Status: accepted.

## Context

An agent's public route can change independently of its computer's host address. A person watching the
computer also needs a clear path into control, and a new browser tab should belong to the same computer.
The public runner must support deployments with their own network isolation without knowing a provider.

## Decision

Protocol 33 adds an optional `egress` observation to `pong`: `{ip: string | null, country?: string}`. The
server grants `observeEgress` in `welcome` only to a database `kind: managed` computer. Its system runner
samples the paired server’s unauthenticated `/api/machines/ip` every 30 seconds and on welcome, using an
existing agent UID inside its systemd slice and normal launcher, with no user creation, start-page preparation
or machine credentials. Personal and server-hosted computers never sample, emit, store or display this field. Only public addresses survive validation; three failures report
`{ip:null}`. Identical observations reuse their object, so ordinary heartbeats carry no repeated payload.
The server stores its receive time in `machines.egress`, clears it on a new connection, and publishes changed
observations. Offline computers show no address. Country marks are bundled SVGs; unknown countries use a globe.
The field is informational and is excluded from telemetry.

`networkLauncher` is an optional administrator-owned executable in the system runner's configuration. It
receives the UID, `--`, and the command, and must prepare the network context before exec. Both root-side
socket inspection and the bind-enforcement self-check enter it; the worker then runs there as the agent.
Thus Chrome, agent-browser, CDP HTTP/WebSocket calls, terminal shells and desktop processes inherit the same
context. VNC and worker coordination retain their filesystem sockets. Every executable path component is
root-owned and immutable to ordinary users. The existing host loopback guard remains for old processes.
Changing the setting updates launch defaults live; existing processes retain their network until they finish.

The offline new-tab page is a permissionless extension loaded by Chrome's command line. It reuses the desktop
art and brand fonts, contains no links or buttons, and hides its decorative content from accessibility snapshots.
The root runner installs system-mode assets outside agent homes, with read-only access for agents; a regular
runner writes its own assets. Only the local data file is refreshed. The server sends the responsible person's
language with the agent list; Portuguese maps to pt-BR and all other languages fall back to English. No Chrome
managed policy is installed. Only the extension's exact fixed URL is treated as a blank page in site checks.

A screen click or printable key while watching opens a translucent take-control prompt. The initial input is
not replayed. Escape dismisses the prompt first, and the prompt waits twenty seconds before offering again.
Keyboard-triggered prompts keep focus where it was. The existing explicit control action remains authoritative.

Browser streams use JPEG quality 60. A backed-up runner socket skips independent browser pictures above 2 MiB,
while results and heartbeats keep their ordered delivery. Desktop encoding adjusts to browser-reported network
conditions and data-saving preferences without reopening the stream. These are bounded improvements; end-to-end
viewer acknowledgements and measured-throughput adaptation remain separate work.

A root-configured `networkMark` optionally permits trusted routing through loopback for foreign destinations.
It is one uint32 packet bit outside the local-service conntrack tag bits, absent by default. The early guard
exception tests that bit, excludes destination NAT, and requires `fib daddr type != local` without `.mark`.
This preserves the original destination check, including wildcard services on a host's public address. The
external routing layer must reject private destinations before marking and keep agent processes without
network administrative/raw capabilities, including file capability escalation. No provider is named in core.
The exception is independent of the optional namespace launcher, so existing host-network processes can drain.
The [Linux IPv4 FIB implementation](https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux-stable.git/+/3f786abd23951f3f600a62fef42469d9200d5f52/net/ipv4/netfilter/nft_fib_ipv4.c)
checks local address type separately from the marked policy route. The
[IPv6 FIB implementation](https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux-stable/+/4fa048ed72531d6c2a2147fa9b52b6a5451213a2/net/ipv6/netfilter/nft_fib_ipv6.c)
also only includes the packet mark when explicitly requested.

When `networkMark` is configured, `systemLauncher` runs `setpriv --no-new-privs --bounding-set=-net_admin,-net_raw` immediately before `runuser`, after the optional network launcher.
This also covers deployments using marked routing without a namespace launcher. The kernel bind self-check
uses the same restriction. Existing processes must be drained or restarted before relying on it.

## Verification

Unit tests use fake sockets, processes and the in-memory database. They cover observed-address validation,
clearing and live updates, forwarded-address handling, helper ownership and command ordering, offline extension
permissions, localization, accidental input, and streaming backpressure. A release using a custom helper also
needs Linux acceptance checks of both IPv4 and IPv6, existing-process coexistence, browser CDP, desktop and
terminal paths, Chrome's user-namespace sandbox under no-new-privileges, and rollback before any production rollout.

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


## Bounded migration policy

System launches with an explicit network launcher, mark or revision fresh-mount procfs with `hidepid=2`
inside the existing private mount namespace. Unconfigured self-host launches keep their existing mount behavior. Other users’
processes, including `/proc/1/net`, are hidden; the host’s proc mount is unchanged. A custom network launcher
must also mask host network configuration and choose its hostname inside its own mount and UTS namespaces.

`networkRevision` is an optional root-controlled context revision (default 0). Increasing it starts a new
transition even when the launcher path and mark are unchanged, so existing processes cannot keep an old
helper’s mount policy indefinitely. The context key is `[launcher|null, mark|null, revision]`; the root state
and per-UID pins preserve the revision.

A root configuration may set `networkDrainSeconds` (30–3600). Stale UID contexts immediately refuse new work;
existing work drains until its persisted deadline. `network-state.json` adds per-UID `transitions` with agent ID,
target, start time, deadline and `draining`/`restart_required` state. Reapplying the same policy or restarting
cannot extend the deadline. Managed machines publish a bounded `networkTransition` in pongs, lists and live
updates; the computer view announces when its sessions will restart. At the deadline only the runner’s known
worker, desktop and terminal handles close, with an interruption reason. The external routing controller must
block old host-UID egress at the same deadline, then retire that UID’s managed cgroup if needed. Unknown
processes keep the machine explicitly pending until an operator resolves them. No arbitrary process is killed
by the runner, and no pending migration is reported complete merely because its known sessions closed.

Without a network launcher, mark or retained isolated context, network-state persistence is skipped. Settings
saves the account’s language before changing the local UI; the start page follows it through agent updates.
Chrome itself keeps its previous OS language behavior.
