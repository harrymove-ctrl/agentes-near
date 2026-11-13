import { and, desc, eq, gte, isNotNull, isNull, like, schema } from "@agenteschat/db";
import {
  chartBlocksOf,
  chartBlockToWidgetSpec,
  clipText,
  isWidgetSchedule,
  isWidgetSize,
} from "@agenteschat/ui/widgets/spec";
import { getAgent } from "../agents";
import { canTalkTo, speakerOf } from "../audience";
import { requireChannelAccess } from "../channels";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requireActiveMembership } from "../organizations";
import { requireDashboard } from "./access";
import { insertWidget, widgetView } from "./service";
import {
  DASHBOARD_ERRORS,
  type DashboardDeps,
  type PinnableBlockView,
  type PinWidgetInput,
  WIDGET_PROMPT_MAX,
  WIDGET_TITLE_MAX,
  type WidgetView,
} from "./types";

const { messages, channels, channelMembers } = schema;

/** "Pin" a chart an agent sent in chat (ADR 0135 §3). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far back "Pin from chat" looks. */
const PINNABLE_DAYS = 30;
/** Messages read for "Pin from chat" before their charts are picked out. */
const PINNABLE_SCAN = 200;
/** What of the message around a chart goes into the widget's instructions. */
const CONTEXT_MAX = 600;

const blockNotFound = () => new NotFoundError("That chart isn't in the message", DASHBOARD_ERRORS.blockNotFound);

/** A message's words without its chart blocks, on one line. */
const textAround = (body: string) =>
  body
    .replace(/```chart[^\S\n]*\n[\s\S]*?\n?```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTEXT_MAX)
    .trim();

/**
 * The standing instructions of a pinned chart's widget (its refresh run reads them, ADR 0135 §5): keep the chart up
 * to date, with what the chart and its message said.
 */
export function pinnedWidgetPrompt(chart: { title: string; subtitle?: string | null }, body: string): string {
  const lines = [`Keep this chart up to date with fresh data: "${chart.title}".`];
  if (chart.subtitle) lines.push(`Its subtitle: ${chart.subtitle}.`);
  const around = textAround(body);
  if (around) lines.push(`It was sent in a conversation with this text: ${around}`);
  return lines.join("\n").slice(0, WIDGET_PROMPT_MAX);
}

