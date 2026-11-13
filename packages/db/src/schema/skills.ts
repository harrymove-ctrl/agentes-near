import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * Skills in Markdown (Agent Skills `SKILL.md` format), per organization:
 * a name and description the agent sees, and a body it loads on demand
 * (`load_skill`). No code runs: scripts are kept as "ignored" until the
 * sandbox exists (ADR 0020).
 */
/** A changed file that runs, as its link has it now (`before` null: new); texts null past what the page shows. */
export interface SkillPendingFile {
  path: string;
  before: string | null;
  after: string | null;
  large?: boolean;
}

/**
 * An update from its link waiting for a person (`skills.pendingUpdate`): what its link held (`hash`), its files that
 * run (`scripts`, with their text in `files`) and its text (`body`, `description`), to show what it would change.
 */
export interface SkillPendingUpdate {
  hash: string;
  scripts: string[];
  at: string;
  dismissed?: boolean;
  /** When a person kept the skill as it is (`dismissed`). */
  dismissedAt?: string;
  edited?: boolean;
  body?: string;
  description?: string;
  files?: SkillPendingFile[];
}

export const skills = pgTable(
  "skills",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The skill's `name` (kebab-case, ≤ 64), unique in the org. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    body: text().notNull(),
    /** Other frontmatter fields, as given. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** `upload`, `url` or `manual`. */
    source: text().notNull(),
    sourceUrl: text(),
    /**
     * How a private repository was read (`github_app` or the `github` connection), which updating reads through
     * again. Null: read with no credentials.
     */
    sourceVia: text(),
    version: integer().notNull().default(1),
    /** Enabled for agents created later. */
    defaultForNewAgents: boolean().notNull().default(false),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** `person` (installed or written by people) or `agent` (promoted from an agent's how-tos, ADR 0120). */
    origin: text().notNull().default("person"),
    /** An agent-made skill's agent: the only one that may change it with `update_skill`. */
    ownerAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** A person froze it: agents can't change it and decay leaves it alone. */
    locked: boolean().notNull().default(false),
    /** "Agentes melhoram as skills sozinhos" for this skill; null: the workspace's setting. */
    agentsImprove: boolean(),
    /** `load_skill` calls, for an agent-made skill's decay. */
    useCount: integer().notNull().default(0),
    lastUsedAt: timestamp({ withTimezone: true }),
    /** "Atualizar sozinha": read from its link every day, with the rights of `autoUpdateUserId` (who turned it on). */
    autoUpdate: boolean().notNull().default(false),
    autoUpdateUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** What its link held when last read (`skillSourceHash`): the same again is no new version. */
    sourceHash: text(),
    /** When its link was last read to update it. */
    checkedAt: timestamp({ withTimezone: true }),
    /**
     * An update from its link that adds or changes what runs (scripts, other executables), waiting for a person who
     * manages skills: what it held (`hash`) and those files. `dismissed`: said no to; the same content isn't raised again.
     * `edited`: it waits (also) because it would replace what agents changed (`editedSinceSource`).
     */
    pendingUpdate: jsonb().$type<SkillPendingUpdate>(),
    /**
     * Changed by an agent (or an accepted proposal) since its link last wrote it: the next update from its link waits
     * for a person (`pendingUpdate.edited`), since it would replace that change. A save of the whole skill clears it.
     */
    editedSinceSource: boolean().notNull().default(false),
    /**
     * The text its link last wrote, kept when an agent (or an accepted proposal) first changes it after that: what the
     * agents changed is measured from it, and so is what its link changed next. Null once its link writes it again.
     */
    linkBase: jsonb().$type<{ body: string; description: string; at: string }>(),
    /** The last refusal of an update from its link (its code), so a failure is reported once, not every day. */
    updateError: text(),
    /**
     * The last update from its link, or an agent's last change to it (`agentId`), to undo it: the version before (its
     * text) and the version it made.
     */
    lastUpdate: jsonb().$type<{
      from: { version: number; body: string; description: string; metadata: Record<string, unknown> };
      version: number;
      at: string;
      agentId?: string;
      /**
       * It was a waiting update a person applied: undoing it brings the choice back (this update waiting, its link's
       * hash, `editedSinceSource` and `linkBase` as they were).
       */
      waited?: {
        pending: SkillPendingUpdate;
        sourceHash: string | null;
        linkBase: { body: string; description: string; at: string } | null;
        /** `editedSinceSource` then (absent on older rows: the update's `edited`). */
        edited?: boolean;
      };
      /** An agent's change: `editedSinceSource` and `linkBase` before it, as undoing it leaves them. */
      prior?: { edited: boolean; linkBase: { body: string; description: string; at: string } | null };
    }>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.slug), index().on(t.orgId)],
);

/** A skill's supporting files (references, templates, examples, images), per version. */
export const skillFiles = pgTable(
  "skill_files",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    path: text().notNull(),
    size: integer().notNull(),
    mime: text().notNull(),
    /**
     * `stored` (the model may read it: text, images, other files), `script` (kept for the sandbox, never shown) or
     * `ignored` (listed only: a binary past what a skill keeps; size 0 when installed before binaries were kept).
     */
    status: text().notNull(),
    storageConfigId: uuid(),
    blobKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.skillId, t.version, t.path), index().on(t.orgId)],
);

/** Which skills an agent has. */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.agentId, t.skillId), index().on(t.orgId)],
);
