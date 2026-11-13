import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  announceMessageMemories,
  askProposal,
  type ContextItem,
  can,
  decideProposal,
  editContextItem,
  ForbiddenError,
  getAgent,
  isHowTo,
  isPlaybook,
  itemVisibleIn,
  itemWords,
  listAgentMemoryRows,
  listOrgMemoryRows,
  listProposals,
  listTeamMemories,
  makeTeamMemory,
  mayEditItem,
  memoryScorecard,
  NotFoundError,
  ownerDecides,
  type Proposal as ProposalRow,
  requirePermission,
  resolveNotifications,
  revertMemoryChange,
  SERVER_REASONS,
  SETTING_GROUP,
  settingsGroup,
  userVisibleChannels,
  WAITING_GROUP,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Knowledge"];

const Memory = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    kind: z.enum(["fact", "decision", "lesson", "preference", "rule"]).openapi({
      description:
        "`rule`: a lasting rule a person gave the agent (a permission, where to send things), followed in every run it does for them; `origin` says who and when.",
    }),
    text: z.string(),
    how: z.enum(["refused", "corrected"]).nullable().optional().openapi({
      description:
        "A lesson from something a person refused or corrected: `text` is what it is about, and the apps say the rest in the person's language.",
    }),
    source: z.string().openapi({ example: "Learned in #eng · Oct 12" }),
    origin: z
      .object({
        by: z.enum(["person", "app", "agent", "lesson", "recorded"]),
        name: z
          .string()
          .nullable()
          .openapi({ description: "The person who wrote it (`by: person`) or sent it through an AI app (`by: app`)." }),
        channel: z.string().nullable().openapi({ description: "Channel name, without `#`." }),
        at: z.string(),
      })
      .optional()
      .openapi({ description: "`source` in parts, for the app to say it in its language (`source` is English)." }),
    uses: z.number(),
    lastUsedAt: z.string().nullable(),
    pinned: z.boolean(),
    archived: z.boolean(),
    lowTrust: z
      .boolean()
      .openapi({ description: "Came from outside the team (webhook, tool output, public comment)." }),
    verified: z.boolean().openapi({ description: "Backed by an outcome or a person; agent claims alone are not." }),
    supersedes: z.string().nullable().openapi({ description: "The text this one replaced." }),
    editedByUserId: z.string().nullable(),
    learned: z.boolean().optional().openapi({
      description:
        'What the agent learned itself ("What it learned", ADR 0120): its own saves, its learning job\'s, and what a person said that it kept.',
    }),
    howTo: z.boolean().optional().openapi({ description: "A how-to the agent worked out (`save_how_to`)." }),
    summary: z.string().nullable().optional().openapi({
      description:
        "One plain line to show first, written when it was saved; `text` holds the detail. Null when it has none.",
    }),
    playbook: z.boolean().optional().openapi({
      description:
        'The agent\'s own how-tos, lessons and notes ("How it works"): no receipt in the chat, listed only for its owner and who manages agents.',
    }),
    disputed: z.boolean().optional().openapi({ description: "Another memory says otherwise, until a person decides." }),
    removable: z
      .boolean()
      .optional()
      .openapi({ description: "A `rule` the viewer may remove: its giver, the agent's owner or an admin." }),
    channelId: z.uuid().nullable().optional().openapi({ description: "Where it was learned." }),
    updatedAt: z.string(),
    from: z
      .object({
        messageId: z.uuid(),
        channelId: z.uuid(),
        threadId: z.string().nullable(),
        dm: z.boolean().openapi({ description: "Said in a direct conversation." }),
        at: z.string(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          '`?about=me` only: the viewer\'s message it came from (newest), to say "Você disse hoje, nesta conversa".',
      }),
  })
  .openapi("Memory");