const subtitleOf = (block: string): string | null => {
  try {
    const raw = JSON.parse(block) as { subtitle?: unknown };
    return typeof raw.subtitle === "string" && raw.subtitle.trim() ? raw.subtitle.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
};

/**
 * Pins the ```chart block `input.block` of message `input.messageId` to a board the person edits: the person must read
 * the message (its channel or thread), the message must be an agent's and hold that block (`chartBlocksOf`, compared
 * trimmed) that `chartBlockToWidgetSpec` reads. The widget keeps the block's data (`ok`), its agent is the message's,
 * its title the chart's (or `input.title`), its instructions "keep this up to date" with the chart's title, subtitle
 * and the message's text around it, and `source_message_id` the message. A schedule other than `manual` needs the
 * person to be able to talk to the agent and makes its routine.
 */
export async function pinMessageAsWidget(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  input: PinWidgetInput,
): Promise<WidgetView> {
  const { board, membership } = await requireDashboard(deps.db, actorId, orgId, dashboardId, "edit");
  if (!isWidgetSchedule(input.schedule)) throw new ValidationError("Unknown schedule");
  if (input.size !== undefined && !isWidgetSize(input.size)) throw new ValidationError("Unknown size");
  if (!UUID.test(input.messageId)) throw blockNotFound();
  const [message] = await deps.db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, input.messageId), isNull(messages.deletedAt)));
  if (!message) throw blockNotFound();
  // Only someone who reads the conversation pins from it: the same check as reading its messages.
  try {
    await requireChannelAccess(deps.db, actorId, orgId, message.channelId);
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) throw blockNotFound();
    throw error;
  }
  if (message.authorType !== "agent" || !message.authorAgentId) {
    throw new ValidationError("Only an agent's chart is pinned", DASHBOARD_ERRORS.notAgentMessage);
  }
  const wanted = input.block.trim();
  const block = chartBlocksOf(message.body).find((b) => b.trim() === wanted);
  const chart = block ? chartBlockToWidgetSpec(block) : null;
  if (!block || !chart) throw blockNotFound();
  const agent = await getAgent(deps.db, orgId, message.authorAgentId);
  if (!agent) throw blockNotFound();
  if (input.schedule !== "manual") {
    // Updating it is asking the agent again and again: only who may talk to it (ADR 0135 §3).
    if (agent.archivedAt) {
      throw new ValidationError(`${agent.name} is archived`, DASHBOARD_ERRORS.agentArchived, { agentName: agent.name });
    }
    if (!canTalkTo(agent, actorId, speakerOf(membership))) {
      throw new ForbiddenError(`You can't talk to ${agent.name}`, DASHBOARD_ERRORS.agentUnreachable, {
        agentName: agent.name,
      });
    }
  }
  const title = clipText((input.title ?? "").replace(/\s+/g, " ").trim(), WIDGET_TITLE_MAX) || chart.title;
  const row = await insertWidget(deps, {
    orgId,
    dashboardId: board.id,
    agentId: agent.id,
    title,
    prompt: pinnedWidgetPrompt({ title: chart.title, subtitle: subtitleOf(block) }, message.body),
    format: chart.spec.kind,
    schedule: input.schedule,
    ...(input.size ? { size: input.size } : {}),
    spec: chart.spec,
    sourceMessageId: message.id,
    createdByUserId: actorId,
    // A title the person typed is theirs; the chart's own is its agent's (ADR 0135 §17).
    titleSetByUser: Boolean(input.title?.trim()),
  });
  return widgetView(deps.db, row);
}

/**
 * "Pin from chat": the latest chart blocks agents sent where the person reads (channels and threads they're in, their
 * DMs with agents), last 30 days, newest first, at most `limit` (default 20), each read by `chartBlockToWidgetSpec`.
 */
export async function listPinnableBlocks(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  limit = 20,
): Promise<PinnableBlockView[]> {
  await requireActiveMembership(deps.db, actorId, orgId);
  const max = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
  const since = new Date((deps.now?.() ?? new Date()).getTime() - PINNABLE_DAYS * 86_400_000);
  const rows = await deps.db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      threadId: messages.threadId,
      agentId: messages.authorAgentId,
      body: messages.body,
      createdAt: messages.createdAt,
      channelKind: channels.kind,
      channelName: channels.name,
    })
    .from(messages)
    .innerJoin(channels, and(eq(channels.orgId, messages.orgId), eq(channels.id, messages.channelId)))
    .innerJoin(
      channelMembers,
      and(
        eq(channelMembers.orgId, channels.orgId),
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.userId, actorId),
      ),
    )
    .where(
      and(
        eq(messages.orgId, orgId),
        gte(messages.createdAt, since),
        isNull(messages.deletedAt),
        eq(messages.authorType, "agent"),
        isNotNull(messages.authorAgentId),
        isNull(channels.archivedAt),
        like(messages.body, "%```chart%"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(PINNABLE_SCAN);
  const out: PinnableBlockView[] = [];
  for (const m of rows) {
    if (!m.agentId) continue;
    for (const block of chartBlocksOf(m.body)) {
      const chart = chartBlockToWidgetSpec(block);
      if (!chart) continue;
      const dm = m.channelKind === "dm";
      out.push({
        messageId: m.id,
        channelId: m.channelId,
        threadId: m.threadId,
        agentId: m.agentId,
        at: m.createdAt.toISOString(),
        block,
        title: chart.title,
        spec: chart.spec,
        place: { kind: dm ? "dm" : m.threadId ? "thread" : "channel", name: dm ? null : m.channelName },
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}
