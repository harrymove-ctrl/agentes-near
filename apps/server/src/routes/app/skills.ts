import { connectorOAuthApps } from "@agenteschat/config";
import {
  agentMadeSkills,
  agentSkillList,
  approveSkillUpdate,
  deleteSkill,
  dismissSkillUpdate,
  getSkill,
  getSkillFile,
  getSkillSettings,
  importPickedSkills,
  importSkillFromUrl,
  importSkillZip,
  listSkills,
  parseSkillMarkdown,
  reopenSkillUpdate,
  restoreSkill,
  revertSkillChange,
  SKILL_LIMITS,
  type SkillDeps,
  saveSkill,
  setAgentSkills,
  setSkillAgentsImprove,
  setSkillAutoUpdate,
  setSkillLocked,
  setSkillSettings,
  undoSkillUpdate,
  updateSkill,
  updateSkillFromSource,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { githubAppOf } from "../github-app";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Skills"];
const Skill = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    version: z.number(),
    source: z.string().openapi({ description: "`upload`, `url` or `manual`." }),
    sourceUrl: z.string().nullable(),
    sourceVia: z.enum(["github_app", "github"]).nullable().openapi({
      description:
        "Which of the workspace's GitHub connections read its private repository (the GitHub App, or the GitHub connector): updating reads through it first, then through the other, and keeps the one that read it. Null: read with no credentials.",
    }),
    defaultForNewAgents: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
    origin: z.enum(["person", "agent"]).openapi({ description: "`agent`: promoted from an agent's how-tos." }),
    ownerAgentId: z
      .uuid()
      .nullable()
      .openapi({ description: "An agent-made skill's agent (the only one that changes it)." }),
    locked: z.boolean().openapi({ description: "Agents can't change it; never archived for disuse." }),
    useCount: z.number(),
    lastUsedAt: z.string().nullable(),
    autoUpdate: z.boolean().openapi({ description: "Read from its link every day and updated from it." }),
    checkedAt: z.string().nullable().openapi({ description: "When its link was last read to update it." }),
    pendingUpdate: z
      .object({
        scripts: z.array(z.string()),
        at: z.string(),
        dismissed: z.boolean(),
        dismissedAt: z.string().nullable().openapi({ description: "When a person kept the skill as it is." }),
        edited: z.boolean(),
      })
      .nullable()
      .openapi({
        description:
          "An update from its link waiting for who manages skills: it adds or changes files that run (`scripts`), or it would replace what agents changed since (`edited`); `dismissed`: kept out (`…/update/reopen` makes it wait again).",
      }),
    updateError: z
      .string()
      .nullable()
      .openapi({ description: "Why its last update from its link failed: a stable code the app translates." }),
    lastUpdate: z
      .object({
        fromVersion: z.number(),
        at: z.string(),
        agentId: z.uuid().nullable().openapi({ description: "The agent that changed it; null: its link." }),
        waited: z.boolean().openapi({
          description: "A person chose this update while it waited: undoing it makes it wait again.",
        }),
      })
      .nullable()
      .openapi({
        description: "Its last update from its link, or an agent's last change to it, while it can be undone.",
      }),
    agentsImprove: z.boolean().nullable().openapi({
      description:
        "Agents change it at once when they fix it (a new version, with undo) instead of proposing; files that run always wait. Null: the workspace's setting.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Skill");
const SkillDetail = Skill.extend({
  body: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number(),
      mime: z.string(),
      status: z.enum(["stored", "script", "ignored"]).openapi({
        description:
          "`stored`: kept, agents can read it (text, an image they see, other files on their computer); `script`: runs only on the agent's computer, never shown; `ignored`: listed only (past the 20 MB a skill keeps for files that aren't text, or installed before such files were kept).",
      }),
    }),
  ),
  pending: z
    .object({
      body: z.string(),
      description: z.string(),
      base: z
        .object({ body: z.string(), description: z.string(), at: z.string() })
        .nullable()
        .openapi({ description: "What its link last wrote before agents changed it; null: not known." }),
      files: z.array(
        z.object({
          path: z.string(),
          before: z.string().nullable().openapi({ description: "Null: a new file, or `large`." }),
          after: z.string().nullable(),
          large: z.boolean().openapi({ description: "Past what the page shows: only its name." }),
        }),
      ),
    })
    .nullable()
    .openapi({ description: "The waiting update's content: its text and its files that run, as its link has them." }),
  changes: z
    .array(
      z.object({
        id: z.uuid(),
        agentId: z.uuid(),
        at: z.string(),
        before: z.string(),
        after: z.string(),
        undone: z.boolean(),
      }),
    )
    .openapi({ description: "The agents' changes to its text, newest first (the last 20)." }),
}).openapi("SkillDetail");
const SkillChoice = z
  .object({
    path: z.string().openapi({ description: "The skill's folder from the repository's root: what `paths` sends." }),
    name: z.string(),
    description: z.string(),
    replaces: z.enum(["installed", "removed"]).optional().openapi({
      description:
        "A skill of this name is installed (this becomes a new version of it, for every agent that has it) or was removed (it comes back on for none of its old agents).",
    }),
  })
  .openapi("SkillChoice");
