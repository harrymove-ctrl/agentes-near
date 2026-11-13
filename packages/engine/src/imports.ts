import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, like, or, schema, sql } from "@agenteschat/db";
import { isCustomModel, isKnownModel, isOpenRouterModel } from "@agenteschat/providers";
import { driveFolder, isIdHandle, isSecretFile } from "@agenteschat/ui/names";
import { createAgent, freeHandle, HANDLE_PATTERN, updateAgent } from "./agents";
import { type AgentAppearance, setAgentAppearance, validateAppearance } from "./appearance";
import { ARTIFACT_LIMITS, type ArtifactDeps, createFileArtifact } from "./artifacts";
import { recordAudit } from "./audit";
import { addChannelMember, CHANNEL_NAME_PATTERN, createChannel } from "./channels";
import type { ConnectorTriggerDeps } from "./connector-triggers";
import { addContextItemByPerson, editContextItem, holdsSecret, looksLikeSecret } from "./context/items";
import { nextCronTime, zonedParts } from "./cron";
import { sha256 } from "./crypto";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { can, requirePermission } from "./organizations";
import { createRoutine, type RoutineDeps, type RoutineTriggerInput, routineTimezone, updateRoutine } from "./routines";
import { localDate, nextOccurrence, normalizeRule, type ScheduleRule } from "./rrule";
import { type ParsedSkill, parseSkillMarkdown, saveSkill, setAgentSkills } from "./skills";
import { canonicalJson } from "./tools/json-schema";

const { importItems, agents, skills, channels, channelMembers, routines, contextItems, organizationMembers } = schema;

// The bundle (ADR 0055). Mirrors `MigrationBundle` in packages/client/src/api/types.ts; the route validates it.

export interface MigrationBundle {
  format: "agenteschat.bundle";
  version: 1;
  source: { app: string; ref: string; name: string; files: string[] };
  agents: BundleAgent[];
  skills: BundleSkill[];
  channels: BundleChannel[];
  routines: BundleRoutine[];
  notes: BundleNote[];
  todo: { kind: "connection" | "app" | "secret" | "model" | "file"; label: string; url?: string; agents: string[] }[];
  leftOut: { kind: string; label: string }[];
}

export interface BundleAgent {
  key: string;
  name: string;
  handle: string;
  role: string;
  instructions: string;
  model: string | null;
  appearance: { color?: string; eyes?: string; accessory?: string };
  skills: string[];
}

export interface BundleSkill {
  key: string;
  markdown: string;
}

export interface BundleChannel {
  key: string;
  name: string;
  topic: string;
  agents: { key: string; autoReply: boolean }[];
}

/** Our schedule rule as the client's `ApiRule` (the picker's `once`, nulls, the zone left out); checked here. */
export type BundleRule = Omit<ScheduleRule, "freq" | "timezone" | "start" | "bySetPos"> & {
  freq: ScheduleRule["freq"] | "once";
  timezone?: string | null;
  start?: string | null;
  bySetPos?: number | number[] | null;
};

export type BundleTrigger = { cron: string; timezone: string | null } | { rule: BundleRule } | { at: string };

export interface BundleRoutine {
  key: string;
  name: string;
  agent: string;
  prompt: string;
  channel: string | null;
  trigger: BundleTrigger;
}

export const NOTE_KINDS = ["fact", "preference", "decision", "note", "lesson"] as const;

export interface BundleNote {
  key: string;
  agent: string | null;
  kind: (typeof NOTE_KINDS)[number];
  title?: string;
  content: string;
}

export const IMPORT_KINDS = ["agent", "skill", "channel", "routine", "note"] as const;
export type ImportItemKind = (typeof IMPORT_KINDS)[number];

export type ImportSkipReason =
  | "exists"
  | "model_not_in_catalog"
  | "invalid_skill"
  | "schedule_unsupported"
  | "schedule_in_past"
  | "secret_like"
  | "agent_not_picked"
  | "channel_not_picked"
  | "invalid"
  | "failed"
  /** A note on a created routine: its agent already had the most active routines, so it arrived paused. */
  | "too_many_routines";

export interface ImportItemResult {
  kind: ImportItemKind;
  key: string;
  label: string;
  action: "create" | "update" | "unchanged" | "skip";
  /** Why it is skipped; on a create or update, a note (`model_not_in_catalog`, or `exists` for a channel joined). */
  reason?: ImportSkipReason;
  trimmed?: string[];
  renamedTo?: string;
  targetId?: string;
}

export interface ImportInput {
  bundle: MigrationBundle;
  dryRun: boolean;
  /** `kind:key` of the items to apply; default every item. Items left out aren't in the result. */
  pick?: string[];
}

export interface ImportPlan {
  items: ImportItemResult[];
}

/** How much one import carries (the route refuses more) and applies per call. */
export const IMPORT_LIMITS = {
  agents: 200,
  skills: 300,
  channels: 300,
  routines: 1000,
  notes: 5000,
  bodyBytes: 32 * 1024 * 1024,
  /** Items one apply may create or update: a big import is applied in chunks of `pick`, in the plan's order. */
  perApply: 200,
};

