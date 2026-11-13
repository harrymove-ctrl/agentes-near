import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, gt, inArray, isNull, lte, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { mapInBatches } from "./batches";
import { activeConnections, type ConnectorDeps } from "./connectors/connections";
import { type ErrorParams, ForbiddenError, NotFoundError, TooManyError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import { formatBytes } from "./format";
import { connectionToken } from "./git/branches";
import { appTokenForRepo, boundInstallations, type GitHubAppConfig, type GitHubHttp } from "./git/github-app";
import { assertStorageRoom } from "./limits";
import { assertPublicHttpsUrl, type ResolveHost } from "./net-guard";
import { can, requirePermission } from "./organizations";
import { isRightHand } from "./right-hand";
import { inflateZipEntry, listZip, type ZipListing } from "./zip";

const { skills, skillFiles, agentSkills } = schema;

export type SkillRow = typeof skills.$inferSelect;

/**
 * `maxBytes`: the text and scripts a skill keeps (past it the skill is refused). `assetBytes`: the images, PDFs and
 * other binary files it keeps, in folder order (past it the rest are only listed). `imageBytes`: the largest image
 * shown to a model (5 MB of base64, what the Claude API takes). The first two sized for the largest skills published
 * for other agents (design kits of about 1,600 files, 8 MB of text and scripts, 28 MB of images), with room to grow;
 * a version is held in memory whole while it installs, so they bound that too.
 */
export const SKILL_LIMITS = {
  maxFiles: 3000,
  maxBytes: 16 * 1024 * 1024,
  assetBytes: 40 * 1024 * 1024,
  imageBytes: 3_750_000,
  bodyChars: 200_000,
  fileReadChars: 40_000,
};
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Files the model reads as text. */
const SHOWABLE: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
};

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
}

function unquote(v: string) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Past this many values a frontmatter is refused as YAML (aliases can make a few lines stand for millions). */
const FRONTMATTER_MAX_NODES = 10_000;

/** The frontmatter as YAML (nested maps such as `metadata.openclaw`, block scalars, lists); null when it isn't. */
function yamlFields(yaml: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Every alias is the same object (possibly cyclic): a plain copy, within the budget, is what gets stored.
  let nodes = 0;
  try {
    return JSON.parse(
      JSON.stringify(parsed, (_key, value) => {
        if (++nodes > FRONTMATTER_MAX_NODES) throw new Error("frontmatter too large");
        return value;
      }),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Top-level `key: value`, quoted strings, `|`/`>` blocks and `- item` lists, line by line. */
function lineFields(yaml: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as string;
    const value = kv[2] ?? "";
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      fields[key] = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (value === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1] ?? "")) {
        items.push(unquote((lines[++i] ?? "").replace(/^\s+-\s+/, "")));
      }
      fields[key] = items.length > 0 ? items : "";
    } else fields[key] = unquote(value);
  }
  return fields;
}

/**
 * Parses a `SKILL.md`: YAML frontmatter and the Markdown body. `name` and
 * `description` are required (kebab-case ≤ 64; ≤ 1024 characters); other
 * fields are kept as metadata, nested ones included.
 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) {
    throw new ValidationError("SKILL.md needs a frontmatter block (--- name/description ---)", "skill.no_frontmatter");
  }
  const lines = lineFields(m[1] ?? "");
  // Many published skills aren't valid YAML (`description: Use when: …`): they keep the line reading.
  const { name, description, ...metadata } = yamlFields(m[1] ?? "") ?? lines;
  // YAML reads `description: Yes` as a boolean and `name: 1.0` as a number: then the text as written.
  const written = (value: unknown, key: "name" | "description") =>
    (typeof value === "string" ? value : typeof lines[key] === "string" ? (lines[key] as string) : "").trim();
  const parsed = {
    name: written(name, "name"),
    description: written(description, "description"),
    body: (m[2] ?? "").trim(),
    metadata,
  };
  validateSkill(parsed);
  return parsed;
}

export function validateSkill(s: { name: string; description: string; body: string }) {
  if (!SKILL_NAME.test(s.name) || s.name.length > 64) {
    throw new ValidationError(
      "name: kebab-case (lowercase letters, numbers and hyphens), up to 64 characters",
      "skill.invalid_name",
      { max: 64 },
    );
  }
  if (!s.description || s.description.length > 1024)
    throw new ValidationError("description: 1 to 1024 characters", "skill.invalid_description", { max: 1024 });
  if (s.body.length > SKILL_LIMITS.bodyChars) {
    throw new ValidationError("The skill body is too long", "skill.body_too_long", { max: SKILL_LIMITS.bodyChars });
  }
}

/** Scripts we keep (never shown to the model) so `run_skill_script` can run them on the agent's computer (ADR 0021). */
export const SKILL_SCRIPTS: Record<string, string> = {
  py: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
};

/**
 * `stored`: kept, and the model may read it (text as text, an image as an image, other files described); `script`:
 * kept for the agent's computer, never shown; `ignored`: listed only (a binary past `SKILL_LIMITS.assetBytes`).
 */
export type SkillFileStatus = "stored" | "script" | "ignored";

/** Images the models read (what the Claude, OpenAI and Gemini APIs take). */
export const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A file by its name: text the model reads, a script, or a binary (an image, a PDF, anything else). */
export function classifyFile(path: string): { mime: string; kind: "text" | "script" | "binary" } {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const mime = SHOWABLE[ext];
  if (mime) return { mime, kind: "text" };
  const script = SKILL_SCRIPTS[ext];
  if (script) return { mime: script, kind: "script" };
  return { mime: Bun.file(path).type.split(";")[0] || "application/octet-stream", kind: "binary" };
}

/** The binary files a skill keeps: in the order given, while they fit `SKILL_LIMITS.assetBytes`. */
function keptBinaries(files: { path: string; size: number }[]) {
  const kept = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (classifyFile(f.path).kind !== "binary" || total + f.size > SKILL_LIMITS.assetBytes) continue;
    total += f.size;
    kept.add(f.path);
  }
  return kept;
}

/** A path in a skill's folder as written, with `/` separators and no leading `./` or `/`. */
export const cleanSkillPath = (path: string) => path.replace(/\\/g, "/").replace(/^\.?\/+/, "");

function safePath(path: string) {
  const clean = cleanSkillPath(path);
  if (!clean || clean.split("/").some((p) => p === ".." || p === "") || clean.startsWith("/")) {
    throw new ValidationError(`Invalid path in the skill: ${path}`);
  }
  return clean;
}

export interface SkillFileInput {
  path: string;
  data: Uint8Array;
  /** A binary left unread (past `SKILL_LIMITS.assetBytes`): its size, and `data` is empty. */
  skippedSize?: number;
}

/** A skill folder's files → the SKILL.md (found at the root, or under one top folder) and the rest. */
export function splitSkillFolder(files: SkillFileInput[]) {
  const normalized = files.map((f) => ({ ...f, path: safePath(f.path) }));
  const firstSegments = new Set(normalized.map((f) => f.path.split("/")[0]));
  let root = "";
  if (!normalized.some((f) => f.path.toLowerCase() === "skill.md") && firstSegments.size === 1) {
    root = `${[...firstSegments][0]}/`;
  }
  const inRoot = normalized
    .filter((f) => f.path.startsWith(root) && !f.path.split("/").some((p) => p.startsWith(".") && p !== "."))
    .map((f) => ({ ...f, path: f.path.slice(root.length) }));
  const main = inRoot.find((f) => f.path.toLowerCase() === "skill.md");
  if (!main) throw new ValidationError("No SKILL.md at the top of the skill folder", "skill.no_skill_md_zip");
  return { skillMd: new TextDecoder().decode(main.data), files: inRoot.filter((f) => f !== main) };
}

export interface SkillDeps {
  db: Database;
  blobs: BlobStoreResolver;
  /** Tests: fake HTTP and DNS for URL imports. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveHost?: ResolveHost;
  /** The workspace's GitHub (its connection, the GitHub App), for private repositories. None: public ones only. */
  github?: { connectors: ConnectorDeps; app?: GitHubAppConfig | null };
  /** Notifications of updates from a skill's link (`skill-updates.ts`). */
  pubsub?: PubSub;
}

