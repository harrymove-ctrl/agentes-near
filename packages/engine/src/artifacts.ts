import { createHash } from "node:crypto";
import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import {
  type BlockSpec,
  BlockSpecError,
  blockSpecText,
  dryRunBlock,
  parseBlockSpec,
} from "@agenteschat/ui/blocks/spec";
import { type AgentsDmReads, agentsDmReads, readerOfRun } from "./agents-dm-reads";
import { recordAudit } from "./audit";
import { runAuthorityById, runPerson, UUID } from "./authority";
import { routineBriefOfRun } from "./background";
import { answersAgentsOnly, peopleSee } from "./consultations";
import { isAgentOnlyDm, openDm } from "./dms";
import { markdownToDocx } from "./docx";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishListChanged } from "./events";
import { textOfBytes } from "./format";
import { assertStorageRoom } from "./limits";
import { can, getMembership, requireActiveMembership } from "./organizations";
import { runItselfReadOutside } from "./outside";
import { markdownToPdf } from "./pdf";
import { maySql } from "./permissions";
import { routineCreatorOf } from "./requester";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";
import { accountInUse } from "./standing";
import {
  AUDIENCE_MAX,
  adminChannelSql,
  artifactCol,
  channelReaderSql,
  fileSeenSql,
  fileSharedSql,
  taskReaderSql,
} from "./task-access";

const { artifacts, artifactVersions, channels, channelMembers } = schema;

export type ArtifactKind = "document" | "table" | "diff" | "html" | "diagram" | "file" | "block" | "poll" | "choices";
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "document",
  "table",
  "diff",
  "html",
  "diagram",
  "file",
  "block",
  "poll",
  "choices",
];
/**
 * What lives in a conversation and not in the Drive (ADR 0113, 0124): made only through `show_block`, `start_poll`
 * and `ask_choices`, never by `create_artifact` or a person.
 */
export type ConversationKind = "block" | "poll" | "choices";
/** Kinds made from content (JSON); `file` is made only from bytes (`createFileArtifact`, ADR 0025). */
export const TEXT_ARTIFACT_KINDS: readonly Exclude<ArtifactKind, "file" | ConversationKind>[] = [
  "document",
  "table",
  "diff",
  "html",
  "diagram",
];

/** A binary file as is: metadata only (the bytes are the blob); `text` for small UTF-8 text files. */
export interface FileContent {
  kind: "file";
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  text?: string;
}

export type ArtifactContent =
  | { kind: "document"; markdown: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "diff"; files: { path: string; patch: string }[] }
  | { kind: "diagram"; mermaid: string }
  | { kind: "html"; html: string }
  /**
   * A live block (ADR 0113): parts the apps draw (`spec`), or, when no part can show it, the agent's own page (`html`),
   * which runs only when a person asks. Exactly one of the two.
   */
  | { kind: "block"; spec?: BlockSpec; html?: string; subtitle?: string }
  | { kind: "poll"; question: string; options: string[]; multiple: boolean }
  | { kind: "choices"; questions: ChoiceQuestion[] }
  | FileContent;

/**
 * One question of a choice card (ADR 0124): its options are shown as A, B, C…, and after them "Outra resposta", a
 * written answer (picked as the index past the last option).
 */
export interface ChoiceQuestion {
  question: string;
  options: { label: string; description?: string }[];
}

/**
 * An option that only says "other" (Outra, Outro, Other, Otra, maybe with "opção" or "(escreva)" after it): every
 * question takes a written answer of its own, so such an option goes, or picking it would answer with the word alone.
 * ponytail: Portuguese, English and Spanish words; another language's stays an option that answers as its label.
 */
const OTHER_OPTION =
  /^(?:outr[ao]|other|otr[ao])(?:\s+(?:op[cç][aã]o|resposta|coisa|option|answer|opci[oó]n|respuesta))?(?:\s*\(.*\))?[\s.…:!?]*$/iu;