/** Our field limits (the create routes'): longer text is cut and reported in `trimmed`. */
const FIELD = {
  agentName: 80,
  role: 200,
  instructions: 50_000,
  channelName: 80,
  topic: 500,
  routineName: 120,
  prompt: 10_000,
  noteTitle: 300,
  note: 8000,
};

// ── Planning ─────────────────────────────────────────────────────────────────

interface Made {
  kind: ImportItemKind;
  key: string;
  targetId: string;
  hash: string;
  adopted: boolean;
  /** The target is still there (not archived or deleted). */
  live: boolean;
  /** Agents: the handle it got. */
  handle?: string;
}

/** What the plan compares the bundle with. */
export interface ImportState {
  /** What earlier imports of this package made, by `kind:key`. */
  made: Map<string, Made>;
  /** Taken @handles: every agent's (archived ones too) and the ones they had, and every person's. */
  handles: Set<string>;
  /** Skill names (deleted ones too) → id. */
  skills: Map<string, string>;
  /** Channel names (archived ones and DMs too) → id; `open`: a live public channel agents can join. */
  channels: Map<string, { id: string; open: boolean }>;
  now: Date;
}

type Work =
  | {
      kind: "agent";
      name: string;
      handle: string;
      role: string;
      instructions: string;
      model: string | null;
      look: AgentAppearance | null;
      skills: string[];
    }
  | { kind: "skill"; skill: ParsedSkill }
  | { kind: "channel"; name: string; topic: string; adopt: boolean; agents: { key: string; autoReply: boolean }[] }
  | { kind: "routine"; name: string; prompt: string; agent: string; channel: string | null; trigger: BundleTrigger }
  | { kind: "note"; agent: string | null; noteKind: BundleNote["kind"]; title: string; content: string };

export type PlannedItem = ImportItemResult & { hash: string; work?: Work };

const digest = (value: unknown) => sha256(canonicalJson(value));

/** Cut to `max`, noting the field in `trimmed`. */
function fit(text: string, max: number, field: string, trimmed: string[]) {
  if (text.length <= max) return text;
  trimmed.push(field);
  return text.slice(0, max);
}

/** Letters and digits without accents, as the apps make a handle from a name (`handleFrom` in packages/client). */
const handleLetters = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);

/** What OpenBot.run calls an agent nobody named. */
const UNNAMED = /^new agent$/i;

/**
 * The handle of an agent whose source handle is an id: from its name, as an agent made here gets one. One still
 * named "New agent" (or by its id), or whose name has no letter we keep, takes it from its role, else from the
 * first sentence of its instructions, else it is `newagent`.
 */
export function handleFromName(name: string, role: string, instructions: string) {
  const own = UNNAMED.test(name) || isIdHandle(name) ? "" : name;
  const texts = [own, role, instructions.split(/[.!?\n]/)[0] ?? "", "New agent"];
  return (texts.map(handleLetters).find(Boolean) ?? "").padEnd(2, "0");
}

/** A partial look is completed with the defaults; one we can't draw is dropped (and reported). */
function lookOf(input: BundleAgent["appearance"] | undefined, trimmed: string[]): AgentAppearance | null {
  if (!input || (!input.color && !input.eyes && !input.accessory)) return null;
  try {
    return validateAppearance({ color: "sky", eyes: "round", ...input });
  } catch {
    trimmed.push("appearance");
    return null;
  }
}

/**
 * A bundle rule as ours, nulls dropped. The picker's `once` becomes a
 * one-time rule (daily, count 1), which the schedule runs once.
 */
function asRule(input: BundleRule): ScheduleRule {
  const rule = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null)) as unknown as ScheduleRule;
  return (rule.freq as string) === "once" ? { ...rule, freq: "daily", count: 1 } : rule;
}

/** A one-off moment as a one-time rule in `zone`. */
function onceRule(at: Date, zone: string): ScheduleRule {
  const p = zonedParts(at, zone);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return { freq: "daily", count: 1, start: localDate(at, zone), times: [time], timezone: zone };
}

/** Why a trigger can't land, or null. Zones the bundle leaves out are checked in UTC. */
function triggerProblem(trigger: BundleTrigger, now: Date): ImportSkipReason | null {
  try {
    if ("cron" in trigger)
      return nextCronTime(trigger.cron, trigger.timezone || "UTC", now) ? null : "schedule_in_past";
    if ("rule" in trigger) {
      const rule = asRule(trigger.rule);
      return nextOccurrence(normalizeRule({ ...rule, timezone: rule.timezone || "UTC" }, now), now)
        ? null
        : "schedule_in_past";
    }
    const at = Date.parse(trigger.at);
    if (Number.isNaN(at)) return "schedule_unsupported";
    return at > now.getTime() ? null : "schedule_in_past";
  } catch {
    return "schedule_unsupported";
  }
}