/** Which of the workspace's GitHub connections read a private repository: the GitHub App, or the GitHub connector. */
export type SkillVia = "github_app" | "github";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  version: number;
  source: string;
  sourceUrl: string | null;
  sourceVia: SkillVia | null;
  defaultForNewAgents: boolean;
  metadata: Record<string, unknown>;
  /** `person` or `agent` (promoted from an agent's how-tos, ADR 0120). */
  origin: "person" | "agent";
  ownerAgentId: string | null;
  locked: boolean;
  useCount: number;
  lastUsedAt: string | null;
  /** "Atualizar sozinha": read from its link every day. */
  autoUpdate: boolean;
  /** When its link was last read to update it. */
  checkedAt: string | null;
  /**
   * An update from its link that changes what runs, or would replace what agents changed since its link last wrote it
   * (`edited`), waiting for a person who manages skills. `dismissed`: kept as it is (`dismissedAt`), until
   * `reopenSkillUpdate`.
   */
  pendingUpdate: {
    scripts: string[];
    at: string;
    dismissed: boolean;
    dismissedAt: string | null;
    edited: boolean;
  } | null;
  /** Why its last update from its link failed (a code the app translates), until one works. */
  updateError: string | null;
  /**
   * Its last update from its link, or an agent's last change to it (`agentId`), while it can be undone (the skill is
   * still at the version it made).
   */
  lastUpdate: { fromVersion: number; at: string; agentId: string | null; waited: boolean } | null;
  /** "Agentes melhoram as skills sozinhos" set for this skill; null: the workspace's setting. */
  agentsImprove: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** An agent's change to a skill's text (`skill.updated`), newest first: the skill's page shows each with its diff. */
export interface SkillAgentChange {
  id: string;
  agentId: string;
  at: string;
  before: string;
  after: string;
  undone: boolean;
}

/** How many of a skill's changes by agents its page lists. */
export const SKILL_CHANGES_SHOWN = 20;

export interface SkillDetail extends SkillView {
  body: string;
  files: { path: string; size: number; mime: string; status: SkillFileStatus }[];
  /**
   * The waiting update's content, to show what it changes: its text, its files that run, and the text its link last
   * wrote before agents changed it (`base`, null when that isn't known).
   */
  pending: {
    body: string;
    description: string;
    base: { body: string; description: string; at: string } | null;
    files: { path: string; before: string | null; after: string | null; large: boolean }[];
  } | null;
  changes: SkillAgentChange[];
}

const view = (s: SkillRow): SkillView => ({
  id: s.id,
  name: s.name,
  description: s.description,
  version: s.version,
  source: s.source,
  sourceUrl: s.sourceUrl,
  sourceVia: s.sourceVia as SkillVia | null,
  defaultForNewAgents: s.defaultForNewAgents,
  metadata: s.metadata,
  origin: s.origin === "agent" ? "agent" : "person",
  ownerAgentId: s.ownerAgentId,
  locked: s.locked,
  useCount: s.useCount,
  lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
  autoUpdate: s.autoUpdate,
  checkedAt: s.checkedAt?.toISOString() ?? null,
  pendingUpdate: s.pendingUpdate
    ? {
        scripts: s.pendingUpdate.scripts,
        at: s.pendingUpdate.at,
        dismissed: s.pendingUpdate.dismissed === true,
        dismissedAt: s.pendingUpdate.dismissedAt ?? null,
        edited: s.pendingUpdate.edited === true,
      }
    : null,
  updateError: s.updateError,
  lastUpdate:
    s.lastUpdate && s.lastUpdate.version === s.version
      ? {
          fromVersion: s.lastUpdate.from.version,
          at: s.lastUpdate.at,
          agentId: s.lastUpdate.agentId ?? null,
          waited: !!s.lastUpdate.waited,
        }
      : null,
  agentsImprove: s.agentsImprove,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

/** Files of the skill's current version. */
export async function skillFilesOf(db: Database, s: SkillRow) {
  const rows = await db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, s.version)))
    .orderBy(asc(skillFiles.path));
  return rows.map((f) => ({ path: f.path, size: f.size, mime: f.mime, status: f.status as SkillFileStatus }));
}

/** The agents' changes to its text, newest first (`SKILL_CHANGES_SHOWN`). */
async function skillChanges(db: Database, s: SkillRow): Promise<SkillAgentChange[]> {
  const rows = await db
    .select()
    .from(schema.agentActions)
    .where(
      and(
        eq(schema.agentActions.orgId, s.orgId),
        eq(schema.agentActions.kind, "skill.updated"),
        eq(schema.agentActions.targetId, s.id),
      ),
    )
    .orderBy(sql`${schema.agentActions.createdAt} desc`)
    .limit(SKILL_CHANGES_SHOWN);
  return rows.flatMap((r) => {
    const before = (r.before as { body?: unknown } | null)?.body;
    const after = (r.after as { body?: unknown } | null)?.body;
    // An update from its link an agent asked for (`update_skill_from_source`) isn't a change of its own.
    if (typeof before !== "string" || typeof after !== "string" || (r.params as { fromLink?: unknown }).fromLink)
      return [];
    return [
      { id: r.id, agentId: r.agentId, at: r.createdAt.toISOString(), before, after, undone: r.undoneAt !== null },
    ];
  });
}

const pendingOf = (s: SkillRow): SkillDetail["pending"] => {
  const p = s.pendingUpdate;
  if (!p || p.body === undefined) return null;
  return {
    body: p.body,
    description: p.description ?? s.description,
    base: s.linkBase,
    files: (p.files ?? []).map((f) => ({ path: f.path, before: f.before, after: f.after, large: !!f.large })),
  };
};

export const skillDetail = async (db: Database, s: SkillRow): Promise<SkillDetail> => ({
  ...view(s),
  body: s.body,
  files: await skillFilesOf(db, s),
  pending: pendingOf(s),
  changes: await skillChanges(db, s),
});

/**
 * The fields an agent's change (or an accepted proposal) writes on the skill as it was (`before`): it is edited since
 * its link last wrote it, and the first such change keeps that text and when it was written (`linkBase`).
 */
export const editedByAgents = (before: SkillRow) => ({
  editedSinceSource: true,
  linkBase:
    before.editedSinceSource || before.source !== "url"
      ? before.linkBase
      : { body: before.body, description: before.description, at: before.updatedAt.toISOString() },
});

export async function loadSkill(db: Database, orgId: string, id: string) {
  const [s] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId), isNull(skills.deletedAt)));
  if (!s) throw new NotFoundError("Skill not found");
  return s;
}

const MB = 1024 * 1024;

/**
 * A skill whose files have these paths and sizes within the limits, refused as an upload is. Binaries (images, PDFs,
 * videos) count as files, not toward the size: past `SKILL_LIMITS.assetBytes` they are only listed.
 */
function assertSkillSize(files: { path: string; size: number }[]) {
  const { maxFiles, maxBytes } = SKILL_LIMITS;
  if (files.length > maxFiles) {
    throw new ValidationError(`This skill has ${files.length} files (max ${maxFiles})`, "skill.too_many_files", {
      files: files.length,
      max: maxFiles,
    });
  }
  const bytes = files.reduce((n, f) => n + (classifyFile(f.path).kind === "binary" ? 0 : f.size), 0);
  if (bytes > maxBytes) {
    const [size, max] = [Math.ceil((bytes / MB) * 10) / 10, maxBytes / MB];
    throw new ValidationError(`This skill has ${size} MB of text and scripts (max ${max} MB)`, "skill.too_large", {
      size,
      max,
    });
  }
}