/** A choice card as text, for the model and for search: each question with its lettered options. */
export function choicesText(questions: ChoiceQuestion[]): string {
  return questions
    .map((q, i) =>
      [
        questions.length > 1 ? `${i + 1}. ${q.question}` : q.question,
        ...q.options.map(
          (o, j) => `${String.fromCharCode(65 + j)}. ${o.label}${o.description ? ` (${o.description})` : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

type TextContent = Exclude<ArtifactContent, FileContent>;

export interface ArtifactAuthor {
  type: "agent" | "person";
  id: string;
}

/** An artifact as the app lists it. */
export interface ArtifactView {
  id: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  channelId: string | null;
  threadId: string | null;
  createdBy: ArtifactAuthor;
  updatedBy: ArtifactAuthor;
  createdAt: string;
  updatedAt: string;
  /** The viewer may save new versions (documents, tables, and uploads of files). */
  canEdit: boolean;
  /** HTML pages and files: never rendered on the app's origin (sandboxed iframe on another origin, or download). */
  untrusted: boolean;
  /** False for a block or a poll, which live in their conversation until someone keeps a block (ADR 0113). */
  inDrive: boolean;
  /** Who sees it past its conversation (ADR 0157). */
  sharing: FileSharing;
}

/**
 * Who sees a file on top of where it lives (ADR 0157): its conversation alone (`conversation`, the default), also the
 * people and roles chosen and administrators (`people`), or the whole workspace (`everyone`).
 */
export interface FileSharing {
  mode: "conversation" | "people" | "everyone";
  userIds: string[];
  roleIds: string[];
}

export interface ArtifactDetailView extends ArtifactView {
  shownVersion: number;
  content: ArtifactContent;
  /** It keeps versions: a history and "Enviar nova versão" (`keepsVersions`). */
  versioned: boolean;
}

/** A picture, a clip or a recording: a snapshot, sent again as a new file rather than as a version. */
const SNAPSHOT_TYPE = /^(image|video|audio)\//i;

/**
 * Whether an artifact keeps versions (ADR 0019, addendum 2026-11-03): what is worked on over time does (documents,
 * tables, diffs, pages, diagrams, files such as a PDF or a spreadsheet), a snapshot does not (an agent's screenshot, a
 * photo), unless it already has a history from before, which stays.
 */
export function keepsVersions(content: ArtifactContent, latestVersion: number): boolean {
  return content.kind !== "file" || latestVersion > 1 || !SNAPSHOT_TYPE.test(content.contentType);
}

function detail(artifact: ArtifactView, shownVersion: number, content: ArtifactContent): ArtifactDetailView {
  return { ...artifact, shownVersion, content, versioned: keepsVersions(content, artifact.version) };
}

export interface ArtifactVersionView {
  version: number;
  author: ArtifactAuthor;
  note: string | null;
  createdAt: string;
}

/** Who acts: a person, or an agent during a run in a channel. */
export type ArtifactActor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; channelId: string; threadId?: string | null; runId?: string | null };

export interface ArtifactDeps {
  db: Database;
  blobs: BlobStoreResolver;
  pubsub?: PubSub;
}

/** Limits per kind (bytes are UTF-8 of the stored form). */
export const ARTIFACT_LIMITS = {
  titleChars: 200,
  documentBytes: 1_000_000,
  htmlBytes: 2_000_000,
  /** A block is short by design (ADR 0113): the kit does the work and the data goes in it. */
  blockBytes: 200_000,
  pollOptions: 8,
  pollOptionChars: 120,
  /** A choice card (ADR 0124): a few short decisions, never a form. */
  choiceQuestions: 5,
  choiceOptions: 6,
  choiceQuestionChars: 300,
  choiceLabelChars: 120,
  choiceDescriptionChars: 200,
  /** A question's written answer ("Outra resposta"), in place of its options. */
  choiceOtherChars: 1000,
  diagramBytes: 200_000,
  tableRows: 10_000,
  tableColumns: 100,
  cellChars: 10_000,
  tableBytes: 5_000_000,
  diffFiles: 500,
  diffBytes: 2_000_000,
  /** One `file` version (ADR 0025). */
  fileBytes: 50 * 1024 * 1024,
  fileNameChars: 255,
  /** `file` versions whose text `read_artifact` and the app get (UTF-8 text files only). */
  fileTextChars: 40_000,
};

type ArtifactRow = typeof artifacts.$inferSelect;
type VersionRow = typeof artifactVersions.$inferSelect;

const sha256Hex = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks kind, shape and size; returns a clean copy. Never a `file`: those come from bytes. */
export function validateContent(raw: unknown): TextContent {
  const c = (raw ?? {}) as Record<string, unknown>;
  const tooBig = (what: string) => new ValidationError(`${what} is too large`);
  switch (c.kind) {
    case "document": {
      if (typeof c.markdown !== "string") throw new ValidationError("document needs markdown");
      if (bytes(c.markdown) > ARTIFACT_LIMITS.documentBytes) throw tooBig("document");
      return { kind: "document", markdown: c.markdown };
    }
    case "html": {
      if (typeof c.html !== "string") throw new ValidationError("html needs html");
      if (bytes(c.html) > ARTIFACT_LIMITS.htmlBytes) throw tooBig("html page");
      return { kind: "html", html: c.html };
    }
    case "block": {
      const subtitle = typeof c.subtitle === "string" ? c.subtitle.trim().slice(0, 120) : "";
      const more = subtitle ? { subtitle } : {};
      if (c.spec !== undefined) {
        if (c.html !== undefined) throw new ValidationError("a block is a spec or html, not both");
        if (bytes(JSON.stringify(c.spec)) > ARTIFACT_LIMITS.blockBytes) throw tooBig("block");
        let spec: BlockSpec;
        try {
          spec = parseBlockSpec(c.spec);
        } catch (error) {
          if (error instanceof BlockSpecError) throw new ValidationError(error.message, "block.spec");
          throw error;
        }
        // Drawn once from its start: a formula that fails on the block's own data is the agent's to fix now.
        const failing = dryRunBlock(spec);
        if (failing.length > 0) throw new ValidationError(failing.slice(0, 5).join(". "), "block.spec");
        return { kind: "block", spec, ...more };
      }
      if (typeof c.html !== "string" || !c.html.trim()) throw new ValidationError("a block needs a spec or html");
      if (bytes(c.html) > ARTIFACT_LIMITS.blockBytes) throw tooBig("block");
      return { kind: "block", html: c.html, ...more };
    }
    case "poll": {
      const options = Array.isArray(c.options) ? c.options.map((o) => String(o).trim()).filter(Boolean) : [];
      if (typeof c.question !== "string" || !c.question.trim()) throw new ValidationError("a poll needs a question");
      if (new Set(options).size !== options.length) throw new ValidationError("poll options must differ");
      if (options.length < 2 || options.length > ARTIFACT_LIMITS.pollOptions) {
        throw new ValidationError(`a poll takes 2 to ${ARTIFACT_LIMITS.pollOptions} options`);
      }
      if (options.some((o) => o.length > ARTIFACT_LIMITS.pollOptionChars)) throw tooBig("poll option");
      return { kind: "poll", question: c.question.trim(), options, multiple: c.multiple === true };
    }
    case "choices": {
      const L = ARTIFACT_LIMITS;
      const raw = Array.isArray(c.questions) ? (c.questions as Record<string, unknown>[]) : [];
      if (raw.length < 1 || raw.length > L.choiceQuestions)
        throw new ValidationError(`a choice card takes 1 to ${L.choiceQuestions} questions`);
      const questions = raw.map((q): ChoiceQuestion => {
        const question = typeof q?.question === "string" ? q.question.trim() : "";
        if (!question) throw new ValidationError("every question needs its text");
        if (question.length > L.choiceQuestionChars) throw tooBig("question");
        const options = (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map((o) => {
          const label = typeof o?.label === "string" ? o.label.trim() : "";
          const description = typeof o?.description === "string" ? o.description.trim() : "";
          if (!label) throw new ValidationError("every option needs a label");
          if (label.length > L.choiceLabelChars || description.length > L.choiceDescriptionChars)
            throw tooBig("option");
          return description ? { label, description } : { label };
        });
        if (options.length < 2 || options.length > L.choiceOptions)
          throw new ValidationError(`a question takes 2 to ${L.choiceOptions} options`);
        if (new Set(options.map((o) => o.label)).size !== options.length)
          throw new ValidationError("options must differ");
        const named = options.filter((o) => !OTHER_OPTION.test(o.label));
        return { question, options: named.length > 0 ? named : options };
      });
      return { kind: "choices", questions };
    }
    case "diagram": {
      if (typeof c.mermaid !== "string") throw new ValidationError("diagram needs mermaid source");
      if (bytes(c.mermaid) > ARTIFACT_LIMITS.diagramBytes) throw tooBig("diagram");
      return { kind: "diagram", mermaid: c.mermaid };
    }
    case "table": {
      const columns = c.columns;
      if (!isStringArray(columns) || columns.length === 0) throw new ValidationError("table needs columns");
      if (!Array.isArray(c.rows) || !c.rows.every(isStringArray)) throw new ValidationError("table rows: text cells");
      const rows = c.rows as string[][];
      if (columns.length > ARTIFACT_LIMITS.tableColumns || rows.length > ARTIFACT_LIMITS.tableRows) {
        throw tooBig("table");
      }
      const badCell = (r: string[]) => r.length > columns.length || r.some((x) => x.length > ARTIFACT_LIMITS.cellChars);
      if (rows.some(badCell)) throw new ValidationError("table rows: too many cells, or a cell is too long");
      const table: ArtifactContent = { kind: "table", columns: [...columns], rows: rows.map((r) => [...r]) };
      if (bytes(JSON.stringify(table)) > ARTIFACT_LIMITS.tableBytes) throw tooBig("table");
      return table;
    }
    case "diff": {
      const files = c.files;
      const ok = (f: unknown) => {
        const file = f as Record<string, unknown>;
        return typeof file?.path === "string" && file.path.length > 0 && typeof file.patch === "string";
      };
      if (!Array.isArray(files) || files.length === 0 || !files.every(ok)) {
        throw new ValidationError("diff needs files with path and patch");
      }
      if (files.length > ARTIFACT_LIMITS.diffFiles) throw tooBig("diff");
      const clean = (files as { path: string; patch: string }[]).map((f) => ({ path: f.path, patch: f.patch }));
      if (bytes(JSON.stringify(clean)) > ARTIFACT_LIMITS.diffBytes) throw tooBig("diff");
      return { kind: "diff", files: clean };
    }
    case "file":
      throw new ValidationError("files are uploaded as bytes (upload_file, or an upload in the Drive), not as content");
    default:
      throw new ValidationError(`kind must be one of ${TEXT_ARTIFACT_KINDS.join(", ")}`);
  }
}

/** How each kind is stored: documents, pages and diagrams as text; tables and diffs as JSON. */
function encode(content: TextContent): { body: Uint8Array; contentType: string } {
  const text = (s: string, contentType: string) => ({ body: new TextEncoder().encode(s), contentType });
  switch (content.kind) {
    case "document":
      return text(content.markdown, "text/markdown; charset=utf-8");
    case "html":
      return text(content.html, "text/html; charset=utf-8");
    case "block":
      return text(
        JSON.stringify({ spec: content.spec, html: content.html, subtitle: content.subtitle }),
        "application/json",
      );
    case "poll":
      return text(
        JSON.stringify({ question: content.question, options: content.options, multiple: content.multiple }),
        "application/json",
      );
    case "choices":
      return text(JSON.stringify({ questions: content.questions }), "application/json");
    case "diagram":
      return text(content.mermaid, "text/plain; charset=utf-8");
    case "table":
      return text(JSON.stringify({ columns: content.columns, rows: content.rows }), "application/json");
    case "diff":
      return text(JSON.stringify({ files: content.files }), "application/json");
  }
}

function decode(kind: Exclude<ArtifactKind, "file">, body: Uint8Array): TextContent {
  const s = new TextDecoder().decode(body);
  switch (kind) {
    case "document":
      return { kind, markdown: s };
    case "html":
      return { kind, html: s };
    case "block":
      return { kind, ...(JSON.parse(s) as { spec?: BlockSpec; html?: string; subtitle?: string }) };
    case "poll":
      return { kind, ...(JSON.parse(s) as { question: string; options: string[]; multiple: boolean }) };
    case "choices":
      return { kind, questions: (JSON.parse(s) as { questions: ChoiceQuestion[] }).questions };
    case "diagram":
      return { kind, mermaid: s };
    case "table": {
      const t = JSON.parse(s) as { columns: string[]; rows: string[][] };
      return { kind, columns: t.columns, rows: t.rows };
    }
    case "diff":
      return { kind, files: (JSON.parse(s) as { files: { path: string; patch: string }[] }).files };
  }
}

const EXTENSIONS: Record<ArtifactKind, string> = {
  document: "md",
  html: "html",
  diagram: "mmd",
  table: "json",
  diff: "json",
  file: "bin",
  block: "json",
  poll: "json",
  choices: "json",
};

// ── Files (ADR 0025) ─────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

/** Text-like extensions whose small files get `text` (beyond `text/*` types). */
const TEXT_EXTENSIONS = new Set(["md", "csv", "tsv", "json", "txt", "log", "yaml", "yml", "xml"]);
const TEXT_READ_BYTES = 200_000;

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * The type a file is stored and served with: from its extension; otherwise
 * the one given, when it is plain (never a type a browser would run);
 * otherwise `application/octet-stream`.
 */
export function fileContentType(name: string, given?: string | null): string {
  const known = CONTENT_TYPES[extensionOf(name)];
  if (known) return known;
  const g = given?.split(";")[0]?.trim().toLowerCase() ?? "";
  const plain = /^[a-z]+\/[a-z0-9.+-]+$/.test(g) && !/html|xml|svg|javascript|ecmascript/.test(g);
  return plain ? g : "application/octet-stream";
}

/** The original file name, cleaned: no folders, no control characters, at most 255 characters (extension kept). */
export function cleanFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).at(-1) ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim();
  if (!base || base === "." || base === "..")
    throw new ValidationError("the file needs a name", "artifact.file_name_required");
  const max = ARTIFACT_LIMITS.fileNameChars;
  if (base.length <= max) return base;
  const ext = extensionOf(base);
  return ext && ext.length < 20 ? `${base.slice(0, max - ext.length - 1)}.${ext}` : base.slice(0, max);
}

const isTextFile = (name: string, contentType: string) =>
  contentType.startsWith("text/") ||
  contentType.startsWith("application/json") ||
  TEXT_EXTENSIONS.has(extensionOf(name));

/** A `file` version as content: metadata, plus its text when it is a small UTF-8 text file. */
function fileContent(
  v: Pick<VersionRow, "fileName" | "contentType" | "size" | "sha256">,
  body: Uint8Array | null,
): FileContent {
  const name = v.fileName ?? "file";
  // By its name first (a picture stored as plain bytes before uploads were typed by name reads as a picture).
  const contentType = fileContentType(name, v.contentType);
  const content: FileContent = { kind: "file", name, contentType, size: v.size, sha256: v.sha256 };
  if (body && isTextFile(name, v.contentType)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (text.length <= ARTIFACT_LIMITS.fileTextChars) content.text = text;
    } catch {
      // Not UTF-8: metadata only.
    }
  }
  return content;
}

/** Whether a `file` version's bytes are worth reading for `text`. */
const wantsFileText = (v: Pick<VersionRow, "fileName" | "contentType" | "size">) =>
  v.size <= TEXT_READ_BYTES && isTextFile(v.fileName ?? "", v.contentType);

/** The content of a `file` version just written from `body`. */
const storedFileContent = (
  name: string,
  blob: { contentType: string; size: number; sha: string },
  body: Uint8Array,
) => {
  const v = { fileName: name, contentType: blob.contentType, size: blob.size, sha256: blob.sha };
  return fileContent(v, wantsFileText(v) ? body : null);
};

/** Plain text for search: what a person would look for in the file (a `file`: its name only). */
function excerptOf(content: ArtifactContent): string {
  const s =
    content.kind === "file"
      ? content.name
      : content.kind === "document"
        ? content.markdown
        : content.kind === "block" && content.spec
          ? blockSpecText(content.spec)
          : content.kind === "html" || content.kind === "block"
            ? (content.html ?? "").replace(/<[^>]+>/g, " ")
            : content.kind === "poll"
              ? [content.question, ...content.options].join("\n")
              : content.kind === "choices"
                ? choicesText(content.questions)
                : content.kind === "diagram"
                  ? content.mermaid
                  : content.kind === "table"
                    ? [content.columns.join(" "), ...content.rows.map((r) => r.join(" "))].join("\n")
                    : content.files.map((f) => f.path).join("\n");
  return s.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

/** CSV with RFC 4180 quoting. */
export function tableToCsv(columns: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** A Markdown table (for PDF export of tables). */
function tableToMarkdown(columns: string[], rows: string[][]): string {
  const cell = (v: string) => v.replace(/\|/g, "/").replace(/\n/g, " ");
  const line = (r: string[]) => `| ${columns.map((_, i) => cell(r[i] ?? "")).join(" | ")} |`;
  return [line(columns), `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

/** One unified patch with `diff --git` headers per file. */
export function diffToPatch(files: { path: string; patch: string }[]): string {
  return files.map((f) => `diff --git a/${f.path} b/${f.path}\n${f.patch.replace(/\n?$/, "\n")}`).join("");
}

// ── Access ───────────────────────────────────────────────────────────────────

/**
 * The wiki's rule for a run (ADR 0023 addendum), for what a file's sharing adds: a run reaches a shared file only when
 * the person behind it and everyone who reads its conversation see the file, since what it says reaches them all. With
 * nobody behind it, only a file shared with the whole workspace. As a condition over `artifacts`.
 */
function runSharedSql(personId: string | null, channelId: string) {
  return and(
    sql`${artifactCol("share")} <> 'conversation'`,
    personId ? fileSharedSql(sql`${personId}::text`) : sql`${artifactCol("share")} = 'everyone'`,
    // Who reads it by `channelReaderSql`, not its members alone: no person is a member of a task's conversation,
    // which whoever sees the task reads. Aliases of their own: `fileSeenSql` nests `channelReaderSql` too.
    sql`not exists (select 1 from organization_members runr where runr.org_id = ${artifactCol("org_id")}
      and ${channelReaderSql(sql`${channelId}::uuid`, sql`runr.user_id`)} and not ${fileSeenSql(sql`runr.user_id`)})`,
    sql`not exists (select 1 from ${channels} runc join organization_members runo on runo.org_id = runc.org_id
      where runc.id = ${channelId}::uuid and runc.kind = 'channel' and runc.visibility = 'public'
        and not ${fileSeenSql(sql`runo.user_id`)})`,
  ) as SQL;
}

/** What decides who reads a file: where it lives and its sharing (absent for a conversation alone, as `placeNew` asks). */
type Readable = Pick<ArtifactRow, "channelId"> & Partial<Pick<ArtifactRow, "share" | "shareUserIds" | "shareRoleIds">>;

const sharingOf = (a: Pick<ArtifactRow, "share" | "shareUserIds" | "shareRoleIds">): FileSharing => ({
  mode: a.share,
  userIds: a.share === "people" ? a.shareUserIds : [],
  roleIds: a.share === "people" ? a.shareRoleIds : [],
});

/** Whether a person reads a file: where it lives (`readsWhereItLives`), or through its sharing (ADR 0157). */
async function personCanRead(db: Database, userId: string, orgId: string, a: Readable) {
  if (!a.channelId || a.share === "everyone" || (a.share === "people" && a.shareUserIds?.includes(userId))) return true;
  if (await readsWhereItLives(db, userId, orgId, a.channelId)) return true;
  return a.share === "people" && sharedByRole(db, userId, orgId, a.shareRoleIds ?? []);
}

/** Whether a people list's roles reach this person: one they hold, or administrator, who always sees a list. */
async function sharedByRole(db: Database, userId: string, orgId: string, roleIds: string[]) {
  const [row] = rowsOf<{ yes: boolean | string }>(
    await db.execute(sql`select (${maySql(sql`${orgId}::uuid`, sql`${userId}::text`, "administrator")}
      or exists (select 1 from organization_member_roles sr where sr.org_id = ${orgId}::uuid and sr.user_id = ${userId}
        and sr.role_id = any(${`{${roleIds.join(",")}}`}::uuid[]))) as yes`),
  );
  return row?.yes === true || row?.yes === "t";
}

/** Of these files, the ones whose sharing shows them to this person (`fileSharedSql`), deleted ones included. */
async function sharedWith(db: Database, userId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(inArray(artifacts.id, ids), fileSharedSql(sql`${userId}::text`)));
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether a person reads a conversation's files: a member, anyone for a public channel, an administrator for any
 * channel, whoever sees the task of a task's conversation.
 */
async function readsWhereItLives(db: Database, userId: string, orgId: string, channelId: string) {
  const [row] = await db
    .select({
      visibility: channels.visibility,
      kind: channels.kind,
      memberId: channelMembers.id,
      // A task's conversation: whoever sees the task (ADR 0145).
      taskReader: taskReaderSql(sql`${channels.id}`, sql`${userId}::text`),
      admin: sql<boolean>`${adminChannelSql(sql`${orgId}::uuid`, sql`${userId}::text`)}`,
    })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!row) return false;
  if (row.kind === "task") return row.taskReader === true || String(row.taskReader) === "t";
  return (
    row.memberId !== null ||
    (row.visibility === "public" && row.kind === "channel") ||
    row.admin === true ||
    String(row.admin) === "t"
  );
}

/** The channels whose files this person may read: those they belong to, public channels, tasks they see, and for an administrator every channel. */
async function personReadableChannels(db: Database, userId: string, orgId: string): Promise<string[]> {
  const member = and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId));
  const open = and(eq(channels.visibility, "public"), eq(channels.kind, "channel"));
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelMembers, member)
    .where(
      and(
        eq(channels.orgId, orgId),
        or(
          sql`${channelMembers.id} is not null`,
          open,
          and(eq(channels.kind, "task"), taskReaderSql(sql`${channels.id}`, sql`${userId}::text`)),
          adminChannelSql(sql`${orgId}::uuid`, sql`${userId}::text`),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** Whether every version of an artifact in the agents' DM was made by a run for the same person (`agentsDmReads`). */
async function madeForSamePerson(db: Database, dm: AgentsDmReads, artifactId: string) {
  const rows = await db
    .select({ runId: artifactVersions.runId })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId));
  const results = await Promise.all(rows.map((v) => (v.runId ? dm.ofRun(v.runId) : false)));
  return rows.length > 0 && results.every(Boolean);
}

/** Whether a person may add files to the Drive (`placeNew`); someone who left never does. */
async function addsToDrive(db: Database, orgId: string, userId: string) {
  return can(await getMembership(db, userId, orgId), "upload_files");
}

/** A room no person reads (a routine's, an agents' DM), as a channel row, or null for any other conversation. */
export async function agentRoom(db: Executor, orgId: string, channelId: string) {
  const [channel] = await db
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  return channel && isAgentOnlyDm(channel) ? channel : null;
}

/** A run in this room made a version of the row: a room's files land where people see them, and stay the room's. */
const madeInRoomSql = (roomId: string) => sql`exists (
  select 1 from ${artifactVersions} join ${schema.agentRuns} on ${schema.agentRuns.id} = ${artifactVersions.runId}
  where ${artifactVersions.artifactId} = ${artifacts.id} and ${schema.agentRuns.channelId} = ${roomId})`;

/** Whether a run in `roomId` made a version of this file. */
async function madeInRoom(db: Database, artifactId: string, roomId: string) {
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), madeInRoomSql(roomId)));
  return row !== undefined;
}

/** A file this agent's room saved elsewhere (`placeFile`); in the agents' DM, only one made for the same person. */
async function ownRoomFile(db: Database, actor: Extract<ArtifactActor, { type: "agent" }>, orgId: string, id: string) {
  if (!(await agentRoom(db, orgId, actor.channelId)) || !(await madeInRoom(db, id, actor.channelId))) return false;
  const dm = await agentsDmReads(db, orgId, actor.channelId, () => readerOfRun(db, orgId, actor.runId));
  return !dm || madeForSamePerson(db, dm, id);
}

/**
 * An agent's own reach, what `listArtifacts` lists and what it may change: org-wide files, its run's conversation and
 * public channels it is in (in the agents' DM, only those made for the same person), the conversations it shares
 * with the person behind the run, and what its room saved elsewhere.
 */
async function agentReaches(
  db: Database,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  a: Pick<ArtifactRow, "id" | "channelId">,
) {
  if (!a.channelId) return true;
  if (!(await agentSearchChannels(db, orgId, actor.agentId, actor.channelId, { files: true })).includes(a.channelId)) {
    const person = await runPerson(db, orgId, actor.runId ?? undefined);
    if (person !== null && (await requesterSharedChannels(db, orgId, actor.agentId, person)).includes(a.channelId))
      return true;
    return ownRoomFile(db, actor, orgId, a.id);
  }
  const dm = await agentsDmReads(db, orgId, a.channelId, () => readerOfRun(db, orgId, actor.runId));
  return !dm || madeForSamePerson(db, dm, a.id);
}

/** Whether a run reaches a file through its sharing, by the wiki's rule (`runSharedSql`). */
async function runReachesShared(db: Database, channelId: string, person: string | null, artifactId: string) {
  const [row] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), runSharedSql(person, channelId)));
  return row !== undefined;
}

/**
 * By id an agent also reads whatever the person behind the run may read where it lives, a file shared past its
 * conversation by the wiki's rule (`runSharedSql`), and what a teammate made for that person in the agents' DM, which
 * no person sees: an id reaches it in ways `listArtifacts` doesn't list (attached from another conversation, passed
 * on by the agent asking it, named in a consulted agent's answer).
 */
async function canRead(db: Database, actor: ArtifactActor, orgId: string, a: Pick<ArtifactRow, "id"> & Readable) {
  if (actor.type === "person") return personCanRead(db, actor.userId, orgId, a);
  if (!a.channelId || (await agentReaches(db, actor, orgId, { id: a.id, channelId: a.channelId }))) return true;
  const person = await runPerson(db, orgId, actor.runId ?? undefined);
  if (person !== null && (await readsWhereItLives(db, person, orgId, a.channelId))) return true;
  if (await runReachesShared(db, actor.channelId, person, a.id)) return true;
  if (person === null) return false;
  const dm = await agentsDmReads(db, orgId, a.channelId, () => Promise.resolve(person));
  return dm !== null && madeForSamePerson(db, dm, a.id);
}

async function requireMember(db: Database, actor: ArtifactActor, orgId: string) {
  if (actor.type !== "person") return null;
  const membership = await requireActiveMembership(db, actor.userId, orgId);
  return membership;
}

const authorOf = (actor: ArtifactActor): ArtifactAuthor =>
  actor.type === "person" ? { type: "person", id: actor.userId } : { type: "agent", id: actor.agentId };

function view(a: ArtifactRow, canEdit: boolean): ArtifactView {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    version: a.currentVersion,
    channelId: a.channelId,
    threadId: a.threadId,
    createdBy: { type: a.createdByType as ArtifactAuthor["type"], id: a.createdById },
    updatedBy: { type: a.updatedByType as ArtifactAuthor["type"], id: a.updatedById },
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    canEdit,
    untrusted: a.untrusted,
    inDrive: a.inDrive,
    sharing: sharingOf(a),
  };
}

/** People save new versions of documents and tables (editor) and of files (an upload). */
const editableKind = (kind: ArtifactKind) => kind === "document" || kind === "table" || kind === "file";

async function loadArtifact(db: Database, orgId: string, id: string) {
  // A model can send any 36 characters: Postgres would answer with an error about the uuid type.
  if (!UUID.test(id)) return null;
  const [a] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
  return a ?? null;
}

/**
 * An agent's "not found", with what to do: a bare one left agents asking people to send the file again. One text for
 * a wrong id and a file out of reach, deleted or not: which of them it is would say a private conversation holds it.
 */
async function agentRefusal(db: Database, actor: Extract<ArtifactActor, { type: "agent" }>, orgId: string, id: string) {
  const [gone] = UUID.test(id)
    ? await db
        .select({ id: artifacts.id, channelId: artifacts.channelId })
        .from(artifacts)
        .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId), sql`${artifacts.deletedAt} is not null`))
    : [];
  if (gone && (await canRead(db, actor, orgId, gone))) {
    return new NotFoundError(
      "File not found: it was deleted. Say so: a person can restore it from the Drive's trash (Lixeira).",
    );
  }
  const nobody = (await runPerson(db, orgId, actor.runId ?? undefined))
    ? ""
    : " Nobody is behind this run, so you only reach this conversation, public channels you are in and the Drive.";
  return new NotFoundError(
    `File not found: ${id} is no file you can open from here. The id may be wrong, or the file is in a conversation out of your reach.${nobody} Copy the whole id from list_artifacts or an "(attached files: …)" line, never from memory. If that isn't it, say so and ask someone who sees the file to attach it here or put it in the Drive. This id won't work again.`,
  );
}

async function readable(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, id: string) {
  await requireMember(deps.db, actor, orgId);
  const a = await loadArtifact(deps.db, orgId, id);
  if (a && (await canRead(deps.db, actor, orgId, a))) return a;
  if (actor.type === "agent") throw await agentRefusal(deps.db, actor, orgId, id);
  // Not visible = not found: don't reveal files of channels you can't see.
  throw new NotFoundError("Artifact not found");
}

/** `readable` to save a version: reading follows the person behind the run, changing a file only the agent's own reach. */
async function writable(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, id: string) {
  const a = await readable(deps, actor, orgId, id);
  if (actor.type === "agent" && !(await agentReaches(deps.db, actor, orgId, a))) {
    throw new ForbiddenError(
      "You can read this file but not change it: it is in a conversation you aren't in. Save your version as a new file with create_artifact.",
    );
  }
  return a;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** What a version stores: the bytes and their type (and, for a `file`, its name). */
interface Stored {
  body: Uint8Array;
  contentType: string;
  fileName?: string | null;
}

async function writeBlob(deps: ArtifactDeps, orgId: string, artifactId: string, version: number, stored: Stored) {
  const location = await deps.blobs.forOrg(orgId);
  const { body, contentType } = stored;
  // The workspace's own bucket counts against no limit of ours.
  if (location.storageConfigId === null) await assertStorageRoom(deps.db, orgId, body.byteLength);
  // A per-write suffix so two saves racing on the same version number never share a key: without it the
  // loser's put overwrites the winner's committed bytes, leaving the row's size and sha not matching disk.
  const key = `${location.prefix}artifacts/${artifactId}/v${version}-${Bun.randomUUIDv7()}`;
  await location.store.put(key, body, { contentType });
  return { storageConfigId: location.storageConfigId, key, contentType, size: body.byteLength, sha: sha256Hex(body) };
}

/** Who may create, and where: people in the Drive or a channel they see; agents in their run's channel and thread. */
async function placeNew(
  db: Database,
  actor: ArtifactActor,
  orgId: string,
  input: { title: string; channelId?: string | null; threadId?: string | null },
) {
  const membership = await requireMember(db, actor, orgId);
  if (membership && !can(membership, "upload_files")) throw new ForbiddenError();
  const title = input.title.trim().slice(0, ARTIFACT_LIMITS.titleChars);
  if (!title) throw new ValidationError("title is required");
  const channelId = actor.type === "agent" ? actor.channelId : (input.channelId ?? null);
  const threadId = actor.type === "agent" ? (actor.threadId ?? null) : (input.threadId ?? null);
  if (channelId && actor.type === "person" && !(await readsWhereItLives(db, actor.userId, orgId, channelId))) {
    throw new NotFoundError("Channel not found");
  }
  return { title, channelId, threadId };
}

/**
 * `placeNew` for a Drive file: an agent's run in a room no person reads saves where people follow that run
 * (`peopleSee`): where its routine reports, or the shared Drive when that is what its people chose (`toDrive`), else
 * the conversation a consultation started in. One that answers agents only, or nobody, stays in the room, and
 * `fileReach` tells the agent so.
 */
async function placeFile(
  db: Database,
  actor: ArtifactActor,
  orgId: string,
  input: { title: string; channelId?: string | null; threadId?: string | null },
) {
  const place = await placeNew(db, actor, orgId, input);
  if (actor.type !== "agent" || !actor.runId) return place;
  const room = await agentRoom(db, orgId, actor.channelId);
  if (!room) return place;
  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, orgId), eq(schema.agentRuns.id, actor.runId)));
  if (!run) return place;
  const brief = run.background ? await routineBriefOfRun(db, run) : null;
  const toDrive = brief?.toDrive && brief.creatorUserId && (await addsToDrive(db, orgId, brief.creatorUserId));
  return { ...place, ...(toDrive ? { channelId: null, threadId: null } : await peopleSee(db, run, room)) };
}

/** Version 1 of a new artifact: blob, rows, index, audit and the channel event. */
async function insertArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: {
    kind: ArtifactKind;
    title: string;
    channelId: string | null;
    threadId: string | null;
    untrusted: boolean;
    /** False for what lives only in its conversation (ADR 0113): out of the Drive and of search. */
    inDrive?: boolean;
    excerpt: string;
    stored: Stored;
    note?: string | null;
    /** Whose file it is, when not the actor's (an imported agent's own files); the audit keeps the actor. */
    author?: ArtifactAuthor;
  },
) {
  const { db } = deps;
  const id = Bun.randomUUIDv7();
  const blob = await writeBlob(deps, orgId, id, 1, input.stored);
  const author = input.author ?? authorOf(actor);
  const row = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(artifacts)
      .values({
        id,
        orgId,
        kind: input.kind,
        title: input.title,
        channelId: input.channelId,
        threadId: input.threadId,
        untrusted: input.untrusted,
        inDrive: input.inDrive ?? true,
        excerpt: input.excerpt,
        currentVersion: 1,
        createdByType: author.type,
        createdById: author.id,
        updatedByType: author.type,
        updatedById: author.id,
      })
      .returning();
    if (!a) throw new Error("artifact insert returned nothing");
    await tx.insert(artifactVersions).values({
      orgId,
      artifactId: id,
      version: 1,
      storageConfigId: blob.storageConfigId,
      blobKey: blob.key,
      contentType: blob.contentType,
      size: blob.size,
      sha256: blob.sha,
      fileName: input.stored.fileName ?? null,
      note: input.note?.trim().slice(0, 500) || null,
      authorType: author.type,
      authorId: author.id,
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
    });
    if (input.inDrive !== false) await enqueueIndex(tx, { orgId, kind: "file", sourceId: id });
    await recordAudit(tx, {
      orgId,
      actor: authorOf(actor),
      action: "artifact.created",
      target: { type: "artifact", id },
      details: { kind: input.kind, version: 1, size: blob.size },
    });
    return a;
  });
  const artifact = view(row, editableKind(row.kind));
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.created", channelId: row.channelId, artifact });
  }
  if (row.inDrive) await publishListChanged(deps.pubsub, orgId, "artifacts");
  return { artifact, blob };
}

/** A new version of `current`: blob, rows (a newer version in between is a conflict), index, audit, event. */
export async function insertVersion(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  current: ArtifactRow,
  input: { stored: Stored; excerpt: string; note?: string | null; title?: string },
) {
  const { db } = deps;
  const artifactId = current.id;
  const version = current.currentVersion + 1;
  const blob = await writeBlob(deps, orgId, artifactId, version, input.stored);
  const author = authorOf(actor);
  const title = input.title?.trim().slice(0, ARTIFACT_LIMITS.titleChars) || current.title;
  const note = input.note?.trim().slice(0, 500) || null;
  const row = await db.transaction(async (tx) => {
    const [a] = await tx
      .update(artifacts)
      .set({
        currentVersion: version,
        title,
        excerpt: input.excerpt,
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.currentVersion, current.currentVersion)))
      .returning();
    if (!a) throw new ConflictError("Someone saved a newer version. Reload and try again.");
    await tx.insert(artifactVersions).values({
      orgId,
      artifactId,
      version,
      storageConfigId: blob.storageConfigId,
      blobKey: blob.key,
      contentType: blob.contentType,
      size: blob.size,
      sha256: blob.sha,
      fileName: input.stored.fileName ?? null,
      note,
      authorType: author.type,
      authorId: author.id,
      runId: actor.type === "agent" ? (actor.runId ?? null) : null,
    });
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: artifactId });
    await recordAudit(tx, {
      orgId,
      actor: author,
      action: "artifact.version_created",
      target: { type: "artifact", id: artifactId },
      details: { version, size: blob.size, note },
    });
    return a;
  });
  const artifact = view(row, editableKind(row.kind));
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.updated", channelId: row.channelId, artifact });
  }
  if (row.inDrive) await publishListChanged(deps.pubsub, orgId, "artifacts");
  return { artifact, blob, version };
}

/**
 * Creates an artifact (version 1). People create in the Drive (no channel:
 * the whole org sees it) or in a channel they belong to; agents create in
 * the channel and thread of their run (`placeFile`). `html` is stored as is
 * and marked untrusted. Never a `file` (see `createFileArtifact`).
 */
export async function createArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: { title: string; content: unknown; channelId?: string | null; threadId?: string | null },
): Promise<ArtifactDetailView> {
  const place = await placeFile(deps.db, actor, orgId, input);
  const content = validateContent(input.content);
  const { artifact } = await insertArtifact(deps, actor, orgId, {
    ...place,
    kind: content.kind,
    untrusted: content.kind === "html",
    excerpt: excerptOf(content),
    stored: encode(content),
  });
  return detail(artifact, 1, content);
}

/**
 * What an agent shows in its conversation (ADR 0113): a live block or a poll. Stored like any file, for its channel's
 * visibility, versions and the card on the message, but out of the Drive and of search. Runs apart like a page.
 */
export async function createConversationArtifact(
  deps: ArtifactDeps,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  input: { title: string; content: Extract<ArtifactContent, { kind: ConversationKind }> },
): Promise<ArtifactDetailView> {
  const place = await placeNew(deps.db, actor, orgId, input);
  const content = validateContent(input.content) as Extract<ArtifactContent, { kind: ConversationKind }>;
  const { artifact } = await insertArtifact(deps, actor, orgId, {
    ...place,
    kind: content.kind,
    untrusted: true,
    inDrive: false,
    excerpt: excerptOf(content),
    stored: encode(content),
  });
  return detail(artifact, 1, content);
}

/** "Guardar no Drive": a block a person wants to keep joins the Drive and search (ADR 0113). */
export async function keepBlock(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const actor: ArtifactActor = { type: "person", userId };
  const current = await readable(deps, actor, orgId, artifactId);
  if (current.kind !== "block") throw new ValidationError("only a block can be kept");
  if (current.inDrive) return view(current, false);
  const row = await deps.db.transaction(async (tx) => {
    const [a] = await tx
      .update(artifacts)
      .set({ inDrive: true })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId)))
      .returning();
    if (!a) throw new NotFoundError("Artifact not found");
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: artifactId });
    return a;
  });
  const artifact = view(row, false);
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.updated", channelId: row.channelId, artifact });
  }
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  return artifact;
}

/**
 * Saves a new version (always; old versions stay). People pass the version
 * they edited (`baseVersion`): a newer one in between is a conflict (409).
 */
export async function updateArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  input: { content: unknown; note?: string | null; baseVersion?: number; title?: string },
): Promise<ArtifactDetailView> {
  const current = await writable(deps, actor, orgId, artifactId);
  if (current.kind === "file") {
    throw new ValidationError("this artifact is an uploaded file: send a new version of the file instead");
  }
  const content = validateContent(input.content);
  if (content.kind !== current.kind) throw new ValidationError(`this artifact is a ${current.kind}`);
  if (actor.type === "person" && !editableKind(current.kind)) {
    throw new ForbiddenError("Only documents and tables can be edited here");
  }
  if (input.baseVersion !== undefined && input.baseVersion !== current.currentVersion) {
    throw new ConflictError("Someone saved a newer version. Reload and try again.");
  }
  const { artifact, version } = await insertVersion(deps, actor, orgId, current, {
    stored: encode(content),
    excerpt: excerptOf(content),
    note: input.note,
    title: input.title,
  });
  return detail(artifact, version, content);
}

/** Checks a file's name and size and describes it (ADR 0025). */
function fileInput(input: { name: string; bytes: Uint8Array; contentType?: string | null }) {
  const name = cleanFileName(input.name);
  if (input.bytes.byteLength > ARTIFACT_LIMITS.fileBytes) {
    const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
    throw new ValidationError(`the file is too large (max ${maxMb} MB)`, "artifact.file_too_large", { maxMb });
  }
  const contentType = fileContentType(name, input.contentType);
  return { name, stored: { body: input.bytes, contentType, fileName: name } satisfies Stored };
}

/**
 * Stores any bytes as a `file` artifact (version 1), with the original name,
 * type, size and SHA-256 (ADR 0025). Always untrusted: downloaded as an
 * attachment, never rendered on the app's origin. Placed like `createArtifact`.
 */
export async function createFileArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  input: {
    title: string;
    name: string;
    bytes: Uint8Array;
    contentType?: string | null;
    channelId?: string | null;
    threadId?: string | null;
    note?: string | null;
    author?: ArtifactAuthor;
    /** What a tool brought back for the agent to work on, not saved for anyone: it stays in the run's conversation. */
    byProduct?: boolean;
  },
): Promise<ArtifactDetailView> {
  const place = await (input.byProduct ? placeNew : placeFile)(deps.db, actor, orgId, input);
  const file = fileInput(input);
  const { artifact, blob } = await insertArtifact(deps, actor, orgId, {
    ...place,
    kind: "file",
    untrusted: true,
    excerpt: file.name,
    stored: file.stored,
    note: input.note,
    author: input.author,
  });
  return detail(artifact, 1, storedFileContent(file.name, blob, input.bytes));
}

/** A new version of a `file` artifact from bytes (who may: like documents and tables). */
export async function addFileVersion(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  input: {
    name: string;
    bytes: Uint8Array;
    contentType?: string | null;
    note?: string | null;
    title?: string;
    baseVersion?: number;
  },
): Promise<ArtifactDetailView> {
  const current = await writable(deps, actor, orgId, artifactId);
  if (current.kind !== "file") {
    throw new ValidationError(`this artifact is a ${current.kind}, not an uploaded file`);
  }
  if (input.baseVersion !== undefined && input.baseVersion !== current.currentVersion) {
    throw new ConflictError("Someone saved a newer version. Reload and try again.");
  }
  const latest = await versionRow(deps.db, current);
  if (!keepsVersions(fileContent(latest, null), current.currentVersion)) {
    throw new ValidationError(
      "this file is a snapshot (an image, a video or a recording): send it as a new file",
      "artifact.not_versioned",
    );
  }
  const file = fileInput(input);
  const { artifact, blob, version } = await insertVersion(deps, actor, orgId, current, {
    stored: file.stored,
    excerpt: file.name,
    note: input.note,
    title: input.title,
  });
  return detail(artifact, version, storedFileContent(file.name, blob, input.bytes));
}

/**
 * Why a run can't show a file of a private conversation to the whole workspace, null when it can. Only someone who may
 * add to the Drive widens an audience: the person behind the run, or the creator of the routine it works for in a room
 * no person reads (a run a report woke sits in a conversation, whose private text is no routine's to publish). And a
 * file it didn't make takes more: a routine only moves what its room alone made, and a run that read outside content
 * moves nothing of anyone's, so an injected page can't publish a person's private file.
 */
async function sharedDriveRefusal(
  db: Database,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  a: ArtifactRow,
) {
  const [here] = await db
    .select({ kind: channels.kind, visibility: channels.visibility })
    .from(channels)
    .where(eq(channels.id, a.channelId as string));
  if (here?.kind === "channel" && here.visibility === "public") return null;
  const runId = actor.runId ?? "";
  if (runId && (await answersAgentsOnly(db, orgId, runId))) {
    return "nothing of this run reaches people, it answers the agent that asked";
  }
  const authority = await runAuthorityById(db, orgId, runId);
  const room = await agentRoom(db, orgId, actor.channelId);
  const asker = authority.personId ?? (room ? routineCreatorOf(authority) : null);
  if (!asker || !(await addsToDrive(db, orgId, asker))) {
    return "only a person who may add files to the Drive can ask for that, and nobody who can is behind this run";
  }
  const made = await db
    .select({ runId: artifactVersions.runId, roomId: schema.agentRuns.channelId })
    .from(artifactVersions)
    .leftJoin(schema.agentRuns, eq(schema.agentRuns.id, artifactVersions.runId))
    .where(eq(artifactVersions.artifactId, a.id));
  if (made.every((m) => m.runId === runId)) return null;
  if (!authority.personId) {
    return made.every((m) => m.roomId === actor.channelId)
      ? null
      : "a person changed this file where it is, so only a person can ask to move it";
  }
  return (await runItselfReadOutside(db, orgId, runId))
    ? "this run read content from outside and didn't make this file. It moves when the person asks for it in a new message"
    : null;
}

/**
 * `shared_drive`: the file leaves its conversation for the workspace's shared Drive (no channel), so everyone there
 * sees it (`sharedDriveRefusal`). Links and cards keep working, since it is the same file.
 */
export async function moveToSharedDrive(
  deps: ArtifactDeps,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  artifactId: string,
) {
  const a = await writable(deps, actor, orgId, artifactId);
  if (!a.inDrive) throw new ValidationError(`a ${a.kind} lives in its conversation, not in the Drive`);
  if (!a.channelId) return;
  const refusal = await sharedDriveRefusal(deps.db, actor, orgId, a);
  if (refusal) throw new ForbiddenError(refusal);
  const row = await deps.db.transaction(async (tx) => {
    const [moved] = await tx
      .update(artifacts)
      .set({ channelId: null, threadId: null })
      .where(and(eq(artifacts.id, a.id), eq(artifacts.orgId, orgId)))
      .returning();
    if (!moved) throw new NotFoundError("Artifact not found");
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: a.id });
    await recordAudit(tx, {
      orgId,
      actor: authorOf(actor),
      action: "artifact.moved_to_drive",
      target: { type: "artifact", id: a.id },
      details: { fromChannelId: a.channelId },
    });
    return moved;
  });
  const artifact = view(row, editableKind(row.kind));
  await publishChannelEvent(deps.pubsub, { type: "artifact.updated", channelId: a.channelId, artifact });
  await publishListChanged(deps.pubsub, orgId, "artifacts");
}

const SHARED_DRIVE_HINT = "To put it there: update_artifact with shared_drive: true.";

/** Where a file is and who sees it, for an agent to tell people (what `withPersonFacts` shows them). */
export async function fileReach(db: Database, orgId: string, artifactId: string, hint = SHARED_DRIVE_HINT) {
  const [a] = await db
    .select({
      channelId: artifacts.channelId,
      kind: channels.kind,
      name: channels.name,
      open: channels.visibility,
      share: artifacts.share,
      userIds: artifacts.shareUserIds,
      roleIds: artifacts.shareRoleIds,
    })
    .from(artifacts)
    .leftJoin(channels, eq(channels.id, artifacts.channelId))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId)));
  if (!a?.channelId) return "It is in the workspace's shared Drive: everyone in the workspace sees it.";
  if (a.share === "everyone") return "It was shared with the whole workspace: everyone in the workspace sees it.";
  const notShared = `in the Drive's private section, not in the shared Drive. ${hint}`.trimEnd();
  if (a.share === "people") {
    return `Who reads its conversation sees it, and it is also shared with ${await sharedList(db, orgId, a.userIds, a.roleIds)}: it is ${notShared}`;
  }
  if (a.kind === "task") return "It is in the Drive, on its task: whoever sees the task sees it.";
  if (a.kind === "channel" && a.open === "public") {
    return `It is in the shared Drive, from #${a.name}: everyone in the workspace sees it.`;
  }
  if (a.kind === "channel") return `Only the members of #${a.name} and administrators see it: it is ${notShared}`;
  const people = await db
    .select({ name: schema.users.name })
    .from(channelMembers)
    .innerJoin(schema.users, eq(schema.users.id, channelMembers.userId))
    .where(eq(channelMembers.channelId, a.channelId));
  if (people.length > 0) return `Only ${people.map((p) => p.name).join(", ")} can see it: it is ${notShared}`;
  return `No person sees it: it is in a conversation between agents, not in the shared Drive. Don't say it is saved for people. ${hint}`.trimEnd();
}

/** Who a people list adds, for `fileReach`: "Ana, the role Finance and administrators". */
async function sharedList(db: Database, orgId: string, userIds: string[], roleIds: string[]) {
  const [people, roles] = await Promise.all([
    userIds.length
      ? db.select({ name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
      : Promise.resolve([]),
    roleIds.length
      ? db
          .select({ name: schema.orgRoles.name })
          .from(schema.orgRoles)
          .where(and(eq(schema.orgRoles.orgId, orgId), inArray(schema.orgRoles.id, roleIds)))
      : Promise.resolve([]),
  ]);
  const names = [...people.map((p) => p.name), ...roles.map((r) => `the role ${r.name}`), "administrators"];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The Drive files a run saved, as a message carries them, of those the people of `channelId` see (or everyone does). */
export function filesOfRun(db: Executor, orgId: string, runId: string, channelId: string) {
  return db
    .selectDistinct({ id: artifacts.id, version: artifacts.currentVersion, title: artifacts.title })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.artifactId, artifacts.id))
    .where(
      and(
        eq(artifacts.orgId, orgId),
        eq(artifactVersions.runId, runId),
        isNull(artifacts.deletedAt),
        eq(artifacts.inDrive, true),
        or(isNull(artifacts.channelId), eq(artifacts.channelId, channelId)),
      ),
    );
}

async function versionRow(db: Database, a: ArtifactRow, version?: number) {
  const wanted = version ?? a.currentVersion;
  // A link's `?version=abc` names no version: Postgres would fail on it, a failure of ours to whoever opened it.
  const [v] = Number.isSafeInteger(wanted)
    ? await db
        .select()
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, a.id), eq(artifactVersions.version, wanted)))
    : [];
  if (!v) throw new NotFoundError("Version not found", "artifact.version_not_found", { latest: a.currentVersion });
  return v;
}

async function readVersion(deps: ArtifactDeps, a: ArtifactRow, v: VersionRow) {
  const store = await deps.blobs.forConfig(a.orgId, v.storageConfigId);
  const object = await store.get(v.blobKey);
  if (!object) throw new NotFoundError("The stored file is missing");
  return object;
}

/** A version's content: decoded text kinds; a `file`'s metadata (its bytes read only for a small text file). */
async function contentOf(deps: ArtifactDeps, a: ArtifactRow, v: VersionRow): Promise<ArtifactContent> {
  if (a.kind === "file") return fileContent(v, wantsFileText(v) ? (await readVersion(deps, a, v)).body : null);
  return decode(a.kind, (await readVersion(deps, a, v)).body);
}

/**
 * A block's parts at `version`, or null for a page or anything else: what the agent's context computes the block's
 * results from (`blockStateNotes`). The context only names blocks of messages the run already reads.
 */
export async function blockSpecAt(
  deps: ArtifactDeps,
  orgId: string,
  artifactId: string,
  version: number,
): Promise<BlockSpec | null> {
  const [a] = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
  if (a?.kind !== "block") return null;
  const v = await versionRow(deps.db, a, version).catch(() => null);
  if (!v) return null;
  const content = await contentOf(deps, a, v);
  return content.kind === "block" ? (content.spec ?? null) : null;
}

/**
 * Where the bytes of a `file` artifact at `version` (default: latest) are, after
 * the visibility check: for `import_file` and the like.
 */
export async function storedFileOfArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  version?: number,
) {
  const a = await readable(deps, actor, orgId, artifactId);
  if (a.kind !== "file") throw new ValidationError(`this artifact is a ${a.kind}, not an uploaded file`);
  const v = await versionRow(deps.db, a, version);
  return {
    version: v.version,
    name: v.fileName ?? "file",
    storageConfigId: v.storageConfigId,
    blobKey: v.blobKey,
    size: v.size,
    sha256: v.sha256,
  };
}

/** All the text of a `file` too long or not UTF-8 for `content.text`, which `read_artifact` reads in pages; else null. */
export async function fileFullText(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  version?: number,
): Promise<string | null> {
  const a = await readable(deps, actor, orgId, artifactId);
  const v = await versionRow(deps.db, a, version);
  return isTextFile(v.fileName ?? "", v.contentType) ? textOfBytes((await readVersion(deps, a, v)).body) : null;
}

/** One artifact at `version` (default: latest), with content. */
export async function getArtifact(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
  version?: number,
): Promise<ArtifactDetailView> {
  const a = await readable(deps, actor, orgId, artifactId);
  const v = await versionRow(deps.db, a, version);
  return detail(view(a, editableKind(a.kind)), v.version, await contentOf(deps, a, v));
}

/** What a file's pill in a text shows (`idRef`): its name and type, only for a person who may read it; else null. */
export async function fileRefOf(db: Database, userId: string, orgId: string, artifactId: string) {
  const a = await loadArtifact(db, orgId, artifactId);
  if (!a || !(await personCanRead(db, userId, orgId, a))) return null;
  const v = a.kind === "file" ? await versionRow(db, a).catch(() => null) : null;
  return {
    id: a.id,
    title: a.title,
    artifactKind: a.kind,
    fileName: v?.fileName ?? null,
    contentType: v?.contentType ?? null,
  };
}

export async function listArtifactVersions(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
): Promise<ArtifactVersionView[]> {
  const a = await readable(deps, actor, orgId, artifactId);
  const rows = await deps.db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, a.id))
    .orderBy(desc(artifactVersions.version));
  return rows.map((v) => ({
    version: v.version,
    author: { type: v.authorType as ArtifactAuthor["type"], id: v.authorId },
    note: v.note,
    createdAt: v.createdAt.toISOString(),
  }));
}