/**
 * Compares a bundle with what the workspace has (pure). Every picked item
 * gets an action: `create`; `unchanged` or `update` when an earlier import
 * of this package made it and it is still there (same or other hash; a
 * channel is also `update` when an agent it lists arrives now); or
 * `skip` with the reason. A handle that is an id becomes one from the
 * agent's name, after the handles someone chose, and a taken one the next
 * free one, given over every agent of the bundle, picked or not; a public
 * channel that exists is joined (`update` with `exists`); text that looks
 * like a credential is never brought; fields are cut to our limits
 * (`trimmed`). Items come in dependency order: skills, agents, channels,
 * routines, notes.
 */
export function planImport(input: ImportInput, state: ImportState): { items: PlannedItem[] } {
  const { bundle } = input;
  const items: PlannedItem[] = [];
  const pick = input.pick ? new Set(input.pick) : null;
  const seen = new Set<string>();
  /** Picked, and the first item with that key (a repeated key is refused). */
  const take = (kind: ImportItemKind, key: string) => {
    const id = `${kind}:${key}`;
    if (pick && !pick.has(id)) return false;
    if (!seen.has(id)) {
      seen.add(id);
      return true;
    }
    items.push({ kind, key, label: key, hash: "", action: "skip", reason: "invalid" });
    return false;
  };
  const made = (kind: ImportItemKind, key: string) => state.made.get(`${kind}:${key}`);
  /** Planned to exist after this import, or made by an earlier one and still there. */
  const willExist = new Set<string>();
  const ready = (kind: ImportItemKind, key: string) =>
    willExist.has(`${kind}:${key}`) || made(kind, key)?.live === true;
  const secret = (...texts: string[]) => texts.some(looksLikeSecret);
  const skip = (item: Omit<PlannedItem, "action">, reason: ImportSkipReason) =>
    items.push({ ...item, action: "skip", reason });
  const add = (item: PlannedItem) => {
    if (item.trimmed?.length === 0) delete item.trimmed;
    willExist.add(`${item.kind}:${item.key}`);
    items.push(item);
  };
  const compare = (kind: ImportItemKind, key: string, hash: string) => {
    const prev = made(kind, key);
    if (!prev?.live) return { action: "create" as const };
    return { action: prev.hash === hash ? ("unchanged" as const) : ("update" as const), targetId: prev.targetId };
  };

  const skillNames = new Map(state.skills);
  for (const s of bundle.skills) {
    if (!take("skill", s.key)) continue;
    const hash = digest(s);
    let skill: ParsedSkill;
    try {
      skill = parseSkillMarkdown(s.markdown);
    } catch {
      skip({ kind: "skill", key: s.key, label: s.key, hash }, "invalid_skill");
      continue;
    }
    const item = { kind: "skill" as const, key: s.key, label: skill.name, hash };
    if (secret(s.markdown)) {
      skip(item, "secret_like");
      continue;
    }
    const prev = made("skill", s.key);
    const holder = skillNames.get(skill.name);
    // Ours only while it keeps its name: saving under another name would write over someone else's skill.
    if (holder !== undefined && holder !== prev?.targetId) {
      skip(item, "exists");
      continue;
    }
    skillNames.set(skill.name, prev?.targetId ?? `new:${s.key}`);
    add({
      ...item,
      ...(holder ? compare("skill", s.key, hash) : { action: "create" }),
      work: { kind: "skill", skill },
    });
  }

  const readAgent = (a: BundleAgent) => {
    const trimmed: string[] = [];
    const name = fit(a.name.trim(), FIELD.agentName, "name", trimmed);
    const role = fit(a.role.trim(), FIELD.role, "role", trimmed);
    const instructions = fit(a.instructions.trim(), FIELD.instructions, "instructions", trimmed);
    const look = lookOf(a.appearance, trimmed);
    const wanted = a.handle.trim().replace(/^@/, "").toLowerCase();
    return { trimmed, name, role, instructions, look, wanted, secretLike: secret(name, role, instructions) };
  };
  // Every agent is read first, picked or not, so the handle a new one gets never depends on the pick.
  const read = new Map<string, ReturnType<typeof readAgent>>();
  for (const a of bundle.agents) if (!read.has(a.key)) read.set(a.key, readAgent(a));
  // The handles someone chose in the other app come first: one made from a name never takes them. An id the
  // other app gave its agent is no handle, so that agent gets one from its name.
  const handles = new Set(state.handles);
  const newHandles = new Map<string, string>();
  for (const fromName of [false, true]) {
    for (const [key, r] of read) {
      if (!r.name || r.secretLike || made("agent", key)?.live || isIdHandle(r.wanted) !== fromName) continue;
      const base = fromName ? handleFromName(r.name, r.role, r.instructions) : fit(r.wanted, 32, "handle", r.trimmed);
      if (!HANDLE_PATTERN.test(base)) continue;
      const handle = handles.has(base) ? freeHandle(base, handles) : base;
      handles.add(handle);
      newHandles.set(key, handle);
    }
  }
  for (const a of bundle.agents) {
    const r = read.get(a.key);
    if (!r || !take("agent", a.key)) continue;
    // The model is chosen here when the agent is created (onboarding picks one the workspace's key runs):
    // never a change at the source.
    const hash = digest({ ...a, model: null });
    const item = { kind: "agent" as const, key: a.key, label: r.name || a.handle || a.key, hash };
    if (!r.name) {
      skip(item, "invalid");
      continue;
    }
    if (r.secretLike) {
      skip(item, "secret_like");
      continue;
    }
    // An OpenRouter model would need the workspace's OpenRouter key: an import keeps catalog models only.
    const model =
      a.model && !isOpenRouterModel(a.model) && !isCustomModel(a.model) && isKnownModel(a.model) ? a.model : null;
    // A source that couldn't read this agent (another bot's reply lists it by name only) has nothing to say about
    // it: what an earlier import brought stays.
    const prev = made("agent", a.key);
    const step =
      prev?.live && !r.instructions
        ? { action: "unchanged" as const, targetId: prev.targetId }
        : compare("agent", a.key, hash);
    const handle = step.action === "create" ? newHandles.get(a.key) : (made("agent", a.key)?.handle ?? r.wanted);
    if (!handle) {
      skip(item, "invalid");
      continue;
    }
    const { trimmed, name, role, instructions, look } = r;
    add({
      ...item,
      ...step,
      ...(step.action === "create" && a.model && !model ? { reason: "model_not_in_catalog" as const } : {}),
      ...(handle !== r.wanted ? { renamedTo: handle } : {}),
      trimmed,
      work: { kind: "agent", name, handle, role, instructions, model, look, skills: a.skills },
    });
  }

  const channelNames = new Map(state.channels);
  for (const c of bundle.channels) {
    if (!take("channel", c.key)) continue;
    const trimmed: string[] = [];
    // The topic is set when the import creates the channel; after that it belongs to the people in it.
    const hash = digest({ name: c.name, agents: c.agents });
    const name = fit(c.name.trim().toLowerCase(), FIELD.channelName, "name", trimmed);
    const topic = fit(c.topic.trim(), FIELD.topic, "topic", trimmed);
    const item = { kind: "channel" as const, key: c.key, label: name || c.key, hash };
    if (!CHANNEL_NAME_PATTERN.test(name) || name.startsWith("dm-")) {
      skip(item, "invalid");
      continue;
    }
    if (secret(name, topic)) {
      skip(item, "secret_like");
      continue;
    }
    const prev = made("channel", c.key);
    const holder = channelNames.get(name);
    let step: Pick<PlannedItem, "action" | "targetId" | "reason">;
    let adopt = false;
    if (prev?.live) {
      // Ours (even renamed since): the agents follow the source.
      step = compare("channel", c.key, hash);
      adopt = prev.adopted;
    } else if (holder?.open) {
      step = { action: "update", reason: "exists", targetId: holder.id };
      adopt = true;
    } else if (holder) {
      skip({ ...item, trimmed }, "exists");
      continue;
    } else step = { action: "create" };
    channelNames.set(name, { id: step.targetId ?? `new:${c.key}`, open: false });
    let members = c.agents.filter((m) => ready("agent", m.key));
    // Unchanged at the source, but an agent it lists arrives with this import: that agent joins, and only it.
    const joining = step.action === "unchanged" ? members.filter((m) => !made("agent", m.key)?.live) : [];
    if (joining.length > 0) {
      step = { ...step, action: "update" };
      members = joining;
    }
    add({ ...item, ...step, trimmed, work: { kind: "channel", name, topic, adopt, agents: members } });
  }

  for (const r of bundle.routines) {
    if (!take("routine", r.key)) continue;
    const trimmed: string[] = [];
    const hash = digest(r);
    const name = fit(r.name.trim(), FIELD.routineName, "name", trimmed);
    const prompt = fit(r.prompt.trim(), FIELD.prompt, "prompt", trimmed);
    const item = { kind: "routine" as const, key: r.key, label: name || prompt.slice(0, 60) || r.key, hash };
    const problem = !prompt
      ? "invalid"
      : !ready("agent", r.agent)
        ? "agent_not_picked"
        : r.channel !== null && !ready("channel", r.channel)
          ? "channel_not_picked"
          : secret(name, prompt)
            ? "secret_like"
            : triggerProblem(r.trigger, state.now);
    if (problem) {
      skip(item, problem);
      continue;
    }
    add({
      ...item,
      ...compare("routine", r.key, hash),
      trimmed,
      work: { kind: "routine", name, prompt, agent: r.agent, channel: r.channel, trigger: r.trigger },
    });
  }

  for (const n of bundle.notes) {
    if (!take("note", n.key)) continue;
    const trimmed: string[] = [];
    const hash = digest(n);
    const title = fit((n.title ?? "").trim(), FIELD.noteTitle, "title", trimmed);
    const content = fit(n.content.trim(), FIELD.note, "content", trimmed);
    const label = title || content.split("\n")[0]?.slice(0, 80) || n.key;
    const item = { kind: "note" as const, key: n.key, label, hash };
    const problem =
      !content || !NOTE_KINDS.includes(n.kind)
        ? "invalid"
        : n.agent !== null && !ready("agent", n.agent)
          ? "agent_not_picked"
          : secret(title, content)
            ? "secret_like"
            : null;
    if (problem) {
      skip(item, problem);
      continue;
    }
    add({
      ...item,
      ...compare("note", n.key, hash),
      trimmed,
      work: { kind: "note", agent: n.agent, noteKind: n.kind, title, content },
    });
  }

  return { items };
}

