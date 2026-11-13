import { type AccountKind, isAccountKind, type PubSub, ROUTE_PROTOCOL, ROUTE_TIMEOUT_MS } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, isNotNull, isNull, schema } from "@agenteschat/db";
import { recordPlanUsage, toolOff } from "./brains/claude-code";
import { publishChannelEvent } from "./events";
import type { MachineCaller } from "./machine-hub";
import { parseRouterJson, RouterSkip, type RouterStrategy, routerPrompt, scoresOf } from "./router";

const { agents, machineAccounts, machines } = schema;

/** A plan sign-in that may pick who answers its owner's messages (ADR 0074 §3). */
export interface PlanSignIn {
  machineId: string;
  /** The agent it thinks for: the route runs in that agent's folder, as its user. */
  agent: { id: string; handle: string };
  /** Its account folder; null: the computer's own Claude Code sign-in. */
  accountId: string | null;
  kind: AccountKind;
  /** Whose plan it is. */
  ownerId: string;
}

/**
 * The plan sign-ins that may pick who answers, `userId`'s own (or anyone's, for `ai-status`), Claude before
 * ChatGPT, the most recently used first: an active CLI sign-in the person made (never a coding plan's key)
 * that one of their own agents thinks with, once, and the computer's own Claude Code sign-in where the person
 * paired that computer, one of their agents thinks with it and it is signed in with a plan (`claude.ai`). Codex
 * doesn't say how it is signed in, so a computer's own Codex sign-in never counts. Only computers online now
 * that speak `brain.route`, aren't paused and would run it: not on Windows, and with that CLI switched on there.
 */
export async function planSignInsOf(
  db: Executor,
  hub: Pick<MachineCaller, "status">,
  orgId: string,
  userId?: string,
): Promise<PlanSignIn[]> {
  const [lent, own] = await Promise.all([
    db
      .select({
        accountId: machineAccounts.id,
        kind: machineAccounts.kind,
        machineId: machineAccounts.machineId,
        ownerId: machineAccounts.createdBy,
        usedAt: machineAccounts.lastUsedAt,
        agentId: agents.id,
        handle: agents.handle,
      })
      .from(machineAccounts)
      .innerJoin(
        agents,
        and(
          eq(agents.orgId, machineAccounts.orgId),
          eq(agents.brainAccountId, machineAccounts.id),
          eq(agents.ownerUserId, machineAccounts.createdBy),
          eq(agents.brain, machineAccounts.kind),
          eq(agents.machineId, machineAccounts.machineId),
          isNull(agents.archivedAt),
        ),
      )
      .where(
        and(
          eq(machineAccounts.orgId, orgId),
          eq(machineAccounts.status, "active"),
          isNull(machineAccounts.provider),
          userId ? eq(machineAccounts.createdBy, userId) : isNotNull(machineAccounts.createdBy),
        ),
      ),
    db
      .select({ machineId: machines.id, ownerId: machines.pairedByUserId, agentId: agents.id, handle: agents.handle })
      .from(agents)
      .innerJoin(
        machines,
        and(
          eq(machines.orgId, agents.orgId),
          eq(machines.id, agents.machineId),
          eq(machines.pairedByUserId, agents.ownerUserId),
          isNull(machines.deletedAt),
        ),
      )
      .where(
        and(
          eq(agents.orgId, orgId),
          isNull(agents.archivedAt),
          eq(agents.brain, "claude_code"),
          isNull(agents.brainAccountId),
          userId ? eq(agents.ownerUserId, userId) : undefined,
        ),
      )
      .orderBy(asc(agents.createdAt)),
  ]);
  const found: (PlanSignIn & { usedAt: number })[] = [];
  for (const r of lent) {
    // One per account: one made for all agents thinks for several of them (protocol 29).
    // Cursor's, OpenCode's, Grok's and Antigravity's CLIs pick nobody (`brain.route` is Claude Code's and Codex's).
    if (
      !r.ownerId ||
      !isAccountKind(r.kind) ||
      r.kind === "cursor" ||
      r.kind === "opencode" ||
      r.kind === "grok" ||
      r.kind === "antigravity" ||
      found.some((s) => s.accountId === r.accountId)
    )
      continue;
    found.push({
      machineId: r.machineId,
      agent: { id: r.agentId, handle: r.handle },
      accountId: r.accountId,
      kind: r.kind,
      ownerId: r.ownerId,
      usedAt: r.usedAt?.getTime() ?? 0,
    });
  }
  // One per computer: its own sign-in is one folder, whichever agent thinks with it.
  for (const r of own) {
    if (!r.ownerId || found.some((s) => s.machineId === r.machineId && s.accountId === null)) continue;
    found.push({
      machineId: r.machineId,
      agent: { id: r.agentId, handle: r.handle },
      accountId: null,
      kind: "claude_code",
      ownerId: r.ownerId,
      usedAt: 0,
    });
  }
  const ids = [...new Set(found.map((s) => s.machineId))];
  const statuses = new Map(
    await Promise.all(ids.map(async (id) => [id, await hub.status(id).catch(() => null)] as const)),
  );
  return found
    .filter((s) => {
      const status = statuses.get(s.machineId);
      if (!status?.online || status.protocol < ROUTE_PROTOCOL || status.paused) return false;
      if (status.os === "windows" || toolOff(status, s.kind === "codex" ? "codex" : "claude")) return false;
      // A sign-in made with a key is neither a plan nor free.
      return s.accountId !== null || status.executors.claude?.authMethod === "claude.ai";
    })
    .sort((a, b) => (a.kind === b.kind ? b.usedAt - a.usedAt : a.kind === "claude_code" ? -1 : 1))
    .map(({ usedAt: _, ...s }) => s);
}