/** What a list of files narrows by: the Drive's filters, the same for a page and for the counts by kind. */
export interface ArtifactFilters {
  /** Words in the title, the text or the conversation's name. */
  q?: string;
  kind?: ArtifactKind;
  /** Any of these kinds (the Drive's kind chips, several on). */
  kinds?: ArtifactKind[];
  channelId?: string;
  /** In any of these conversations. */
  channelIds?: string[];
  author?: ArtifactAuthor;
  /** Made or last changed by any of them. */
  authors?: ArtifactAuthor[];
  /** Made or changed by (any version), e.g. an agent's files on its page. */
  changedBy?: ArtifactAuthor;
  /** Made by an agent or by a person (Quem fez). */
  who?: "agents" | "people";
  /** Updated at or after this time. */
  since?: Date;
  /** Agents: also the conversations this person shares with the agent (see `requesterSharedChannels`). */
  requesterUserId?: string | null;
}

export type ArtifactSort = "recent" | "name" | "kind";

/** The longest page a list returns. */
export const ARTIFACT_PAGE_MAX = 200;

/** The order of `sort: "kind"`, as the apps list the kinds (mirror of `ARTIFACT_KINDS` in `@agenteschat/client`). */
const KIND_ORDER = ["document", "table", "diff", "diagram", "html", "file"];

