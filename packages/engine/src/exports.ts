import { and, arrayContained, asc, type Database, desc, eq, inArray, isNull, ne, or, schema } from "@agenteschat/db";
import { type BundleRoutine, type BundleRule, IMPORT_LIMITS, type MigrationBundle, NOTE_KINDS } from "./imports";
import { requirePermission } from "./organizations";
import type { RoutineTarget } from "./routines";

const { organizations, agents, skills, skillFiles, agentSkills, channels, channelMembers, routines, contextItems } =
  schema;

/** A stored skill as a `SKILL.md`: name, description and the rest of its frontmatter, then the body. */
function skillMarkdown(s: { name: string; description: string; body: string; metadata: Record<string, unknown> }) {
  const frontmatter = Bun.YAML.stringify({ name: s.name, description: s.description, ...s.metadata }, null, 2);
  return `---\n${frontmatter.trimEnd()}\n---\n\n${s.body}\n`;
}

type RoutineRow = typeof routines.$inferSelect;

/** A routine as the bundle carries it; null when its trigger or target can't move (events, mail). */
function bundleRoutine(r: RoutineRow, channelIds: Set<string>): BundleRoutine | null {
  const target = r.target as unknown as RoutineTarget;
  const channel =
    target.type === "dm"
      ? null
      : target.type === "channel" && channelIds.has(target.channelId)
        ? target.channelId
        : undefined;
  const trigger =
    r.triggerType === "schedule"
      ? r.rule
        ? { rule: r.rule as unknown as BundleRule }
        : r.cron
          ? { cron: r.cron, timezone: r.timezone }
          : null
      : r.triggerType === "once" && r.nextRunAt
        ? { at: r.nextRunAt.toISOString() }
        : null;
  if (channel === undefined || !trigger) return null;
  return { key: r.id, name: r.name, agent: r.agentId, prompt: r.prompt, channel, trigger };
}

/**
 * This workspace as a migration bundle (ADR 0055; `GET …/export`, admins),
 * importable into another one (self-host ↔ Cloud) through `applyImport`.
 * Keys are our ids. Agents with their look and the skills they have on;
 * skills as `SKILL.md` (their other files are listed as left out); public
 * channels with their agents; scheduled routines;
 * memory everyone here can see, up to the import limit, most relevant
 * first. Never credentials, connections or their tokens, computers, runs,
 * usage, audit or messages.
 */