/** Where a version's files go and how each is kept, refused before the skill or any file is written. */
async function planFiles(deps: SkillDeps, orgId: string, files: SkillFileInput[]) {
  assertSkillSize(files.map((f) => ({ path: f.path, size: f.skippedSize ?? f.data.byteLength })));
  // Two entries that normalize to the same path would share one blob key: the second's bytes overwrite
  // the first on disk while its row insert is dropped on the unique key, so the stored size stops matching disk.
  const normalized = files.map((f) => ({ ...f, path: safePath(f.path) }));
  const seen = new Set<string>();
  for (const { path } of normalized) {
    if (seen.has(path)) throw new ValidationError(`Two files share the path ${path}`, "skill.duplicate_path");
    seen.add(path);
  }
  const location = await deps.blobs.forOrg(orgId);
  const kept = keptBinaries(
    normalized.filter((n) => n.skippedSize === undefined).map((n) => ({ path: n.path, size: n.data.byteLength })),
  );
  const planned = normalized.map((n) => {
    const { mime, kind } = classifyFile(n.path);
    const status: SkillFileStatus =
      kind === "text" ? "stored" : kind === "script" ? "script" : kept.has(n.path) ? "stored" : "ignored";
    return {
      path: n.path,
      data: status === "ignored" ? new Uint8Array() : n.data,
      size: n.skippedSize ?? n.data.byteLength,
      mime,
      status,
    };
  });
  // The workspace's own bucket counts against no limit of ours. Storing no file (the skill's text is in the database)
  // takes no room, even past a limit lowered below what the workspace already keeps.
  const stored = planned.filter((p) => p.status !== "ignored").reduce((n, p) => n + p.data.byteLength, 0);
  if (location.storageConfigId === null && stored > 0) await assertStorageRoom(deps.db, orgId, stored);
  return { location, files: planned };
}

/** Blob reads and writes at a time: one by one, a skill of thousands of files outlasts a request on object storage. */
const BLOB_BATCH = 16;

/** Stores a version's files: kept ones in the blob store, the rest only listed as ignored. */
async function storeFiles(
  deps: SkillDeps,
  s: { id: string; orgId: string },
  version: number,
  { location, files }: Awaited<ReturnType<typeof planFiles>>,
) {
  if (files.length === 0) return;
  const rows = await mapInBatches(files, BLOB_BATCH, async ({ path, data, size, mime, status }) => {
    let blobKey: string | null = null;
    if (status !== "ignored") {
      blobKey = `${location.prefix}skills/${s.id}/v${version}/${path}`;
      await location.store.put(blobKey, data, { contentType: mime });
    }
    return {
      orgId: s.orgId,
      skillId: s.id,
      version,
      path,
      size,
      mime,
      status,
      storageConfigId: status !== "ignored" ? location.storageConfigId : null,
      blobKey,
    };
  });
  await deps.db.insert(skillFiles).values(rows);
}

/**
 * Installs or updates a skill from parsed content (admins, `manage_agents`).
 * The same name again is a new version of that skill; every change is audited.
 */
export async function saveSkill(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  input: ParsedSkill & {
    source: "upload" | "url" | "manual";
    sourceUrl?: string | null;
    sourceVia?: SkillVia | null;
    /** What its link held (`skillSourceHash`), read from it. */
    sourceHash?: string;
    files?: SkillFileInput[];
    defaultForNewAgents?: boolean;
  },
): Promise<SkillDetail> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  validateSkill(input);
  const files = await planFiles(deps, orgId, input.files ?? []);
  const [existing] = await deps.db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.slug, input.name)));
  let row: SkillRow;
  if (existing) {
    // Same name: a new version of that skill. A deleted one comes back with its agents' assignments, except from a link
    // (a pick of one too): it may hold anything under that name, so it comes back on for none of its old agents.
    const [updated] = await deps.db
      .update(skills)
      .set({
        description: input.description,
        body: input.body,
        metadata: input.metadata,
        source: input.source,
        sourceUrl: input.sourceUrl ?? existing.sourceUrl,
        // A link read again says how it was read; an edit or an upload keeps what updating reads through.
        sourceVia: input.source === "url" ? (input.sourceVia ?? null) : existing.sourceVia,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        // Incremented in SQL (not from the value read above) so two concurrent saves take distinct versions.
        version: sql`${skills.version} + 1`,
        ...(input.defaultForNewAgents !== undefined ? { defaultForNewAgents: input.defaultForNewAgents } : {}),
        deletedAt: null,
        editedSinceSource: false,
        linkBase: null,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, existing.id))
      .returning();
    if (!updated) throw new Error("skill update returned nothing");
    row = updated;
    if (existing.deletedAt && input.source === "url")
      await deps.db.update(agentSkills).set({ enabled: false }).where(eq(agentSkills.skillId, existing.id));
  } else {
    const [created] = await deps.db
      .insert(skills)
      .values({
        orgId,
        slug: input.name,
        name: input.name,
        description: input.description,
        body: input.body,
        metadata: input.metadata,
        source: input.source,
        sourceUrl: input.sourceUrl ?? null,
        sourceVia: input.sourceVia ?? null,
        sourceHash: input.sourceHash ?? null,
        defaultForNewAgents: input.defaultForNewAgents ?? false,
        createdByUserId: actorId,
      })
      .returning();
    if (!created) throw new Error("skill insert returned nothing");
    row = created;
  }
  await storeFiles(deps, row, row.version, files);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: existing && !existing.deletedAt ? "skill.updated" : existing ? "skill.restored" : "skill.installed",
    target: { type: "skill", id: row.id },
    details: {
      name: row.name,
      version: row.version,
      source: row.source,
      sourceUrl: row.sourceUrl,
      ...(row.sourceVia ? { sourceVia: row.sourceVia } : {}),
    },
  });
  return skillDetail(deps.db, row);
}

/** Import from a zip of the skill folder (`SKILL.md` + files). */
export async function importSkillZip(deps: SkillDeps, actorId: string, orgId: string, zip: Uint8Array) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const entries = listZip(zip).filter((e) => !e.symlink);
  return saveSkill(deps, actorId, orgId, {
    ...repositorySkill(
      zip,
      "",
      entries.map((e) => [e.path, e]),
    ),
    source: "upload",
  });
}

const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "api.github.com", "codeload.github.com"]);

/** Outbound HTTP and DNS for GitHub reads (tests: fakes). */
export interface GithubFetchDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  resolveHost?: ResolveHost;
}

export interface GithubFetchOptions {
  maxBytes: number;
  tooLarge: string;
  /** The refusal's code and params, when the app has its own words for it. */
  tooLargeCode?: string;
  tooLargeParams?: ErrorParams;
  /** Redirects followed, each hop checked as the first request is. None by default: a redirect is refused. */
  redirects?: number;
  /** Over the whole exchange, body included (default 15 s). */
  timeoutMs?: number;
}

/**
 * Minutes until GitHub stops limiting this server, or null when it isn't. GitHub answers 403 or 429 and says when
 * to retry in `retry-after` (seconds), else in `x-ratelimit-reset` once none remain, else "at least one minute"
 * (docs.github.com, "Rate limits for the REST API").
 */
function githubWaitMinutes(res: Response): number | null {
  const retryAfter = Number(res.headers.get("retry-after"));
  const spent = res.headers.get("x-ratelimit-remaining") === "0";
  if (res.status !== 429 && !(res.status === 403 && (spent || retryAfter > 0))) return null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const seconds = retryAfter > 0 ? retryAfter : spent && reset > 0 ? reset - Date.now() / 1000 : 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

const GITHUB_API = "https://api.github.com";

/** GitHub didn't answer (no answer, a 5xx while making a token): trying again later may read it. */
const unreachable = () => new ValidationError("Could not reach GitHub", "github.unreachable");

/**
 * One GET to a GitHub host through the SSRF guard (on every hop); GitHub limiting this server is refused as such.
 * `token` goes to api.github.com only: the archive it redirects to carries a short-lived link of its own.
 */
async function githubGet(
  deps: GithubFetchDeps,
  url: string,
  accept: string,
  options: GithubFetchOptions,
  token?: string,
) {
  const http = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const redirects = options.redirects ?? 0;
  let next = url;
  for (let hop = 0; ; hop++) {
    const at = await assertPublicHttpsUrl(next, deps.resolveHost);
    if (!GITHUB_HOSTS.has(at.hostname)) throw new ValidationError("Only GitHub URLs can be imported for now");
    const headers: Record<string, string> = { accept, "user-agent": "agentes.chat" };
    if (token && at.origin === GITHUB_API) headers.authorization = `Bearer ${token}`;
    const res = await http(at.toString(), {
      headers,
      redirect: redirects > 0 ? "manual" : "error",
      signal,
    }).catch(() => {
      throw unreachable();
    });
    const location = res.headers.get("location");
    if (hop < redirects && res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      next = new URL(location, at).toString();
      continue;
    }
    const minutes = githubWaitMinutes(res);
    if (minutes !== null) {
      throw new TooManyError(`GitHub is limiting downloads for now. Try again in ${minutes} min.`, "github.limited", {
        count: minutes,
      });
    }
    return { res, at };
  }
}

/** A success's body, refused past `maxBytes` while it streams (codeload sends no length). */
async function githubBody(res: Response, at: URL, options: GithubFetchOptions) {
  if (!res.ok) throw new ValidationError(`GitHub answered ${res.status} for ${at.pathname}`);
  const tooLarge = () => new ValidationError(options.tooLarge, options.tooLargeCode, options.tooLargeParams);
  if (Number(res.headers.get("content-length") ?? 0) > options.maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > options.maxBytes) throw tooLarge();
        chunks.push(chunk);
      }
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw unreachable();
  }
  return Buffer.concat(chunks);
}