/** The files the actor can see that pass `filters` (all but the kinds), as SQL, and what an agent's DM reads. */
async function artifactScope(db: Database, actor: ArtifactActor, orgId: string, filters: ArtifactFilters) {
  await requireMember(db, actor, orgId);
  let visible: string[];
  let dm: AgentsDmReads | null = null;
  let ownRoom: SQL | undefined;
  // What a file's sharing adds (ADR 0157).
  let widened: SQL;
  if (actor.type === "agent") {
    widened = runSharedSql(filters.requesterUserId ?? null, actor.channelId);
    dm = await agentsDmReads(db, orgId, actor.channelId, () => readerOfRun(db, orgId, actor.runId));
    visible = await agentSearchChannels(db, orgId, actor.agentId, actor.channelId, { files: true });
    if (await agentRoom(db, orgId, actor.channelId)) ownRoom = madeInRoomSql(actor.channelId);
    if (filters.requesterUserId) {
      const shared = await requesterSharedChannels(db, orgId, actor.agentId, filters.requesterUserId);
      // A run where the agent isn't a member (the right hand, called by name) still lists that conversation.
      const here =
        (await getMembership(db, filters.requesterUserId, orgId)) &&
        (await readsWhereItLives(db, filters.requesterUserId, orgId, actor.channelId));
      visible = [...new Set([...visible, ...shared, ...(here ? [actor.channelId] : [])])];
    }
  } else {
    visible = await personReadableChannels(db, actor.userId, orgId);
    widened = fileSharedSql(sql`${actor.userId}::text`);
  }
  const q = filters.q?.trim();
  const madeBy = (a: ArtifactAuthor) => and(eq(artifacts.createdByType, a.type), eq(artifacts.createdById, a.id));
  const where = and(
    eq(artifacts.orgId, orgId),
    isNull(artifacts.deletedAt),
    eq(artifacts.inDrive, true),
    or(
      isNull(artifacts.channelId),
      visible.length > 0 ? inArray(artifacts.channelId, visible) : undefined,
      ownRoom,
      widened,
    ),
    filters.channelId ? eq(artifacts.channelId, filters.channelId) : undefined,
    filters.channelIds?.length ? inArray(artifacts.channelId, filters.channelIds) : undefined,
    filters.since ? gte(artifacts.updatedAt, filters.since) : undefined,
    filters.author ? madeBy(filters.author) : undefined,
    filters.authors?.length
      ? or(
          ...filters.authors.flatMap((a) => [
            madeBy(a),
            and(eq(artifacts.updatedByType, a.type), eq(artifacts.updatedById, a.id)),
          ]),
        )
      : undefined,
    filters.changedBy
      ? sql`exists (select 1 from ${artifactVersions} where ${artifactVersions.artifactId} = ${artifacts.id} and ${artifactVersions.authorType} = ${filters.changedBy.type} and ${artifactVersions.authorId} = ${filters.changedBy.id})`
      : undefined,
    filters.who ? eq(artifacts.createdByType, filters.who === "agents" ? "agent" : "person") : undefined,
    q
      ? sql`(${artifacts.title} ilike ${`%${q}%`} or ${artifacts.excerpt} ilike ${`%${q}%`} or exists (select 1 from ${channels} where ${channels.id} = ${artifacts.channelId} and ${channels.kind} = 'channel' and ${channels.name} ilike ${`%${q}%`}))`
      : undefined,
  );
  return { where, dm, visible };
}

