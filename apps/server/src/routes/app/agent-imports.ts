import {
  ARTIFACT_LIMITS,
  applyImport,
  attachmentDisposition,
  copyImportedFile,
  exportBundle,
  IMPORT_KINDS,
  IMPORT_LIMITS,
  importedSources,
  NEW_AGENT_DEFAULTS,
  NOTE_KINDS,
  readGithubImport,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  MULTIPART_SLACK_BYTES,
  OrgParams,
  requireSession,
  routineConnectorDeps,
  security,
} from "./context";

const tags = ["Agents"];

const ImportedFiles = z
  .object({
    files: z.array(
      z.object({
        path: z.string().openapi({ description: "Relative to the linked folder, or the file's name." }),
        text: z.string(),
      }),
    ),
    skipped: z
      .array(z.string())
      .optional()
      .openapi({ description: "Files that fit the list but not the limits (200 files, 8 MB), not read." }),
  })
  .openapi("AgentImportFiles");

const Key = z.string().min(1).max(200);

/** Like the routines' schedule rule, but as other apps write it (nulls, no zone); the engine checks it. */
const BundleRule = z.object({
  freq: z.enum(["once", "hourly", "daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().optional(),
  byWeekday: z.array(z.string().max(8)).max(14).optional(),
  byMonthDay: z.array(z.number().int()).max(31).optional(),
  byMonth: z.array(z.number().int()).max(12).optional(),
  bySetPos: z
    .union([z.number().int(), z.array(z.number().int()).max(10)])
    .nullable()
    .optional(),
  time: z.string().max(5).optional(),
  times: z.array(z.string().max(5)).max(24).optional(),
  timezone: z.string().max(64).nullable().optional(),
  start: z.string().max(10).nullable().optional(),
  until: z.string().max(10).nullable().optional(),
  count: z.number().int().nullable().optional(),
});

/**
 * `MigrationBundle` (ADR 0055). Text may be longer than our limits (the
 * import cuts it and reports `trimmed`); these caps only bound the request.
 */
const Bundle = z
  .object({
    format: z.literal("agenteschat.bundle"),
    version: z.literal(1),
    source: z.object({
      app: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
      ref: z.string().min(1).max(500),
      name: z.string().max(1000),
      files: z.array(z.string().max(1000)).max(10_000),
    }),
    agents: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(1000),
          handle: z.string().max(200),
          role: z.string().max(10_000),
          instructions: z.string().max(1_000_000),
          model: z.string().max(200).nullable(),
          appearance: z.object({
            color: z.string().max(40).optional(),
            eyes: z.string().max(40).optional(),
            accessory: z.string().max(40).optional(),
          }),
          skills: z.array(Key).max(IMPORT_LIMITS.skills),
        }),
      )
      .max(IMPORT_LIMITS.agents),
    skills: z.array(z.object({ key: Key, markdown: z.string().max(1_000_000) })).max(IMPORT_LIMITS.skills),
    channels: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(200),
          topic: z.string().max(100_000),
          agents: z.array(z.object({ key: Key, autoReply: z.boolean() })).max(IMPORT_LIMITS.agents),
        }),
      )
      .max(IMPORT_LIMITS.channels),
    routines: z
      .array(
        z.object({
          key: Key,
          name: z.string().max(1000),
          agent: Key,
          prompt: z.string().max(100_000),
          channel: Key.nullable(),
          trigger: z.union([
            z.object({ cron: z.string().max(200), timezone: z.string().max(64).nullable() }),
            z.object({ rule: BundleRule }),
            z.object({ at: z.string().max(40) }),
          ]),
        }),
      )
      .max(IMPORT_LIMITS.routines),
    notes: z
      .array(
        z.object({
          key: Key,
          agent: Key.nullable(),
          kind: z.enum(NOTE_KINDS),
          title: z.string().max(10_000).optional(),
          content: z.string().max(100_000),
        }),
      )
      .max(IMPORT_LIMITS.notes),
    todo: z
      .array(
        z.object({
          kind: z.enum(["connection", "app", "secret", "model", "file"]),
          label: z.string().max(500),
          url: z.string().max(2000).optional(),
          agents: z.array(Key).max(IMPORT_LIMITS.agents),
        }),
      )
      .max(1000),
    leftOut: z.array(z.object({ kind: z.string().max(40), label: z.string().max(500) })).max(100_000),
  })
  .openapi("MigrationBundle");