const Proposal = z
  .object({
    id: z.uuid(),
    agentId: z.string().openapi({ description: "The agent it changes; empty for the org context." }),
    proposedByAgentId: z.string().openapi({
      description: "The agent that proposed it; older proposals and memory promotions: the agent it changes.",
    }),
    target: z.union([
      z.object({ type: z.literal("agent_instructions"), agentId: z.string() }),
      z.object({ type: z.literal("org_context") }),
      z.object({ type: z.literal("agent_role"), agentId: z.string() }),
      z.object({ type: z.literal("agent_access"), agentId: z.string() }),
      z.object({ type: z.literal("agent_settings"), agentId: z.string() }).openapi({
        description: "A teammate's settings, from the right hand's card (ADR 0137): the lines in `settings`.",
      }),
      z
        .object({
          type: z.literal("skill"),
          agentId: z.string(),
          skillId: z.string(),
          name: z.string(),
        })
        .openapi({ description: "A fix to a skill a person made, from the agent `agentId` that used it." }),
    ]),
    access: z
      .array(z.object({ id: z.string(), label: z.string(), on: z.boolean() }))
      .nullable()
      .openapi({
        description:
          "`agent_access`: each app turned on or off, as `request_permission` names it (a built-in scope or `connector:<connectionId>`, `label` in English).",
      }),
    settings: z
      .array(
        z.object({
          field: z.enum(Object.keys(SETTING_GROUP) as [keyof typeof SETTING_GROUP, ...(keyof typeof SETTING_GROUP)[]]),
          from: z.unknown(),
          to: z.unknown(),
          channelId: z.string().optional(),
          skillId: z.string().optional(),
          label: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
        }),
      )
      .nullable()
      .openapi({
        description:
          "`agent_settings`: each setting then (`from`) and proposed (`to`): `model` a model id; `ai_account` `{ brain, accountId }`; `budget` nano-USD a month or null (the workspace's default); `owner` a user id; `audience` `{ mode, userIds, roleIds }`; `channel_add` / `channel_remove` / `reply_mode` its seat in `channelId` (null: not in it, else whether it answers without a mention); `skill` whether it has the skill in `skillId` on; `archive` / `delete` true (deleting is for good, ADR 0082). `label`: names for ids.",
      }),
    requestedBy: z
      .object({ userId: z.string(), name: z.string() })
      .nullable()
      .openapi({ description: "The person who asked for it in conversation (null: memory promotions, older rows)." }),
    askedAt: z.string().nullable().openapi({
      description: 'When the person who asked sent it to whoever may decide it (`POST …/ask`, "Pedir a um admin").',
    }),
    undoActionId: z.string().nullable().openapi({
      description:
        "`agent_settings` once applied: its receipt on the card, for Desfazer (`POST …/agent-actions/{id}/undo`).",
    }),
    title: z.string(),
    why: z.string().openapi({ description: "Words of a person or an agent; empty when `whyCode` alone says it." }),
    whyCode: z.enum(["refused", "corrected", "seen", "skill", "asked", "budget", "no_channel"]).nullable().openapi({
      description:
        "How it came, for the apps to say in the person's language (`why` holds the words it is about, if any): a refusal or a correction it was made from, `seen` (its memory is gone), `skill` (from using the skill), `asked` (in a conversation, no reason given), `budget` or `no_channel` (the week's review of the team). Null: `why` as it is.",
    }),
    evidence: z.array(
      z.object({
        where: z.string(),
        what: z.string(),
        channelId: z.string().nullable().optional(),
        type: z.enum(["outcome", "human", "agent", "app", "self"]).optional().openapi({
          description: "Where the evidence came from; the app translates it (`where` is the English text).",
        }),
      }),
    ),
    before: z.string().openapi({ description: "`agent_role`: the role then; `agent_access`: empty." }),
    after: z.string(),
    status: z.enum(["pending", "accepted", "refused"]),
    stale: z
      .boolean()
      .openapi({ description: "What it was made against changed since (or its agent left); it can't be accepted." }),
    decider: z.union([
      z.object({ type: z.literal("user"), userId: z.string(), name: z.string() }),
      z.object({ type: z.literal("admins") }),
      z
        .object({ type: z.literal("account_owner") })
        .openapi({ description: "`agent_settings` of an AI account: only the account's owner gives it." }),
    ]),
    canDecide: z.boolean(),
    createdAt: z.string(),
    decidedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
    decidedAt: z.string().nullable(),
  })
  .openapi("Proposal");