/** The workspace as the plan needs it, for one source package as this person imported it. */
export async function loadImportState(
  db: Database,
  actorId: string,
  orgId: string,
  source: { app: string; ref: string },
  now = new Date(),
): Promise<ImportState> {
  // Another app's reply is one package per app ("grok-bot"). Replies imported before that were kept under the
  // model's own name for the export ("grok-bot:my-bots"): they are the same package, so asking again finds them.
  const reply = source.app === "agenteschat" && /^[a-z0-9-]+$/.test(source.ref);
  const found = await db
    .select()
    .from(importItems)
    .where(
      and(
        eq(importItems.orgId, orgId),
        eq(importItems.createdByUserId, actorId),
        eq(importItems.sourceApp, source.app),
        reply
          ? or(eq(importItems.sourceRef, source.ref), like(importItems.sourceRef, `${source.ref}:%`))
          : eq(importItems.sourceRef, source.ref),
      ),
    );
  // Of two rows with one key, the last one is the one the plan sees: this package's own, else the newest.
  const rows = found.sort(
    (a, b) =>
      Number(a.sourceRef === source.ref) - Number(b.sourceRef === source.ref) ||
      a.updatedAt.getTime() - b.updatedAt.getTime(),
  );
  const targets = (kind: ImportItemKind) => rows.filter((r) => r.kind === kind).map((r) => r.targetId);
  const [agentRows, skillRows, channelRows, routineRows, noteRows, people] = await Promise.all([
    db
      .select({
        id: agents.id,
        handle: agents.handle,
        previousHandles: agents.previousHandles,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
    db
      .select({ id: skills.id, slug: skills.slug, deletedAt: skills.deletedAt })
      .from(skills)
      .where(eq(skills.orgId, orgId)),
    db
      .select({
        id: channels.id,
        name: channels.name,
        kind: channels.kind,
        visibility: channels.visibility,
        archivedAt: channels.archivedAt,
      })
      .from(channels)
      .where(eq(channels.orgId, orgId)),
    targets("routine").length > 0
      ? db
          .select({ id: routines.id, deletedAt: routines.deletedAt })
          .from(routines)
          .where(and(eq(routines.orgId, orgId), inArray(routines.id, targets("routine"))))
      : [],
    targets("note").length > 0
      ? db
          .select({ id: contextItems.id })
          .from(contextItems)
          .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, targets("note"))))
      : [],
    db
      .select({ handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId)),
  ]);
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  // A note merged or archived by memory upkeep still counts as there; only a deleted one is gone.
  // A channel made private since is no longer the import's to put agents in.
  const live: Record<ImportItemKind, (id: string) => boolean> = {
    agent: (id) => agentById.get(id)?.archivedAt === null,
    skill: (id) => skillRows.some((s) => s.id === id && s.deletedAt === null),
    channel: (id) =>
      channelRows.some(
        (c) => c.id === id && c.archivedAt === null && c.kind === "channel" && c.visibility === "public",
      ),
    routine: (id) => routineRows.some((r) => r.id === id && r.deletedAt === null),
    note: (id) => noteRows.some((n) => n.id === id),
  };
  return {
    made: new Map(
      rows.map((r) => {
        const kind = r.kind as ImportItemKind;
        return [
          `${kind}:${r.key}`,
          {
            kind,
            key: r.key,
            targetId: r.targetId,
            hash: r.hash,
            adopted: r.adopted,
            live: live[kind]?.(r.targetId) ?? false,
            handle: kind === "agent" ? agentById.get(r.targetId)?.handle : undefined,
          },
        ];
      }),
    ),
    handles: new Set([
      ...agentRows.flatMap((a) => [a.handle, ...a.previousHandles]),
      ...people.flatMap((p) => (p.handle ? [p.handle] : [])),
    ]),
    skills: new Map(skillRows.map((s) => [s.slug, s.id])),
    // Agents never join a private channel through an import: it would show them what's said there.
    channels: new Map(
      channelRows.map((c) => [
        c.name,
        { id: c.id, open: c.kind === "channel" && c.visibility === "public" && c.archivedAt === null },
      ]),
    ),
    now,
  };
}