const tokens = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/**
 * The chain's plan step (ADR 0074 §3): the author's own Claude or ChatGPT plan reads their message on the
 * computer where it is signed in (`brain.route`, every tool off), when nothing faster could. Plans are
 * personal, so only the author's own, never for an agent's message, and never where a rule already picks.
 * "Picking who answers" shows meanwhile (`message.routing`). A sign-in busy with an agent's process yields
 * to the author's next one. Recorded on the plan, at no cost. Off on the Cloud (the server leaves it out).
 */
export function createPlanRouterStrategy(deps: {
  db: Database;
  hub: Pick<MachineCaller, "call" | "status">;
  pubsub?: PubSub;
  timeoutMs?: number;
}): RouterStrategy {
  return {
    name: "plan",
    async decide(input) {
      const author = input.authorUserId;
      if (!author || input.ruleDecides) throw new RouterSkip();
      const signIns = await planSignInsOf(deps.db, deps.hub, input.orgId, author);
      if (signIns.length === 0) throw new RouterSkip();
      const { system, prompt, schema } = routerPrompt(input);
      await publishChannelEvent(deps.pubsub, {
        type: "message.routing",
        channelId: input.channel.id,
        messageId: input.message.id,
        step: "plan",
      });
      for (const s of signIns) {
        const reply = await deps.hub.call(
          s.machineId,
          {
            op: "brain.route",
            agent: s.agent,
            kind: s.kind,
            ...(s.accountId ? { account: s.accountId } : {}),
            system,
            prompt,
            schema,
          },
          { timeoutMs: deps.timeoutMs ?? ROUTE_TIMEOUT_MS },
        );
        if ("busy" in reply) continue;
        const parsed = parseRouterJson(reply.json);
        const usageRecordId = await recordPlanUsage(deps.db, {
          orgId: input.orgId,
          agentId: s.agent.id,
          kind: "router",
          provider: s.kind,
          machineId: s.machineId,
          accountId: s.accountId,
          ...(typeof reply.model === "string" && reply.model ? { model: reply.model.slice(0, 100) } : {}),
          inputTokens: tokens(reply.usage?.input),
          outputTokens: tokens(reply.usage?.output),
          cacheReadTokens: tokens(reply.usage?.cacheRead),
          cacheWriteTokens: tokens(reply.usage?.cacheWrite),
        }).catch(() => null);
        return {
          ...scoresOf(input, parsed),
          // Written by a model that read other people's messages: kept short, never shown.
          reason: parsed.reason.slice(0, 200),
          ...(usageRecordId ? { usageRecordId } : {}),
          strategy: `plan:${s.kind}`,
          decidedBy: { step: "plan", brand: s.kind === "codex" ? "chatgpt" : "claude", ownerId: author },
        };
      }
      throw new Error("every sign-in is busy");
    },
  };
}