/** The reason a proposal gives people: never a template or a line written for the agent. */
function proposalWhy(r: ProposalRow, items: ContextItem[]) {
  const words = items.map(itemWords);
  if (words.length > 0)
    return { why: words.map((w) => w.text).join(" "), whyCode: words.find((w) => w.how)?.how ?? null };
  if (r.target === "skill") return { why: "", whyCode: "skill" as const };
  if (r.itemIds.length > 0) return { why: "", whyCode: "seen" as const };
  const whyCode = SERVER_REASONS[r.rationale] ?? null;
  return { why: whyCode ? "" : r.rationale, whyCode };
}

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });

const KIND: Record<ContextItem["kind"], z.infer<typeof Memory>["kind"]> = {
  fact: "fact",
  decision: "decision",
  lesson: "lesson",
  preference: "preference",
  rule: "rule",
  note: "fact",
  open_question: "fact",
  entity_profile: "fact",
  thread_summary: "fact",
  period_summary: "fact",
};

/** `items` must be visible to the viewer; `visible` (the channels they read) also bounds the old versions shown. */
async function memoryViews(db: Database, items: ContextItem[], visible: readonly string[]) {
  if (items.length === 0) return [];
  const channelIds = [...new Set(items.flatMap((i) => i.channelIds))];
  const channels = channelIds.length
    ? await db
        .select({ id: schema.channels.id, name: schema.channels.name })
        .from(schema.channels)
        .where(inArray(schema.channels.id, channelIds))
    : [];
  const channelName = new Map(channels.map((c) => [c.id, c.name]));
  const replaced = await db
    .select({
      supersededBy: schema.contextItems.supersededBy,
      content: schema.contextItems.content,
      channelIds: schema.contextItems.channelIds,
    })
    .from(schema.contextItems)
    .where(
      inArray(
        schema.contextItems.supersededBy,
        items.map((i) => i.id),
      ),
    );
  // A version merged in from a channel the viewer can't read isn't quoted.
  const previous = new Map(
    replaced.filter((r) => itemVisibleIn(r, visible)).map((r) => [r.supersededBy, itemWords(r).text]),
  );
  const people = items.flatMap((i) => (i.createdByKind === "person" && i.createdById ? [i.createdById] : []));
  const names = new Map(
    (people.length
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, people))
      : []
    ).map((u) => [u.id, u.name]),
  );
  return items.map((i) => {
    const channel = i.channelIds[0] ? (channelName.get(i.channelIds[0]) ?? null) : null;
    const where = i.channelIds[0] ? ` in #${channel ?? "channel"}` : "";
    const name = i.createdByKind === "person" ? (names.get(i.createdById ?? "") ?? null) : null;
    const viaApp = i.evidence.some((e) => e.type === "app") && !i.evidence.some((e) => e.type === "human");
    const by =
      i.createdByKind === "person"
        ? viaApp
          ? ("app" as const)
          : ("person" as const)
        : i.createdByKind === "agent"
          ? ("agent" as const)
          : i.kind === "lesson"
            ? ("lesson" as const)
            : ("recorded" as const);
    const how = {
      person: `Written by ${name ?? "a person"}`,
      app: `Sent by ${name ?? "a person"} through an AI app`,
      agent: "Noted by the agent",
      lesson: "Learned",
      recorded: "Recorded",
    }[by];
    return {
      id: i.id,
      agentId: i.agentId ?? "",
      kind: KIND[i.kind],
      ...itemWords(i),
      source: `${how}${where} · ${shortDate(i.createdAt)}`,
      origin: { by, name, channel, at: i.createdAt.toISOString() },
      uses: i.useCount,
      lastUsedAt: i.lastUsedAt ? i.lastUsedAt.toISOString() : null,
      pinned: i.pinned,
      archived: i.status === "archived",
      lowTrust: i.trust === "low",
      verified: i.verified,
      supersedes: previous.get(i.id) ?? null,
      editedByUserId: i.createdByKind === "person" ? i.createdById : null,
      learned: i.kind !== "rule" && (i.createdByKind !== "person" || i.sourceIds.length > 0 || viaApp),
      howTo: isHowTo(i),
      summary: i.title.trim() && i.title.trim() !== i.content.trim() ? i.title.trim() : null,
      playbook: isPlaybook(i),
      disputed: i.disputed,
      channelId: i.channelIds[0] ?? null,
      updatedAt: i.updatedAt.toISOString(),
    };
  });
}

