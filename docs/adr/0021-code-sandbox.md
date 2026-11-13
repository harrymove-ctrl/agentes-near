# 0021. One computer per agent: Daytona behind a provider interface

- Status: Superseded by ADR 0077 (2026-10-28), except **Tools** and **Skill scripts**, which stay on connected computers
- Date: 2026-10-14

## Decision

**Provider.** `SandboxProvider` (`packages/adapters/src/sandbox.ts`) exposes create, get, ensureStarted, exec, writeFile, readFile, listFiles, stop and destroy. Two implementations exist:
- `createDaytonaSandboxProvider`, over Daytona's REST API: the main API for the lifecycle and the toolbox proxy (`{toolboxProxyUrl}/{id}/…`) for commands and files. It uses a bearer key from `DAYTONA_API_KEY`, a platform secret that is never stored per organization nor returned by the API.
- `createFakeSandboxProvider`, for the tests.

We call the REST API directly instead of the official `@daytonaio/sdk`. Adding the SDK would change the lockfile, which CI installs frozen, and the SDK calls this same API anyway.

**Isolation.**
- Sandboxes are created with `env: {}`, `public: false` and, by default, `networkBlockAll: true`. An organization can allow domains instead (`domainAllowList`, at most 100).
- Commands never carry `envs`. Each one is base64-wrapped in `sh -c`, with stderr captured to a file after a random marker, so stdout and stderr come back apart from Daytona's combined result.
- Daytona tiers that refuse a per-sandbox network policy get one retry without it (the Daytona organization's policy then applies), and the sandbox is recorded as `provider-default`.

**Lifecycle.** Each agent has one computer: the key is `agent:{agentId}`, and the `sandboxes` table enforces one live row per key with a partial unique index. Every conversation of the agent uses the same machine, so `/workspace` persists across them. We treat the workspace as trusted: people in it are trustworthy, and an agent whose audience is its owner or a few people effectively has a private computer.
- The first tool call (or `POST …/computer/start`) creates it.
- Daytona auto-stops it after 10 idle minutes and auto-archives it after N days stopped (7 by default, at most 30). Archived machines keep their files. `autoDeleteInterval` is `-1`: it is never deleted on its own.
- A stopped or archived computer is started again on use.
- Only when the provider lost it is the row marked deleted and a new, empty one created. That is audited (`sandbox.recreated`), and the tool result tells the agent its old files are gone, so it can tell the people.

**API.** `GET …/agents/{id}/computer` returns `{ status, diskUsedGib, createdAt, lastUsedAt, network }` (`costMonthUsd` was dropped in 0026: the cost counts in the agent's budget percentage), where `status` is `running`, `stopped`, `archived` or `none`. The disk size is measured with `du` while the computer runs and kept for when it is stopped. `POST …/computer/start|stop` and `DELETE …/computer` complete the set. The agent's owner and admins can use all of it; everything is audited.

**Network mode.** `org_sandbox_settings.network` is one of three modes:
- `blocked`, the default (`networkBlockAll`);
- `allowlist` (`domainAllowList`);
- `open`, with no network field at create, so egress is full and there are still no secrets inside.

Migration 0030 maps existing rows: domains present means `allowlist`, otherwise `blocked`. A change applies in place with `POST /sandbox/{id}/network-settings`: no restart, `/workspace` untouched. Running computers get it right after `PUT …/sandbox-settings`. The others get it when they next start, because `sandboxes.network_applied_at` is older than the settings. `run_code`'s description states the mode, and a network failure is explained to match it ("sem internet" vs "o site ou o endereço").

**Image.** `infra/sandbox/Dockerfile` defines the computer: a non-root user `agente` with `WORKDIR /workspace` owned by it, Python 3.12 with pandas, numpy, matplotlib, openpyxl, python-docx and reportlab, Node 22 LTS with npm and corepack (so pnpm and yarn work, and global npm installs go to the user's home, no root needed), git, curl, and the DejaVu and Noto fonts.
- `apps/server/scripts/sandbox-snapshot.ts [name]` registers it as a Daytona snapshot (`POST /snapshots` with the Dockerfile content) and waits until it is active.
- The script then checks one sandbox made from it (`node -v`, `npm -v`, `pnpm -v`, `python3 -c "import pandas, matplotlib"`) and deletes that sandbox.
- `SANDBOX_SNAPSHOT` names the snapshot sandboxes are created from, as user `agente`. Without it, the provider's default image is used, and the adapter creates `/workspace` on first start.

**What agents and people see.** The workspace is always `/workspace`, and tools show paths relative to it. The adapter masks the provider in everything it returns: its home paths become `/workspace` or `~`, and its name becomes "computador". That covers command output, provider errors and the error reasons of a computer that failed.

**Start and stop don't block.** `POST …/computer/start` and `POST …/computer/stop` mark the computer `starting` or `stopping`, queue an outbox job (`sandbox.start`, `sandbox.stop`) and return `202`. On a first start, a placeholder row (no provider id) holds `starting` until the job fills it in. Each change is broadcast to the organization as `agent.computer { agentId, status, step?: creating|preparing|ready, error? }`; every member can see its agents. A failure leaves `status: error` with the masked reason in `last_error` (migration 0028).

**Tools.** The `sandbox:run` scope covers `run_code`, `write_file`, `read_file`, `list_files`, `export_file`, `upload_file` (any file or folder as is, ADR 0025), `import_file` and `run_skill_script`. It is not in the default scopes, and the `*` ("all tools") grant does not cover it (`NOT_IN_ALL` in `tools/scopes.ts`).
- An organization can make `run_code` and `run_skill_script` sensitive, so every call waits for an approval.
- `export_file` maps `.md`/`.txt`, `.csv`, `.html` and `.mmd` to Drive kinds, as a new file or a new version.
- `import_file` writes a Drive file's text form into the workspace.

**Cost.** Each call records a `usage_records` row of kind `sandbox` (with `org_id`, `agent_id`, `run_id` and the cost from `SANDBOX_PRICE_*`), and the same cost goes into the agent's monthly counter. The sandbox's totals and the org's day (`sandbox_usage_days`) are updated too.
- Billed time is the call itself plus the idle time since the last use, capped at the auto-stop interval, because the sandbox was running in between.
- Before anything is created or run, the code checks that the sandbox is on, that the org has daily minutes left and that the agent's budget covers the call's timeout.

**Skill scripts.** Files with a script extension (`py`, `sh`, `js`…) are now stored with status `script`.
- They are never shown to the model, and `read_skill_file` refuses them.
- `run_skill_script` copies the skill's kept files to `.skills/{name}/` and runs the script with arguments, each one shell-quoted.
- Skills imported before this have scripts as `ignored`, with nothing stored: they need a re-import.

## Consequences

- Running code is opt-in twice: the server needs a provider, and each agent needs the scope.
- The idle-tail estimate can miss the last idle period before an agent stops using its computer. That error makes us under-bill, never over-bill.
- A shared computer means conversations of the same agent can see each other's files; that is intended (the workspace is trusted) and is narrowed by the agent's audience.
- Self-host needs another `SandboxProvider` (or keeps it off).
