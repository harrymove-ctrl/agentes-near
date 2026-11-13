import { ACCOUNT_KINDS, PROVIDER_FAILURE_CAUSES } from "@agenteschat/adapters";
import {
  AI_ACCOUNT_STATUSES,
  AI_ACCOUNTS_RECENT_FAILURES,
  ANALYTICS_LIST_MAX,
  ANALYTICS_MAX_DAYS,
  ANALYTICS_ROWS_MAX,
  CONNECTOR_KEY,
  operatorAiAccounts,
  operatorAnalytics,
  operatorConnectorAnalytics,
  operatorListAiAccounts,
  operatorOrgWorkAnalytics,
  operatorWorkAnalytics,
  WORK_ANALYTICS_HOURLY_DAYS,
  WORK_ANALYTICS_MAX_DAYS,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request (`analytics.range`: the dates)"),
  401: errorResponse("Missing or wrong token"),
};

const Day = z.string().openapi({ description: "A UTC day, YYYY-MM-DD.", example: "2026-10-31" });
const Count = z.number().int().min(0);
const Via = z.enum(["native", "mcp", "composio"]).openapi("OperatorConnectorVia", {
  description:
    "How the connector's tools reach it: `native` our own code (GitHub's git tools, Postgres, IMAP mailboxes), `mcp` an MCP server (the catalog's, one-click presets, custom servers), `composio` this server's own Composio project (Gmail and Outlook mailboxes), which Composio bills.",
});
const Key = z.string().openapi({
  description:
    "The connector's stable key: a catalog connector's or a one-click preset's id (a custom server on a preset's host takes it too), a custom server's hostname (never its path), `gmail`, `outlook`, an IMAP preset's id or `imap`, `postgres`, or a Composio toolkit's slug.",
});
const Label = z.string().openapi({ description: "Its name in the catalog or the presets, else the key." });
const Counters = {
  calls: Count.openapi({ description: "Tool calls that ran, approved ones included." }),
  errors: Count.openapi({ description: "Calls whose result was an error, or whose tool threw." }),
  approvalsAsked: Count.openapi({ description: "Approval requests its calls created." }),
  approvalsGiven: Count.openapi({ description: "Approved actions that ran." }),
};
const Range = z.object({
  from: z.string().openapi({ description: "The first UTC day, YYYY-MM-DD.", example: "2026-10-01" }),
  to: z.string().openapi({
    description: `The last UTC day, YYYY-MM-DD: at most ${ANALYTICS_MAX_DAYS} days, both counted. Else 400 \`analytics.range\`.`,
    example: "2026-10-31",
  }),
});

const ConnectorUse = z
  .object({
    connector: Key,
    label: Label,
    via: Via,
    ...Counters,
    workspaces: Count.openapi({
      description:
        "Workspaces with at least one call. For `composio`, also those Composio billed without one (an execution or a trigger event).",
    }),
    agents: Count.openapi({ description: "Agents with at least one call." }),
    accounts: Count.openapi({ description: "Accounts connected now (servers, installations, mailboxes, databases)." }),
    accountsAdded: Count.openapi({ description: "Of those, the ones connected in the dates." }),
    executions: Count.openapi({ description: "`composio` only: executions Composio answered, each one billed." }),
    executionFailures: Count.openapi({ description: "Of those, the ones Composio answered as failed." }),
    events: Count.openapi({ description: "`composio` only: trigger events delivered (new mail), each one billed." }),
  })
  .openapi("OperatorConnectorUse");

const ComposioCounts = {
  executions: Count,
  failures: Count,
  events: Count,
};

