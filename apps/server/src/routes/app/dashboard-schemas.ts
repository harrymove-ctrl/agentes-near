import {
  WIDGET_FORMATS,
  WIDGET_KINDS,
  WIDGET_LIMITS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  WIDGET_STATUSES,
} from "@agenteschat/ui/widgets/spec";
import { z } from "@hono/zod-openapi";

/**
 * Request and response bodies of the boards and widgets routes (ADR 0135), mirroring the engine's views
 * (`packages/engine/src/dashboards/types.ts`). A widget's data is checked by `validateWidgetSpec` where it is made
 * (the agents' tools, a pin), so here it only describes it.
 */

export const WidgetKind = z.enum(WIDGET_KINDS).openapi("WidgetKind");
export const WidgetFormat = z
  .enum(WIDGET_FORMATS)
  .openapi("WidgetFormat", { description: "A kind, or `auto`: the agent picks the kind that shows the ask best." });
export const WidgetSchedule = z.enum(WIDGET_SCHEDULES).openapi("WidgetSchedule", {
  description:
    "`half` every 30 minutes (the floor), `hour` on the hour, `day` at 08:00, `week` Mondays at 08:00 (in the time zone of who set it up), `manual` only when asked.",
});
export const WidgetSize = z.enum(WIDGET_SIZES).openapi("WidgetSize", { description: "S = 1×1, M = 2×1, L = 2×2." });
export const WidgetStatus = z.enum(WIDGET_STATUSES).openapi("WidgetStatus");
export const DashboardAudience = z.enum(["workspace", "roles", "private"]).openapi("DashboardAudience", {
  description: "Every member, whoever holds one of `roleIds` at the time, or only its owner.",
});
export const DashboardEditPolicy = z.enum(["viewers", "owner", "roles"]).openapi("DashboardEditPolicy", {
  description:
    "Whoever sees it; only its owner and admins; or, besides them, whoever sees it and holds one of `editRoleIds`.",
});

const Span = z.union([z.literal(1), z.literal(2)]);

export const WidgetSpec = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("kpi"),
      value: z.number(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      delta: z
        .object({ text: z.string(), up: z.boolean().openapi({ description: "The good direction, any sign." }) })
        .optional(),
      note: z.string().optional(),
      spark: z.array(z.number()).optional(),
    }),
    z.object({
      kind: z.literal("goal"),
      pct: z.number().openapi({ description: "0–100." }),
      line: z.string(),
      note: z.string().optional(),
    }),
    z.object({
      kind: z.literal("bars"),
      labels: z.array(z.string()).max(WIDGET_LIMITS.points),
      values: z.array(z.number()).max(WIDGET_LIMITS.points),
      alertIndex: z.number().int().optional(),
      unit: z.string().optional(),
      note: z.string().optional(),
    }),
    z.object({
      kind: z.literal("line"),
      labels: z.array(z.string()).max(WIDGET_LIMITS.points),
      values: z.array(z.number()).max(WIDGET_LIMITS.points),
      unit: z.string().optional(),
      note: z.string().optional(),
    }),
    z.object({
      kind: z.literal("list"),
      rows: z
        .array(z.object({ text: z.string(), meta: z.string().optional(), tone: z.enum(["ok", "warn"]).optional() }))
        .max(WIDGET_LIMITS.rows),
    }),
    z.object({ kind: z.literal("text"), items: z.array(z.string()).max(WIDGET_LIMITS.items) }),
  ])
  .openapi("WidgetSpec", { description: "What a widget draws (`@agenteschat/ui/widgets/spec`)." });

export const HomeTile = z
  .object({ key: z.enum(["waiting", "working"]), position: z.number(), w: Span, h: Span })
  .openapi("HomeTile", { description: "A home board's fixed tile (Waiting on you, Working now) among its widgets." });

const DashboardOwner = z.object({ kind: z.enum(["person", "agent"]), id: z.string(), name: z.string() });

const DashboardProposal = z
  .object({
    audience: z.enum(["workspace", "roles"]),
    roleIds: z.array(z.uuid()),
    agentId: z.uuid(),
    why: z.string(),
    at: z.string(),
    canDecide: z.boolean().openapi({ description: "The caller is the person it asks: Publish or Keep only for me." }),
  })
  .openapi("DashboardProposal", { description: "An agent asks to show the board to more people (ADR 0135 §11)." });