const ImportPlan = z
  .object({
    items: z.array(
      z.object({
        kind: z.enum(IMPORT_KINDS),
        key: z.string(),
        label: z.string(),
        action: z.enum(["create", "update", "unchanged", "skip"]),
        reason: z
          .enum([
            "exists",
            "model_not_in_catalog",
            "invalid_skill",
            "schedule_unsupported",
            "schedule_in_past",
            "secret_like",
            "agent_not_picked",
            "channel_not_picked",
            "invalid",
            "failed",
            "too_many_routines",
          ])
          .optional()
          .openapi({
            description: "Why it is skipped; on a create or update, a note (default model, channel joined).",
          }),
        trimmed: z.array(z.string()).optional().openapi({ description: "Fields cut to fit our limits." }),
        renamedTo: z.string().optional().openapi({
          description: "The @handle an agent gets when it isn't the bundle's: that one was taken, or is an id.",
        }),
        targetId: z.string().optional(),
      }),
    ),
  })
  .openapi("ImportPlan");

const ImportedFile = z
  .object({
    status: z.enum(["created", "exists"]).openapi({
      description: "`exists`: the folder had a file with that name already, and it stays as it was.",
    }),
    artifactId: z.uuid(),
    title: z.string().openapi({ description: "`<folder>/<path>`." }),
    folder: z.string().openapi({ description: "The agent's folder in the Drive: its name." }),
  })
  .openapi("ImportedFile");

const ImportedSources = z
  .object({
    sources: z.array(
      z.object({
        app: z.string().openapi({ description: "The app it came from (`openbotrun`, `openmausbot`, `agenteschat`…)." }),
        ref: z.string().openapi({ description: "The package or workspace in that app." }),
        counts: z.object({
          agent: z.number().int(),
          skill: z.number().int(),
          channel: z.number().int(),
          routine: z.number().int(),
          note: z.number().int(),
        }),
      }),
    ),
  })
  .openapi("ImportedSources");

/**
 * Bring agents and what's around them from another app (or another
 * agentes.chat): the backend reads the files behind a GitHub link (only
 * github.com and raw.githubusercontent.com over HTTPS, 15 s per request);
 * the web app parses them into a bundle, plans it here and applies the
 * items picked. Admins also download this workspace as a bundle.
 */