// ── Applying ─────────────────────────────────────────────────────────────────

export interface ImportDeps {
  db: Database;
  /** Skills keep their files in the blob store. */
  blobs: BlobStoreResolver;
  pubsub: PubSub;
  /** An update that moves a connector routine (ADR 0130) to a schedule takes its webhook back at the provider. */
  connectors?: ConnectorTriggerDeps;
}

const publicItem = ({ hash: _hash, work: _work, ...item }: PlannedItem): ImportItemResult => item;

/** Why an item that was planned couldn't be applied. */
function failure(error: unknown): ImportSkipReason {
  if (error instanceof ConflictError) return "exists";
  if (error instanceof ValidationError && error.code === "schedule.in_the_past") return "schedule_in_past";
  if (error instanceof ValidationError && error.code.startsWith("schedule.")) return "schedule_unsupported";
  return "failed";
}

/**
 * Plans the bundle (`dryRun`: only that, nothing is written) or applies the
 * picked items through the usual create functions, in dependency order:
 * skills, agents (look, skills turned on), channels (agents and auto-reply),
 * routines (active, like one made by hand), notes. Each item stands alone (a failure is
 * reported and the rest goes on) and leaves a provenance row as soon as it
 * exists, so running it again picks up where it stopped. One audit entry,
 * `import.applied`. Admins only (`manage_agents`); never brings chat history.
 */