/** What "O que sabe sobre você" lists (summaries and open questions are the agent's own bookkeeping). */
const ABOUT_KINDS = new Set<ContextItem["kind"]>(["fact", "decision", "lesson", "preference", "note"]);

/** Items saved from the viewer's own messages → the newest such message (where and when they said it). */
async function viewerSources(db: Database, orgId: string, viewerId: string, items: ContextItem[]) {
  const out = new Map<
    string,
    { messageId: string; channelId: string; threadId: string | null; dm: boolean; at: string }
  >();
  const ids = [...new Set(items.flatMap((i) => i.sourceIds))];
  if (ids.length === 0) return out;
  const said = await db
    .select({
      id: schema.messages.id,
      channelId: schema.messages.channelId,
      threadId: schema.messages.threadId,
      createdAt: schema.messages.createdAt,
      kind: schema.channels.kind,
    })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(
      and(
        eq(schema.messages.orgId, orgId),
        inArray(schema.messages.id, ids),
        eq(schema.messages.authorType, "person"),
        eq(schema.messages.authorUserId, viewerId),
      ),
    );
  const byId = new Map(said.map((m) => [m.id, m]));
  for (const item of items) {
    const newest = item.sourceIds
      .flatMap((id) => (byId.get(id) ? [byId.get(id) as (typeof said)[number]] : []))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!newest) continue;
    out.set(item.id, {
      messageId: newest.id,
      channelId: newest.channelId,
      threadId: newest.threadId,
      dm: newest.kind === "dm",
      at: newest.createdAt.toISOString(),
    });
  }
  return out;
}

/** Lines kept or removed in the diff = the text before. */
const TITLE: Record<ProposalRow["target"], (name: string) => string> = {
  agent_instructions: (name) => `Update ${name}'s instructions`,
  agent_role: (name) => `Change ${name}'s role`,
  agent_access: (name) => `Change ${name}'s access`,
  org_context: () => "Update the organization context",
  skill: (name) => `Fix the skill ${name}`,
  agent_settings: (name) => `Change ${name}'s settings`,
};

const beforeOf = (diff: string) =>
  diff
    .split("\n")
    .filter((l) => l.startsWith(" ") || l.startsWith("-"))
    .map((l) => l.slice(1))
    .join("\n");

