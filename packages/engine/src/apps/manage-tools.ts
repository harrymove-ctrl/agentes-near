import { and, eq, gte, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import {
  type Agent,
  createAgent,
  freeHandle,
  listAgents,
  NEW_AGENT_DEFAULTS,
  takenHandles,
  updateAgent,
} from "../agents";
import { AGENT_LOOK, setAgentAppearance } from "../appearance";
import { recordAudit } from "../audit";
import { createChannel, listChannels } from "../channels";
import { addContextItemByPerson } from "../context/items";
import { ConflictError, TooManyError, ValidationError } from "../errors";
import { handleFromName } from "../imports";
import { publishMachineAgentsChanged } from "../machines";
import { notifyAppCreated } from "../notification-producers";
import { createRoutine, listRoutines } from "../routines";
import {
  listSkills,
  parseSkillMarkdown,
  SKILL_LIMITS,
  saveSkill,
  setAgentSkills,
  updateSkill,
  validateSkill,
} from "../skills";
import type { AppPrincipal } from "./grants";
import { type AppsToolDeps, cleanUntrusted, type RegisterTool } from "./tools";
import { appsUrls } from "./urls";

const { auditLog } = schema;

/**
 * The tools an import needs (ADR 0119 addendum): an AI app moves the person's agents, instructions, skills, routines
 * and memories here. Behind `manage`, each through the engine call the web app makes, so every permission is the
 * person's own; each creation is audited with the app's name, rate-limited, keyed for retries and told to the person.
 */

export const APP_MANAGE_TOOL_NAMES = [
  "import_summary",
  "create_agent",
  "update_agent_instructions",
  "update_agent",
  "list_skills",
  "create_skill",
  "update_skill",
  "create_routine",
  "add_memory",
  "create_channel",
] as const;

/** Creations per person and workspace, across their apps. */
const CREATE_LIMITS = [
  { limit: 30, windowMs: 60_000 },
  { limit: 300, windowMs: 86_400_000 },
];
/** How long an idempotency key keeps answering with what it made. */
const KEY_MS = 7 * 86_400_000;

const KEY = z.string().min(1).max(64).optional().describe("The same key creates the item once, on retries too");
const AGENT_REF = z.string().min(1).max(64).describe("Agent id or handle (from import_summary or list_agents)");

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Kind = "agent" | "skill" | "routine" | "memory" | "channel";

export function registerManageTools(deps: AppsToolDeps, p: AppPrincipal, tool: RegisterTool) {
  const issuer = appsUrls(deps.publicUrl).issuer;
  const base = `${issuer}/org/${p.orgId}`;
  /** Text others wrote (a skill installed from a link, an agent's role): fenced by `toolResult` as content. */
  const fenced = (text: string | null | undefined, max: number) =>
    text ? { untrusted_text: cleanUntrusted(text, max).text } : null;

  const agentOut = (a: Pick<Agent, "id" | "name" | "handle">, existing: boolean) => ({
    id: a.id,
    name: a.name,
    handle: a.handle,
    existing,
    url: `${base}/agents/${a.id}`,
  });

  const allow = async () => {
    for (const [i, rule] of CREATE_LIMITS.entries()) {
      const r = await deps.rateLimiter.consume(`mcp:manage:${i}:${p.userId}:${p.orgId}`, rule);
      if (!r.allowed) throw new TooManyError("Too many items created from apps.");
    }
  };

  /** What this connection already made with `key`: its id. */
  const madeWith = async (key: string | undefined, kind: Kind) => {
    if (!key) return null;
    // ponytail: two calls with one key at the same moment can both create; a unique row per key if that shows up.
    const [row] = await deps.db
      .select({ id: auditLog.targetId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, p.orgId),
          eq(auditLog.action, "apps.created"),
          eq(auditLog.targetType, kind),
          gte(auditLog.createdAt, new Date(Date.now() - KEY_MS)),
          sql`${auditLog.details}->>'grantId' = ${p.grantId}`,
          sql`${auditLog.details}->>'key' = ${key}`,
        ),
      )
      .limit(1);
    return row?.id ?? null;
  };

  /** Audited as the person through the app, and told to them in their inbox (never undoes the creation). */
  const made = async (kind: Kind, id: string, name: string, key: string | undefined) => {
    await recordAudit(deps.db, {
      orgId: p.orgId,
      actor: { type: "person", id: p.userId },
      action: "apps.created",
      target: { type: kind, id },
      details: { grantId: p.grantId, client: p.app.name, name, ...(key ? { key } : {}) },
    });
    await notifyAppCreated(
      { db: deps.db, pubsub: deps.pubsub },
      { orgId: p.orgId, userId: p.userId, grantId: p.grantId, app: p.app.name, kind, id },
    ).catch((error) => deps.report?.(error, { tool: "notify", orgId: p.orgId }));
  };

  const resolveAgent = async (ref: string) => {
    const handle = ref.replace(/^@/, "").toLowerCase();
    const agent = (await listAgents(deps.db, p.userId, p.orgId)).find(
      (a) => a.id === ref || a.handle.toLowerCase() === handle,
    );
    if (!agent)
      throw new ValidationError(`No agent "${ref}" in this workspace. import_summary lists the agents and their ids.`);
    return agent;
  };

  tool(
    "import_summary",
    {
      scope: "manage",
      title: "What already exists",
      description:
        "Lists the agents, skills, routines and channels that already exist in this agentes.chat workspace, by name. The create tools return an item with the same name as existing: true and leave it unchanged.",
      input: z.object({}).strict(),
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async () => {
      const [agents, skills, routines, channels] = await Promise.all([
        listAgents(deps.db, p.userId, p.orgId),
        listSkills(deps.db, p.userId, p.orgId),
        listRoutines(deps.db, p.userId, p.orgId),
        listChannels(deps.db, p.userId, p.orgId),
      ]);
      return {
        agents: agents.map((a) => ({ id: a.id, name: a.name, handle: a.handle, role: fenced(a.role, 200) })),
        skills: skills.map((s) => ({ id: s.id, name: s.name })),
        routines: routines.map((r) => ({ id: r.id, name: r.name, agent_id: r.agentId })),
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
      };
    },
  );

  tool(
    "create_agent",
    {
      scope: "manage",
      title: "Create an agent",
      description: `Creates an agent in agentes.chat owned by ${p.personName}, with its name, role and instructions. It thinks with the workspace's default AI, which ${p.personName} can change later. An agent with the same name comes back as existing: true, unchanged.`,
      input: z
        .object({
          name: z.string().trim().min(1).max(80).describe("The agent's name"),
          role: z.string().max(200).optional().describe("What it does, in a few words"),
          instructions: z.string().max(50_000).optional().describe("How it works: its system prompt"),
          avatar_color: z.enum(AGENT_LOOK.colors).optional().describe("Its avatar's color"),
          handle: z.string().max(32).optional().describe("Its @handle; made from the name when left out"),
          idempotency_key: KEY,
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const agents = await listAgents(deps.db, p.userId, p.orgId);
      const keyed = await madeWith(args.idempotency_key, "agent");
      const same = agents.find((a) => a.id === keyed) ?? agents.find((a) => sameName(a.name, args.name));
      if (same) return agentOut(same, true);
      await allow();
      const wanted =
        args.handle?.trim().replace(/^@/, "").toLowerCase() ||
        handleFromName(args.name, args.role ?? "", args.instructions ?? "");
      const taken = await takenHandles(deps.db, p.orgId);
      let agent = await createAgent(
        deps.db,
        p.userId,
        p.orgId,
        {
          name: args.name,
          handle: taken.has(wanted) ? freeHandle(wanted, taken) : wanted,
          role: args.role,
          instructions: args.instructions,
        },
        NEW_AGENT_DEFAULTS,
        { pubsub: deps.pubsub },
      );
      if (args.avatar_color)
        agent = await setAgentAppearance(
          deps.db,
          p.userId,
          p.orgId,
          agent.id,
          { color: args.avatar_color, eyes: AGENT_LOOK.eyes[0] },
          { pubsub: deps.pubsub },
        );
      // Born on the workspace's own computer: it lists its agents again.
      if (agent.machineId) await publishMachineAgentsChanged(deps.pubsub, p.orgId);
      await made("agent", agent.id, agent.name, args.idempotency_key);
      return agentOut(agent, false);
    },
  );

  tool(
    "update_agent_instructions",
    {
      scope: "manage",
      title: "Replace an agent's instructions",
      description:
        "Replaces the instructions (system prompt) of an existing agentes.chat agent. Needs the permission to manage agents in this workspace.",
      input: z
        .object({ agent: AGENT_REF, instructions: z.string().max(50_000).describe("The whole new instructions") })
        .strict(),
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const agent = await resolveAgent(args.agent);
      await allow();
      const updated = await updateAgent(
        deps.db,
        p.userId,
        p.orgId,
        agent.id,
        { instructions: args.instructions },
        { remember: false, pubsub: deps.pubsub },
      );
      await recordAudit(deps.db, {
        orgId: p.orgId,
        actor: { type: "person", id: p.userId },
        action: "apps.updated",
        target: { type: "agent", id: agent.id },
        details: { grantId: p.grantId, client: p.app.name, changed: ["instructions"] },
      });
      return agentOut(updated, true);
    },
  );

  tool(
    "update_agent",
    {
      scope: "manage",
      title: "Change an agent's role, name or look",
      description:
        "Changes the role, the name or the look of an existing agentes.chat agent. What is left out stays. Needs the permission to manage agents; the look alone can also be changed by the agent's owner.",
      input: z
        .object({
          agent: AGENT_REF,
          role: z.string().max(200).optional().describe("What it does, in a few words"),
          name: z.string().trim().min(1).max(80).optional().describe("The agent's name"),
          avatar_color: z.enum(AGENT_LOOK.colors).optional().describe("Its avatar's color"),
          avatar_eyes: z.enum(AGENT_LOOK.eyes).optional().describe("Its avatar's eyes"),
          avatar_accessory: z.enum(AGENT_LOOK.accessories).optional().describe("Its avatar's accessory"),
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const agent = await resolveAgent(args.agent);
      const look = args.avatar_color || args.avatar_eyes || args.avatar_accessory;
      const fields = {
        ...(args.role !== undefined ? { role: args.role } : {}),
        ...(args.name ? { name: args.name } : {}),
      };
      if (!look && Object.keys(fields).length === 0)
        throw new ValidationError("Nothing to change: give role, name, or one of the avatar fields.");
      await allow();
      let updated: Pick<Agent, "id" | "name" | "handle"> = agent;
      if (Object.keys(fields).length > 0)
        updated = await updateAgent(deps.db, p.userId, p.orgId, agent.id, fields, {
          remember: false,
          pubsub: deps.pubsub,
        });
      if (look) {
        const now = agent.appearance;
        updated = await setAgentAppearance(
          deps.db,
          p.userId,
          p.orgId,
          agent.id,
          {
            color: args.avatar_color ?? now?.color ?? AGENT_LOOK.colors[0],
            eyes: args.avatar_eyes ?? now?.eyes ?? AGENT_LOOK.eyes[0],
            accessory: args.avatar_accessory ?? now?.accessory ?? "none",
          },
          { pubsub: deps.pubsub },
        );
      }
      await recordAudit(deps.db, {
        orgId: p.orgId,
        actor: { type: "person", id: p.userId },
        action: "apps.updated",
        target: { type: "agent", id: agent.id },
        details: {
          grantId: p.grantId,
          client: p.app.name,
          changed: [...Object.keys(fields), ...(look ? ["look"] : [])],
        },
      });
      return agentOut(updated, true);
    },
  );

  tool(
    "list_skills",
    {
      scope: "manage",
      title: "List skills",
      description: "Lists the skills installed in this agentes.chat workspace, with how many agents have each one on.",
      input: z.object({}).strict(),
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async () => ({
      skills: (await listSkills(deps.db, p.userId, p.orgId)).map((s) => ({
        id: s.id,
        name: s.name,
        description: fenced(s.description, 1024),
        agents_count: s.agentsCount,
      })),
    }),
  );

  tool(
    "create_skill",
    {
      scope: "manage",
      title: "Create a skill",
      description:
        "Installs a skill from Markdown: a SKILL.md with name and description in its frontmatter, or plain Markdown with name and description given apart. The name is kebab-case. With agent, that agent gets the skill on. A skill with the same name comes back as existing: true, unchanged. Needs the permission to manage agents.",
      input: z
        .object({
          markdown: z.string().min(1).max(SKILL_LIMITS.bodyChars).describe("SKILL.md, or the skill's Markdown body"),
          name: z.string().max(64).optional().describe("kebab-case name, when the Markdown has no frontmatter"),
          description: z.string().max(1024).optional().describe("When to use it, when the Markdown has no frontmatter"),
          agent: AGENT_REF.optional(),
          idempotency_key: KEY,
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const parsed = args.markdown.trimStart().startsWith("---")
        ? parseSkillMarkdown(args.markdown)
        : { name: args.name?.trim() ?? "", description: args.description?.trim() ?? "", body: args.markdown.trim() };
      validateSkill(parsed);
      const agent = args.agent ? await resolveAgent(args.agent) : null;
      const skills = await listSkills(deps.db, p.userId, p.orgId);
      const keyed = await madeWith(args.idempotency_key, "skill");
      let skill: { id: string; name: string } | undefined =
        skills.find((s) => s.id === keyed) ?? skills.find((s) => s.name === parsed.name);
      const existing = !!skill;
      if (!skill) {
        if (!deps.blobs) throw new ValidationError("This server has no storage for skills.");
        await allow();
        skill = await saveSkill({ db: deps.db, blobs: deps.blobs }, p.userId, p.orgId, {
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          metadata: "metadata" in parsed ? parsed.metadata : {},
          source: "manual",
        });
        await made("skill", skill.id, skill.name, args.idempotency_key);
      }
      if (agent) await setAgentSkills(deps.db, p.userId, p.orgId, agent.id, [{ skillId: skill.id, enabled: true }]);
      return {
        id: skill.id,
        name: skill.name,
        existing,
        agent: agent ? { id: agent.id, name: agent.name } : null,
        url: `${base}/settings/skills`,
      };
    },
  );

  tool(
    "update_skill",
    {
      scope: "manage",
      title: "Change a skill",
      description:
        "Replaces the body, the description or both of a skill already installed in this workspace, as a new version. Its files stay. Needs the permission to manage agents.",
      input: z
        .object({
          skill: z.string().min(1).max(64).describe("The skill's id or name (from list_skills)"),
          body: z
            .string()
            .min(1)
            .max(SKILL_LIMITS.bodyChars)
            .optional()
            .describe("The skill's whole new Markdown body"),
          description: z.string().min(1).max(1024).optional().describe("When to use it"),
        })
        .strict(),
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      if (args.body === undefined && args.description === undefined)
        throw new ValidationError("Nothing to change: give body or description.");
      const found = (await listSkills(deps.db, p.userId, p.orgId)).find(
        (s) => s.id === args.skill || s.name === args.skill.trim().toLowerCase(),
      );
      if (!found) throw new ValidationError(`No skill "${args.skill}" in this workspace. list_skills lists them.`);
      if (!deps.blobs) throw new ValidationError("This server has no storage for skills.");
      await allow();
      const skill = await updateSkill({ db: deps.db, blobs: deps.blobs }, p.userId, p.orgId, found.id, {
        body: args.body,
        description: args.description,
      });
      await recordAudit(deps.db, {
        orgId: p.orgId,
        actor: { type: "person", id: p.userId },
        action: "apps.updated",
        target: { type: "skill", id: found.id },
        details: {
          grantId: p.grantId,
          client: p.app.name,
          changed: [
            ...(args.body !== undefined ? ["body"] : []),
            ...(args.description !== undefined ? ["description"] : []),
          ],
        },
      });
      return { id: found.id, name: skill.name, version: skill.version, url: `${base}/settings/skills` };
    },
  );

  tool(
    "create_routine",
    {
      scope: "manage",
      title: "Create a routine",
      description: `Creates a routine: an agent does something on a schedule, asked on behalf of ${p.personName}. schedule is a phrase in any language ("every weekday at 9am"). It posts in the channel given, else in the private conversation between ${p.personName} and the agent. A routine with the same name for the same agent comes back as existing: true, unchanged.`,
      input: z
        .object({
          agent: AGENT_REF,
          instructions: z.string().min(1).max(10_000).describe("What the agent does each time"),
          schedule: z.string().min(1).max(200).describe("When it runs, as a phrase"),
          name: z.string().max(120).optional().describe("A short name; the first line of instructions when left out"),
          channel_id: z.uuid().optional().describe("The channel it posts in (from list_channels)"),
          timezone: z.string().max(64).optional().describe("IANA time zone of the schedule; default the person's"),
          idempotency_key: KEY,
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const agent = await resolveAgent(args.agent);
      // As `createRoutine` names one, so the same routine sent again is found by it.
      const name = args.name?.trim() || args.instructions.trim().split("\n")[0]?.slice(0, 60) || "Routine";
      const routines = await listRoutines(deps.db, p.userId, p.orgId);
      const keyed = await madeWith(args.idempotency_key, "routine");
      let routine =
        routines.find((r) => r.id === keyed) ?? routines.find((r) => r.agentId === agent.id && sameName(r.name, name));
      const existing = !!routine;
      if (!routine) {
        await allow();
        routine = await createRoutine({ db: deps.db, pubsub: deps.pubsub, context: deps.context }, p.userId, p.orgId, {
          name,
          agentId: agent.id,
          prompt: args.instructions,
          target: args.channel_id ? { type: "channel", channelId: args.channel_id } : { type: "dm" },
          trigger: { type: "schedule", phrase: args.schedule, timezone: args.timezone },
        });
        await made("routine", routine.id, routine.name, args.idempotency_key);
      }
      return {
        id: routine.id,
        name: routine.name,
        existing,
        agent: { id: agent.id, name: agent.name, handle: agent.handle },
        schedule: routine.trigger.type === "schedule" ? routine.trigger.description : null,
        next_run_at: routine.nextRunAt,
        posts_in: routine.target.type === "channel" ? { channel_id: routine.target.channelId } : "direct_conversation",
        url: `${base}/routines?open=${routine.id}`,
      };
    },
  );

  tool(
    "add_memory",
    {
      scope: "manage",
      title: "Add to an agent's memory",
      description: `Adds a fact or a preference to an agent's own memory, marked as sent through this app for ${p.personName} to review. Needs to be the agent's owner or to manage agents.`,
      input: z
        .object({
          agent: AGENT_REF,
          text: z.string().trim().min(1).max(2_000).describe("The fact or preference, one per call"),
          kind: z.enum(["fact", "preference"]).optional().describe("fact (default) or preference"),
          idempotency_key: KEY,
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const agent = await resolveAgent(args.agent);
      const keyed = await madeWith(args.idempotency_key, "memory");
      if (keyed) return { id: keyed, existing: true, agent: { id: agent.id, name: agent.name } };
      await allow();
      const item = await addContextItemByPerson(
        deps.db,
        p.userId,
        p.orgId,
        { kind: args.kind ?? "fact", content: args.text, agentId: agent.id, viaApp: true },
        deps.judge,
      );
      await made("memory", item.id, agent.name, args.idempotency_key);
      return { id: item.id, existing: false, agent: { id: agent.id, name: agent.name } };
    },
  );

  tool(
    "create_channel",
    {
      scope: "manage",
      title: "Create a channel",
      description: `Creates a channel with ${p.personName} in it. Names are lower-case letters, digits, - or _. A channel with the same name comes back as existing: true.`,
      input: z
        .object({
          name: z.string().trim().min(1).max(80).describe("The channel's name"),
          topic: z.string().max(250).optional().describe("What it is for"),
          private: z.boolean().optional().describe("Only people added can see it (default false)"),
          idempotency_key: KEY,
        })
        .strict(),
      readOnly: false,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async (args) => {
      const name = args.name.toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");
      const channels = await listChannels(deps.db, p.userId, p.orgId);
      const keyed = await madeWith(args.idempotency_key, "channel");
      const same = channels.find((c) => c.id === keyed) ?? channels.find((c) => c.name === name);
      if (same) return { id: same.id, name: same.name, existing: true, url: `${base}/c/${same.id}` };
      await allow();
      const channel = await createChannel(
        deps.db,
        p.userId,
        p.orgId,
        { name, topic: args.topic, visibility: args.private ? "private" : "public" },
        { pubsub: deps.pubsub },
      ).catch((error) => {
        if (error instanceof ConflictError)
          throw new ValidationError(
            `A channel named ${name} exists that ${p.personName} can't see. Pick another name.`,
          );
        throw error;
      });
      await made("channel", channel.id, channel.name, args.idempotency_key);
      return { id: channel.id, name: channel.name, existing: false, url: `${base}/c/${channel.id}` };
    },
  );
}