/**
 * GET one GitHub URL (github.com, raw.githubusercontent.com, api.github.com or codeload.github.com only), with the
 * SSRF guard, no redirects unless `options.redirects`, a timeout and a size cap.
 */
export async function fetchGithub(deps: GithubFetchDeps, url: string, accept: string, options: GithubFetchOptions) {
  const { res, at } = await githubGet(deps, url, accept, options);
  return githubBody(res, at, options);
}

const notGithubLink = (message: string) => new ValidationError(message, "skill.not_github_link");

/**
 * Where a GitHub URL points: a folder (the repository, or `/tree/{ref}/{path}`) or a file (`/blob/…` or
 * raw.githubusercontent), with its path decoded. No ref is the default branch (`HEAD`).
 */
export function parseGithubUrl(url: string) {
  let u: URL;
  let segments: string[];
  try {
    u = new URL(url);
    segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw notGithubLink("Unrecognized GitHub URL");
  }
  if (u.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = segments;
    // GitHub's Raw button spells the branch out: `refs/heads/main/…`.
    const [ref, ...path] = rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? rest.slice(2) : rest;
    if (!owner || !repo || !ref || path.length === 0) throw notGithubLink("Unrecognized GitHub URL");
    return { kind: "file" as const, owner, repo, ref, path: path.join("/") };
  }
  if (u.hostname !== "github.com") throw notGithubLink("Only GitHub URLs can be imported for now");
  const [owner, name, mode, ref, ...rest] = segments;
  const repo = name?.replace(/\.git$/, "");
  if (!owner || !repo) throw notGithubLink("Unrecognized GitHub URL");
  if (mode === "blob" && ref) return { kind: "file" as const, owner, repo, ref, path: rest.join("/") };
  if (mode === "tree" && ref) return { kind: "folder" as const, owner, repo, ref, path: rest.join("/") };
  return { kind: "folder" as const, owner, repo, ref: "HEAD", path: "" };
}

type GithubTarget = ReturnType<typeof parseGithubUrl>;

/** A repository's archive is downloaded whole: past this size a link into it can't be read. */
const ARCHIVE: GithubFetchOptions = {
  maxBytes: 50 * 1024 * 1024,
  tooLarge: "The repository is too large to download (max 50 MB). Upload the skill's folder as a .zip instead.",
  tooLargeCode: "skill.repo_too_large",
  tooLargeParams: { max: 50 },
  // github.com redirects to codeload.github.com, and first to the new name of a renamed repository.
  redirects: 3,
  timeoutMs: 60_000,
};

/** How deep below a link a SKILL.md is looked for, and how many skills one link may hold. */
const SKILL_SEARCH = { depth: 6, max: 100 };

/** A path for a URL: each segment percent-encoded, the slashes kept. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The key of `folders` that is `dir` or a folder above it ("" the root), if any: one lookup a level. */
function folderOf(folders: ReadonlyMap<string, unknown>, dir: string): string | undefined {
  for (let at = dir; ; at = parentOf(at)) {
    if (folders.has(at)) return at;
    if (!at) return undefined;
  }
}

const refMissing = (target: GithubTarget) => {
  const repo = `${target.owner}/${target.repo}`;
  return new ValidationError(`${repo} has no branch, tag or commit ${target.ref}`, "github.ref_missing", {
    repo,
    ref: target.ref,
  });
};

/** An archive's files by path from the repository's root, symbolic links left out. */
function repositoryOf(zip: Uint8Array) {
  const files = new Map<string, ZipListing>();
  for (const entry of listZip(zip)) {
    // Every path starts with the archive's own folder (`{repo}-{ref}/`, `{owner}-{repo}-{commit}/` from the API).
    const slash = entry.path.indexOf("/");
    if (!entry.symlink && slash > 0) files.set(entry.path.slice(slash + 1), entry);
  }
  return { zip, files };
}

type GithubRepository = ReturnType<typeof repositoryOf>;

/**
 * The repository at the link's ref, from its zip archive (`github.com/{owner}/{repo}/archive/{ref}.zip`, served by
 * codeload.github.com): one download, outside the REST API, where unauthenticated calls share one limit per server
 * address (60 an hour) that every workspace's imports would spend. Null when github.com hides it (private, or
 * missing).
 */
async function publicRepository(deps: SkillDeps, target: GithubTarget) {
  const archive = `https://github.com/${encodePath(`${target.owner}/${target.repo}`)}/archive/${encodePath(target.ref)}.zip`;
  const { res, at } = await githubGet(deps, archive, "application/zip", ARCHIVE);
  if (res.status === 404) {
    await res.body?.cancel();
    // Past github.com's redirect, codeload lacks the ref.
    if (at.hostname === "codeload.github.com" && target.ref !== "HEAD") throw refMissing(target);
    return null;
  }
  return repositoryOf(await githubBody(res, at, ARCHIVE));
}

/**
 * The repository's archive read with one of the workspace's tokens (`api.github.com/repos/{repo}/zipball/{ref}`, on
 * the token's own limit). Null when the token works and can't read it (403, an organization's SSO say, or 404),
 * `refused` when GitHub no longer takes it (401). The API answers 404 alike for a ref the repository lacks and for a
 * repository the token can't see: asking for the repository tells them apart.
 */
async function tokenRepository(deps: SkillDeps, target: GithubTarget, token: string) {
  const repo = `${GITHUB_API}/repos/${encodePath(target.owner)}/${encodePath(target.repo)}`;
  const ref = target.ref === "HEAD" ? "" : `/${encodePath(target.ref)}`;
  const { res, at } = await githubGet(deps, `${repo}/zipball${ref}`, "application/vnd.github+json", ARCHIVE, token);
  if (res.ok) return repositoryOf(await githubBody(res, at, ARCHIVE));
  await res.body?.cancel();
  if (res.status === 404 && target.ref !== "HEAD") {
    const seen = await githubGet(deps, repo, "application/vnd.github+json", ARCHIVE, token);
    await seen.res.body?.cancel();
    if (seen.res.ok) throw refMissing(target);
  }
  if (res.status === 401) return "refused" as const;
  if (res.status === 403 || res.status === 404) return null;
  throw new ValidationError(`GitHub answered ${res.status} for ${at.pathname}`);
}

/** An account or repository name as GitHub allows it, so building an API path from one never climbs out of it. */
const GITHUB_NAME = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/** A link a token may go with: its owner, repository and ref can't climb out of the repository's API path. */
const tokenSafe = (target: GithubTarget) =>
  GITHUB_NAME.test(target.owner) &&
  GITHUB_NAME.test(target.repo) &&
  !target.ref.split("/").some((s) => s === "." || s === "..");

/**
 * The GitHub App's token for the repository (only from an installation on its account bound to this workspace), and
 * whether GitHub left one of the requests for it unanswered (no answer, or a 5xx).
 */
async function appToken(deps: SkillDeps, orgId: string, app: GitHubAppConfig, target: GithubTarget) {
  const seen = { unanswered: false };
  const send = deps.fetch ?? fetch;
  const http: GitHubHttp = {
    apiUrl: GITHUB_API,
    fetch: (async (url: string, init?: RequestInit) => {
      const res = await send(url, init).catch((err) => {
        seen.unanswered = true;
        throw err;
      });
      if (res.status >= 500) seen.unanswered = true;
      return res;
    }) as typeof fetch,
  };
  const tenant = { db: deps.db, orgId };
  const read = { contents: "read" } as const;
  const token = await appTokenForRepo(app, http, tenant, target.owner, target.repo, read).catch(() => null);
  return { token, unanswered: seen.unanswered };
}