export async function applyImport(
  deps: ImportDeps,
  actorId: string,
  orgId: string,
  input: ImportInput,
  defaults: { model: string },
): Promise<ImportPlan> {
  const { db, pubsub } = deps;
  await requirePermission(db, actorId, orgId, "create_agents");
  const { source } = input.bundle;
  const state = await loadImportState(db, actorId, orgId, source);
  const plan = planImport(input, state);
  if (input.dryRun) return { items: plan.items.map(publicItem) };
  const writes = plan.items.filter((i) => i.action === "create" || i.action === "update").length;
  if (writes > IMPORT_LIMITS.perApply) {
    throw new ValidationError(
      `Apply at most ${IMPORT_LIMITS.perApply} items per call: send them in chunks of pick, in the plan's order`,
      "import.too_many_items",
      { max: IMPORT_LIMITS.perApply },
    );
  }

  const routineDeps: RoutineDeps = { db, pubsub, connectors: deps.connectors };
  const ids: Record<ImportItemKind, Map<string, string>> = {
    agent: new Map(),
    skill: new Map(),
    channel: new Map(),
    routine: new Map(),
    note: new Map(),
  };
  for (const m of state.made.values()) if (m.live) ids[m.kind].set(m.key, m.targetId);
  const remember = async (item: PlannedItem, targetId: string, adopted = false) => {
    ids[item.kind].set(item.key, targetId);
    item.targetId = targetId;
    await db
      .insert(importItems)
      .values({
        orgId,
        sourceApp: source.app,
        sourceRef: source.ref,
        kind: item.kind,
        key: item.key,
        targetId,
        hash: item.hash,
        adopted,
        createdByUserId: actorId,
      })
      .onConflictDoUpdate({
        target: [
          importItems.orgId,
          importItems.createdByUserId,
          importItems.sourceApp,
          importItems.sourceRef,
          importItems.kind,
          importItems.key,
        ],
        set: { targetId, hash: item.hash, adopted, updatedAt: new Date() },
      });
  };
  /** A routine posts only where its agent is: it joins quietly (mentions only) when it isn't there yet. */
  const joinQuietly = async (channelId: string, agentId: string) => {
    const [member] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)));
    if (!member) await addChannelMember(db, actorId, orgId, channelId, { agentId, autoReply: false }, { pubsub });
  };
  /** A missing zone is the importer's (then the workspace's), like a routine made by hand. */
  const triggerInput = async (trigger: BundleTrigger): Promise<RoutineTriggerInput> => {
    if ("cron" in trigger) {
      return { type: "schedule", phrase: trigger.cron, ...(trigger.timezone ? { timezone: trigger.timezone } : {}) };
    }
    if ("rule" in trigger) return { type: "schedule", rule: asRule(trigger.rule) };
    return { type: "schedule", rule: onceRule(new Date(trigger.at), await routineTimezone(db, actorId, orgId)) };
  };

  const apply = async (item: PlannedItem, work: Work) => {
    switch (work.kind) {
      case "skill": {
        const create = item.action === "create";
        const saved = await saveSkill({ db, blobs: deps.blobs }, actorId, orgId, {
          ...work.skill,
          source: "upload",
          ...(create ? { defaultForNewAgents: false } : {}),
        });
        // A skill deleted here comes back with its agents' old assignments: only the agents that bring it get it on.
        if (create) {
          await db.update(schema.agentSkills).set({ enabled: false }).where(eq(schema.agentSkills.skillId, saved.id));
        }
        await remember(item, saved.id);
        return;
      }
      case "agent": {
        const fields = { name: work.name, role: work.role, instructions: work.instructions };
        let agentId = item.targetId;
        if (!agentId) {
          const model = work.model ? { model: work.model } : {};
          const input = { ...fields, ...model, handle: work.handle };
          agentId = (await createAgent(db, actorId, orgId, input, defaults, { pubsub })).id;
        } else await updateAgent(db, actorId, orgId, agentId, fields, { pubsub });
        await remember(item, agentId);
        if (work.look) await setAgentAppearance(db, actorId, orgId, agentId, work.look, { pubsub });
        return;
      }
      case "channel": {
        const channelId =
          item.targetId ??
          (await createChannel(db, actorId, orgId, { name: work.name, topic: work.topic }, { pubsub })).id;
        await remember(item, channelId, work.adopt);
        for (const m of work.agents) {
          const agentId = ids.agent.get(m.key);
          if (agentId) {
            await addChannelMember(db, actorId, orgId, channelId, { agentId, autoReply: m.autoReply }, { pubsub });
          }
        }
        return;
      }
      case "routine": {
        const agentId = ids.agent.get(work.agent) as string;
        const channelId = work.channel === null ? null : (ids.channel.get(work.channel) as string);
        if (channelId) await joinQuietly(channelId, agentId);
        const fields = {
          name: work.name,
          prompt: work.prompt,
          agentId,
          target: channelId ? { type: "channel" as const, channelId } : { type: "dm" as const },
          trigger: await triggerInput(work.trigger),
        };
        if (item.targetId) {
          // An update keeps it on or off as the person left it.
          await updateRoutine(routineDeps, actorId, orgId, item.targetId, fields);
          await remember(item, item.targetId);
          return;
        }
        const routine = await createRoutine(routineDeps, actorId, orgId, fields).catch((error) => {
          if (!(error instanceof ValidationError && error.code === "routine.too_many")) throw error;
          item.reason = "too_many_routines";
          return createRoutine(routineDeps, actorId, orgId, { ...fields, paused: true });
        });
        await remember(item, routine.id);
        return;
      }
      case "note": {
        const agentId = work.agent === null ? null : (ids.agent.get(work.agent) as string);
        const fields = { content: work.content, ...(work.title ? { title: work.title } : {}) };
        const row = item.targetId
          ? await editContextItem(db, actorId, orgId, item.targetId, fields)
          : await addContextItemByPerson(db, actorId, orgId, { ...fields, kind: work.noteKind, agentId });
        await remember(item, row.id);
        return;
      }
    }
  };

  for (const item of plan.items) {
    const work = item.work;
    if (item.action === "skip" || item.action === "unchanged" || !work) continue;
    // What it depends on may have failed a step earlier.
    const missing =
      (work.kind === "routine" || work.kind === "note") && work.agent !== null && !ids.agent.has(work.agent)
        ? "agent_not_picked"
        : work.kind === "routine" && work.channel !== null && !ids.channel.has(work.channel)
          ? "channel_not_picked"
          : null;
    try {
      if (missing) throw missing;
      await apply(item, work);
    } catch (error) {
      Object.assign(item, { action: "skip", reason: missing ?? failure(error) });
    }
  }

  // Imported skills arrive on for the agents that had them, only where the agent or the skill is new: a pair that
  // came in an earlier import stays as the person left it.
  const createdSkills = new Set(
    plan.items.filter((i) => i.kind === "skill" && i.action === "create").map((i) => i.key),
  );
  const wanted = new Map<string, string[]>();
  for (const item of plan.items) {
    if (item.work?.kind !== "agent" || item.action === "skip") continue;
    const agentId = ids.agent.get(item.key);
    const skillIds = item.work.skills.flatMap((key) => {
      const id = item.action === "create" || createdSkills.has(key) ? ids.skill.get(key) : undefined;
      return id ? [id] : [];
    });
    if (agentId && skillIds.length > 0) wanted.set(agentId, skillIds);
  }
  if (wanted.size > 0) {
    const on = await db
      .select({ agentId: schema.agentSkills.agentId, skillId: schema.agentSkills.skillId })
      .from(schema.agentSkills)
      .where(
        and(
          eq(schema.agentSkills.orgId, orgId),
          inArray(schema.agentSkills.agentId, [...wanted.keys()]),
          eq(schema.agentSkills.enabled, true),
        ),
      );
    for (const [agentId, skillIds] of wanted) {
      const off = skillIds.filter((id) => !on.some((r) => r.agentId === agentId && r.skillId === id));
      if (off.length > 0) {
        await setAgentSkills(
          db,
          actorId,
          orgId,
          agentId,
          off.map((skillId) => ({ skillId, enabled: true })),
        );
      }
    }
  }

  const count = (action: ImportItemResult["action"]) => plan.items.filter((i) => i.action === action).length;
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "import.applied",
    target: { type: "import", id: null },
    details: {
      app: source.app,
      ref: source.ref,
      name: source.name,
      created: count("create"),
      updated: count("update"),
      unchanged: count("unchanged"),
      skipped: count("skip"),
    },
  });
  return { items: plan.items.map(publicItem) };
}

