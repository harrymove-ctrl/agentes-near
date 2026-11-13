# 0169. Agents' containers: rootless Podman, each agent its own containers service

- Status: Proposed
- Date: 2026-11-11
- Amends: ADR 0030 and 0101 (no_new_privs: kept on every launch of an agent but its containers service), ADR 0096
  (what a uid-keyed firewall must count as an agent's), ADR 0057 (what an agent's share holds)
- Code: runner `agent-users.ts` (`agentSubids`, `ensureSubids`, `rootlessContainers`, `containersCommand`,
  `ensureContainers`, `containersFailure`, `keepContainers`, `stopContainers`, `RUNTIME_DIR`, `DELEGATE`,
  `CGROUP_KEPT`, `CGROUP_BACK`, `NOSUID_VIEW`, `CONTAINERS_START`, the launcher's `containers`), `supervisor.ts` (`launchWorker`, `stopContainers` at a network's
  deadline), `daemon.ts` (a desktop or terminal, an agent that left, `containersAllowed`, a brain that changed),
  `accounts.ts` (`withoutContainers`) in `brain-codex.ts`, `brain-codex-app.ts`, `brain-cursor.ts`, `brain-grok.ts`,
  `brain-antigravity.ts`, `brain-route.ts` and `tasks.ts`, `access.ts` (`parseAgents`), `service.ts`
  (`AGENT_TMP_CLEANUP`), `toolchains.ts` (`podman`); adapters `RunnerToolchains.podman`, `MachineAgent.containers`;
  engine `machines.ts` (`machineAgents`), `brains/types.ts` (`isSandboxedBrain`), `context.ts` (`containersText`);
  tests `agent-users.test.ts`, `accounts.test.ts`, `brain-codex.test.ts`, `brain-route.test.ts`, `tasks.test.ts`,
  `supervisor.test.ts`, `system-mode.test.ts`, `toolchains.test.ts`, `isolation.root.test.ts`, engine
  `machines.test.ts`, `right-hand-plans.test.ts`, `desktop.test.ts`, `turn-context.test.ts`

## Context

Software teams' agents need `docker` and `docker compose`: a test database, a dev stack, a build in an image. On a
computer where each agent is its own user (system mode, ADR 0058 §10), Docker's group is root on that computer for
whoever is in it, which would end every isolation between agents. Rootless containers run as their user, but they need
subordinate ids (`/etc/subuid`, `/etc/subgid`) mapped by the set-user-ID helpers `newuidmap` and `newgidmap`, which
no_new_privs voids (ADR 0101 put it on every launch where a network mark is configured, which ADR 0096 already noted
costs rootless Podman). And Podman as a plain process falls short under our launches: with systemd running and no user
manager for the agent, netavark starts compose's DNS helper through `systemd-run --user` and healthchecks need systemd
timers, so a compose file with two services that call each other by name, or one that waits for a healthy database,
fails. A user manager the agent doesn't run in can't take those either: a delegated cgroup can only hold processes
started inside it.

## Decision

1. **Rootless Podman**, not Docker: no daemon of root's and no `docker` group. `docker` is Podman's (`podman-docker`),
   `docker compose` runs Compose v2 (`docker-compose`) through Podman's Docker API, and `podman compose` the same.
2. **Each agent's subordinate ids are the 65536 from `uid << 16`** (`agentSubids`), in both files. Taken from the uid
   alone, they are the same on any computer where the agent keeps its uid, which a move does, so what its containers
   left in its home (owned by those ids, which have no names: tar keeps the numbers) still belongs to it there. No two
   agents share one, and none is a real uid: those are all below 65536, an agent's block at 1000 << 16 or above, and
   from 600,100,000 up for the default range, beyond what useradd hands out itself. At each agent's first request per
   runner process, `ensureSubids` makes that block the agent's only range (useradd gave a new user the next free one by
   the order users came in, which no other computer repeats) through usermod, which takes the files' lock. Anyone
   else's range over the block leaves the agent with none, logged: ids are never shared.