/** The workspace's GitHub connection: none, one GitHub refuses (a token it no longer takes), or one that works. */
type GithubConnectionState = "none" | "refused" | "ok";

/**
 * The repository a link points into, and which of the workspace's GitHub connections read it (null: none was
 * needed). A repository github.com hides is read with the workspace's tokens, which never leave the server: the
 * GitHub App's for it, then the GitHub connection's, each made only when the one before can't read it. `through`: how
 * a skill installed before was read, tried first and with no read without credentials before it (the other
 * connection follows it, so a skill never stays stuck on one the workspace replaced).
 *
 * None reads it: `github.unreachable` when GitHub left a token request unanswered, `skill.connection_gone` when the
 * workspace no longer has the connection `through` names, else `github.repo_missing` with the connection's state and
 * whether the GitHub App is installed on some account (`app`).
 */
async function readRepository(deps: SkillDeps, orgId: string, target: GithubTarget, through: SkillVia | null) {
  const repo = `${target.owner}/${target.repo}`;
  if (!through) {
    const open = await publicRepository(deps, target);
    if (open) return { ...open, via: null };
  }
  const github = deps.github;
  const connection = github && (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  let state: GithubConnectionState = connection ? "ok" : "none";
  let unanswered = false;
  if (github && tokenSafe(target)) {
    const order: SkillVia[] = through === "github" ? ["github", "github_app"] : ["github_app", "github"];
    for (const via of order) {
      let token: string | null = null;
      if (via === "github_app" && github.app) {
        const made = await appToken(deps, orgId, github.app, target);
        token = made.token;
        unanswered ||= made.unanswered;
      } else if (via === "github" && connection) {
        const made = await connectionToken(github.connectors, connection).then(
          (value) => ({ value, failed: false }),
          // A refresh the provider refused needs connecting again; one that got no answer may work later.
          (err: unknown) => ({ value: null, failed: !(err instanceof ValidationError) }),
        );
        token = made.value;
        unanswered ||= made.failed;
        if (!token && !made.failed) state = "refused";
      }
      if (!token) continue;
      const found = await tokenRepository(deps, target, token);
      if (found === "refused") {
        if (via === "github") state = "refused";
      } else if (found) return { ...found, via };
    }
  }
  if (unanswered) throw unreachable();
  const installations = github?.app ? await boundInstallations(deps.db, orgId) : [];
  const owner = target.owner.toLowerCase();
  const gone =
    through === "github"
      ? !connection
      : through === "github_app" && !installations.some((i) => i.accountLogin.toLowerCase() === owner);
  if (gone) {
    throw new ValidationError(`The GitHub connection that read ${repo} is gone`, "skill.connection_gone", { repo });
  }
  throw new ValidationError(`${repo} is private or doesn't exist on GitHub`, "github.repo_missing", {
    repo,
    connection: state,
    app: installations.length > 0,
  });
}

/**
 * The skill folders at or below `folder`, each with its SKILL.md, by path. A SKILL.md inside another skill's folder
 * is a file of that skill, not a skill of its own.
 */
function skillFolders(files: GithubRepository["files"], folder: string) {
  const depth = (dir: string) => (dir ? dir.split("/").length : 0);
  const prefix = folder ? `${folder}/` : "";
  const found = [...files]
    .filter(([path]) => path.startsWith(prefix) && /(^|\/)skill\.md$/i.test(path))
    .map(([path, entry]) => [parentOf(path), entry] as const)
    .filter(([dir]) => depth(dir) - depth(folder) <= SKILL_SEARCH.depth)
    .sort(([a], [b]) => depth(a) - depth(b));
  const skills = new Map<string, ZipListing>();
  for (const [dir, entry] of found) if (folderOf(skills, dir) === undefined) skills.set(dir, entry);
  return new Map([...skills].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * A skill folder of a zip (`inside`: its files), within the limits by their declared sizes before anything is
 * inflated: binaries past `SKILL_LIMITS.assetBytes` are listed, never inflated.
 */
function repositorySkill(zip: Uint8Array, dir: string, inside: [string, ZipListing][]) {
  const prefix = dir ? `${dir}/` : "";
  const listed = inside.map(([path, entry]) => ({ path: path.slice(prefix.length), size: entry.size, entry }));
  assertSkillSize(listed);
  const kept = keptBinaries(listed);
  const { skillMd, files } = splitSkillFolder(
    listed.map(({ path, size, entry }) =>
      classifyFile(path).kind === "binary" && !kept.has(path)
        ? { path, data: new Uint8Array(), skippedSize: size }
        : { path, data: inflateZipEntry(zip, entry) },
    ),
  );
  return { ...parseSkillMarkdown(skillMd), files };
}

/**
 * A skill a GitHub link holds, offered to pick when it holds several. `path`: its folder from the repository's root.
 * `replaces`: a skill of this name is installed (it becomes a new version of it, for every agent that has it) or was
 * removed (it comes back on for none of its old agents).
 */
export interface SkillChoice {
  path: string;
  name: string;
  description: string;
  replaces?: "installed" | "removed";
}

/** A skill a GitHub link holds that can't be installed, with the refusal: its code, English text and params. */
export interface SkillSkipped {
  path: string;
  code: string;
  message: string;
  params?: ErrorParams;
}

/**
 * What a GitHub link holds: the repository, how it was read, and the skill folders at or below the link (a file's:
 * its folder's).
 */
async function readGithubLink(deps: SkillDeps, orgId: string, url: string, through: SkillVia | null = null) {
  const target = parseGithubUrl(url);
  const repository = await readRepository(deps, orgId, target, through);
  const folder = target.kind === "file" ? parentOf(target.path) : target.path;
  const folders = skillFolders(repository.files, folder);
  const repo = `${target.owner}/${target.repo}`;
  if (folders.size === 0) {
    const where = folder ? `${repo}/${folder}` : repo;
    throw new ValidationError(`No SKILL.md in ${where} or the folders inside it`, "skill.no_skill_md", { path: where });
  }
  if (folders.size > SKILL_SEARCH.max) {
    throw new ValidationError(
      `That link holds more than ${SKILL_SEARCH.max} skills. Link one of its folders.`,
      "skill.too_many_skills",
      { max: SKILL_SEARCH.max },
    );
  }
  const found = new Map([...folders].map(([dir, skillMd]) => [dir, { skillMd, files: [] as [string, ZipListing][] }]));
  // Every skill's files in one pass: no skill folder holds another.
  for (const file of repository.files) {
    const dir = folderOf(found, parentOf(file[0]));
    if (dir !== undefined) found.get(dir)?.files.push(file);
  }
  /** The skill at `dir`, refused past the skill limits. */
  const skillIn = (dir: string) => {
    const skill = found.get(dir);
    if (!skill) throw new ValidationError(`That link holds no skill at ${dir}`);
    assertSkillSize(skill.files.map(([path, entry]) => ({ path, size: entry.size })));
    return skill;
  };
  /** The skill at `dir` from its SKILL.md alone, refused as installing it would be for its limits or its text. */
  const about = (dir: string) =>
    parseSkillMarkdown(new TextDecoder().decode(inflateZipEntry(repository.zip, skillIn(dir).skillMd)));
  /** The skill at `dir`, ready to save: from the link itself when it points at the skill, else from its folder. */
  const skillAt = (dir: string) => {
    const skill = repositorySkill(repository.zip, dir, skillIn(dir).files);
    return {
      ...skill,
      sourceHash: skillSourceHash(skill),
      source: "url" as const,
      sourceUrl:
        dir === folder
          ? url
          : `https://github.com/${encodePath(repo)}/tree/${encodePath(target.ref)}/${encodePath(dir)}`,
      sourceVia: repository.via,
    };
  };
  return { found, about, skillAt, via: repository.via };
}

/**
 * A GitHub link holding several skills: those that can be installed, to pick, and those that can't, with why. `via`:
 * which of the workspace's GitHub connections read it, when the repository needed one.
 */
export interface SkillPick {
  choices: SkillChoice[];
  skipped?: SkillSkipped[];
  via?: SkillVia;
}

/**
 * Import from a GitHub link, read by the backend from the repository's archive (only GitHub hosts, the SSRF guard
 * on every request, within `SKILL_LIMITS`): the skill
 * folder it points at (a file's folder), or the one skill below it. A link that holds several answers with them to
 * pick from (`importPickedSkills`), nothing installed, and with those that can't be installed (past the limits, or a
 * SKILL.md that doesn't parse) apart, each with why; `list` answers so for one skill too. Installing a skill whose
 * name is already installed makes a new version. A private repository is read through the workspace's GitHub (the
 * GitHub App, else the connection): installing skills (`manage_agents`) is what lets a person read through it.
 * `through`: that connection first, with no read without credentials (a skill updated from the link it came from).
 * `forAgentId`: the agent whose card opened the install (`turnOnFor`).
 */
export async function importSkillFromUrl(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  url: string,
  options: { list?: boolean; through?: SkillVia | null; forAgentId?: string } = {},
): Promise<SkillDetail | SkillPick> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const link = await readGithubLink(deps, orgId, url, options.through);
  const [only, ...more] = link.found.keys();
  if (!options.list && only !== undefined && more.length === 0) {
    const skill = await saveSkill(deps, actorId, orgId, link.skillAt(only));
    await turnOnFor(deps, actorId, orgId, options.forAgentId, [skill.id]);
    return skill;
  }
  const choices: SkillChoice[] = [];
  const skipped: SkillSkipped[] = [];
  let refused: unknown;
  for (const path of link.found.keys()) {
    try {
      const { name, description } = link.about(path);
      choices.push({ path, name, description });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      refused ??= err;
      skipped.push({ path, code: err.code, message: err.message, ...(err.params ? { params: err.params } : {}) });
    }
  }
  if (choices.length === 0) throw refused;
  const same = await deps.db
    .select({ slug: skills.slug, deletedAt: skills.deletedAt })
    .from(skills)
    .where(
      and(
        eq(skills.orgId, orgId),
        inArray(
          skills.slug,
          choices.map((c) => c.name),
        ),
      ),
    );
  for (const c of choices) {
    const hit = same.find((k) => k.slug === c.name);
    if (hit) c.replaces = hit.deletedAt ? "removed" : "installed";
  }
  return { choices, ...(skipped.length > 0 ? { skipped } : {}), ...(link.via ? { via: link.via } : {}) };
}

/**
 * Skills installed from an agent's card (`offer_install_skill`), the installer's box checked, go on for that agent when
 * the installer may change its skills, as on its page. Not for an agent archived or gone, nor the right hand (it has
 * no skill tools): the install still stands, and an agent asks for them on its own settings card.
 */
async function turnOnFor(deps: SkillDeps, actorId: string, orgId: string, agentId: string | undefined, ids: string[]) {
  if (!agentId || ids.length === 0) return;
  const agent = await getAgent(deps.db, orgId, agentId);
  if (!agent || agent.archivedAt || isRightHand(agent)) return;
  try {
    await setAgentSkills(
      deps.db,
      actorId,
      orgId,
      agentId,
      ids.map((skillId) => ({ skillId, enabled: true })),
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return;
    throw error;
  }
  // An open agent page saves its whole list: it reads the new one first.
  await publishAgentsChanged(deps.pubsub, orgId);
}

/** Installs the skills picked among a link's choices (`paths`, as `importSkillFromUrl` gave them). */
export async function importPickedSkills(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  url: string,
  paths: string[],
  options: { forAgentId?: string } = {},
) {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const link = await readGithubLink(deps, orgId, url);
  /** A refusal names the skill's folder. */
  const named = <T>(dir: string, read: () => T) => {
    try {
      return read();
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(`${dir}: ${err.message}`, err.code, err.params);
      throw err;
    }
  };
  const dirs = [...new Set(paths)];
  // Every pick's limits and text are checked before any is saved, by the SKILL.md alone: its files are inflated one
  // skill at a time, since a small archive can declare the most a skill keeps for each of the 100 it may hold.
  const names = dirs.map((dir) => {
    if (!link.found.has(dir)) throw new ValidationError(`That link holds no skill at ${dir}`);
    return named(dir, () => link.about(dir).name);
  });
  const twin = names.find((name, i) => names.indexOf(name) !== i);
  if (twin) throw new ValidationError(`Two of the skills picked are named ${twin}. Pick one of them.`);
  const installed: SkillDetail[] = [];
  for (const dir of dirs) {
    installed.push(
      await saveSkill(
        deps,
        actorId,
        orgId,
        named(dir, () => link.skillAt(dir)),
      ),
    );
  }
  await turnOnFor(
    deps,
    actorId,
    orgId,
    options.forAgentId,
    installed.map((k) => k.id),
  );
  return installed;
}

/**
 * What a skill's link held, as `sourceHash` keeps it: the same text, metadata and files read again hash the same.
 */
export function skillSourceHash(s: ParsedSkill & { files: SkillFileInput[] }) {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(JSON.stringify([s.name, s.description, s.body, s.metadata]));
  for (const f of [...s.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`\0${f.path}\0${f.data.byteLength}\0${f.skippedSize ?? ""}\0`);
    hash.update(f.data);
  }
  return hash.digest("hex");
}

/**
 * A file that runs, or that something could run: a script (`run_skill_script`), or a binary that isn't an image or a
 * PDF (an executable, an archive, a `.ts` Bun reads as video). An update adding or changing one waits for a person.
 */
export function runsCode(path: string) {
  const { mime, kind } = classifyFile(path);
  return kind === "script" || (kind === "binary" && !mime.startsWith("image/") && mime !== "application/pdf");
}

/**
 * The skill its link holds now, ready to save, read as updating reads it (through the GitHub connection that read it
 * first). Refused when the link holds several skills now, or another one.
 */
export async function readSkillSource(deps: SkillDeps, s: SkillRow) {
  if (!s.sourceUrl) throw new ValidationError("This skill wasn't imported from a link", "skill.no_link");
  const link = await readGithubLink(deps, s.orgId, s.sourceUrl, s.sourceVia as SkillVia | null);
  const [only, ...more] = link.found.keys();
  if (only === undefined || more.length > 0) {
    throw new ValidationError(
      "Its link holds several skills now. Install this one again from its own folder.",
      "skill.link_holds_several",
    );
  }
  const skill = link.skillAt(only);
  if (skill.name !== s.name) {
    throw new ValidationError(`Its link holds the skill ${skill.name} now`, "skill.link_renamed", { name: skill.name });
  }
  return skill;
}

/**
 * Imports the skill again from where it came (a new version). A skill a GitHub connection read is read through it
 * first, then through the workspace's other one, and keeps the one that read it (`skill.connection_gone` when the
 * workspace no longer has the first and the other can't read it).
 */
export async function reimportSkill(deps: SkillDeps, actorId: string, orgId: string, id: string) {
  const s = await loadSkill(deps.db, orgId, id);
  if (!s.sourceUrl) throw new ValidationError("This skill wasn't imported from a URL");
  const through = s.sourceVia as SkillVia | null;
  const again = await importSkillFromUrl(deps, actorId, orgId, s.sourceUrl, { through });
  if ("choices" in again) {
    throw new ValidationError("Its link holds several skills now. Install this one again from its own folder.");
  }
  return again;
}

export async function listSkills(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), isNull(skills.deletedAt)))
    .orderBy(asc(skills.name));
  const counts = await db
    .select({ skillId: agentSkills.skillId, n: sql<number>`count(*)::int` })
    .from(agentSkills)
    .innerJoin(schema.agents, eq(schema.agents.id, agentSkills.agentId))
    .where(and(eq(agentSkills.orgId, orgId), eq(agentSkills.enabled, true), isNull(schema.agents.archivedAt)))
    .groupBy(agentSkills.skillId);
  const byId = new Map(counts.map((c) => [c.skillId, Number(c.n)]));
  /** How many active agents have each skill on. */
  return rows.map((r) => ({ ...view(r), agentsCount: byId.get(r.id) ?? 0 }));
}

