# 0077. An agent's computer is always a connected computer

- Status: Accepted (2026-10-28)
- Date: 2026-10-28
- Supersedes: ADR 0021, except **Tools** and **Skill scripts**; in part ADR 0024 (the cloud computer's credential and its setup inside that computer, **Network**), ADR 0025 (§1's lifecycle half of `SandboxProvider`, §2's server-side upload fallback, and in §6 the cloud computer as the null target, the organization's network mode and the tools only with Daytona), ADR 0026 (the sandbox's budget check), ADR 0027 (the cloud computer's secrets helper), ADR 0029 (the `cloud_computer` reason), ADR 0031 (Daytona as a host for an agent's screens), ADR 0032 §2 (git on cloud computers), ADR 0042 (Daytona hosts and metered computer time), ADR 0060 §3 (the exception for servers with cloud computers), ADR 0065 §2 (`computer_start` and `computer_stop`) and ADR 0066 §8 (coming from the menu bar app)
- Builds on: ADR 0024's addendum (git on connected computers), ADR 0025 (connected computers), ADR 0056 §10 (the workspace's own computer), ADR 0060 §3 (the server's own computer), ADR 0066 §5 and §7

## Context

ADR 0021 gave each agent a computer we created at Daytona and then started, stopped, archived and billed by the hour, behind `SandboxProvider`. ADR 0025 added connected computers, machines that run our runner, and today every computer the product offers is one: agentes.chat Cloud gives each workspace a computer of its own, always on (ADR 0056 §10); a self-hosted server is its agents' computer by default (ADR 0060 §3); people connect their own (ADR 0025, ADR 0066 §5); the desktop app's server here uses the computer it runs on (ADR 0066 §7). Nothing depends on a third-party computer per agent anymore. Keeping that path cost a second lifecycle, its own usage, limits and network policy, an image and its snapshot script, and words on every computer screen. It also hid a bug: the server registered the git proxy only when Daytona was configured, so connected computers, which clone and push through it, had no git anywhere else.

The desktop app's move from the menu bar app (ADR 0066 §8) carried people over: it retired the homes paired with agentes.chat Cloud, kept the homes of their own servers running and put those servers in the list, and opened the server chosen in the menu bar app. That app is gone.

Before launch nothing needs a compatibility path or a data migration, so all of it goes in one change.

## Decision

### 1. What goes

- The Daytona provider and its settings: `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET`, `SANDBOX_SNAPSHOT`, `SANDBOX_PRICE_VCPU_HOUR_USD`, `SANDBOX_PRICE_MEMORY_GIB_HOUR_USD`, `SANDBOX_PRICE_DISK_GIB_HOUR_USD`, `SANDBOX_AUTO_STOP_MINUTES`, `SANDBOX_ARCHIVE_AFTER_DAYS`; its image (`infra/sandbox/Dockerfile`), `apps/server/scripts/sandbox-snapshot.ts` and the step of `bun run smoke` that used it.
- The cloud computer's lifecycle (create, start, stop when idle, archive, destroy, recreate): the `sandbox.start` and `sandbox.stop` jobs, `POST …/agents/{id}/computer/start`, `POST …/computer/stop`, `DELETE …/computer`, the tools `computer_start` and `computer_stop`, and the lifecycle half of `SandboxProvider`.
- Its metering: usage rows of kind `sandbox` (the kind and its rows), cost by the vCPU-hour, the organization's daily minutes (`sandbox_usage_days`) and the budget check before a command.
- The organization's network mode for computers (no internet, some domains, open) and its domains: a connected computer is on its own network.
- What only a computer we created needed: its secrets helper (ADR 0027), the server reading or zipping a file itself for `upload_file` (every computer sends it, `pushFile`), `git clone` run as a command there, and its git credential and setup.
- The tables `sandboxes` and `sandbox_usage_days` and the columns `network`, `allow_domains` and `daily_minutes` of `org_sandbox_settings`, dropped with what they hold.
- The cloud computer in the apps: the target, the place to move agents to when a computer goes offline, the `cloud_computer` reason when choosing an agent for a mission, its picture, its settings card and its words; Daytona in the privacy policy and the docs.
- The desktop app's move from the menu bar app: with no `servers.json` the app starts with an empty list and shows the first run (ADR 0066 §1). Homes a terminal install's `agentes-runner host` keeps (`managedBy: "host"`) are still never started unless they are the server here's own (ADR 0066 §7).

### 2. What stays

- `run_code`, `write_file`, `read_file`, `list_files`, `export_file`, `upload_file`, `import_file`, `run_skill_script`, `request_secret` and `computer_status` under `sandbox:run`, outside "all tools" (ADR 0021 **Tools**, ADR 0025 §4), on connected computers.
- The organization's switches that hold for every computer: running code on or off (`org_sandbox_settings.enabled`), the default timeout of a command, and a person's approval before each run (`GET`/`PUT …/sandbox-settings`).
- `SandboxProvider` as the channel tools reach a computer through (commands, files, uploads, secrets), implemented for connected computers by `packages/engine/src/machine-provider.ts`; `withSandbox` (the mission's computer, else the agent's) and `withConnectedMachine`.
- The names: `sandbox:run`, `org_sandbox_settings`, `SandboxProvider` and `withSandbox` keep "sandbox". Scope strings are stored in agents' grants, and a rename would need a data migration for no change in behavior.

### 3. Which computer an agent uses

`agents.machine_id`: set, that connected computer; null, none, shown as `{ "kind": "none" }` wherever the API names an agent's computer. With none, a tool says the agent has no computer or, while the workspace's own computer is being prepared, that it is on its way (ADR 0056 §10). A mission's work runs on the mission's computer, as before (ADR 0029). No computer time is metered.

### 4. The git proxy on every server

`/api/git/*` (ADR 0024) is registered on every server: connected computers clone, fetch and push through it (`git.sync`, ADR 0024's addendum). It accepts only credentials issued to a connected computer; anything else gets a 401.

## Consequences

- One optional third-party service and nine settings fewer; Postgres stays the only dependency, and an agent's computer is the same kind on every install: one code path and one set of words.
- A server with no connected computer gives its agents none, as before without Daytona; the setup makes the server its agents' computer by default (ADR 0060 §3).
- Agents' git works on every server, so a reverse proxy in front of one must let pushes of up to 100 MB through (`GIT_LIMITS.pushBytes`).
- The organization's run-code settings have no screen for now; they are read and changed through the API.
- The dropped tables and the usage rows of kind `sandbox` go with their data; nothing is moved.