3. **Each agent has a containers service** (but those of §9), `agentes-containers-<uid>.service`: a systemd user
   manager of its own, which runs Podman's API (`podman.socket`), the healthcheck timers, compose's DNS helper
   (aardvark-dns) and the containers themselves. Root starts it as a transient unit of the agent's slice
   (`agents-<uid>.slice`) through the same steps as every launch of the agent (its tmpfs, its mount namespace with its
   own /tmp, the private /proc a network policy asks for, its network hook, its user), with `Delegate=yes` and its
   cgroup given to the agent as user@ gets its own, `Restart=always` (network hook included) and `OOMPolicy=continue`.
   A network hook that enters its namespace through `ip netns exec` mounts a fresh /sys with no cgroup2 under it, where
   a user manager can't start, so the computer's cgroup2 is kept before the hook and bound there again after it (a
   bind: a new cgroup2 mount from the init cgroup namespace would set the hierarchy's root flags from its own options).
   Its steps' stderr goes to the journal as `agentes-containers`, and the user manager logs there too
   (`--log-target=journal`: the console it uses otherwise is root's). One that exits at once loses its unit in the
   journal, so the start checks the cgroup it needs first and says so when it can't have it.
   Its start, as the agent, writes Podman's defaults where the agent has none (`storage.conf` with its images and
   volumes in its home, `containers.conf` without compose's banner) and switches on Podman's socket and its restart of
   `restart: always` containers, all of it the agent's to change. The service gets its runtime dir at `/run/user/<uid>`
   in its view, `run/` in the agent's tmpfs: cleared at every boot, never aged by systemd-tmpfiles (`x` in
   `AGENT_TMP_CLEANUP`).
4. **Every launch of the agent is a client of it**: the same runtime dir bound in its view, `XDG_RUNTIME_DIR`, and
   `CONTAINER_HOST` and `DOCKER_HOST` naming Podman's socket, so `podman` and `docker` go remote and any Docker client
   (Compose, the Docker SDKs) finds it. A container then lives in the service, not in the command that started it: it
   keeps running when that command, the agent's CLI or its worker ends.
5. **no_new_privs stays on every launch but the containers service**, which runs without it since it would void the
   helpers' set-user-ID. Through its user manager the agent can run anything there (`systemd-run --user`), so the
   service's mount view stands where no_new_privs stood: every mount is remounted nosuid, its other options given back
   (`NOSUID_VIEW`), and only `/usr/bin/newuidmap` and `/usr/bin/newgidmap` are bound set-user-ID again. The bounding
   set drops NET_ADMIN and NET_RAW there as on every launch, so no process of the agent's can forge the network mark
   or touch nftables, and a new user namespace's capabilities reach only its own namespaces.
6. **Containers' traffic is the agent's.** Their network helper (pasta) runs as the agent's uid in the agent's network
   (the computer's, or its namespace), and the loopback guard (ADR 0096) tells agents by the cgroup a socket was made
   in, which holds container processes whatever their uid: a container reaches exactly what its agent reaches. A
   container on the host network (`--network host`) whose user inside isn't root opens sockets as a subordinate id,
   which a firewall keyed on the agents' uid range doesn't see: an operator's uid-keyed egress rules must take every id
   from 65536 up for an agent's, or refuse them off loopback, as the Cloud's guard does.
7. **Resources stay the agent's share** (ADR 0057): everything runs inside `agents-<uid>.slice`, so its equal CPU
   weight, its 4096 tasks and the agents' common memory limit hold, and with the delegated cgroup each container's own
   `--memory`, `--cpus` and `--pids-limit` hold inside them. Images and volumes are in the agent's home, on the disk the
   workspace's files are on, which moves with it.
8. **Lifecycle.** Root makes sure the service runs as it should before it starts the agent's worker, desktop or
   terminal (`ensureContainers`): started when it isn't, started anew when its command changed (a namespace, a network
   hook, a runner whose steps differ: the unit's description carries the command's hash), which stops its containers.
   It gets 5 starts a minute: one that fails at every start then stays failed (no `--collect`), and for that same
   command root doesn't start it again but logs `containers unavailable:` and the last line its steps or its user
   manager wrote. A new command, a restart of the computer or `systemctl reset-failed` on the unit gives it new tries.
   A network change's deadline stops it (`retireNetworkAgent`), as does an agent leaving the computer. Stopping
   `agents.slice` (a hold) stops every container. After a reboot it comes back with the agent's next worker, and its
   `restart: always` containers with it.
9. **None where a sandbox of the CLI's own holds the brain.** Codex's, Cursor's, Grok's and Antigravity's shells run in
   their CLI's sandbox, which is all that holds what their turns do (ADR 0053 §3, 0114, 0142, 0143). The service runs
   outside it, and through Podman's socket or its user manager runs what it is asked (a container with the agent's home
   mounted, any command), so for those agents it doesn't run at all. The agents frame says which may have it
   (`MachineAgent.containers`, `machineAgents`): every agent but those on those four brains (`isSandboxedBrain`) and the
   team's right hand, which thinks on several. Root keeps the service only for those (`keepContainers` before a worker,
   desktop or terminal) and stops it as soon as a frame takes it away (a brain changed: before its next turn); one given
   it back gets it at once while its worker runs, else with its next start. Every launch of a sandboxed CLI (Codex's
   turns, app-server, background tasks and routes; Cursor's, Grok's and Antigravity's turns) also goes without
   `CONTAINER_HOST`, `DOCKER_HOST` and `XDG_RUNTIME_DIR` (`withoutContainers`); the agent's own secrets keep theirs. No
   sandbox can refuse the socket instead: Codex's on Linux is Landlock, which doesn't cover connecting to a Unix socket,
   and seccomp, which refuses every connect or none (its turns run without the network, its background tasks with it);
   Cursor's is on or off (`--sandbox`), Grok's a named profile, Antigravity's `enableTerminalSandbox` and
   `allowNonWorkspaceAccess`, and their allow and deny rules are about their own tools, which a command in their shell
   doesn't go through. A path denied alone wouldn't do either: the agent's other processes (its worker, its Podman) are
   its own uid, and `/proc/<pid>/root` of any of them leads to the same socket unless the sandbox also has its own
   process namespace. Claude Code's own sandbox is never switched on here and OpenCode has none: their agents keep the
   service, and a Codex task such an agent starts reaches nothing through it that the agent's own shell doesn't.
10. **Agents are told**, in their computer's blocks, when its runner reports Podman (`toolchains.podman`) on a
    system-mode computer: `# Containers on "<computer>"` (`containersText`), on any brain but those of §9.
11. **On by installation.** A system-mode computer gets all this once Podman and both helpers are there
    (`rootlessContainers`); the runner's installer doesn't install them (a server with Docker has its own `docker`).
    SELF_HOSTING.md says what to install.

## Consequences

- Agent A can't reach agent B's containers or their files: B's home is 0700, B's storage and runtime dir are B's,
  every container process runs as B's uid or B's block, none of which A holds, and signals and ptrace follow uids.
  A's containers reach no local listener of B's (the loopback guard, by cgroup), no private range or metadata address
  (the operator's rules, as for A itself), and on the Cloud nothing off loopback as a subordinate id.
- Ports below 1024 can't be published (`-p 8080:80`). The agent's bind policy (ADR 0096) is on its slice, so it holds
  for its containers too, inside their own networks as well: none binds another agent's browser ports.
- The user manager costs about 15 MB per agent, and holds the agent's network while it runs: a network change waits
  for its drain deadline, and without one (`networkDrainSeconds` unset) the agent keeps its old network until the
  service stops.
- Agents on Codex, Cursor, Grok or Antigravity have no containers, and their prompts don't say they do. Switching an
  agent to one of them stops its containers; switching it back starts the service again, its `restart: always`
  containers with it. A mission's own brain or executor doesn't change that: its agent's brain does.
- The service's processes run without no_new_privs (§5): an exec there gains no more than the nosuid view leaves
  set-user-ID, the two id-map helpers.
- A mount whose path has a space keeps its set-user-ID in the service's view (`findmnt -r` escapes the name), as does
  an autofs point (`/proc/sys/fs/binfmt_misc`, which holds no programs); system mode's computers have neither kind
  where programs live.

## Verification

Unit tests on fakes: the ids (blocks, useradd's range replaced, a clash leaving none, missing files), the launcher's
environment and view, the service's command (delegation only of its own cgroup, the nosuid view last, no no_new_privs,
its network hook, no client variables), its start script run by a real shell, `ensureContainers`' start, keep and
restart, its start limit (down for the same command with its journal's reason, tried again for a new one or after a
stop that timed out), its start saying why where its view has no cgroup of its own, `keepContainers` stopping it for an agent the frame doesn't let have it, the frame's flag per brain (none for
Codex, Cursor, Grok, Antigravity or the right hand), a Codex turn, task and route started from a client's environment
getting none of its variables, the toolchains probe, and the prompt block per brain. On a Debian 13 VM (kernel 6.12,
Podman 5.4.2, crun 1.21, netavark 1.14, pasta, Compose 2.26.1) with two test agents launched as these steps do: an image
with a non-root user ran (the ids mapped), its files were owned by the agent's block in its home; healthchecks became
healthy; a compose file's services found each other by name and one waited for another's health; `--memory 64m` held;
every container process stayed in the agent's slice and outlived the command that started it; under no_new_privs a plain
launch couldn't map ids, while a client under it used the service; a set-user-ID-root program ran by the service's user
manager stayed the agent; pasta's traffic left as the agent's uid, a non-root host-network container's as a subordinate
id, which a rule refusing ids from 65536 up off loopback stopped while loopback still worked; the other agent could
neither list the first one's home, mount it into a container, see its containers nor signal them. On Debian 13
(systemd 257, Podman 5.4.2), through a network hook entering its namespace with `ip netns exec`, the user manager
exited 1 within milliseconds and wrote nothing its unit's journal shows ("Cannot determine cgroup we are running in: No
medium found", under the agent's uid only), restarted every 5 s for good; with cgroup2 put back after the hook it
stayed up and the agent's `podman --remote info` answered through the socket, and a hook that fails every time stopped
after 5 starts with its own line as the reason.