export async function getSkill(db: Database, actorId: string, orgId: string, id: string): Promise<SkillDetail> {
  await requirePermission(db, actorId, orgId, "read");
  return skillDetail(db, await loadSkill(db, orgId, id));
}

/** Edits by hand (a new version); renaming isn't allowed (the name is the skill's identity). */
export async function updateSkill(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  id: string,
  input: { description?: string; body?: string; defaultForNewAgents?: boolean },
) {
  const s = await loadSkill(deps.db, orgId, id);
  if (input.description === undefined && input.body === undefined && input.defaultForNewAgents !== undefined) {
    await requirePermission(deps.db, actorId, orgId, "manage_agents");
    await deps.db
      .update(skills)
      .set({ defaultForNewAgents: input.defaultForNewAgents, updatedAt: new Date() })
      .where(eq(skills.id, s.id));
    return getSkill(deps.db, actorId, orgId, id);
  }
  return saveSkill(deps, actorId, orgId, {
    name: s.name,
    description: input.description ?? s.description,
    body: input.body ?? s.body,
    metadata: s.metadata,
    source: "manual",
    sourceUrl: s.sourceUrl,
    defaultForNewAgents: input.defaultForNewAgents,
  });
}

export async function deleteSkill(db: Database, actorId: string, orgId: string, id: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const s = await loadSkill(db, orgId, id);
  // Soft delete: agents stop seeing it at once. Their assignments come back when it is restored or saved again under
  // its name, except by an install from a link (`saveSkill`).
  await db.update(skills).set({ deletedAt: new Date() }).where(eq(skills.id, s.id));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.deleted",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
}