const Analytics = z
  .object({
    from: Day,
    to: Day,
    since: Day.nullable().openapi({ description: "The first day anything was counted here, null before any." }),
    totals: z.object({
      ...Counters,
      workspaces: Count.openapi({ description: "Workspaces with at least one call of any connector." }),
      agents: Count,
    }),
    days: z
      .array(z.object({ day: Day, via: Via, ...Counters, workspaces: Count }))
      .openapi({ description: "Per UTC day and way, oldest first. A day without calls is left out." }),
    connectors: z.array(ConnectorUse).openapi({
      description: `Per connector and way, most calls first (then executions, events and accounts), at most ${ANALYTICS_ROWS_MAX}. One connected but unused in the dates has zero calls.`,
    }),
    connectorsMore: z.boolean().openapi({ description: "More connectors than were listed." }),
    composio: z.object({
      days: z
        .array(z.object({ day: Day, ...ComposioCounts }))
        .openapi({ description: "What this server asked of its Composio project, per UTC day, oldest first." }),
      month: z
        .object({
          month: z.string().openapi({ description: "The UTC calendar month so far, YYYY-MM.", example: "2026-10" }),
          ...ComposioCounts,
          connections: Count.openapi({
            description:
              "Composio connected accounts made this month (mailboxes), reconnects included: Composio bills each once past the free ones.",
          }),
        })
        .openapi({ description: "This month whatever the dates: Composio's free allowances are monthly." }),
    }),
    product: z.object({
      days: z
        .array(
          z.object({
            day: Day,
            runs: Count.openapi({ description: "Agent runs that ended." }),
            tasks: Count.openapi({ description: "Tasks on computers that ended." }),
            activeWorkspaces: Count.openapi({ description: "Workspaces where a run or a task ended." }),
            newWorkspaces: Count,
            signUps: Count,
          }),
        )
        .openapi({ description: "From the events feed, oldest first. A day without any is left out." }),
      activeWorkspaces: Count.openapi({ description: "Workspaces where a run or a task ended in the dates." }),
      keptDays: z.number().int().openapi({ description: "Days the events feed keeps: older days read as zero." }),
    }),
  })
  .openapi("OperatorAnalytics");

const ConnectorParams = z.object({
  connector: z
    .string()
    .regex(CONNECTOR_KEY)
    .openapi({ param: { name: "connector", in: "path" }, example: "github" }),
});

const ConnectorAnalytics = z
  .object({
    connector: Key,
    label: Label,
    from: Day,
    to: Day,
    days: z
      .array(
        z.object({
          day: Day,
          via: Via,
          calls: Count,
          errors: Count,
          approvals: Count.openapi({ description: "Approval requests its calls created." }),
          executions: Count,
          events: Count,
        }),
      )
      .openapi({ description: "Per UTC day and way, oldest first. Executions and events are `composio`'s." }),
    tools: z
      .array(
        z.object({
          via: Via,
          tool: z.string().openapi({
            description:
              "The server's own tool name (a catalog connector's or a preset's) or our verb. `other` for a custom server's tools, whose owner names them, and for an unusual name.",
          }),
          calls: Count,
          errors: Count,
          approvals: Count,
          workspaces: Count,
        }),
      )
      .openapi({ description: `Most calls first, at most ${ANALYTICS_LIST_MAX}.` }),
    actions: z
      .array(
        z.object({
          action: z
            .string()
            .openapi({ description: "Composio's action or trigger slug.", example: "GMAIL_FETCH_EMAILS" }),
          ...ComposioCounts,
          workspaces: Count,
        }),
      )
      .openapi({ description: `Most executions first, at most ${ANALYTICS_LIST_MAX}.` }),
    orgs: z
      .array(
        z.object({
          orgId: z.uuid(),
          via: Via,
          calls: Count,
          errors: Count,
          approvals: Count,
          executions: Count,
          events: Count,
          agents: Count,
          accounts: Count.openapi({ description: "Its accounts of this connector connected now." }),
          lastDay: Day.nullable().openapi({ description: "Its last day with a count in the dates." }),
        }),
      )
      .openapi({
        description: `Per workspace and way, most calls first, at most ${ANALYTICS_ROWS_MAX}. One connected but idle in the dates has zero calls.`,
      }),
    orgsMore: z.boolean(),
  })
  .openapi("OperatorConnectorAnalytics");

const WorkRange = z.object({
  from: Range.shape.from,
  to: z.string().openapi({
    description: `The last UTC day, YYYY-MM-DD: at most ${WORK_ANALYTICS_MAX_DAYS} days, both counted. Else 400 \`analytics.range\`.`,
    example: "2026-10-31",
  }),
});
const Turns = z
  .object({
    total: Count.openapi({ description: "Agent turns (runs) created in the bucket." }),
    person: Count.openapi({ description: "Started by a person's message." }),
    agent: Count.openapi({
      description: "Agent to agent: started by another agent's message or answer, or 2+ agent replies deep.",
    }),
    routine: Count.openapi({ description: "Started by a routine (its run, its reminder, its report)." }),
    longWork: Count.openapi({ description: "Long work and other background runs." }),
    followUp: Count.openapi({
      description: "The agent coming back to its own work: a follow-up due, a wait or proposal ended, a check-in.",
    }),
    other: Count.openapi({ description: "Its trigger message is gone." }),
    done: Count,
    canceled: Count,
    active: Count.openapi({ description: "Not ended yet (queued, running, waiting)." }),
    failed: Count,
    computerBusy: Count.openapi({ description: "Failed: no room on its computer for the whole wait." }),
    noAi: Count.openapi({ description: "Failed: no AI to think with (no sign-in, no key, a revoked or wrong key)." }),
    paused: Count.openapi({ description: "Failed: the workspace or agent on hold or paused, or its budget spent." }),
    failedOther: Count,
  })
  .openapi("OperatorWorkTurns");