export function agentImportRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use(
    "/organizations/:orgId/imports",
    bodyLimit({
      maxSize: IMPORT_LIMITS.bodyBytes,
      onError: (c) => apiError(c, 413, "import.too_large", "The import is too large (max 32 MB)"),
    }),
  );
  app.use(
    "/organizations/:orgId/imports/files",
    bodyLimit({
      maxSize: ARTIFACT_LIMITS.fileBytes + MULTIPART_SLACK_BYTES,
      onError: (c) => {
        const maxMb = ARTIFACT_LIMITS.fileBytes / 1024 / 1024;
        return apiError(c, 413, "artifact.file_too_large", `The file is too large (max ${maxMb} MB)`, { maxMb });
      },
    }),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-imports/github",
      tags,
      security,
      summary: "Read the files behind a GitHub link to import (nothing is saved)",
      description:
        "A file link reads that file. A folder link reads, relative to the folder: its Markdown/JSON/YAML, `agents/` (one level of folders), `skills/` (SKILL.md and other Markdown), `cron/jobs.json` and `memory/*.md` (newest first), up to 200 files and 8 MB (4 MB per file).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            url: z
              .string()
              .max(2000)
              .refine((value) => {
                try {
                  const u = new URL(value);
                  return u.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(u.hostname);
                } catch {
                  return false;
                }
              }, "Only https://github.com or https://raw.githubusercontent.com links"),
          }),
        ),
      },
      responses: { 200: json(ImportedFiles), ...errors },
    }),
    async (c) => {
      const result = await readGithubImport(
        { db: deps.db, fetch: deps.extras?.http, resolveHost: deps.extras?.resolveHost },
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json").url,
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/imports",
      tags,
      security,
      summary: "Plan (dryRun) or apply an import (admins)",
      description: `Every item comes back as create, update (made by an earlier import of this package and changed), unchanged or skip with the reason. Applying never brings chat history; routines arrive active (with their next run) and skills on for the agents that had them. One apply creates or updates at most ${IMPORT_LIMITS.perApply} items (\`import.too_many_items\`): apply a big import in chunks of \`pick\`, in the plan's order; each call is safe to repeat.`,
      request: {
        params: OrgParams,
        body: body(
          z.object({
            bundle: Bundle,
            dryRun: z.boolean(),
            pick: z
              .array(z.string().max(300))
              .max(20_000)
              .optional()
              .openapi({ description: "`kind:key` of the items to apply; default every item." }),
          }),
        ),
      },
      responses: { 200: json(ImportPlan), ...errors, 413: errorResponse("Over 32 MB") },
    }),
    async (c) => {
      const blobs = deps.extras?.artifacts?.blobs;
      if (!blobs) throw new Error("storage is not configured on this server");
      const plan = await applyImport(
        { db: deps.db, blobs, pubsub: deps.adapters.pubsub, connectors: routineConnectorDeps(deps) },
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
        NEW_AGENT_DEFAULTS,
      );
      return c.json(plan, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/imports/files",
      tags,
      security,
      summary: "Copy one of an imported agent's files into its folder in the Drive (admins)",
      description:
        "The file lands as `<agent's name>/<path>`, keeping the source's folders, made by the agent and seen by the whole workspace. A name the folder already has is never overwritten (`exists`). Files with keys or sign-ins are refused (`import.secret_file`). The Drive's limits apply: 50 MB a file, the workspace's storage and daily uploads (409).",
      request: {
        params: OrgParams,
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.any().openapi({ type: "string", format: "binary", description: "The file (≤ 50 MB)." }),
                agentId: z.uuid(),
                path: z.string().min(1).max(1000).openapi({ description: "Where it goes in the agent's folder." }),
                note: z.string().max(500).optional().openapi({ description: "For its first version." }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(ImportedFile, "Already there: it stays as it was"),
        201: json(ImportedFile, "Copied"),
        413: errorResponse("The file is too large"),
        ...errors,
      },
    }),
    async (c) => {
      const artifacts = deps.extras?.artifacts;
      if (!artifacts) throw new Error("storage is not configured on this server");
      const form = c.req.valid("form");
      if (!(form.file instanceof File)) {
        throw new ValidationError("send the file in the field file", "artifact.file_required");
      }
      const copied = await copyImportedFile(artifacts, c.get("user").id, c.req.valid("param").orgId, {
        agentId: form.agentId,
        path: form.path,
        name: form.file.name,
        bytes: new Uint8Array(await form.file.arrayBuffer()),
        contentType: form.file.type || null,
        note: form.note ?? null,
      });
      return c.json(copied, copied.status === "created" ? 201 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/imports",
      tags,
      security,
      summary: "What this workspace brought from other apps (admins)",
      description:
        "One entry per source package, in the order they first came, with how many of each kind came. A channel that was here already isn't counted.",
      request: { params: OrgParams },
      responses: { 200: json(ImportedSources), ...errors },
    }),
    async (c) => {
      const sources = await importedSources(deps.db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ sources }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/export",
      tags,
      security,
      summary: "Download this workspace as an import bundle (admins)",
      description:
        "Agents, skills (SKILL.md), public channels with their agents, scheduled routines and the memory everyone can see. Never keys, connections, computers, runs, usage, audit or messages.",
      request: { params: OrgParams },
      responses: { 200: json(Bundle), ...errors },
    }),
    async (c) => {
      const bundle = await exportBundle(deps.db, c.get("user").id, c.req.valid("param").orgId);
      const day = new Date().toISOString().slice(0, 10);
      return c.json(bundle, 200, { "content-disposition": attachmentDisposition(`agentes-chat-${day}.json`) });
    },
  );

  return app;
}