/**
 * A skill's body as a new version, its files carried over to it (they are stored per version). For changes that
 * come from use, not from a person's editor: an agent's own skill (`update_skill`), an accepted proposal, an undo.
 */
export const writeSkillBody = (db: Database, s: SkillRow, body: string) => writeSkillVersion(db, s, { body });

/**
 * A new version with this text and the files of version `filesOf` (default: the current one), stored per version:
 * an undo of an update from its link brings back the version before with its files.
 */
export async function writeSkillVersion(
  db: Database,
  s: SkillRow,
  text: { body: string; description?: string; metadata?: Record<string, unknown> },
  filesOf = s.version,
): Promise<SkillRow> {
  const [row] = await db
    .update(skills)
    .set({ ...text, version: sql`${skills.version} + 1`, updatedAt: new Date() })
    .where(eq(skills.id, s.id))
    .returning();
  if (!row) throw new NotFoundError("Skill not found");
  await db.execute(sql`insert into skill_files (org_id, skill_id, version, path, size, mime, status, storage_config_id, blob_key)
    select org_id, skill_id, ${row.version}, path, size, mime, status, storage_config_id, blob_key
    from skill_files where skill_id = ${s.id}::uuid and version = ${filesOf}`);
  return row;
}

/**
 * A new version with this body and these files changed or added (the others carried over): an agent's fix to a skill
 * (`update_skill`) or an accepted proposal for one of its files. Refused as an upload is past the limits.
 */
export async function writeSkillChange(
  deps: { db: Database; blobs?: BlobStoreResolver },
  s: SkillRow,
  change: { body: string; files: SkillFileInput[] },
): Promise<SkillRow> {
  if (change.files.length === 0) return writeSkillVersion(deps.db, s, { body: change.body });
  if (!deps.blobs) throw new ValidationError("Skill files can't be changed on this server (no storage)");
  const skillDeps = { db: deps.db, blobs: deps.blobs };
  const planned = await planFiles(skillDeps, s.orgId, change.files);
  const changed = new Set(planned.files.map((f) => f.path));
  assertSkillSize([
    ...(await skillFilesOf(deps.db, s)).filter((f) => !changed.has(f.path)),
    ...planned.files.map((f) => ({ path: f.path, size: f.size })),
  ]);
  const row = await writeSkillVersion(deps.db, s, { body: change.body });
  await deps.db
    .delete(skillFiles)
    .where(
      and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, row.version), inArray(skillFiles.path, [...changed])),
    );
  await storeFiles(skillDeps, row, row.version, planned);
  return row;
}

/**
 * The resolver with the workspace's current storage read now, for a transaction that stores or reads skill files:
 * the resolver's own queries run outside it, which a single-connection database (PGlite) would wait on forever.
 */
export async function pinBlobs(blobs: BlobStoreResolver, orgId: string): Promise<BlobStoreResolver> {
  const location = await blobs.forOrg(orgId);
  return {
    forOrg: async () => location,
    forConfig: (o, id) => (id === location.storageConfigId ? Promise.resolve(location.store) : blobs.forConfig(o, id)),
  };
}

/** Whether agents change this person-made skill at once ("Agentes melhoram as skills sozinhos"): its own, else the workspace's. */
export async function agentsImproveSkill(db: Database, s: Pick<SkillRow, "orgId" | "agentsImprove">) {
  if (s.agentsImprove !== null) return s.agentsImprove;
  const [row] = await db
    .select({ on: schema.organizationSettings.agentsImproveSkills })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, s.orgId));
  return row?.on ?? true;
}

/** The workspace's "Agentes melhoram as skills sozinhos" (on by default). */
export async function getSkillSettings(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  return { agentsImprove: await agentsImproveSkill(db, { orgId, agentsImprove: null }) };
}

/** Who manages agents turns "Agentes melhoram as skills sozinhos" on or off for the workspace. */
export async function setSkillSettings(
  db: Database,
  actorId: string,
  orgId: string,
  input: { agentsImprove: boolean },
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await db
    .insert(schema.organizationSettings)
    .values({ orgId, agentsImproveSkills: input.agentsImprove })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { agentsImproveSkills: input.agentsImprove, updatedAt: new Date() },
    });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: input.agentsImprove ? "skills.agents_improve_on" : "skills.agents_improve_off",
    target: { type: "organization", id: orgId },
    details: {},
  });
  return { agentsImprove: input.agentsImprove };
}

/** The same for one skill (who manages agents); null follows the workspace again. */
export async function setSkillAgentsImprove(
  db: Database,
  actorId: string,
  orgId: string,
  id: string,
  on: boolean | null,
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const s = await loadSkill(db, orgId, id);
  const [row] = await db.update(skills).set({ agentsImprove: on }).where(eq(skills.id, s.id)).returning();
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.agents_improve",
    target: { type: "skill", id: s.id },
    details: { name: s.name, on },
  });
  return skillDetail(db, row ?? s);
}

/** Who may lock or undo an agent-made skill: who manages agents, or the owner of the agent that made it. */
async function mayChangeAgentSkill(db: Database, actorId: string, orgId: string, ownerAgentId: string | null) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (can(membership, "manage_agents")) return true;
  if (!ownerAgentId) return false;
  return (await getAgent(db, orgId, ownerAgentId))?.ownerUserId === actorId;
}

export async function requireAgentSkillChange(db: Database, actorId: string, orgId: string, s: SkillRow) {
  if (s.origin !== "agent") await requirePermission(db, actorId, orgId, "manage_agents");
  else if (!(await mayChangeAgentSkill(db, actorId, orgId, s.ownerAgentId)))
    throw new ForbiddenError("Only the agent's owner or an admin can change this");
}

/**
 * A person locks or unlocks a skill: a locked one agents can't change and is never archived for disuse. An agent-made
 * one also its agent's owner.
 */
export async function setSkillLocked(db: Database, actorId: string, orgId: string, id: string, locked: boolean) {
  const s = await loadSkill(db, orgId, id);
  await requireAgentSkillChange(db, actorId, orgId, s);
  await db.update(skills).set({ locked, updatedAt: new Date() }).where(eq(skills.id, s.id));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: locked ? "skill.locked" : "skill.unlocked",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
  return getSkill(db, actorId, orgId, id);
}

/** Brings back a skill archived for disuse (or deleted), with its agents' assignments. */
export async function restoreSkill(db: Database, actorId: string, orgId: string, id: string) {
  const [found] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId)));
  if (!found) {
    await requirePermission(db, actorId, orgId, "manage_agents");
    throw new NotFoundError("Skill not found");
  }
  await requireAgentSkillChange(db, actorId, orgId, found);
  const [s] = await db
    .update(skills)
    .set({ deletedAt: null, lastUsedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
    .returning();
  if (!s) throw new NotFoundError("Skill not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "skill.restored",
    target: { type: "skill", id: s.id },
    details: { name: s.name },
  });
  return getSkill(db, actorId, orgId, id);
}