const Waits = z
  .object({
    waited: Count.openapi({ description: "Turns that waited for room on a computer." }),
    peakWaiting: Count.openapi({ description: "Most turns waiting for room at once (for a row, its own)." }),
    personReplies: Count.openapi({ description: "Person-started turns that replied." }),
    personFailed: Count.openapi({
      description: "Person-started turns that failed: they have no reply, so the reply times leave them out.",
    }),
    replyMedianSec: z.number().int().nullable().openapi({
      description:
        "Median seconds from a person-started turn's creation to its reply; null without one. Work it handed to another agent is not waited for.",
    }),
    replyP90Sec: z.number().int().nullable(),
  })
  .openapi("OperatorWorkWaits");
const Tokens = z
  .object({
    input: z.number().int().min(0).openapi({ description: "Uncached input tokens." }),
    output: z.number().int().min(0),
    cacheRead: z.number().int().min(0),
    cacheWrite: z.number().int().min(0),
    costUsd: z.number().openapi({ description: "What was billed through an API (a plan's tokens are 0)." }),
    apiEquivalentUsd: z.number().openapi({
      description: "Everything at API prices: a plan's tokens priced like the app's plan card (≈ … pela API).",
    }),
  })
  .openapi("OperatorWorkTokens");
const Payer = z.object({
  payer: z.string().openapi({
    description:
      "Who pays: `plan` (a computer brain's plan), `workspace_key` (the workspace's API key), `platform_key` (this server's model key, or a key since removed), `platform` (this server's own services).",
  }),
  ...Tokens.shape,
});
const WorkRow = {
  turns: Turns,
  waits: Waits,
  tokens: Tokens,
  agentShare: z.number().min(0).max(1).openapi({ description: "Agent-to-agent turns over all turns." }),
};
const workSeries = z.array(z.object({ at: z.string(), ...WorkRow, byPayer: z.array(Payer) })).openapi({
  description:
    "Oldest first, by `bucket`: `at` is YYYY-MM-DD, or YYYY-MM-DDTHH (UTC) by hour. A bucket with nothing is left out.",
});
const workTotals = z.object({
  ...WorkRow,
  byPayer: z.array(Payer).openapi({ description: "Most tokens first." }),
  turnsWithUsage: Count.openapi({ description: "Distinct turns that spent tokens in the dates." }),
  perTurn: z
    .object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count })
    .openapi({ description: "Tokens over `turnsWithUsage`." }),
});
const workCommon = {
  from: Day,
  to: Day,
  bucket: z
    .enum(["hour", "day"])
    .openapi({ description: `By hour for ${WORK_ANALYTICS_HOURLY_DAYS} days or fewer, else by day.` }),
  totals: workTotals,
  series: workSeries,
  more: z.boolean().openapi({ description: `More rows than the ${ANALYTICS_ROWS_MAX} listed.` }),
};
const WorkAnalytics = z
  .object({
    ...workCommon,
    workspaces: z
      .array(z.object({ orgId: z.uuid(), ...WorkRow }))
      .openapi({ description: `Most tokens first (then turns), at most ${ANALYTICS_ROWS_MAX}.` }),
  })
  .openapi("OperatorWorkAnalytics");
const OrgWorkAnalytics = z
  .object({
    ...workCommon,
    orgId: z.uuid(),
    agents: z.array(z.object({ agentId: z.uuid(), ...WorkRow })).openapi({
      description: `Most tokens first (then turns), at most ${ANALYTICS_ROWS_MAX}. The workspace's own usage (the router, embeddings) is only in the totals.`,
    }),
  })
  .openapi("OperatorOrgWorkAnalytics");