const kindsSql = (filters: ArtifactFilters) =>
  filters.kind
    ? eq(artifacts.kind, filters.kind)
    : filters.kinds?.length
      ? inArray(artifacts.kind, filters.kinds)
      : undefined;

/**
 * What the actor can see, newest update first unless `sort` says otherwise: org-wide files, files of channels they
 * belong to, and of public channels (people), and what a file's sharing adds (ADR 0157): for a person who it shows the
 * file to, for an agent the wiki's rule (`runSharedSql`). `offset` and `limit` page it, at most `ARTIFACT_PAGE_MAX` and
 * one more (so a page knows another follows).
 */
export async function listArtifacts(
  db: Database,
  actor: ArtifactActor,
  orgId: string,
  filters: ArtifactFilters & { limit?: number; offset?: number; sort?: ArtifactSort } = {},
): Promise<ArtifactView[]> {
  const { where, dm, visible } = await artifactScope(db, actor, orgId, filters);
  const order =
    filters.sort === "name"
      ? [sql`lower(${artifacts.title})`]
      : filters.sort === "kind"
        ? [sql`array_position(${`{${KIND_ORDER.join(",")}}`}::text[], ${artifacts.kind}::text) nulls last`]
        : [];
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(where, kindsSql(filters)))
    .orderBy(...order, desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(Math.min(ARTIFACT_PAGE_MAX + 1, filters.limit ?? 100))
    .offset(filters.offset ?? 0);
  const fromDm = dm
    ? await Promise.all(
        rows.map(
          // Shared past its conversation: listed by `runSharedSql`, which no file of the agents' DM passes (nobody may share one).
          (a) =>
            !a.channelId ||
            a.share !== "conversation" ||
            (a.channelId !== dm.channelId && visible.includes(a.channelId)) ||
            madeForSamePerson(db, dm, a.id),
        ),
      )
    : null;
  return rows
    .filter((_, i) => fromDm?.[i] !== false)
    .map((a) => view(a, actor.type === "person" && editableKind(a.kind)));
}