/** The skills an agent made itself (`origin` agent), archived ones too, newest first: "What it learned". */
export async function agentMadeSkills(db: Database, actorId: string, orgId: string, agentId: string) {
  const canChange = await mayChangeAgentSkill(db, actorId, orgId, agentId);
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.origin, "agent"), eq(skills.ownerAgentId, agentId)))
    .orderBy(sql`${skills.createdAt} desc`);
  // Each skill's latest change of its own not undone: Desfazer only while the body is still what it left.
  const changes = rows.length
    ? await db
        .selectDistinctOn([schema.agentActions.targetId], {
          targetId: schema.agentActions.targetId,
          before: schema.agentActions.before,
          after: schema.agentActions.after,
        })
        .from(schema.agentActions)
        .where(
          and(
            eq(schema.agentActions.orgId, orgId),
            eq(schema.agentActions.kind, "skill.updated"),
            inArray(
              schema.agentActions.targetId,
              rows.map((r) => r.id),
            ),
            isNull(schema.agentActions.undoneAt),
          ),
        )
        .orderBy(schema.agentActions.targetId, sql`${schema.agentActions.createdAt} desc`)
    : [];
  const revertible = new Set(
    changes
      .filter((c) => {
        const row = rows.find((r) => r.id === c.targetId);
        return (
          typeof (c.before as { body?: unknown } | null)?.body === "string" &&
          (c.after as { body?: unknown } | null)?.body === row?.body
        );
      })
      .map((c) => c.targetId),
  );
  return rows.map((r) => ({
    ...view(r),
    body: r.body,
    archived: r.deletedAt !== null,
    canChange,
    canRevert: canChange && revertible.has(r.id),
  }));
}

/** The org's skills with whether this agent has each one on. */
export async function agentSkillList(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  const [all, mine] = await Promise.all([
    listSkills(db, actorId, orgId),
    db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.orgId, orgId), eq(agentSkills.agentId, agentId))),
  ]);
  const on = new Map(mine.map((m) => [m.skillId, m.enabled]));
  return all.map((s) => ({ ...s, enabled: on.get(s.id) ?? false }));
}

/** Turns skills on or off for an agent (admins or its owner). */
export async function setAgentSkills(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { skillId: string; enabled: boolean }[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its skills");
  }
  const ids = [...new Set(input.map((i) => i.skillId))];
  if (ids.length > 0) {
    const found = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.orgId, orgId), inArray(skills.id, ids), isNull(skills.deletedAt)));
    if (found.length !== ids.length) throw new ValidationError("Every skill must belong to this organization");
  }
  for (const i of input) {
    await db
      .insert(agentSkills)
      .values({ orgId, agentId, skillId: i.skillId, enabled: i.enabled })
      .onConflictDoUpdate({ target: [agentSkills.agentId, agentSkills.skillId], set: { enabled: i.enabled } });
  }
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.skills_changed",
    target: { type: "agent", id: agentId },
    details: { skills: input },
  });
  return agentSkillList(db, actorId, orgId, agentId);
}

/** The agent's enabled skills (name and description only: the body loads on demand). */
export async function enabledSkills(db: Database, orgId: string, agentId: string) {
  return db
    .select({ id: skills.id, name: skills.name, description: skills.description, version: skills.version })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.enabled, true),
        eq(skills.orgId, orgId),
        isNull(skills.deletedAt),
      ),
    )
    .orderBy(asc(skills.name));
}

/** A skill this agent has on, by name, with its files (for `load_skill` / `read_skill_file`). */
export async function agentSkillByName(db: Database, orgId: string, agentId: string, name: string) {
  const [row] = await db
    .select({ skill: skills })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(
      and(
        eq(agentSkills.orgId, orgId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.enabled, true),
        eq(skills.orgId, orgId),
        eq(skills.slug, name.trim().toLowerCase()),
        isNull(skills.deletedAt),
      ),
    );
  return row?.skill ?? null;
}

/**
 * Why a listed file wasn't kept, from the version's files: past the binaries a skill keeps (with those kept, it
 * doesn't fit), or installed before binaries were kept (it would fit now).
 */
export function notKeptReason(
  f: { path: string; size: number },
  files: { path: string; size: number; status: string }[],
) {
  const kept = files.reduce(
    (n, x) => n + (x.status === "stored" && classifyFile(x.path).kind === "binary" ? x.size : 0),
    0,
  );
  return kept + f.size > SKILL_LIMITS.assetBytes
    ? `${f.path} (${formatBytes(f.size)}) was not kept: a skill keeps up to ${SKILL_LIMITS.assetBytes / 1024 / 1024} MB of images and other files that aren't text, and this one is past it. Ask a person to make the skill's files smaller.`
    : `${f.path} was installed before skills kept images and other files that aren't text: ask a person to reinstall the skill (or update it from its link) to read it.`;
}

/** A kept file of the skill's version with its bytes: `text` when the model reads it as text. */
export async function skillFile(deps: SkillDeps, s: SkillRow, path: string, version = s.version) {
  const [f] = await deps.db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, version), eq(skillFiles.path, path)));
  if (!f) throw new NotFoundError(`No file ${path} in this skill`);
  if (f.status === "script") {
    throw new NotFoundError(`${path} is a script: it is never shown, only run on your computer with run_skill_script`);
  }
  if (f.status !== "stored" || !f.blobKey) {
    throw new NotFoundError(notKeptReason(f, await skillFilesOf(deps.db, { ...s, version })));
  }
  const store = await deps.blobs.forConfig(s.orgId, f.storageConfigId);
  const object = await store.get(f.blobKey);
  if (!object) throw new NotFoundError(`The stored file ${path} is missing`);
  return {
    path,
    mime: f.mime,
    size: f.size,
    data: object.body,
    text: classifyFile(path).kind === "text",
    stored: { storageConfigId: f.storageConfigId, blobKey: f.blobKey, size: f.size },
  };
}

export async function skillFileText(deps: SkillDeps, s: SkillRow, path: string, version = s.version) {
  const f = await skillFile(deps, s, path, version);
  if (!f.text) throw new ValidationError(`${path} is not a text file (${f.mime}, ${formatBytes(f.size)})`);
  return new TextDecoder().decode(f.data);
}

/** `GET …/skills/{id}/files/{path}`: a stored text file of a version (default: current). */
export async function getSkillFile(
  deps: SkillDeps,
  actorId: string,
  orgId: string,
  skillId: string,
  path: string,
  version?: number,
) {
  await requirePermission(deps.db, actorId, orgId, "read");
  const s = await loadSkill(deps.db, orgId, skillId);
  const text = await skillFileText(deps, s, path, version ?? s.version);
  const { mime } = classifyFile(path);
  return { path, version: version ?? s.version, mime, content: text };
}

/**
 * Every kept file of the skill's version (text, binaries and scripts) up to `maxBytes`, with bytes: what
 * `run_skill_script` writes onto the computer.
 */
export async function skillFolderFiles(deps: SkillDeps, s: SkillRow, paths?: string[], maxBytes?: number) {
  const rows = await deps.db
    .select()
    .from(skillFiles)
    .where(
      and(
        eq(skillFiles.skillId, s.id),
        eq(skillFiles.version, s.version),
        paths ? inArray(skillFiles.path, paths) : undefined,
        maxBytes === undefined ? undefined : lte(skillFiles.size, maxBytes),
      ),
    );
  const read = await mapInBatches(rows, BLOB_BATCH, async (f) => {
    if (f.status === "ignored" || !f.blobKey) return null;
    const store = await deps.blobs.forConfig(s.orgId, f.storageConfigId);
    const object = await store.get(f.blobKey);
    return object ? { path: f.path, status: f.status as SkillFileStatus, data: object.body } : null;
  });
  return read.filter((f) => f !== null);
}

/** The rest of what `skillFolderFiles` leaves out past `minBytes`, unread: these reach a computer by `copyToComputer`. */
export async function skillFilesOver(db: Database, s: SkillRow, minBytes: number) {
  const rows = await db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, s.id), eq(skillFiles.version, s.version), gt(skillFiles.size, minBytes)));
  return rows.flatMap((f) =>
    f.status === "ignored" || !f.blobKey
      ? []
      : [{ path: f.path, storageConfigId: f.storageConfigId, blobKey: f.blobKey, size: f.size }],
  );
}