const AuthMethodOrUnknown = z.enum(["cli_login", "setup_token", "api_key", "unknown"]).openapi("OperatorAiAuthMethod", {
  description:
    "`cli_login`: the CLI's own sign-in, kept by the CLI. `setup_token`: `claude setup-token`'s token, kept by the runner. `api_key`: a pasted key. `unknown`: its computer never said.",
});
const Cause = z.string().openapi({
  description: `What the provider or the runner reported: ${PROVIDER_FAILURE_CAUSES.map((c) => `\`${c}\``).join(", ")}. Ignore values you don't know.`,
});
const AccountCounts = {
  connections: Count.openapi({ description: "Signed in or signed out (sign-ins in progress and removals left out)." }),
  usable: Count.openapi({ description: "Signed in, and its runner's last look was conclusive." }),
  signedOut: Count,
  unknown: Count.openapi({ description: "Its runner's last look at its status was inconclusive." }),
};
const AiAccounts = z
  .object({
    generatedAt: z.string(),
    from: Day,
    to: Day,
    totals: z.object({
      ...AccountCounts,
      inProgress: Count.openapi({ description: "Sign-ins started and not finished." }),
      removing: Count.openapi({ description: "Removed, waiting for their computer to confirm." }),
      workspaces: Count.openapi({ description: "Workspaces with at least one of `connections`." }),
      usedLast24h: Count.openapi({ description: "Of `connections`, used by a turn in the last 24 hours." }),
      usedLast7d: Count,
      apiCredentials: Count.openapi({ description: "Workspaces' model API keys not revoked." }),
      apiCredentialWorkspaces: Count,
      inheritedMachineLogins: Count.openapi({
        description:
          "Computers whose own Claude sign-in (no connection of its own) reports signed in. Counted apart: never in `connections`.",
      }),
    }),
    byDimension: z
      .array(
        z.object({
          provider: z.string().openapi({
            description:
              "`anthropic`, `openai`, `xai`, `google`, `cursor`, `opencode`, a coding plan's id, or an API key's provider.",
          }),
          runtime: z.string().openapi({
            description: "`claude_code`, `codex`, `grok`, `antigravity`, `cursor`, `opencode`, or `api` (an API key).",
          }),
          authMethod: AuthMethodOrUnknown,
          billing: z.enum(["subscription", "coding_plan", "metered_api", "unknown"]).openapi({
            description:
              "`subscription`: a CLI's sign-in to a plan. `coding_plan`: a coding plan's key. `metered_api`: an API key, billed per token.",
          }),
          ...AccountCounts,
          usedLast7d: Count,
        }),
      )
      .openapi({
        description: "Most connections first. An API key is usable while it isn't revoked; its use isn't counted here.",
      }),
    identity: z
      .object({
        withProviderIdentity: Count.openapi({
          description: "Connections whose email and provider organization are known.",
        }),
        withoutIdentity: Count,
        distinctProviderAccounts: Count.openapi({
          description:
            "Distinct (kind, email, provider organization) among those: one account signed in on several computers counts once.",
        }),
      })
      .openapi({ description: "Never by a key, a token or a label." }),
    failures: z.object({
      from: Day,
      to: Day,
      byCause: z
        .array(
          z.object({
            cause: Cause,
            authMethod: z.string().openapi({ description: "As the failure's event said, `unknown` if it didn't." }),
            attempts: Count.openapi({
              description: "`account.failure` events: at most one per account and cause every 10 minutes.",
            }),
            accounts: Count,
            workspaces: Count,
          }),
        )
        .openapi({ description: `Most attempts first, at most ${ANALYTICS_ROWS_MAX}.` }),
      recent: z
        .array(
          z.object({
            at: z.string(),
            orgId: z.uuid().nullable(),
            machineId: z.string().nullable(),
            accountId: z.string().nullable(),
            kind: z.string().nullable(),
            authMethod: z.string().nullable(),
            cause: Cause.nullable(),
            code: z.string().nullable().openapi({ description: "The runner's stable code, e.g. `not_logged_in`." }),
            runnerVersion: z.string().nullable(),
          }),
        )
        .openapi({ description: `Newest first, at most ${AI_ACCOUNTS_RECENT_FAILURES}.` }),
    }),
    added: z
      .array(z.object({ day: Day, authMethod: AuthMethodOrUnknown, count: Count }))
      .openapi({ description: "Oldest first. A day without any is left out." }),
    addedSource: z.enum(["events", "retained_rows"]).openapi({
      description:
        "`retained_rows`: from the connections still kept, by the day each was made (removed ones are gone).",
    }),
    coverage: z.object({
      eventsSince: z
        .string()
        .nullable()
        .openapi({ description: "The oldest event the feed keeps; failures before it are gone." }),
      notes: z.array(z.string()).openapi({
        description:
          "Fixed codes on what these numbers can't see: `inherited_logins_by_machine`, `api_credentials_no_usage_identity`, `added_from_retained_rows`.",
      }),
    }),
  })
  .openapi("OperatorAiAccounts");

const AiAccountQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  orgId: z.uuid().optional(),
  kind: z.enum(ACCOUNT_KINDS).optional(),
  authMethod: AuthMethodOrUnknown.optional(),
  status: z.enum(AI_ACCOUNT_STATUSES).optional(),
});
const AiAccountPage = z
  .object({
    accounts: z.array(
      z.object({
        id: z.uuid(),
        orgId: z.uuid(),
        orgName: z.string().openapi({ description: "The workspace's name." }),
        machineId: z.uuid(),
        machineName: z.string(),
        kind: z.string(),
        provider: z.string().nullable().openapi({
          description: "A coding plan's id, `cursor` or `zen` (keys), `enterprise`; null: the CLI's own sign-in.",
        }),
        authMethod: z.string().nullable(),
        label: z.string(),
        plan: z.string().nullable(),
        status: z.string().openapi({ description: AI_ACCOUNT_STATUSES.map((v) => `\`${v}\``).join(", ") }),
        statusUnknown: z.boolean(),
        shared: z.boolean().openapi({ description: "One sign-in thinks for every agent its owner gives it." }),
        ownerId: z.string().nullable(),
        agents: Count.openapi({ description: "Agents set to think with it." }),
        createdAt: z.string(),
        lastUsedAt: z.string().nullable(),
        lastSuccessAt: z.string().nullable(),
        lastFailureCause: Cause.nullable(),
        lastFailureAt: z.string().nullable(),
        usageAt: z.string().nullable().openapi({ description: "When its plan's usage was last read." }),
        usageSource: z.string().nullable().openapi({ description: "`turn` or `probe`." }),
        runnerVersion: z.string().nullable(),
        protocol: z.number().int(),
      }),
    ),
    next: z.string().nullable(),
  })
  .openapi("OperatorAiAccountPage");

export function registerOperatorAnalytics(api: OpenAPIHono, { db }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics",
      tags,
      summary: "How connectors and the product are used, in counts",
      description:
        "Counted on every server, by UTC day (ADR 0103). Only counts, keys and ids: no connection label, URL path, tool input, address or anyone's name.",
      request: { query: Range },
      responses: { 200: json(Analytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorAnalytics(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/connectors/{connector}",
      tags,
      summary: "One connector's use: per day, tool, Composio action and workspace",
      description: "An unknown connector answers with empty lists.",
      request: { params: ConnectorParams, query: Range },
      responses: { 200: json(ConnectorAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) =>
      c.json(await operatorConnectorAnalytics(db, c.req.valid("param").connector, c.req.valid("query")), 200),
  );

  const workDescription =
    "Turns and waits count runs created in the dates, tokens the usage recorded in them. Counts and ids only: no message, no name.";
  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/work",
      tags,
      summary: "Agent work and tokens across workspaces: per day (or hour) and per workspace",
      description: workDescription,
      request: { query: WorkRange },
      responses: { 200: json(WorkAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorWorkAnalytics(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/work/orgs/{orgId}",
      tags,
      summary: "One workspace's agent work and tokens: per day (or hour) and per agent",
      description: `${workDescription} An unknown workspace answers with zeros.`,
      request: { params: OrgParams, query: WorkRange },
      responses: { 200: json(OrgWorkAnalytics), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorOrgWorkAnalytics(db, c.req.valid("param").orgId, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/analytics/ai-accounts",
      tags,
      summary: "The AI accounts people connected: how they sign in, who bills them, how they fail",
      description:
        "Connections now, whatever the dates; failures from the events feed in the dates. Counts, ids and codes only: no email, key hint, token or provider organization id.",
      request: { query: Range },
      responses: { 200: json(AiAccounts), 400: errors[400], 401: errors[401] },
    }),
    async (c) => c.json(await operatorAiAccounts(db, c.req.valid("query")), 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/ai-accounts",
      tags,
      summary: "AI accounts on the workspaces' computers, newest first",
      description: "Keyset pages: an account added while paging never shifts a page. No email, key hint or token.",
      request: { query: AiAccountQuery },
      responses: { 200: json(AiAccountPage), 400: errorResponse("Invalid request"), 401: errors[401] },
    }),
    async (c) => {
      const page = await operatorListAiAccounts(db, c.req.valid("query"));
      const accounts = page.accounts.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
        lastUsedAt: iso(a.lastUsedAt),
        lastSuccessAt: iso(a.lastSuccessAt),
        lastFailureAt: iso(a.lastFailureAt),
      }));
      return c.json({ accounts, next: page.next }, 200);
    },
  );
}