/** How many files a person sees per kind for `filters` (the kinds left out): the Drive's kind chips. */
export async function countArtifacts(
  db: Database,
  actor: Extract<ArtifactActor, { type: "person" }>,
  orgId: string,
  filters: ArtifactFilters = {},
): Promise<Partial<Record<ArtifactKind, number>>> {
  const { where } = await artifactScope(db, actor, orgId, filters);
  const rows = await db
    .select({ kind: artifacts.kind, n: sql<number>`count(*)::int` })
    .from(artifacts)
    .where(where)
    .groupBy(artifacts.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

/**
 * Conversations (channels and DMs, not archived) where both the agent and
 * this person are members: what the agent may look at on that person's
 * behalf, never more.
 */
export async function requesterSharedChannels(db: Database, orgId: string, agentId: string, userId: string) {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`select c.id from channels c
      where c.org_id = ${orgId}::uuid and c.archived_at is null
        and exists (select 1 from channel_members m where m.channel_id = c.id and m.agent_id = ${agentId}::uuid)
        and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = ${userId})`),
  );
  return rows.map((r) => r.id);
}

/** Where artifacts came from, for agents picking one ("DM with Walter", "#general", "Drive"). */
export async function artifactOrigins(
  db: Database,
  orgId: string,
  list: Pick<ArtifactView, "channelId" | "createdBy">[],
) {
  const channelIds = [...new Set(list.flatMap((a) => (a.channelId ? [a.channelId] : [])))];
  const agentIds = [...new Set(list.flatMap((a) => (a.createdBy.type === "agent" ? [a.createdBy.id] : [])))];
  const userIds = [...new Set(list.flatMap((a) => (a.createdBy.type === "person" ? [a.createdBy.id] : [])))];
  const [chans, dmPeople, agentRows, userRows] = await Promise.all([
    channelIds.length
      ? db
          .select({ id: channels.id, kind: channels.kind, name: channels.name })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : Promise.resolve([]),
    channelIds.length
      ? db
          .select({ channelId: channelMembers.channelId, name: schema.users.name })
          .from(channelMembers)
          .innerJoin(schema.users, eq(schema.users.id, channelMembers.userId))
          .where(inArray(channelMembers.channelId, channelIds))
      : Promise.resolve([]),
    agentIds.length
      ? db
          .select({ id: schema.agents.id, handle: schema.agents.handle })
          .from(schema.agents)
          .where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, agentIds)))
      : Promise.resolve([]),
    userIds.length
      ? db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, userIds))
      : Promise.resolve([]),
  ]);
  const channelLabel = new Map<string, string>(
    chans.map((c): [string, string] => {
      if (c.kind !== "dm") return [c.id, `#${c.name}`];
      const people = dmPeople.filter((p) => p.channelId === c.id).map((p) => p.name);
      return [c.id, people.length ? `DM with ${people.join(", ")}` : "a conversation between agents"];
    }),
  );
  const creator = new Map<string, string>([
    ...agentRows.map((a) => [a.id, `@${a.handle}`] as [string, string]),
    ...userRows.map((u) => [u.id, u.name] as [string, string]),
  ]);
  return {
    origin: (a: Pick<ArtifactView, "channelId">) =>
      a.channelId ? (channelLabel.get(a.channelId) ?? "another conversation") : "Drive (the whole organization)",
    creator: (a: Pick<ArtifactView, "createdBy">) => creator.get(a.createdBy.id) ?? a.createdBy.type,
  };
}

/** Whether a run that answers agents only made a version: nothing of it reaches a person. */
async function madeForAgentsOnly(db: Database, orgId: string, artifactId: string) {
  const rows = await db
    .select({ runId: artifactVersions.runId })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId));
  const results = await Promise.all(rows.map((v) => (v.runId ? answersAgentsOnly(db, orgId, v.runId) : false)));
  return results.some(Boolean);
}

/**
 * An agent brings an artifact into its run's conversation (`share_artifact`):
 * allowed only when the person who asked can see where it came from (and the
 * agent was there too), or it was made for that person in the agents' DM.
 * Visible here already (same channel, org-wide, shared with the workspace or a public channel): the same
 * file is attached. From a DM or a private channel: a copy is saved here, so
 * the people here can open it; the original stays where it was. Audited
 * either way.
 */
export async function shareArtifact(
  deps: ArtifactDeps,
  actor: Extract<ArtifactActor, { type: "agent" }>,
  orgId: string,
  artifactId: string,
  /** `alsoFrom`: a conversation the agent's run may take files from on its own (a routine's room). */
  input: { requesterUserId: string | null; note?: string | null; alsoFrom?: string | null },
): Promise<{ artifact: ArtifactView; copied: boolean; from: { channelId: string | null; kind: string | null } }> {
  const { db } = deps;
  const a = await loadArtifact(db, orgId, artifactId);
  if (!a) throw await agentRefusal(db, actor, orgId, artifactId);
  const [origin] = a.channelId
    ? await db
        .select({ kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(and(eq(channels.id, a.channelId), eq(channels.orgId, orgId)))
    : [];
  const openHere =
    !a.channelId ||
    a.channelId === actor.channelId ||
    a.share === "everyone" ||
    (origin?.kind === "channel" && origin.visibility === "public");
  if (!openHere) {
    // From a DM or a private channel: the requester and the agent must both be in it. Reading for a person is no
    // reason to carry a file into another audience.
    const requester = input.requesterUserId;
    const dm = requester ? await agentsDmReads(db, orgId, a.channelId as string, async () => requester) : null;
    const allowed =
      (input.alsoFrom != null && (a.channelId === input.alsoFrom || (await madeInRoom(db, a.id, input.alsoFrom)))) ||
      (requester !== null &&
        (await requesterSharedChannels(db, orgId, actor.agentId, requester)).includes(a.channelId as string)) ||
      // No person is in the agents' DM: what a teammate made there for the person asking is theirs to have, unless
      // that teammate may only answer agents (`answersAgentsOnly`).
      (dm !== null && (await madeForSamePerson(db, dm, a.id)) && !(await madeForAgentsOnly(db, orgId, a.id)));
    if (!allowed) throw await agentRefusal(db, actor, orgId, artifactId);
  }
  let shared: ArtifactView = view(a, editableKind(a.kind));
  let copied = false;
  if (!openHere) {
    const v = await versionRow(db, a, undefined);
    const body = (await readVersion(deps, a, v)).body;
    shared =
      a.kind === "file"
        ? await createFileArtifact(deps, actor, orgId, {
            title: a.title,
            name: v.fileName ?? "file",
            bytes: body,
            contentType: v.contentType,
          })
        : await createArtifact(deps, actor, orgId, { title: a.title, content: decode(a.kind, body) });
    copied = true;
  }
  await recordAudit(db, {
    orgId,
    actor: { type: "agent", id: actor.agentId },
    action: "artifact.shared",
    target: { type: "artifact", id: a.id },
    details: {
      fromChannelId: a.channelId,
      toChannelId: actor.channelId,
      copyId: copied ? shared.id : null,
      requesterUserId: input.requesterUserId,
      note: input.note?.slice(0, 500) ?? null,
    },
  });
  return { artifact: shared, copied, from: { channelId: a.channelId, kind: origin?.kind ?? null } };
}

/**
 * Files saved before `placeFile` still sit in rooms no person reads, written by agents told nobody reads them. Each goes
 * to the one person its runs worked for, in their DM with the agent, however wide the place its routine reports to: a
 * run's working file was never saved for a channel, and that person can have it put in the shared Drive
 * (`moveToSharedDrive`). The rest stay. Once at boot, off its path: who a run worked for is a rule in code, which a SQL
 * migration couldn't read.
 * ponytail: what stays is looked at again on every boot; a mark on the row when that many ever add up.
 */
export async function surfaceRoomFiles(db: Database) {
  const stuck = await db
    .select({ id: artifacts.id, orgId: artifacts.orgId, roomId: channels.id })
    .from(artifacts)
    .innerJoin(channels, eq(channels.id, artifacts.channelId))
    .where(
      and(
        eq(channels.kind, "dm"),
        sql`${channels.dmKey} not like '%u:%'`,
        eq(artifacts.inDrive, true),
        isNull(artifacts.deletedAt),
      ),
    );
  let moved = 0;
  for (const a of stuck) {
    const made = await db
      .select({ run: schema.agentRuns, note: artifactVersions.note })
      .from(artifactVersions)
      .leftJoin(schema.agentRuns, eq(schema.agentRuns.id, artifactVersions.runId))
      .where(eq(artifactVersions.artifactId, a.id));
    // "From …": what a connector or an email brought in, which nobody may have meant for people.
    if (made.some((m) => m.note?.startsWith("From "))) continue;
    const runs = made.flatMap((m) => (m.run ? [m.run] : []));
    const [run] = runs;
    if (!run || runs.length !== made.length) continue;
    const people = await Promise.all(
      runs.map(async (r) => {
        const authority = await runAuthorityById(db, a.orgId, r.id);
        return (await answersAgentsOnly(db, a.orgId, r.id))
          ? null
          : (authority.personId ?? routineCreatorOf(authority));
      }),
    );
    const person = people[0];
    if (!person || people.some((p) => p !== person)) continue;
    // Refused for someone who left or whom the agent no longer answers: the file stays.
    const dm = await openDm(db, person, a.orgId, { agentId: run.agentId }).catch(() => null);
    if (!dm) continue;
    await db.transaction(async (tx) => {
      await tx
        .update(artifacts)
        .set({ channelId: dm.id, threadId: null })
        .where(and(eq(artifacts.id, a.id), eq(artifacts.channelId, a.roomId)));
      await enqueueIndex(tx, { orgId: a.orgId, kind: "file", sourceId: a.id });
      await recordAudit(tx, {
        orgId: a.orgId,
        actor: { type: "system", id: null },
        action: "artifact.surfaced",
        target: { type: "artifact", id: a.id },
        details: { fromChannelId: a.roomId, toChannelId: dm.id, personId: person },
      });
    });
    moved++;
  }
  return moved;
}

/** Deleted files can be restored for this long; then the purge job removes their contents (all versions). */
export const ARTIFACT_TRASH_DAYS = 30;

type Ownable = Pick<ArtifactRow, "id" | "createdByType" | "createdById">;

/**
 * Which of these files this person may delete (and restore): whoever created
 * it; for files an agent made, the person who asked it and the agent's owner;
 * admins always.
 */
async function deletableIds(db: Database, userId: string, orgId: string, list: Ownable[]): Promise<Set<string>> {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (can(membership, "configure")) return new Set(list.map((a) => a.id));
  const out = new Set(list.filter((a) => a.createdByType === "person" && a.createdById === userId).map((a) => a.id));
  const byAgent = list.filter((a) => a.createdByType === "agent");
  if (byAgent.length === 0) return out;
  const [owned, asked] = await Promise.all([
    db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          eq(schema.agents.ownerUserId, userId),
          inArray(schema.agents.id, [...new Set(byAgent.map((a) => a.createdById))]),
        ),
      ),
    // The person behind the run that made the first version.
    db
      .select({ artifactId: artifactVersions.artifactId })
      .from(artifactVersions)
      .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, artifactVersions.runId))
      .innerJoin(
        schema.messages,
        and(eq(schema.messages.id, schema.agentRuns.triggerMessageId), eq(schema.messages.orgId, orgId)),
      )
      .where(
        and(
          inArray(
            artifactVersions.artifactId,
            byAgent.map((a) => a.id),
          ),
          eq(artifactVersions.version, 1),
          eq(schema.messages.authorUserId, userId),
        ),
      ),
  ]);
  const ownedAgents = new Set(owned.map((r) => r.id));
  for (const a of byAgent) if (ownedAgents.has(a.createdById)) out.add(a.id);
  for (const r of asked) out.add(r.artifactId);
  return out;
}