async function proposalViews(db: Database, rows: (ProposalRow & { canDecide: boolean })[]) {
  const agentIds = [...new Set(rows.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  const agents = agentIds.length
    ? await db.select().from(schema.agents).where(inArray(schema.agents.id, agentIds))
    : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const userIds = [
    ...new Set([
      ...agents.flatMap((a) => (a.ownerUserId ? [a.ownerUserId] : [])),
      ...rows.flatMap((r) => (r.decidedByUserId ? [r.decidedByUserId] : [])),
      ...rows.flatMap((r) => (r.requestedByUserId ? [r.requestedByUserId] : [])),
    ]),
  ];
  const users = new Map(
    (userIds.length
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : []
    ).map((u) => [u.id, u.name]),
  );
  const itemIds = [...new Set(rows.flatMap((r) => r.itemIds))];
  const items = itemIds.length
    ? await db.select().from(schema.contextItems).where(inArray(schema.contextItems.id, itemIds))
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const applied = rows.filter((r) => r.target === "agent_settings" && r.status === "accepted").map((r) => r.id);
  const receipts = applied.length
    ? await db
        .select({ id: schema.agentActions.id, proposalId: sql<string>`${schema.agentActions.params}->>'proposalId'` })
        .from(schema.agentActions)
        .where(
          and(
            eq(schema.agentActions.kind, "agent.settings_changed"),
            inArray(sql`${schema.agentActions.params}->>'proposalId'`, applied),
          ),
        )
    : [];
  const receiptOf = new Map(receipts.map((r) => [r.proposalId, r.id]));
  const evidenceLabel = {
    outcome: "Observed outcome",
    human: "A person",
    agent: "Another agent",
    app: "Sent through an AI app",
    self: "The agent itself",
  };
  return rows.map((r) => {
    const agent = r.agentId ? agentById.get(r.agentId) : undefined;
    const owner = agent?.ownerUserId;
    const sourceItems = r.itemIds.flatMap((id) => (itemById.get(id) ? [itemById.get(id) as ContextItem] : []));
    const name = agent?.name ?? "the agent";
    return {
      id: r.id,
      agentId: r.agentId ?? "",
      proposedByAgentId: r.proposedByAgentId ?? r.agentId ?? "",
      target:
        r.target === "skill" && r.agentId
          ? {
              type: "skill" as const,
              agentId: r.agentId,
              skillId: r.access?.[0]?.id ?? "",
              name: r.access?.[0]?.label ?? "",
            }
          : r.target !== "org_context" && r.target !== "skill" && r.agentId
            ? { type: r.target, agentId: r.agentId }
            : { type: "org_context" as const },
      access: r.target === "agent_access" ? (r.access ?? []) : null,
      settings: r.target === "agent_settings" ? (r.settings ?? []) : null,
      requestedBy: r.requestedByUserId
        ? { userId: r.requestedByUserId, name: users.get(r.requestedByUserId) ?? "" }
        : null,
      askedAt: r.askedAt ? r.askedAt.toISOString() : null,
      undoActionId: receiptOf.get(r.id) ?? null,
      title: TITLE[r.target](r.target === "skill" ? (r.access?.[0]?.label ?? "") : name),
      ...proposalWhy(r, sourceItems),
      evidence: sourceItems.flatMap((i) =>
        i.evidence.map((e) => ({
          where: evidenceLabel[e.type],
          what: itemWords(i).text,
          channelId: i.channelIds[0] ?? null,
          type: e.type,
        })),
      ),
      before: beforeOf(r.diff),
      after: r.proposedText,
      status:
        r.status === "accepted"
          ? ("accepted" as const)
          : r.status === "pending"
            ? ("pending" as const)
            : ("refused" as const),
      stale: r.status === "stale",
      decider:
        ownerDecides(r) && owner
          ? { type: "user" as const, userId: owner, name: users.get(owner) ?? "" }
          : r.target === "agent_settings" && settingsGroup(r) === "account"
            ? { type: "account_owner" as const }
            : { type: "admins" as const },
      canDecide: r.canDecide,
      createdAt: r.createdAt.toISOString(),
      decidedBy: r.decidedByUserId ? { userId: r.decidedByUserId, name: users.get(r.decidedByUserId) ?? "" } : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    };
  });
}

/** "O que a Ada sabe" and improvement proposals, in the shapes the web app uses. */
export function memoryRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/memories",
      tags,
      security,
      summary: "What all the agents know: the current memories the viewer may see, newest first",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ memories: z.array(Memory) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { items, visible } = await listOrgMemoryRows(db, c.get("user").id, orgId);
      return c.json({ memories: await memoryViews(db, items, visible) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/memory-scorecard",
      tags,
      security,
      summary:
        "One agent's memory over the last `days` (ADR 0167): how-to reuse cost, repeated preferences, corrections, what it opened, and the holdout's two arms (the agent's owner or who reviews memory)",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        query: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }),
      },
      responses: {
        200: json(
          z.object({
            days: z.number(),
            runs: z.number(),
            howTos: z.object({ runs: z.number(), costNanoUsd: z.number(), writersCostNanoUsd: z.number() }),
            repeatedPreferences: z.number(),
            correctionsPer100: z.number(),
            sent: z.number(),
            opened: z.number(),
            arms: z.object({
              with: z.object({ runs: z.number(), refusedPer100: z.number() }),
              without: z.object({ runs: z.number(), refusedPer100: z.number() }),
            }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const userId = c.get("user").id;
      const membership = await requirePermission(db, userId, orgId, "read");
      const agent = await getAgent(db, orgId, agentId);
      if (!agent) throw new NotFoundError("Agent not found");
      if (!can(membership, "review_memory") && agent.ownerUserId !== userId)
        throw new ForbiddenError("Only the agent's owner or who reviews memory sees this");
      return c.json(await memoryScorecard(db, orgId, agentId, c.req.valid("query").days ?? 7), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team-memories",
      tags,
      security,
      summary:
        "Memória do time (ADR 0167): what people asked every agent to keep, newest first, where the viewer reads it",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ memories: z.array(Memory) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { items, visible } = await listTeamMemories(db, c.get("user").id, orgId);
      return c.json({ memories: await memoryViews(db, items, visible) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/memories/{memoryId}/team",
      tags,
      security,
      summary:
        "Tornar do time (ADR 0167): an agent's memory becomes the team's, and the copies agents kept of it are archived (who reviews memory)",
      request: { params: OrgParams.extend({ memoryId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(Memory), ...errors },
    }),
    async (c) => {
      const { orgId, memoryId } = c.req.valid("param");
      const row = await makeTeamMemory(db, c.get("user").id, orgId, memoryId);
      const [view] = await memoryViews(db, [row], await userVisibleChannels(db, orgId, c.get("user").id));
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/memories",
      tags,
      security,
      summary: "What an agent knows: its notes and lessons (archived included, flagged)",
      description:
        "`about=me`: only what came from the viewer (saved from their messages, or written by them), " +
        "each with `from` (the message it came from).",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        query: z.object({ about: z.enum(["me"]).optional() }),
      },
      responses: { 200: json(z.object({ memories: z.array(Memory) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const viewerId = c.get("user").id;
      await requirePermission(db, viewerId, orgId, "read");
      if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
      // Only what the viewer may see: items learned in a DM or private channel they can't read stay out.
      const { items: rows, visible } = await listAgentMemoryRows(db, viewerId, orgId, agentId);
      const current = rows
        .filter((r) => !r.supersededBy)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.getTime() - a.updatedAt.getTime());
      if (c.req.valid("query").about !== "me") {
        const views = await memoryViews(db, current, visible);
        const rules = new Map(current.filter((i) => i.kind === "rule").map((i) => [i.id, i]));
        const removable = new Map(
          await Promise.all([...rules].map(async ([id, i]) => [id, await mayEditItem(db, viewerId, i)] as const)),
        );
        return c.json(
          { memories: views.map((v) => (rules.has(v.id) ? { ...v, removable: removable.get(v.id) } : v)) },
          200,
        );
      }
      const mine = await viewerSources(db, orgId, viewerId, current);
      const about = current.filter(
        (i) =>
          ABOUT_KINDS.has(i.kind) && (mine.has(i.id) || (i.createdByKind === "person" && i.createdById === viewerId)),
      );
      const views = await memoryViews(db, about, visible);
      return c.json({ memories: views.map((v) => ({ ...v, from: mine.get(v.id) ?? null })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/memories/{memoryId}",
      tags,
      security,
      summary:
        "Edit (keeps history), pin or archive a memory (agent owner or admin; a rule people gave: its giver too), or confirm it (`confirmed`: trusted and verified, ADR 0167; also the person who said it)",
      request: {
        params: OrgParams.extend({ memoryId: z.uuid() }),
        body: body(
          z.object({
            text: z.string().min(1).max(8000).optional(),
            pinned: z.boolean().optional(),
            archived: z.boolean().optional(),
            confirmed: z.literal(true).optional(),
          }),
        ),
      },
      responses: { 200: json(Memory), ...errors },
    }),
    async (c) => {
      const { orgId, memoryId } = c.req.valid("param");
      const input = c.req.valid("json");
      const row = await editContextItem(db, c.get("user").id, orgId, memoryId, {
        content: input.text,
        pinned: input.pinned,
        archived: input.archived,
        confirmed: input.confirmed,
      });
      // The memory mark on the message it came from changes for everyone in the channel.
      await announceMessageMemories({ db, pubsub: deps.adapters.pubsub }, orgId, row).catch(() => {});
      const [view] = await memoryViews(db, [row], await userVisibleChannels(db, orgId, c.get("user").id));
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/memories/{memoryId}/revert",
      tags,
      security,
      summary: "Undo a memory change made in conversation (forgotten → back, updated → previous, new → archived)",
      request: { params: OrgParams.extend({ memoryId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(Memory), ...errors },
    }),
    async (c) => {
      const { orgId, memoryId } = c.req.valid("param");
      const row = await revertMemoryChange(db, c.get("user").id, orgId, memoryId);
      await announceMessageMemories({ db, pubsub: deps.adapters.pubsub }, orgId, row).catch(() => {});
      const [view] = await memoryViews(db, [row], await userVisibleChannels(db, orgId, c.get("user").id));
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/proposals",
      tags,
      security,
      summary: "Proposed changes to agents' instructions, roles and access, or to the org context",
      request: {
        params: OrgParams,
        query: z.object({
          status: z.enum(["pending", "accepted", "refused"]).optional(),
          agentId: z.uuid().optional(),
          ids: z
            .string()
            .max(100 * 37)
            .optional()
            .openapi({
              description:
                "Comma-separated ids, at most 100: only these (a chat card's `proposalIds`). Without it, the newest 200, pending ones first.",
            }),
        }),
      },
      responses: { 200: json(z.object({ proposals: z.array(Proposal) })), ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const rows = await listProposals(db, c.get("user").id, c.req.valid("param").orgId, {
        agentId: q.agentId,
        status: q.status === "refused" ? "rejected" : q.status,
        ids: q.ids?.split(",").filter((id) => z.uuid().safeParse(id).success),
      });
      // An inbox row can outlive what it was for (the text changed by hand, the agent archived): this list ends it.
      if (!q.ids && !q.status && !q.agentId && !rows.some((r) => r.canDecide))
        await resolveNotifications({ db, pubsub: deps.adapters.pubsub }, c.req.valid("param").orgId, {
          groupKey: WAITING_GROUP,
          userIds: [c.get("user").id],
        });
      return c.json({ proposals: await proposalViews(db, rows) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/proposals/{proposalId}/ask",
      tags,
      security,
      summary: 'Send a proposal you asked for and can\'t decide to whoever may ("Pedir a um admin")',
      description:
        "Only the person who asked for it (403 `proposal.not_requester`), once (409 `proposal.asked`), while it is open (409 `proposal.decided`) and only when they can't decide it themselves (409 `proposal.yours`). Each person who may decide it gets a waiting inbox entry (`change_request`).",
      request: { params: OrgParams.extend({ proposalId: z.uuid() }) },
      responses: { 200: json(Proposal), ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      const actorId = c.get("user").id;
      await askProposal({ db, pubsub: deps.adapters.pubsub }, actorId, orgId, proposalId);
      const [row] = await listProposals(db, actorId, orgId, { ids: [proposalId] });
      if (!row) throw new NotFoundError("Proposal not found");
      const [view] = await proposalViews(db, [row]);
      return c.json(view, 200);
    },
  );

  for (const decision of ["accept", "refuse"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/proposals/{proposalId}/${decision}`,
        tags,
        security,
        summary:
          decision === "accept"
            ? "Accept (instructions and the org context: optionally with adjusted text), applied server-side as you: a role or access only as far as you may change them on the agent's page. 409 when what it was made against changed since."
            : "Refuse",
        request: {
          params: OrgParams.extend({ proposalId: z.uuid() }),
          body: body(z.object({ text: z.string().max(50_000).optional() })),
        },
        responses: { 200: json(Proposal), ...errors },
      }),
      async (c) => {
        const { orgId, proposalId } = c.req.valid("param");
        const actorId = c.get("user").id;
        await decideProposal(db, actorId, orgId, proposalId, decision === "accept" ? "accept" : "reject", {
          finalText: decision === "accept" ? c.req.valid("json").text : undefined,
          pubsub: deps.adapters.pubsub,
          blobs: deps.extras?.artifacts?.blobs,
          deletion: { hub: deps.extras?.sandbox?.machines?.hub ?? null, mail: deps.adapters.mail },
        });
        const [row] = await listProposals(db, actorId, orgId, { ids: [proposalId] });
        if (!row) throw new NotFoundError("Proposal not found");
        const [view] = await proposalViews(db, [row]);
        return c.json(view, 200);
      },
    );
  }

  return app;
}