/**
 * What the workspace brought from other apps, one entry per source package in the order they first came: how many
 * of each kind. A channel that was here already (`adopted`) didn't come. Admins only (`manage_agents`).
 */
export async function importedSources(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const rows = await db
    .select({
      app: importItems.sourceApp,
      ref: importItems.sourceRef,
      kind: importItems.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(importItems)
    .where(and(eq(importItems.orgId, orgId), eq(importItems.adopted, false)))
    .groupBy(importItems.sourceApp, importItems.sourceRef, importItems.kind)
    .orderBy(sql`min(${importItems.createdAt})`);
  const sources = new Map<string, { app: string; ref: string; counts: Record<ImportItemKind, number> }>();
  for (const row of rows) {
    const key = JSON.stringify([row.app, row.ref]);
    const source = sources.get(key) ?? {
      app: row.app,
      ref: row.ref,
      counts: Object.fromEntries(IMPORT_KINDS.map((k) => [k, 0])) as Record<ImportItemKind, number>,
    };
    if (row.kind in source.counts) source.counts[row.kind as ImportItemKind] = row.n;
    sources.set(key, source);
  }
  return [...sources.values()];
}

/** `<folder>/<path>` in the Drive's title limit: a long path keeps its end, where the file's name is. */
function driveTitle(folder: string, path: string) {
  const title = `${folder}/${path}`;
  const max = ARTIFACT_LIMITS.titleChars;
  return title.length <= max ? title : `${folder}/…${path.slice(-(max - folder.length - 2))}`;
}

/**
 * One of an imported agent's own files (OpenBot.run's `files/`, an OpenClaw workspace) into its folder in the
 * Drive: titled `<agent's name>/<path>`, keeping the source's folders, seen by the whole workspace and made by the
 * agent (its page lists it; the audit names the importer). A path the agent already has a file at (outside the
 * trash, whatever its folder is named now) stays as it was: `exists`, so importing again never overwrites. Never a credential store, by its name (`isSecretFile`) or
 * by what it holds, whatever its type (`holdsSecret`: a private key, or a key or a password in its text, as for
 * memory). The Drive's limits apply: 50 MB a file, the workspace's storage and daily uploads (409 `storage.full`,
 * `storage.daily_full`). Who may import, into an agent their own import brought (or anyone's, who manages agents).
 */
export async function copyImportedFile(
  deps: ArtifactDeps,
  actorId: string,
  orgId: string,
  input: {
    agentId: string;
    path: string;
    name: string;
    bytes: Uint8Array;
    contentType?: string | null;
    note?: string | null;
  },
): Promise<{ status: "created" | "exists"; artifactId: string; title: string; folder: string }> {
  const { db } = deps;
  const membership = await requirePermission(db, actorId, orgId, "create_agents");
  // The file is credited to the agent: only into one this person's import brought, unless they manage agents.
  if (!can(membership, "manage_agents")) {
    const [mine] = await db
      .select({ id: importItems.id })
      .from(importItems)
      .where(
        and(
          eq(importItems.orgId, orgId),
          eq(importItems.createdByUserId, actorId),
          eq(importItems.kind, "agent"),
          eq(importItems.targetId, input.agentId),
        ),
      )
      .limit(1);
    if (!mine) throw new NotFoundError("Agent not found");
  }
  const parts = input.path.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new ValidationError("the path must stay inside the agent's folder", "import.file_path");
  }
  const path = parts.join("/");
  const name = input.name || (parts.at(-1) as string);
  if (isSecretFile(path) || isSecretFile(name) || holdsSecret(input.bytes)) {
    throw new ValidationError("files with keys or sign-ins are never copied to the Drive", "import.secret_file");
  }
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!agent) throw new NotFoundError("Agent not found");
  const folder = driveFolder(agent.name);
  // Trimmed as the Drive stores titles. What the agent already has at this path, whatever its folder is named now.
  const title = driveTitle(folder, path).trim();
  const tail = title.slice(folder.length);
  const tailChars = [...tail].length;
  const [existing] = await db
    .select({ id: schema.artifacts.id, title: schema.artifacts.title })
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.orgId, orgId),
        eq(schema.artifacts.createdByType, "agent"),
        eq(schema.artifacts.createdById, input.agentId),
        // The whole path below one folder (names never hold a `/`), not any deeper file that ends the same.
        sql`right(${schema.artifacts.title}, ${tailChars}) = ${tail}`,
        sql`char_length(${schema.artifacts.title}) > ${tailChars}`,
        sql`strpos(left(${schema.artifacts.title}, char_length(${schema.artifacts.title}) - ${tailChars}), '/') = 0`,
        isNull(schema.artifacts.channelId),
        isNull(schema.artifacts.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return { status: "exists", artifactId: existing.id, title: existing.title, folder };
  const created = await createFileArtifact(deps, { type: "person", userId: actorId }, orgId, {
    title,
    name,
    bytes: input.bytes,
    contentType: input.contentType,
    note: input.note,
    author: { type: "agent", id: input.agentId },
  });
  return { status: "created", artifactId: created.id, title, folder };
}