const canDeleteArtifact = async (db: Database, userId: string, orgId: string, a: Ownable) =>
  (await deletableIds(db, userId, orgId, [a])).has(a.id);

/**
 * Who can see a file, as the person looking at it reads it (ADR 0111). A
 * file follows the conversation it came from: no conversation = the whole
 * workspace; a public channel = the whole workspace too (anyone may open
 * it), a private channel = its members; a DM = its two participants. Agents
 * follow the same rules, narrower (`agentSearchChannels`).
 */
export type ArtifactAudience =
  | { kind: "workspace" }
  /** `outside`: the viewer doesn't read it there, the file was shared with them (ADR 0157): no way into it. */
  | { kind: "channel"; name: string; private: boolean; outside?: true }
  /**
   * `gone`: the other side is an archived agent or a person who left, so the DM can't be opened any more. `between`:
   * the viewer isn't one of its sides (it was shared with them, ADR 0157), so no `with` and no way into it: its sides.
   */
  | { kind: "dm"; with: ArtifactAuthor | null; gone?: true; between?: ArtifactAuthor[] };

/** What the app adds for the person viewing: may they delete it, who can see it, may they change who sees it. */
export interface PersonArtifactFacts {
  canDelete: boolean;
  audience: ArtifactAudience;
  /**
   * They may change its sharing (`setFileSharing`): it lives in a conversation not everyone reads, and they read it
   * there. False for what the whole workspace sees already.
   */
  canShare: boolean;
}

export async function withPersonFacts<T extends Pick<ArtifactView, "id" | "channelId" | "createdBy" | "inDrive">>(
  db: Database,
  userId: string,
  orgId: string,
  list: T[],
): Promise<(T & PersonArtifactFacts)[]> {
  if (list.length === 0) return [];
  const channelIds = [...new Set(list.flatMap((a) => (a.channelId ? [a.channelId] : [])))];
  const [deletable, chans] = await Promise.all([
    deletableIds(
      db,
      userId,
      orgId,
      list.map((a) => ({ id: a.id, createdByType: a.createdBy.type, createdById: a.createdBy.id })),
    ),
    channelIds.length
      ? db
          .select({ id: channels.id, kind: channels.kind, name: channels.name, visibility: channels.visibility })
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
      : Promise.resolve([]),
  ]);
  const dmIds = chans.filter((c) => c.kind === "dm").map((c) => c.id);
  const dmMembers = dmIds.length
    ? await db
        .select({ channelId: channelMembers.channelId, userId: channelMembers.userId, agentId: channelMembers.agentId })
        .from(channelMembers)
        .where(inArray(channelMembers.channelId, dmIds))
    : [];
  const others = dmMembers.filter((m) => m.userId !== userId);
  const otherAgents = [...new Set(others.flatMap((m) => (m.agentId ? [m.agentId] : [])))];
  const otherPeople = [...new Set(others.flatMap((m) => (m.userId && !m.agentId ? [m.userId] : [])))];
  // What `openDm` refuses: an archived agent, or a person no longer (or blocked) in the workspace.
  const [liveAgents, livePeople] = await Promise.all([
    otherAgents.length
      ? db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.orgId, orgId),
              inArray(schema.agents.id, otherAgents),
              isNull(schema.agents.archivedAt),
            ),
          )
      : Promise.resolve([]),
    otherPeople.length
      ? db
          .select({ id: schema.organizationMembers.userId })
          .from(schema.organizationMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
          .where(
            and(
              eq(schema.organizationMembers.orgId, orgId),
              inArray(schema.organizationMembers.userId, otherPeople),
              accountInUse,
            ),
          )
      : Promise.resolve([]),
  ]);
  const live = new Set([...liveAgents, ...livePeople].map((r) => r.id));
  const closed = new Set(chans.filter((c) => c.kind !== "channel" || c.visibility !== "public").map((c) => c.id));
  const readsThere = closed.size ? new Set(await personReadableChannels(db, userId, orgId)) : closed;
  // Shared with them from a conversation they don't read (ADR 0157): what's said is never "you and …", and there's no
  // way into it.
  const outside = (id: string) => closed.has(id) && !readsThere.has(id);
  const audience = new Map<string, ArtifactAudience>(
    chans.map((c): [string, ArtifactAudience] => {
      if (c.kind !== "dm") {
        const channel = { kind: "channel", name: c.name, private: c.visibility !== "public" } as const;
        return [c.id, outside(c.id) ? { ...channel, outside: true } : channel];
      }
      if (outside(c.id)) {
        const sides = dmMembers.filter((m) => m.channelId === c.id);
        const between: ArtifactAuthor[] = [
          ...sides.flatMap((m) => (m.userId && !m.agentId ? [{ type: "person" as const, id: m.userId }] : [])),
          ...sides.flatMap((m) => (m.agentId ? [{ type: "agent" as const, id: m.agentId }] : [])),
        ];
        return [c.id, { kind: "dm", with: null, between }];
      }
      const other = dmMembers.find((m) => m.channelId === c.id && m.userId !== userId);
      const who: ArtifactAuthor | null = other?.agentId
        ? { type: "agent", id: other.agentId }
        : other?.userId
          ? { type: "person", id: other.userId }
          : null;
      return [c.id, who && !live.has(who.id) ? { kind: "dm", with: who, gone: true } : { kind: "dm", with: who }];
    }),
  );
  return list.map((a) => ({
    ...a,
    // What lives in its conversation was never in the Drive, so it has no trash to go to (ADR 0113).
    canDelete: a.inDrive && deletable.has(a.id),
    audience: a.channelId ? (audience.get(a.channelId) ?? { kind: "dm", with: null }) : { kind: "workspace" },
    canShare: a.inDrive && a.channelId !== null && closed.has(a.channelId) && readsThere.has(a.channelId),
  }));
}

/** The people (active members of this workspace) and roles (its own, never `everyone`) a list may hold. */
async function cleanSharing(db: Database, orgId: string, input: Partial<FileSharing>): Promise<FileSharing> {
  if (input.mode === "everyone") return { mode: "everyone", userIds: [], roleIds: [] };
  if (input.mode !== "people") return { mode: "conversation", userIds: [], roleIds: [] };
  const askedPeople = [...new Set(input.userIds ?? [])];
  const askedRoles = [...new Set(input.roleIds ?? [])].filter((id) => UUID.test(id));
  if (askedPeople.length > AUDIENCE_MAX || askedRoles.length > AUDIENCE_MAX) {
    throw new ValidationError(
      `Choose at most ${AUDIENCE_MAX} people and ${AUDIENCE_MAX} roles`,
      "artifact.sharing_too_many",
      {
        max: AUDIENCE_MAX,
      },
    );
  }
  const [people, roles] = await Promise.all([
    askedPeople.length
      ? db
          .select({ id: schema.organizationMembers.userId })
          .from(schema.organizationMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
          .where(
            and(
              eq(schema.organizationMembers.orgId, orgId),
              inArray(schema.organizationMembers.userId, askedPeople),
              accountInUse,
            ),
          )
      : Promise.resolve([]),
    askedRoles.length
      ? db
          .select({ id: schema.orgRoles.id })
          .from(schema.orgRoles)
          .where(
            and(
              eq(schema.orgRoles.orgId, orgId),
              eq(schema.orgRoles.kind, "custom"),
              inArray(schema.orgRoles.id, askedRoles),
            ),
          )
      : Promise.resolve([]),
  ]);
  const userIds = askedPeople.filter((id) => people.some((p) => p.id === id));
  const roleIds = askedRoles.filter((id) => roles.some((r) => r.id === id));
  if (userIds.length === 0 && roleIds.length === 0) {
    throw new ValidationError("Choose who sees it", "artifact.sharing_empty");
  }
  return { mode: "people", userIds, roleIds };
}

/**
 * "Compartilhar" (ADR 0157): who sees a file on top of the conversation it lives in. Whoever reads it there may change
 * it (a DM's participants, a channel's members and administrators, whoever sees a task for its conversation); someone
 * it was shared with may not. A file the whole workspace sees already (the shared Drive, a public channel) has nothing
 * to widen. Audited, and its conversation hears of it.
 */
export async function setFileSharing(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  input: Partial<FileSharing>,
) {
  const { db } = deps;
  const a = await readable(deps, { type: "person", userId }, orgId, artifactId);
  if (!a.inDrive) throw new ValidationError(`a ${a.kind} lives in its conversation`, "artifact.not_in_drive");
  const [where] = a.channelId
    ? await db
        .select({ kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(eq(channels.id, a.channelId))
    : [];
  if (!a.channelId || (where?.kind === "channel" && where.visibility === "public")) {
    throw new ValidationError("Everyone in the workspace sees this file already", "artifact.sharing_open");
  }
  if (!(await readsWhereItLives(db, userId, orgId, a.channelId))) {
    throw new ForbiddenError(
      "Only who is in the conversation the file is in changes who sees it",
      "artifact.sharing_forbidden",
    );
  }
  const next = await cleanSharing(db, orgId, input);
  const before = sharingOf(a);
  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .update(artifacts)
      .set({ share: next.mode, shareUserIds: next.userIds, shareRoleIds: next.roleIds })
      .where(and(eq(artifacts.id, a.id), eq(artifacts.orgId, orgId)))
      .returning();
    if (!saved) throw new NotFoundError("Artifact not found");
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: a.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.sharing_changed",
      target: { type: "artifact", id: a.id },
      details: { from: before.mode, mode: next.mode, userIds: next.userIds, roleIds: next.roleIds },
    });
    return saved;
  });
  const artifact = view(row, editableKind(row.kind));
  await publishChannelEvent(deps.pubsub, { type: "artifact.updated", channelId: a.channelId, artifact });
  return artifact;
}

/**
 * Deletes a file (people only; agents have no such tool). It leaves the Drive
 * and search; messages that show it say it was removed. It can be restored
 * for 30 days; then its contents are purged. Audited.
 */
export async function deleteArtifact(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const actor: ArtifactActor = { type: "person", userId };
  const a = await readable(deps, actor, orgId, artifactId);
  if (!(await canDeleteArtifact(deps.db, userId, orgId, a))) {
    throw new ForbiddenError(
      "Only who created it, who asked the agent, the agent's owner or an admin can delete this",
      "artifact.delete_forbidden",
    );
  }
  await deps.db.transaction(async (tx) => {
    await tx.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, a.id));
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: a.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.deleted",
      target: { type: "artifact", id: a.id },
      details: { title: a.title },
    });
  });
  if (a.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "artifact.deleted", channelId: a.channelId, artifactId: a.id });
  }
  await publishListChanged(deps.pubsub, orgId, "artifacts");
}

/** A deleted file as the trash shows it. */
export interface TrashedArtifactView {
  id: string;
  title: string;
  kind: ArtifactRow["kind"];
  channelId: string | null;
  createdBy: ArtifactAuthor;
  deletedAt: string;
  /** When its contents go for good. */
  purgeAt: string;
}

/** A trashed file this person can still read (as `readable` for live files), else null. */
async function deletedRow(db: Database, userId: string, orgId: string, id: string) {
  const [a] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId), sql`${artifacts.deletedAt} is not null`));
  return a && (await personCanRead(db, userId, orgId, a)) ? a : null;
}

/** Still in the trash: deleted, and not longer ago than the trash keeps files. */
const inTrash = () =>
  sql`${artifacts.deletedAt} > ${new Date(Date.now() - ARTIFACT_TRASH_DAYS * 86_400_000).toISOString()}::timestamptz`;

const purgeAt = (deletedAt: Date) => new Date(deletedAt.getTime() + ARTIFACT_TRASH_DAYS * 86_400_000);

/** "Lixeira": files deleted in the last 30 days that this person may restore. */
export async function listDeletedArtifacts(
  db: Database,
  userId: string,
  orgId: string,
): Promise<TrashedArtifactView[]> {
  await requireActiveMembership(db, userId, orgId);
  const since = new Date(Date.now() - ARTIFACT_TRASH_DAYS * 86_400_000);
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), sql`${artifacts.deletedAt} > ${since.toISOString()}::timestamptz`))
    .orderBy(desc(artifacts.deletedAt))
    .limit(500);
  // Deleting a file never widens who may read it: the trash shows only files this person could still open.
  const readable = new Set(await personReadableChannels(db, userId, orgId));
  const sharedIds = await sharedWith(
    db,
    userId,
    rows.filter((a) => a.share !== "conversation").map((a) => a.id),
  );
  const deletable = await deletableIds(
    db,
    userId,
    orgId,
    rows.filter((a) => !a.channelId || readable.has(a.channelId) || sharedIds.has(a.id)),
  );
  const out: TrashedArtifactView[] = [];
  for (const a of rows) {
    if (!deletable.has(a.id)) continue;
    out.push({
      id: a.id,
      title: a.title,
      kind: a.kind,
      channelId: a.channelId,
      createdBy: { type: a.createdByType as ArtifactAuthor["type"], id: a.createdById },
      deletedAt: (a.deletedAt as Date).toISOString(),
      purgeAt: purgeAt(a.deletedAt as Date).toISOString(),
    });
  }
  return out;
}

/** Brings a deleted file back (within 30 days), for the same people who may delete it. */
export async function restoreArtifact(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const a = await deletedRow(deps.db, userId, orgId, artifactId);
  if (!a?.deletedAt) throw new NotFoundError("Artifact not found", "artifact.not_found");
  if (purgeAt(a.deletedAt).getTime() <= Date.now()) {
    throw new ConflictError("This file was deleted more than 30 days ago", "artifact.purged", {
      days: ARTIFACT_TRASH_DAYS,
    });
  }
  if (!(await canDeleteArtifact(deps.db, userId, orgId, a))) {
    throw new ForbiddenError("Only who could delete it can restore it", "artifact.restore_forbidden");
  }
  // Out of the trash, what it keeps on this server's storage counts against the limit again.
  const [kept] = await deps.db
    .select({ bytes: sql<string>`coalesce(sum(${artifactVersions.size}), 0)` })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, a.id), isNull(artifactVersions.storageConfigId)));
  const bytes = Number(kept?.bytes ?? 0);
  if (bytes > 0) await assertStorageRoom(deps.db, orgId, bytes, { daily: false });
  const [row] = await deps.db.transaction(async (tx) => {
    // Conditional: a "delete for good" that committed since the read above wins.
    const updated = await tx
      .update(artifacts)
      .set({ deletedAt: null })
      .where(and(eq(artifacts.id, a.id), inTrash()))
      .returning();
    if (updated.length === 0) throw new NotFoundError("Artifact not found", "artifact.not_found");
    await enqueueIndex(tx, { orgId, kind: "file", sourceId: a.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.restored",
      target: { type: "artifact", id: a.id },
      details: { title: a.title },
    });
    return updated;
  });
  if (!row) throw new NotFoundError("Artifact not found", "artifact.not_found");
  await publishListChanged(deps.pubsub, orgId, "artifacts");
  return view(row, true);
}

/** Removes these versions' blobs and rows (the artifact row stays as a tombstone). */
async function dropVersions(deps: ArtifactDeps, list: { version: VersionRow; orgId: string }[]) {
  for (const { version: v, orgId } of list) {
    const store = await deps.blobs.forConfig(orgId, v.storageConfigId).catch(() => null);
    await store?.delete(v.blobKey).catch(() => undefined);
    await deps.db.delete(artifactVersions).where(eq(artifactVersions.id, v.id));
  }
  return list.length;
}

/**
 * Job: files deleted more than 30 days ago lose their contents (every
 * version's blob and row). The artifact row stays as a tombstone, so old
 * messages can still say "File removed" with its title.
 */
export async function purgeDeletedArtifacts(deps: ArtifactDeps, now = new Date()) {
  const cutoff = new Date(now.getTime() - ARTIFACT_TRASH_DAYS * 86_400_000);
  const versions = await deps.db
    .select({ version: artifactVersions, orgId: artifacts.orgId })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(sql`${artifacts.deletedAt} is not null and ${artifacts.deletedAt} < ${cutoff.toISOString()}::timestamptz`)
    .limit(500);
  return dropVersions(deps, versions);
}

/**
 * "Apagar para sempre" in the trash: its contents go now, as the purge job
 * would take them after 30 days. The same people who may restore it.
 */
export async function purgeArtifactNow(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const a = await deletedRow(deps.db, userId, orgId, artifactId);
  if (!a?.deletedAt || purgeAt(a.deletedAt).getTime() <= Date.now()) {
    throw new NotFoundError("Artifact not found", "artifact.not_found");
  }
  if (!(await canDeleteArtifact(deps.db, userId, orgId, a))) {
    throw new ForbiddenError("Only who could delete it can delete it for good", "artifact.delete_forbidden");
  }
  // A tombstone is a row deleted longer ago than the trash keeps it: backdating takes it out of the trash
  // (and out of restore) with no column of its own.
  const gone = new Date(Date.now() - ARTIFACT_TRASH_DAYS * 86_400_000 - 1000);
  await deps.db.transaction(async (tx) => {
    // Conditional: a restore that committed since the read above wins, and its contents stay.
    const updated = await tx
      .update(artifacts)
      .set({ deletedAt: gone })
      .where(and(eq(artifacts.id, a.id), inTrash()))
      .returning({ id: artifacts.id });
    if (updated.length === 0) throw new NotFoundError("Artifact not found", "artifact.not_found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "artifact.purged",
      target: { type: "artifact", id: a.id },
      details: { title: a.title },
    });
  });
  const versions = await deps.db
    .select({ version: artifactVersions, orgId: artifacts.orgId })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(eq(artifactVersions.artifactId, a.id));
  await dropVersions(deps, versions);
  await publishListChanged(deps.pubsub, orgId, "artifacts");
}

/** Message attachments (`meta.artifacts`) of deleted files, as `{ id, deleted: true, title }`. */
export async function withDeletedArtifacts<T extends { meta: Record<string, unknown> }>(
  db: Database,
  orgId: string,
  list: T[],
): Promise<T[]> {
  const ids = new Set<string>();
  for (const m of list) {
    const files = m.meta.artifacts;
    if (Array.isArray(files)) for (const f of files) if (f && typeof f.id === "string") ids.add(f.id);
  }
  if (ids.size === 0) return list;
  const gone = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, [...ids]), sql`${artifacts.deletedAt} is not null`));
  if (gone.length === 0) return list;
  const byId = new Map(gone.map((g) => [g.id, g]));
  return list.map((m) => {
    const files = m.meta.artifacts;
    if (!Array.isArray(files) || !files.some((f) => byId.has(f?.id))) return m;
    return {
      ...m,
      meta: {
        ...m.meta,
        artifacts: files.map((f) => {
          const g = byId.get(f?.id);
          return g ? { id: g.id, deleted: true, title: g.title } : f;
        }),
      },
    };
  });
}

const fileName = (a: ArtifactRow, version: number, ext: string) => {
  const slug =
    a.title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "file";
  return `${slug}-v${version}.${ext}`;
};

export const DOWNLOAD_URL_TTL_SECONDS = 300;

/** A file name safe in any header: non-ASCII, quotes and separators become `_`. */
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\;]/g, "_");

/** `Content-Disposition: attachment` with the name as is (RFC 6266 `filename*`) and an ASCII fallback. */
export function attachmentDisposition(filename: string) {
  return `attachment; filename="${asciiName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * A short-lived download link, after the visibility check: a signed URL of
 * the bucket, or (stores that can't sign) our own streaming endpoint.
 */
export async function artifactDownload(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  version?: number,
): Promise<{ url: string; expiresAt: string }> {
  const a = await readable(deps, { type: "person", userId }, orgId, artifactId);
  const v = await versionRow(deps.db, a, version);
  const store = await deps.blobs.forConfig(orgId, v.storageConfigId);
  const filename =
    a.kind === "file"
      ? asciiName(v.fileName ?? fileName(a, v.version, "bin"))
      : fileName(a, v.version, EXTENSIONS[a.kind]);
  const signed = await store.signedUrl(v.blobKey, { expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, filename });
  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const url = signed ?? `/api/app/organizations/${orgId}/artifacts/${artifactId}/file?version=${v.version}`;
  return { url, expiresAt };
}

/**
 * The stored bytes (streamed by the server), or an export: CSV for tables,
 * a `.patch` for diffs. Always an attachment; HTML is never served inline.
 */
export async function artifactFile(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  options: { version?: number; format?: "csv" | "patch" | "pdf" | "docx" } = {},
): Promise<{ body: Uint8Array; contentType: string; filename: string }> {
  const a = await readable(deps, { type: "person", userId }, orgId, artifactId);
  const v = await versionRow(deps.db, a, options.version);
  if (a.kind === "file") {
    // Uploaded files download as they are: original bytes, name and type.
    if (options.format) {
      throw new ValidationError(
        `${options.format.toUpperCase()} export is not available for uploaded files`,
        "artifact.format_unavailable",
      );
    }
    const object = await readVersion(deps, a, v);
    const filename = v.fileName ?? fileName(a, v.version, "bin");
    return { body: object.body, contentType: fileContentType(filename, v.contentType), filename };
  }
  const object = await readVersion(deps, a, v);
  const content = decode(a.kind, object.body);
  if (options.format === "csv") {
    if (content.kind !== "table") throw new ValidationError("CSV export is for tables", "artifact.format_unavailable");
    const body = new TextEncoder().encode(tableToCsv(content.columns, content.rows));
    return { body, contentType: "text/csv; charset=utf-8", filename: fileName(a, v.version, "csv") };
  }
  if (options.format === "pdf" || options.format === "docx") {
    const markdown =
      content.kind === "document"
        ? content.markdown
        : content.kind === "table"
          ? tableToMarkdown(content.columns, content.rows)
          : null;
    if (markdown === null)
      throw new ValidationError(
        `${options.format.toUpperCase()} export is for documents and tables`,
        "artifact.format_unavailable",
      );
    if (options.format === "docx") {
      return {
        body: markdownToDocx(markdown, { title: a.title }),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: fileName(a, v.version, "docx"),
      };
    }
    const body = markdownToPdf(markdown, { title: a.title });
    return { body, contentType: "application/pdf", filename: fileName(a, v.version, "pdf") };
  }
  if (options.format === "patch") {
    if (content.kind !== "diff") throw new ValidationError("Patch export is for diffs", "artifact.format_unavailable");
    const body = new TextEncoder().encode(diffToPatch(content.files));
    return { body, contentType: "text/x-diff; charset=utf-8", filename: fileName(a, v.version, "patch") };
  }
  return { body: object.body, contentType: object.contentType, filename: fileName(a, v.version, EXTENSIONS[a.kind]) };
}

/**
 * Search: title and excerpt, visible like the channel it came from (shared with people too: its conversation and its
 * agents keep finding it); shared with the workspace, the whole org. Who it's shared with finds it by its own id
 * (`visibleFileScopes`), which only `searchForUser` passes.
 */
registerDocumentBuilder("file", async (db, orgId, id) => {
  const [a] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.orgId, orgId)));
  if (!a || a.deletedAt) return null;
  return {
    orgId,
    kind: "file",
    sourceId: a.id,
    channelIds: a.share === "everyone" || !a.channelId ? [] : [a.channelId],
    title: a.title,
    body: a.excerpt,
    createdAt: a.createdAt,
  };
});