export const DashboardSummary = z
  .object({
    id: z.uuid(),
    kind: z.enum(["board", "home"]),
    title: z.string().openapi({ description: "Empty for a home board: the apps say “My Home”." }),
    about: z.string(),
    audience: DashboardAudience,
    roleIds: z.array(z.uuid()),
    editPolicy: DashboardEditPolicy,
    editRoleIds: z
      .array(z.uuid())
      .openapi({ description: "With `editPolicy` `roles`: the roles whose holders edit it when they see it." }),
    pinned: z.boolean(),
    position: z.number(),
    owner: DashboardOwner.nullable().openapi({ description: "The agent that made it, else the person who owns it." }),
    ownerUserId: z.string().nullable(),
    mine: z.boolean(),
    widgetCount: z.number().int(),
    thumbs: z.array(z.object({ agentId: z.uuid(), w: Span })),
    viewerCount: z.number().int(),
    canEdit: z.boolean(),
    canManage: z.boolean().openapi({ description: "Share, delete and pin: its owner and admins." }),
    proposal: DashboardProposal.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("DashboardSummary");

export const DashboardList = z
  .object({
    home: DashboardSummary.nullable().openapi({ description: "The caller's home board; null until first opened." }),
    dashboards: z.array(DashboardSummary),
    homeDashboardId: z
      .string()
      .nullable()
      .openapi({ description: "The board Início shows instead of the caller's own home; null = their own." }),
  })
  .openapi("DashboardList");

export const HomeChoice = z
  .object({
    homeDashboardId: z
      .uuid()
      .nullable()
      .openapi({ description: "A board the caller sees, shown on their Início; null = their own home board." }),
  })
  .openapi("HomeChoice");

export const Widget = z
  .object({
    id: z.uuid(),
    dashboardId: z.uuid(),
    agentId: z.uuid(),
    title: z.string(),
    prompt: z.string(),
    format: WidgetFormat,
    kind: WidgetKind.nullable(),
    spec: WidgetSpec.nullable().openapi({ description: "Null while it is first built." }),
    sources: z.array(z.string()),
    layout: z.object({ position: z.number(), w: Span, h: Span }),
    schedule: WidgetSchedule,
    alert: z.object({ enabled: z.boolean(), condition: z.string() }),
    status: WidgetStatus,
    failure: z
      .object({
        code: z.string().openapi({
          description:
            "`agent_reported` (show `detail` as is), `no_update`, `error`, or a routine's code (`budget_exceeded`…).",
        }),
        detail: z.string().nullable(),
      })
      .nullable(),
    refreshedAt: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    routineId: z.uuid().nullable(),
    sourceMessageId: z.uuid().nullable(),
    createdBy: z.object({ kind: z.enum(["person", "agent"]), id: z.string() }).nullable(),
    draft: z.boolean().openapi({
      description: "A test not created yet (“Test” in New widget): only its creator sees it, on no board.",
    }),
    lastCostUsd: z.number().nullable().openapi({
      description: "What its latest update cost (“This test cost $0.01”); null on a plan or before it is known.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Widget");

export const Dashboard = DashboardSummary.extend({
  widgets: z.array(Widget),
  tiles: z.array(HomeTile),
}).openapi("Dashboard");

export const WidgetUpdate = z
  .object({
    id: z.uuid(),
    at: z.string(),
    status: z.enum(["ok", "failed"]),
    summary: z.string(),
    alert: z.string().nullable(),
    failureCode: z.string().nullable(),
    change: z.string().nullable(),
    costUsd: z.number().nullable(),
  })
  .openapi("WidgetUpdate");

export const WidgetDetail = Widget.extend({
  dashboard: z.object({ id: z.uuid(), kind: z.enum(["board", "home"]), title: z.string() }),
  canEdit: z.boolean(),
  history: z.array(WidgetUpdate).openapi({ description: "The latest updates, newest first." }),
  step: z
    .object({
      tool: z.string(),
      connector: z.string().nullable(),
      service: z.string().nullable(),
      at: z.string(),
    })
    .nullable()
    .openapi({
      description:
        "While it is building or updating: the tool call its run is in (the app says it in words). Null between calls and otherwise.",
    }),
}).openapi("WidgetDetail");

export const WidgetCostEstimate = z
  .object({
    agentId: z.uuid(),
    schedule: WidgetSchedule,
    runsPerDay: z.number(),
    perRunUsd: z.number().nullable(),
    perDayUsd: z.number().nullable(),
    perWeekUsd: z.number().nullable(),
    basis: z.enum(["history", "model", "none"]),
    billedTo: z.enum(["api", "plan"]),
  })
  .openapi("WidgetCostEstimate");

export const WidgetSuggestions = z
  .object({
    agentId: z.uuid(),
    sources: z.array(z.string()),
    suggestions: z.array(z.object({ title: z.string(), prompt: z.string(), kind: WidgetKind, alert: z.string() })),
  })
  .openapi("WidgetSuggestions");

export const PinnableBlock = z
  .object({
    messageId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    agentId: z.uuid(),
    at: z.string(),
    block: z.string().openapi({ description: "The ```chart block's JSON text: send it back as is to pin it." }),
    title: z.string(),
    spec: WidgetSpec,
    place: z.object({ kind: z.enum(["channel", "dm", "thread"]), name: z.string().nullable() }),
  })
  .openapi("PinnableBlock");

// ── Requests ─────────────────────────────────────────────────────────────────

const AlertInput = z.object({ enabled: z.boolean(), condition: z.string().max(200) });

export const CreateDashboardBody = z
  .object({
    title: z.string().trim().min(1).max(80),
    about: z.string().max(280).optional(),
    audience: DashboardAudience,
    roleIds: z.array(z.uuid()).max(100).optional(),
    editPolicy: DashboardEditPolicy,
    editRoleIds: z.array(z.uuid()).max(100).optional(),
  })
  .openapi("CreateDashboard");

export const UpdateDashboardBody = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    about: z.string().max(280).optional(),
    pinned: z.boolean().optional(),
  })
  .openapi("UpdateDashboard");

export const ShareDashboardBody = z
  .object({
    audience: DashboardAudience,
    roleIds: z.array(z.uuid()).max(100),
    editPolicy: DashboardEditPolicy,
    editRoleIds: z.array(z.uuid()).max(100).optional(),
  })
  .openapi("ShareDashboard");

export const DashboardLayoutBody = z
  .object({
    widgets: z.array(z.object({ id: z.uuid(), position: z.number(), w: Span, h: Span })).max(100),
    tiles: z.array(HomeTile).max(2).optional(),
  })
  .openapi("DashboardLayout");

export const DashboardProposalBody = z.object({ decision: z.enum(["publish", "keep"]) }).openapi("DashboardDecision");

export const CreateWidgetBody = z
  .object({
    agentId: z.uuid(),
    prompt: z.string().trim().min(1).max(2000),
    title: z.string().trim().min(1).max(80).optional(),
    format: WidgetFormat,
    schedule: WidgetSchedule,
    alert: AlertInput.optional(),
    size: WidgetSize.optional(),
  })
  .openapi("CreateWidget");

export const PinWidgetBody = z
  .object({
    messageId: z.uuid(),
    block: z.string().min(2).max(20_000),
    schedule: WidgetSchedule,
    size: WidgetSize.optional(),
    title: z.string().trim().min(1).max(80).optional(),
  })
  .openapi("PinWidget");

export const UpdateWidgetBody = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    prompt: z.string().trim().min(1).max(2000).optional(),
    schedule: WidgetSchedule.optional(),
    alert: AlertInput.optional(),
    size: WidgetSize.optional(),
    dashboardId: z.uuid().optional().openapi({ description: "Move it to another board the caller edits." }),
  })
  .openapi("UpdateWidget");

export const ConfirmWidgetBody = z
  .object({
    dashboardId: z.uuid().openapi({ description: "The board it goes on, first (one the caller edits)." }),
    title: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .openapi({ description: "A title the caller gave (kept from then on); absent: the one its agent wrote." }),
    size: WidgetSize,
    schedule: WidgetSchedule,
    alert: AlertInput,
  })
  .openapi("ConfirmWidget");

export const WidgetChangeBody = z.object({ text: z.string().trim().min(1).max(1000) }).openapi("WidgetChange");

export const DashboardParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  dashboardId: z.uuid().openapi({ param: { name: "dashboardId", in: "path" } }),
});

export const WidgetParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  widgetId: z.uuid().openapi({ param: { name: "widgetId", in: "path" } }),
});

export const WidgetAgentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  agentId: z.uuid().openapi({ param: { name: "agentId", in: "path" } }),
});

export const WidgetCostQuery = z.object({ agentId: z.uuid(), schedule: WidgetSchedule });

export const PinnableQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });
