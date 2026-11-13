# 0103. Connector usage: counted per day, read by the operator

- Status: Accepted (built: the counts and the operator API's reads, for an operator's console to call)
- Date: 2026-10-31
- Amends: ADR 0056 §4 (two analytics reads)
- Extends: ADR 0015 (the Tool Gateway), ADR 0016 (connectors), ADR 0038 (mailboxes through Composio), ADR 0039 (databases)
- Code: `packages/engine/src/connector-usage.ts`, `packages/engine/src/tools/types.ts` (`ToolDefinition.connector`), `packages/engine/src/tools/gateway.ts`, `packages/db/src/schema/connectors.ts` (`connector_usage_days`, `composio_usage_days`), `packages/adapters/src/composio.ts` (`onExecute`), `packages/engine/src/mail/inbound.ts`, `packages/engine/src/mail/accounts.ts` (`orgOfComposioUser`, a mailbox's connection), `apps/server/src/start.ts` (`composioUsageHook`), `apps/server/src/operator/analytics.ts`

## Context

A tool reaches an agent three ways: our own code (GitHub's git tools, Postgres databases, IMAP mailboxes), an MCP server (the catalog's, one-click presets, custom servers), or this server's own Composio project (Gmail and Outlook today, more services soon). Composio bills every tool execution and every trigger event (a webhook delivery costs ten times a call), and it has no usage API. To choose which services to build natively next, and to run some on Composio and others on our own code once costs grow, the people who run an instance need to know which connectors are used, how much, by how many workspaces, and what Composio will bill.

Nothing recorded that in a way anyone could query. `agent_run_steps` keeps the name the model saw, which for custom servers, mailboxes and databases is built from a label people typed. `audit_log`'s `tool.call` rows keep the display label and each call's input, are indexed only by workspace and time, and skip built-in reads. `approvals.connection_id` points into three tables. The telemetry report and `run.finished` carry one total of tool calls. Composio's executions and events were counted nowhere.

## Decision

### 1. Keys and ways

Every connector is counted under a stable key (`connectorKeyOf`) and a way (`native`, `mcp`, `composio`):

| Connector | Key | Way |
| --- | --- | --- |
| Catalog MCP servers (GitHub, Sentry, Linear, Drive) | the catalog's id | `mcp` |
| A custom server | its one-click preset's id when `presetForServer` matches, else the first preset's on its host (Supabase's `?project_ref=`, another path on `mcp.vercel.com`), else its lowercase hostname (never the path or query), and `custom` past 100 characters or outside `[a-z0-9.-]` | `mcp` |
| GitHub's own tools (`git_clone`, `open_pull_request`, `delete_branches`, `request_branch_push`) | `github` | `native` |
| A mailbox through Composio | `gmail` or `outlook` | `composio` |
| An IMAP mailbox | its preset's id (`icloud`), or `imap` when the person typed the hosts | `native` |
| A Postgres database | `postgres` | `native` |
| A Composio toolkit | the catalog's or a preset's id when we have one (`googledrive` is `drive`, `metaads` is `meta-ads`), else Composio's slug | `composio` |

A hostname always has a dot and our ids never do, so the two never meet. GitHub shows twice, native and MCP. Labels come from the catalog, the presets and the mail presets, else the key itself (`connectorLabelOf`). Every key matches `[a-z0-9][a-z0-9._-]{0,99}`, the shape the operator API takes in a path.

### 2. Tools say what they reach

`ToolDefinition` gets `connector?: { key, via, tool }`, set by every source of connector tools: the catalog's and custom servers' tools (`connectors/mcp.ts`), the four git tools, the mail tools (once, in `make()`) and the database tools (once, in their `make`). `tool` is the server's own tool name or our verb (`search`, `query`), never the name the model sees, and is counted as `other` outside `[A-Za-z0-9_.-]{1,64}`. A custom server's tools without a preset all count as `other`: their owner names them, after a customer too (n8n names a tool after its node, Make after its scenario). Only the catalog's and the presets' vendors, our code and Composio name tools for everyone. Built-in tools leave it unset and are never counted.

### 3. Two tables, by UTC day

- `connector_usage_days`: day, connector, way, workspace, agent and tool, with `calls`, `errors`, `approvals_asked` and `approvals_given`. The agent has no foreign key, so the counts outlive a deleted agent.
- `composio_usage_days`: day, toolkit (the key), workspace and action (the action's or the trigger's slug, `other` outside `[A-Za-z0-9_.-]{1,100}`), with `executions`, `failures`, `events` and `connections` (connected accounts made, under the action `connection`).

Both key on the day first, so reads across workspaces are range scans, and both cascade from `organizations`, so a deleted workspace's counts go with it (ADR 0088) and nothing joins `PURGED_BY_HAND`. They are kept for good: about 5K rows a day at a few hundred active workspaces. Days older than a year fold into months once a table passes about 10M rows.

### 4. What is counted where

Each count is one upsert (`insert … on conflict do update set calls = calls + excluded.calls`) on the database's UTC day, awaited and swallowed when it fails (`countToolCall`, `countComposio`): a failed count never fails a call.

- **The Tool Gateway** (`run()`, the one place a tool executes): every call of a tool with `connector`, approved ones included, is one call, and an error when its result has `isError` or the tool threw. A call refused before it runs (scope, policy, input, a check) isn't counted. Calls that run under "Aprovar sempre" are only calls.
- **The approval branch:** one approval asked, only when the insert made a new row (a retried job that finds its request adds nothing).
- **`executeApproved`:** one approval given, with its call, once the claim succeeds. Running it again adds nothing.
- **Composio's client:** `onExecute({ userId, toolkit, slug, ok })` is told of every execution Composio answered (`ok` false for an error status or `successful: false`) and never of a request that didn't reach it. The hook runs inside a `try`. The toolkit is the account's, which every `ComposioAccount` names: an action's slug doesn't say it (`ONE_DRIVE_GET_ITEM`). `composioUsageHook`, which `start.ts` passes in, counts it for the workspace of `org_<uuid>` (`orgOfComposioUser`) and for no other user id, so a mail tool's call that runs several actions (an attachment is a read and a download), inbound mail and account checks are all counted.
- **A mailbox's sign-in:** when `applyComposioStateFor` finds Composio's account active for a row that wasn't (a new mailbox, a reconnect, or one it lets go because it is another mailbox or one already connected), one connection (`countComposioConnection`), since Composio bills each connected account once past the free ones. The callback read again adds nothing.
- **Composio's webhook:** a `mail.received` for a known watch and account is one event under its trigger's slug (`GMAIL_NEW_GMAIL_MESSAGE`), a repeated delivery too, since Composio bills each. A delivery we can't tie to a workspace any more isn't counted: it is rare.

Every server counts, self-hosted ones too, with no setting: it costs one upsert per connector call, and the same tables can feed a usage view in the app later.

### 5. The operator API's reads

Under ADR 0056's token, in its OpenAPI document:

- `GET /analytics?from&to` (UTC days, at most 400, `400 analytics.range` otherwise): `since` (the first day counted), `totals`, `days` per day and way, `connectors` per connector and way with their accounts now and added in the dates and, for Composio, executions, failures and events (most calls first, at most 500, then `connectorsMore`), Composio's `days` and its UTC `month` so far (with the connected accounts made, reconnects included), and the product's days from the events feed (runs, tasks, active workspaces, new workspaces and sign-ups, kept 90 days).
- `GET /analytics/connectors/{connector}?from&to`: one connector's `days`, `tools` and Composio `actions` (at most 200 each) and `orgs` per workspace and way (at most 500, then `orgsMore`), with their accounts and last day. `approvals` there are the approvals asked. An unknown key answers with empty lists, and one outside the key's shape is a 400.

Accounts come from `connector_connections`, `github_app_installations` (GitHub's native way), `mail_accounts` (a pending sign-in isn't connected) and `db_connections`. A custom server's URL is keyed in JavaScript by the same `connectorKeyOf` as its tools. Workspaces and agents "using" a connector made at least one call, and for a Composio row a workspace Composio billed without one (trigger events, account checks) uses it too. Connected accounts count only toward the month.

### 6. Counts, keys and ids only

No connection label, URL path, custom server's tool name, tool input, address or anyone's name is stored in either table or leaves through these reads. Workspace names stay where operators already see them (`GET /orgs`).

### 7. The contract for Composio connectors to come

A source of Composio tools sets `connector` with the alias key and `via: "composio"`. Its calls go through `executeTool` with the account's toolkit slug (`ComposioAccount.toolkit`), which `onExecute` counts under it. One that goes through Composio's MCP calls `countComposio` once per action `composioActions` names. Its accounts table joins the accounts read.

## Consequences

- Operators can rank connectors by use, see which ways they take, and estimate Composio's bill before it arrives. An operator's console reads these two routes.
- One more statement per connector call. Built-in tools, the mention run and the hot paths' query budgets don't change.
- On agentes.chat Cloud, operators see how much each workspace uses each connector, as counts.
- A custom server's hostname is kept: it says which servers deserve a one-click preset, and ADR 0056 already allows domains.
- Messages per day aren't counted: `messages` is partitioned by month and no event records them. A count in the daily report would do it.

## Alternatives considered

- **Reading `audit_log`:** its rows hold each call's input, skip built-in reads, are indexed only by workspace and time and name connectors by their label: a cross-workspace count would scan every row, and the input must never feed analytics.
- **One `custom` bucket for every custom server:** hides which servers people connect by hand, the ones that most deserve a preset.
- **An event per call in `operator_events`:** kept 90 days, recorded only while the operator API is on, and one row per call.
- **Composio's own dashboard:** no API, no workspace, and no split between our connectors.