const SkillSkipped = z
  .object({
    path: z.string(),
    code: z.string().openapi({ description: "Why it can't be installed: stable, the app translates it." }),
    message: z.string().openapi({ description: "English fallback." }),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SkillSkipped");
const SkillParams = OrgParams.extend({ skillId: z.uuid() });
const SkillListItem = Skill.extend({
  agentsCount: z.number().openapi({ description: "Active agents with this skill turned on." }),
}).openapi("SkillListItem");

/** Reading a link downloads the repository's archive (up to 50 MB): to list its skills, install or update one. */
const LINK_READS = { limit: 60, windowMs: 3600_000 };

/**
 * Skills in Markdown (`SKILL.md`, ADR 0020): install by zip, GitHub URL or by
 * hand (admins, `manage_agents`), and turn them on per agent. No code runs:
 * scripts are listed as ignored.
 */
export function skillRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // Private repositories are read with the workspace's GitHub: the GitHub App's token for the repository, else the
  // GitHub connection's. Tokens stay here.
  const github = {
    connectors: {
      db,
      keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers],
      oauthApps: connectorOAuthApps(deps.config),
      publicUrl: deps.config.PUBLIC_URL,
      http: deps.extras?.http,
    },
    get app() {
      return githubAppOf(deps);
    },
  };
  const skills = (): SkillDeps => {
    const blobs = deps.extras?.artifacts?.blobs;
    if (!blobs) throw new Error("storage is not configured on this server");
    return {
      db,
      blobs,
      fetch: deps.extras?.http,
      resolveHost: deps.extras?.resolveHost,
      github,
      pubsub: deps.adapters.pubsub,
    };
  };
  const linkReadAllowed = async (userId: string) =>
    (await deps.adapters.rateLimiter.consume(`skill-link:${userId}`, LINK_READS)).allowed;
  const tooManyReads = "Too many skill links read. Try again later.";

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills",
      tags,
      security,
      summary: "The organization's skills",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ skills: z.array(SkillListItem) })), ...errors },
    }),
    async (c) => c.json({ skills: await listSkills(db, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );

  const SkillSettings = z
    .object({
      agentsImprove: z.boolean().openapi({
        description:
          "Agentes melhoram as skills sozinhos: an agent's fix to a skill a person made applies at once (a new version, with undo, its author told) instead of waiting as a proposal. Files that run always wait for a person, and so does a fix after the agent read outside content.",
      }),
    })
    .openapi("SkillSettings");
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skill-settings",
      tags,
      security,
      summary: "The workspace's skill settings",
      request: { params: OrgParams },
      responses: { 200: json(SkillSettings), ...errors },
    }),
    async (c) => c.json(await getSkillSettings(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/skill-settings",
      tags,
      security,
      summary: "Change the workspace's skill settings (who manages agents)",
      request: { params: OrgParams, body: body(SkillSettings) },
      responses: { 200: json(SkillSettings), ...errors },
    }),
    async (c) =>
      c.json(await setSkillSettings(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills",
      tags,
      security,
      summary: "Create a skill by hand: a SKILL.md text, or name + description + body",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({ markdown: z.string().max(250_000), defaultForNewAgents: z.boolean().optional() }),
            z.object({
              name: z.string().max(64),
              description: z.string().max(1024),
              body: z.string().max(200_000),
              defaultForNewAgents: z.boolean().optional(),
            }),
          ]),
        ),
      },
      responses: { 201: json(SkillDetail, "Created"), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const parsed =
        "markdown" in input
          ? parseSkillMarkdown(input.markdown)
          : { name: input.name.trim(), description: input.description.trim(), body: input.body, metadata: {} };
      const saved = await saveSkill(skills(), c.get("user").id, c.req.valid("param").orgId, {
        ...parsed,
        source: "manual",
        defaultForNewAgents: input.defaultForNewAgents,
      });
      return c.json(saved, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/import",
      tags,
      security,
      summary:
        "Import a skill: a GitHub link (a skill's folder or a file in it, or a folder holding several to pick from) or a zip of the folder (base64)",
      description:
        "A private repository (github.com answers 404) is read through the workspace's GitHub: the GitHub App's token for it, else the GitHub connection's, never sent to the app. `github.repo_missing` says in `connection` how the GitHub connection fared (`none`; `refused`: GitHub no longer takes its token; `ok`: it works and can't see the repository) and in `app` whether the GitHub App is installed on some account for the workspace. `github.unreachable`: GitHub didn't answer, try again.",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({
              url: z.string().url().max(500),
              paths: z
                .array(z.string().max(500))
                .min(1)
                .max(100)
                .optional()
                .openapi({ description: "The skills picked among the link's `choices` (their `path`)." }),
              list: z.boolean().optional().openapi({
                description: "Answer with the skills the link holds to pick, even one, installing none.",
              }),
              forAgentId: z.uuid().optional().openapi({
                description:
                  "The agent whose card (`offer_install_skill`) opened the install: what installs goes on for it when the installer may change its skills, else the install stands alone.",
              }),
            }),
            z.object({
              zipBase64: z
                .string()
                // Base64 of a zip holding all a skill keeps (text and scripts, plus its images and other files).
                .max(Math.ceil(((SKILL_LIMITS.maxBytes + SKILL_LIMITS.assetBytes) * 4) / 3) + 1_000_000)
                .openapi({
                  description: `The skill folder as a zip, base64 (≤ ${SKILL_LIMITS.maxBytes / 1024 / 1024} MB of text and scripts and ${SKILL_LIMITS.assetBytes / 1024 / 1024} MB of other files unzipped).`,
                }),
            }),
          ]),
        ),
      },
      responses: {
        200: json(
          z.object({
            choices: z.array(SkillChoice),
            skipped: z.array(SkillSkipped).optional(),
            via: z.enum(["github_app", "github"]).optional(),
          }),
          "The link holds several skills (or `list`): nothing installed, send the ones picked in `paths`. `skipped`: those that can't be installed, with why. `via`: which of the workspace's GitHub connections read it",
        ),
        201: json(
          z.union([SkillDetail, z.object({ skills: z.array(SkillDetail) })]),
          "Created: the skill, or `{ skills }` for `paths`",
        ),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const actor = c.get("user").id;
      if ("url" in input) {
        if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
        const forAgentId = input.forAgentId;
        if (input.paths) {
          const installed = await importPickedSkills(skills(), actor, orgId, input.url, input.paths, { forAgentId });
          return c.json({ skills: installed }, 201);
        }
        const result = await importSkillFromUrl(skills(), actor, orgId, input.url, { list: input.list, forAgentId });
        return "choices" in result ? c.json(result, 200) : c.json(result, 201);
      }
      let zip: Uint8Array;
      try {
        zip = new Uint8Array(Buffer.from(input.zipBase64, "base64"));
      } catch {
        throw new ValidationError("zipBase64 is not valid base64");
      }
      return c.json(await importSkillZip(skills(), actor, orgId, zip), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "A skill with its body and files",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await getSkill(db, c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/skills/{skillId}/files/{path}",
      tags,
      security,
      summary: "A stored text file of the skill (scripts and binaries are ignored: 404)",
      request: {
        params: SkillParams.extend({
          path: z
            .string()
            .min(1)
            .max(300)
            .openapi({ description: "The file's path inside the skill, URL-encoded (`templates%2Frelatorio.md`)." }),
        }),
        query: z.object({
          version: z.coerce.number().int().min(1).optional().openapi({ description: "Default: the current one." }),
        }),
      },
      responses: {
        200: json(z.object({ path: z.string(), version: z.number(), mime: z.string(), content: z.string() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId, path } = c.req.valid("param");
      const { version } = c.req.valid("query");
      return c.json(await getSkillFile(skills(), c.get("user").id, orgId, skillId, path, version), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "Edit a skill (a new version), or toggle 'default for new agents'",
      request: {
        params: SkillParams,
        body: body(
          z.object({
            description: z.string().max(1024).optional(),
            body: z.string().max(200_000).optional(),
            defaultForNewAgents: z.boolean().optional(),
            locked: z.boolean().optional().openapi({ description: "Freeze it: agents can't change it." }),
            autoUpdate: z
              .boolean()
              .optional()
              .openapi({ description: "Update it from its link every day, with the rights of whoever turns it on." }),
            agentsImprove: z
              .boolean()
              .nullable()
              .optional()
              .openapi({ description: "Agents improve it by themselves (null: as the workspace says)." }),
          }),
        ),
      },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const { locked, autoUpdate, agentsImprove, ...rest } = c.req.valid("json");
      const actor = c.get("user").id;
      let detail: Awaited<ReturnType<typeof getSkill>> | undefined;
      if (locked !== undefined) detail = await setSkillLocked(db, actor, orgId, skillId, locked);
      if (autoUpdate !== undefined) detail = await setSkillAutoUpdate(db, actor, orgId, skillId, autoUpdate);
      if (agentsImprove !== undefined) detail = await setSkillAgentsImprove(db, actor, orgId, skillId, agentsImprove);
      if (detail && Object.values(rest).every((v) => v === undefined)) return c.json(detail, 200);
      return c.json(await updateSkill(skills(), actor, orgId, skillId, rest), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/restore",
      tags,
      security,
      summary: "Bring back a skill archived for disuse (or deleted), with its agents' assignments",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await restoreSkill(db, c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/revert",
      tags,
      security,
      summary: "Undo an agent's last change to its own skill (its owner or admins)",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      await revertSkillChange(db, actor, orgId, skillId);
      return c.json(await getSkill(db, actor, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/reimport",
      tags,
      security,
      summary: "Import again from its URL (a new version); files that run wait for approval, as `…/update`",
      request: { params: SkillParams },
      responses: {
        200: json(SkillDetail),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
      // Apps released before `…/update` still call this: the same gate on files that run.
      return c.json((await updateSkillFromSource(skills(), actor, orgId, skillId)).skill, 200);
    },
  );

  const SourceUpdate = z
    .object({
      status: z.enum(["unchanged", "updated", "waiting"]).openapi({
        description:
          "`waiting`: it adds or changes files that run, so it waits for `…/update/approve` (or `…/update/dismiss`).",
      }),
      skill: SkillDetail,
      scripts: z.array(z.string()).optional().openapi({ description: "`waiting`: the files that run it changes." }),
    })
    .openapi("SkillSourceUpdate");
  const sourceUpdate = (r: Awaited<ReturnType<typeof updateSkillFromSource>>) => ({
    status: r.status,
    skill: r.skill,
    ...(r.status === "waiting" ? { scripts: r.scripts } : {}),
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/update",
      tags,
      security,
      summary: "Update it from its link: new text applies (undoable); files that run wait for approval",
      request: { params: SkillParams },
      responses: {
        200: json(SourceUpdate),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
      return c.json(sourceUpdate(await updateSkillFromSource(skills(), actor, orgId, skillId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/update/approve",
      tags,
      security,
      summary: "Apply the waiting update as it was shown (if its link changed since, it waits again)",
      request: { params: SkillParams },
      responses: {
        200: json(SourceUpdate),
        429: errorResponse("Too many links read, or GitHub limiting this server"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (!(await linkReadAllowed(actor))) return apiError(c, 429, "rate_limited", tooManyReads);
      return c.json(sourceUpdate(await approveSkillUpdate(skills(), actor, orgId, skillId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/update/dismiss",
      tags,
      security,
      summary: "Refuse the waiting update (the same content isn't raised again)",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await dismissSkillUpdate(skills(), c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/update/reopen",
      tags,
      security,
      summary: "Undo keeping the skill as it is: the update it kept out waits again",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await reopenSkillUpdate(skills(), c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/skills/{skillId}/update/undo",
      tags,
      security,
      summary: "Back to the version before its last update from its link",
      request: { params: SkillParams },
      responses: { 200: json(SkillDetail), ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      return c.json(await undoSkillUpdate(skills(), c.get("user").id, orgId, skillId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/skills/{skillId}",
      tags,
      security,
      summary: "Delete a skill (agents lose it; installing the same name again brings it back with its assignments)",
      request: { params: SkillParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, skillId } = c.req.valid("param");
      await deleteSkill(db, c.get("user").id, orgId, skillId);
      return c.body(null, 204);
    },
  );

  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  const AgentSkill = Skill.extend({ enabled: z.boolean() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/learned-skills",
      tags,
      security,
      summary: "Skills the agent made from its own how-tos, archived ones too, newest first",
      request: { params: AgentParams },
      responses: {
        200: json(
          z.object({
            skills: z.array(
              Skill.extend({
                body: z.string(),
                archived: z.boolean(),
                canChange: z.boolean().openapi({ description: "The viewer may lock it and undo its changes." }),
                canRevert: z.boolean().openapi({ description: "It has a change of its own to undo." }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ skills: await agentMadeSkills(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/skills",
      tags,
      security,
      summary: "The org's skills with whether this agent has each one on",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ skills: z.array(AgentSkill) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ skills: await agentSkillList(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/skills",
      tags,
      security,
      summary: "Turn skills on or off for an agent (admins or its owner)",
      request: {
        params: AgentParams,
        body: body(z.object({ skills: z.array(z.object({ skillId: z.uuid(), enabled: z.boolean() })).max(500) })),
      },
      responses: { 200: json(z.object({ skills: z.array(AgentSkill) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const list = await setAgentSkills(db, c.get("user").id, orgId, agentId, c.req.valid("json").skills);
      return c.json({ skills: list }, 200);
    },
  );

  return app;
}