export async function exportBundle(db: Database, actorId: string, orgId: string): Promise<MigrationBundle> {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [agentRows, skillRows, channelRows] = await Promise.all([
    db
      .select()
      .from(agents)
      // The right hand is the product's, not the team's (ADR 0137): never exported, so never imported elsewhere.
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
      .orderBy(asc(agents.createdAt)),
    db
      .select()
      .from(skills)
      .where(and(eq(skills.orgId, orgId), isNull(skills.deletedAt)))
      .orderBy(asc(skills.createdAt)),
    // Private channels stay: an import would make them public, with what they're about.
    db
      .select({ id: channels.id, name: channels.name, topic: channels.topic })
      .from(channels)
      .where(
        and(
          eq(channels.orgId, orgId),
          eq(channels.kind, "channel"),
          eq(channels.visibility, "public"),
          isNull(channels.archivedAt),
        ),
      )
      .orderBy(asc(channels.createdAt)),
  ]);
  const agentIds = agentRows.map((a) => a.id);
  const skillIds = skillRows.map((s) => s.id);
  const channelIds = new Set(channelRows.map((c) => c.id));
  const [skillsOn, files, members, routineRows, noteRows] = await Promise.all([
    agentIds.length > 0 && skillIds.length > 0
      ? db
          .select({ agentId: agentSkills.agentId, skillId: agentSkills.skillId })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.orgId, orgId),
              eq(agentSkills.enabled, true),
              inArray(agentSkills.agentId, agentIds),
              inArray(agentSkills.skillId, skillIds),
            ),
          )
      : [],
    skillIds.length > 0
      ? db
          .select({ skillId: skillFiles.skillId, version: skillFiles.version, path: skillFiles.path })
          .from(skillFiles)
          .where(
            and(eq(skillFiles.orgId, orgId), inArray(skillFiles.skillId, skillIds), ne(skillFiles.status, "ignored")),
          )
      : [],
    agentIds.length > 0 && channelIds.size > 0
      ? db
          .select({
            channelId: channelMembers.channelId,
            agentId: channelMembers.agentId,
            autoReply: channelMembers.autoReply,
          })
          .from(channelMembers)
          .where(
            and(
              eq(channelMembers.orgId, orgId),
              inArray(channelMembers.channelId, [...channelIds]),
              inArray(channelMembers.agentId, agentIds),
            ),
          )
          .orderBy(asc(channelMembers.createdAt))
      : [],
    agentIds.length > 0
      ? db
          .select()
          .from(routines)
          .where(and(eq(routines.orgId, orgId), isNull(routines.deletedAt), inArray(routines.agentId, agentIds)))
          .orderBy(asc(routines.createdAt))
      : [],
    // What a person would stand behind: kept, verified, undisputed knowledge (an import stores it as theirs).
    // Learned in a private channel or a DM, it stays: the other workspace would show it to everyone.
    db
      .select({
        id: contextItems.id,
        agentId: contextItems.agentId,
        kind: contextItems.kind,
        title: contextItems.title,
        content: contextItems.content,
      })
      .from(contextItems)
      .where(
        and(
          eq(contextItems.orgId, orgId),
          eq(contextItems.status, "active"),
          eq(contextItems.trust, "high"),
          eq(contextItems.verified, true),
          eq(contextItems.disputed, false),
          inArray(contextItems.kind, [...NOTE_KINDS]),
          inArray(contextItems.scopeType, ["org", "agent"]),
          agentIds.length > 0
            ? or(isNull(contextItems.agentId), inArray(contextItems.agentId, agentIds))
            : isNull(contextItems.agentId),
          arrayContained(contextItems.channelIds, [...channelIds]),
        ),
      )
      .orderBy(desc(contextItems.pinned), desc(contextItems.relevance), desc(contextItems.updatedAt))
      .limit(IMPORT_LIMITS.notes),
  ]);

  const leftOut: MigrationBundle["leftOut"] = [];
  const bundleRoutines: BundleRoutine[] = [];
  for (const r of routineRows) {
    const entry = bundleRoutine(r, channelIds);
    if (entry) bundleRoutines.push(entry);
    // A paused or finished one-off has no moment left to bring.
    else if (r.triggerType !== "once") leftOut.push({ kind: "routine", label: r.name });
  }
  const versionOf = new Map(skillRows.map((s) => [s.id, s.version]));
  const nameOf = new Map(skillRows.map((s) => [s.id, s.name]));
  for (const f of files) {
    if (versionOf.get(f.skillId) === f.version)
      leftOut.push({ kind: "file", label: `${nameOf.get(f.skillId)}/${f.path}`.slice(0, 500) });
  }
  return {
    format: "agenteschat.bundle",
    version: 1,
    source: { app: "agenteschat", ref: orgId, name: org?.name ?? "", files: [] },
    agents: agentRows.map((a) => ({
      key: a.id,
      name: a.name,
      handle: a.handle,
      role: a.role,
      instructions: a.instructions,
      model: a.model,
      appearance: a.appearance ?? {},
      skills: skillsOn.filter((s) => s.agentId === a.id).map((s) => s.skillId),
    })),
    skills: skillRows.map((s) => ({ key: s.id, markdown: skillMarkdown(s) })),
    channels: channelRows.map((c) => ({
      key: c.id,
      name: c.name,
      topic: c.topic,
      agents: members
        .filter((m) => m.channelId === c.id && m.agentId !== null)
        .map((m) => ({ key: m.agentId as string, autoReply: m.autoReply })),
    })),
    routines: bundleRoutines,
    notes: noteRows.map((n) => ({
      key: n.id,
      agent: n.agentId,
      kind: n.kind as MigrationBundle["notes"][number]["kind"],
      title: n.title,
      content: n.content,
    })),
    todo: [],
    leftOut,
  };
}
