import { and, asc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import {
  isWidgetFormat,
  isWidgetSchedule,
  isWidgetSize,
  validateWidgetSpec,
  WIDGET_FORMATS,
  WIDGET_KINDS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  type WidgetFormat,
  type WidgetSchedule,
  type WidgetSpec,
} from "@agenteschat/ui/widgets/spec";
import { getAgent } from "../agents";
import { canTalkTo, speakerOf } from "../audience";
import { accountablePerson, runAuthorityById } from "../authority";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { getMembership } from "../organizations";
import { routineBriefOf } from "../routine-brief";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { dashboardRights, dashboardSeerSql, viewerOf } from "./access";
import { proposeDashboardAudience } from "./proposals";
import { applyWidgetUpdate, UPDATE_WIDGET_TOOL } from "./refresh";
import { WIDGET_KIND_MANUAL } from "./refresh-context";
import {
  ensureHomeBoard,
  insertDashboard,
  insertWidget,
  setDashboardAudience,
  setDashboardEditors,
  widensDashboardAudience,
} from "./service";
import {
  type AgentMaker,
  DASHBOARD_ABOUT_MAX,
  DASHBOARD_TITLE_MAX,
  type DashboardAudience,
  type DashboardDeps,
  type DashboardEditPolicy,
  type DashboardRow,
  WIDGET_AGENT_TITLE_MAX,
  WIDGET_ALERT_CONDITION_MAX,
  WIDGET_PROMPT_MAX,
} from "./types";

const { dashboards, dashboardWidgets, messages, orgRoles, users, agents } = schema;

/**
 * Agents' dashboard tools (ADR 0135 §10, §11), built in for every agent (no scope): boards and widgets for the person
 * behind the run, private until that person widens them. Every widening an agent asks for (a wider audience on
 * `create_dashboard` or `share_dashboard`, any from a routine's or unattended run) is a request on the board that
 * waits on its person (`proposeDashboardAudience`); narrowing applies at once. A widget's refresh run lists only
 * `update_widget`, its one way to speak.
 *
 * - `list_dashboards`: the boards the person behind the run edits (and their home), with their widgets' titles.
 * - `create_dashboard` `{ title, about?, audience?, roles?, why?, edit?, edit_roles? }`: a board for the person behind
 *   the run (else the accountable person), private; a wider `audience` becomes a proposal to them.
 * - `create_widget` `{ dashboard_id?, title, prompt, kind?, schedule, alert?, size?, data?, sources? }`: on a board
 *   that person edits (default: their home); `data` (a `WidgetSpec`) shows at once, else the first build is queued.
 * - `share_dashboard` `{ dashboard_id, audience?, roles?, why?, edit?, edit_roles? }`: narrower applies (on a board
 *   the agent made or the person manages), wider is a proposal; a routine's or unattended run only ever proposes.
 *   Who edits (`edit`, `edit_roles`) applies at once: editing isn't seeing (ADR 0135 §8).
 * - `update_widget` `{ data?, summary, sources?, title?, prompt?, alert?, failed? }`: listed only on a widget's refresh
 *   run (its brief's `widget`), once per run.
 */

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const failed = (error: unknown): ToolOutput => ({
  content: `Not done: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const refusal = (content: string): ToolOutput => ({ content, isError: true });

/** Errors the engine explains in words the agent can act on (the rest are bugs and propagate). */
const explained = (error: unknown) =>
  error instanceof ValidationError ||
  error instanceof ForbiddenError ||
  error instanceof NotFoundError ||
  error instanceof ConflictError;

const AUDIENCES = ["private", "workspace", "roles"] as const;
const EDITS = ["owner", "viewers", "roles"] as const satisfies readonly DashboardEditPolicy[];
const editPolicyIn = (v: unknown): DashboardEditPolicy | null =>
  (EDITS as readonly string[]).includes(str(v)) ? (str(v) as DashboardEditPolicy) : null;

/** Who stands behind the run: the person it works for (ADR 0053 §1), else who answers for it, and the agent. */
async function makerOf(ctx: ToolContext): Promise<{ maker: AgentMaker; routine: boolean }> {
  const authority = await runAuthorityById(ctx.db, ctx.orgId, ctx.runId);
  const personId = authority.kind === "person" ? authority.personId : null;
  let accountable = accountablePerson(authority);
  if (!accountable) {
    const [a] = await ctx.db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, ctx.agentId));
    accountable = a?.owner ?? null;
  }
  return {
    maker: { agentId: ctx.agentId, runId: ctx.runId, personId, accountableUserId: accountable },
    routine: authority.kind !== "person",
  };
}

/** The person boards are made for, as a member (null: nobody to make them for). */
async function personOf(ctx: ToolContext, maker: AgentMaker) {
  const userId = maker.accountableUserId;
  if (!userId) return null;
  const membership = await getMembership(ctx.db, userId, ctx.orgId);
  if (!membership) return null;
  const [u] = await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return { userId, name: u?.name ?? "the person", membership, viewer: viewerOf(membership, userId) };
}

type Person = NonNullable<Awaited<ReturnType<typeof personOf>>>;

const NOBODY =
  "Nobody is behind this run to make a dashboard for (no person asked, and your work has no owner). Don't make one.";

/** Who sees a board, in words for the agent. */
function audienceWords(board: Pick<DashboardRow, "kind" | "audience">, roleNames: string[], owner: string) {
  if (board.kind === "home" || board.audience === "private") return `only ${owner}`;
  if (board.audience === "workspace") return "the whole workspace";
  return roleNames.length > 0 ? `people with the role ${roleNames.join(", ")}` : `only ${owner} (its roles are gone)`;
}

/** Who edits a board, in words for the agent. */
function editWords(edit: DashboardEditPolicy, roleNames: string[], owner: string) {
  if (edit === "viewers") return "whoever sees it";
  if (edit === "roles" && roleNames.length > 0) {
    return `${owner}, admins and people with the role ${roleNames.join(", ")} who see it`;
  }
  return `only ${owner} and admins`;
}

const editSchema = {
  edit: {
    type: "string",
    enum: [...EDITS],
    description:
      "Who may change its widgets: owner (default: the person and admins), viewers (whoever sees it) or roles (people with `edit_roles` who also see it, besides the person and admins)",
  },
  edit_roles: {
    type: "array",
    items: { type: "string", maxLength: 100 },
    maxItems: 20,
    description: "Role names that edit it, with edit: roles",
  },
};

/** The workspace's custom roles by name (case and spaces ignored), and the names nobody holds. */
async function rolesByName(ctx: ToolContext, names: string[]) {
  const all = await ctx.db
    .select({ id: orgRoles.id, name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, ctx.orgId), eq(orgRoles.kind, "custom")));
  const key = (s: string) => s.replace(/^@/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const name of names) {
    const role = all.find((r) => key(r.name) === key(name));
    if (role) found.set(role.id, role.name);
    else if (name.trim()) missing.push(name.trim());
  }
  return { ids: [...found.keys()], names: [...found.values()], missing, known: all.map((r) => r.name) };
}

async function roleNamesOf(ctx: ToolContext, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({ name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, ctx.orgId), inArray(orgRoles.id, [...ids])));
  return rows.map((r) => r.name);
}

/** A board of the workspace, not deleted. */
async function boardById(ctx: ToolContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [board] = await ctx.db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.orgId, ctx.orgId), eq(dashboards.id, id), isNull(dashboards.deletedAt)));
  return board ?? null;
}

/** A board the agent may put widgets on for `person`: one they edit, or one this agent made for them. */
const mayEdit = (board: DashboardRow, person: Person, agentId: string) =>
  dashboardRights(board, person.viewer).edit || (board.ownerAgentId === agentId && board.ownerUserId === person.userId);

/** A board whose audience the agent may change for `person`: one it made for them, or one they manage. */
const mayShare = (board: DashboardRow, person: Person, agentId: string) =>
  (board.ownerAgentId === agentId && board.ownerUserId === person.userId) ||
  dashboardRights(board, person.viewer).manage;

/** The brief of a background run's trigger, when the run is a routine's (`meta.routineBrief`). */
async function briefOf(ctx: ToolContext) {
  if (!ctx.background) return null;
  const [m] = await ctx.db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, ctx.orgId), eq(messages.id, ctx.triggerMessageId)));
  return routineBriefOf(m?.meta);
}

const SCHEDULE_WORDS: Record<WidgetSchedule, string> = {
  half: "every 30 minutes",
  hour: "every hour",
  day: "every day at 08:00",
  week: "every Monday at 08:00",
  manual: "only when someone asks",
};

export function createDashboardToolSource(deps: DashboardDeps): ToolSource {
  const depsOf = (ctx: ToolContext): DashboardDeps => ({ ...deps, db: ctx.db });
  const dataSchema = {
    type: "object",
    description: `The widget's data now, when you already have it (it shows at once, no build run). One of:\n${WIDGET_KIND_MANUAL}`,
    properties: { kind: { type: "string", enum: [...WIDGET_KINDS] } },
    required: ["kind"],
  };

  const listDashboards: ToolDefinition = {
    name: "list_dashboards",
    description:
      "List the dashboards (in Portuguese, painéis) the person you work for can add widgets to, and their Home, with who sees each one and its widgets. Use it before create_widget when they name a dashboard, or to answer what's on them. Read only.",
    scope: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
      const { maker, routine } = await makerOf(ctx);
      const person = await personOf(ctx, maker);
      if (!person) return refusal(NOBODY);
      const rows = await ctx.db
        .select()
        .from(dashboards)
        .where(and(eq(dashboards.orgId, ctx.orgId), dashboardSeerSql("dashboards", person.userId, person.viewer.admin)))
        .orderBy(sql`${dashboards.pinned} desc`, asc(dashboards.position), asc(dashboards.title));
      // With nobody behind the run, what it says may reach a conversation that person isn't alone in: only the
      // workspace's boards and the ones this agent made are named (ADR 0135 §8).
      const named = (b: DashboardRow) => !routine || b.audience === "workspace" || b.ownerAgentId === ctx.agentId;
      const editable = rows.filter((b) => named(b) && mayEdit(b, person, ctx.agentId));
      const ids = editable.map((b) => b.id);
      const widgets =
        ids.length === 0
          ? []
          : await ctx.db
              .select({
                dashboardId: dashboardWidgets.dashboardId,
                title: dashboardWidgets.title,
                schedule: dashboardWidgets.schedule,
                status: dashboardWidgets.status,
              })
              .from(dashboardWidgets)
              // A person's draft (a test not created yet) is on no board (ADR 0135 §16).
              .where(
                and(
                  eq(dashboardWidgets.orgId, ctx.orgId),
                  inArray(dashboardWidgets.dashboardId, ids),
                  eq(dashboardWidgets.draft, false),
                ),
              )
              .orderBy(asc(dashboardWidgets.position));
      const lines: string[] = [];
      for (const b of editable) {
        const own = widgets.filter((w) => w.dashboardId === b.id);
        const name = b.kind === "home" ? `${person.name}'s Home` : `«${b.title}»`;
        const who = audienceWords(b, await roleNamesOf(ctx, b.audienceRoleIds), person.name);
        const edit = b.kind === "home" ? null : editPolicyIn(b.editPolicy);
        const editors =
          edit && edit !== "owner"
            ? `, edited by ${editWords(edit, await roleNamesOf(ctx, b.editRoleIds), person.name)}`
            : "";
        const pending = b.proposal ? `; waiting on ${person.name} to publish it wider` : "";
        const each = own.map((w) => {
          const when = SCHEDULE_WORDS[w.schedule as WidgetSchedule] ?? w.schedule;
          return `${w.title} (${when}${w.status === "failed" ? ", failing" : ""})`;
        });
        const list = own.length === 0 ? "no widgets yet" : `${own.length} widgets: ${each.join("; ")}`;
        lines.push(`${b.id} — ${name}: seen by ${who}${editors}${pending}; ${list}`);
      }
      if (!routine && !editable.some((b) => b.kind === "home")) {
        lines.push(`(${person.name}'s Home has no widgets yet: create_widget without dashboard_id puts one there.)`);
      }
      return { content: lines.length > 0 ? lines.join("\n") : `${person.name} has no dashboards yet.` };
    },
  };

  const createDashboard: ToolDefinition = {
    name: "create_dashboard",
    description:
      'Create a dashboard (in Portuguese, painel): a board of widgets that you keep up to date, when someone asks for "a dashboard", "um painel", "a page with our numbers", or for several numbers or charts kept together. It is made for the person you work for and only they see it at first. If they want others to see it, set `audience` (`workspace` or `roles` with `roles` names) and `why`: that is never applied by you, it waits for the person to press Publish (or Keep only for me) in Waiting on you. Then add each number or chart with create_widget (its `dashboard_id`), and tell the person it\'s ready and where.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: DASHBOARD_TITLE_MAX },
        about: { type: "string", maxLength: DASHBOARD_ABOUT_MAX },
        audience: {
          type: "string",
          enum: [...AUDIENCES],
          description: "Who should see it: private (default, only the person), workspace, or roles",
        },
        roles: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 20, description: "Role names" },
        why: { type: "string", maxLength: 500, description: "Why others should see it (shown to the person)" },
        ...editSchema,
      },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const { maker } = await makerOf(ctx);
        const person = await personOf(ctx, maker);
        if (!person) return refusal(NOBODY);
        const wantedEdit = editPolicyIn(input.edit) ?? "owner";
        const editors = wantedEdit === "roles" ? await rolesByName(ctx, strings(input.edit_roles)) : null;
        // No role matched: the board starts edited by the person and admins, and the agent hears why.
        const edit: DashboardEditPolicy = editors && editors.ids.length === 0 ? "owner" : wantedEdit;
        const board = await insertDashboard(depsOf(ctx), ctx.orgId, maker, {
          title: str(input.title),
          about: str(input.about),
          editPolicy: edit,
          editRoleIds: editors?.ids ?? [],
        });
        const editNote =
          editors && editors.ids.length === 0
            ? ` Only ${person.name} and admins edit it: no role matched ${strings(input.edit_roles).join(", ") || "(none given)"} (the workspace's roles: ${editors.known.join(", ") || "none"}); use share_dashboard with one of them.`
            : edit === "owner"
              ? ""
              : ` It is edited by ${editWords(edit, editors?.names ?? [], person.name)}.`;
        const audience = (AUDIENCES as readonly string[]).includes(str(input.audience))
          ? (str(input.audience) as DashboardAudience)
          : "private";
        let widened = "";
        if (audience !== "private") {
          const roles = audience === "roles" ? await rolesByName(ctx, strings(input.roles)) : null;
          if (roles && roles.ids.length === 0) {
            widened = ` It stays private: no role matched ${strings(input.roles).join(", ") || "(none given)"} (the workspace's roles: ${roles.known.join(", ") || "none"}); use share_dashboard with one of them.`;
          } else {
            await proposeDashboardAudience(depsOf(ctx), {
              orgId: ctx.orgId,
              dashboardId: board.id,
              agentId: ctx.agentId,
              runId: ctx.runId,
              audience,
              roleIds: roles?.ids ?? [],
              why: str(input.why),
            });
            const to = audience === "workspace" ? "the whole workspace" : `people with ${roles?.names.join(", ")}`;
            widened = ` You asked to show it to ${to}: that waits on ${person.name}, who publishes it or keeps it to themselves from Waiting on you. Don't ask again; tell them it's there.`;
          }
        }
        return {
          content: `Created dashboard ${board.id} «${board.title}»: only ${person.name} sees it for now.${widened}${editNote} Now add its widgets with create_widget (dashboard_id ${board.id}): one per number, chart or list they want. Then tell ${person.name} it's ready, in the Dashboards page.`,
          data: { dashboard: { id: board.id } },
        };
      } catch (error) {
        if (explained(error)) return failed(error);
        throw error;
      }
    },
  };

  const createWidget: ToolDefinition = {
    name: "create_widget",
    description: `Add a widget: one number, goal, chart, list or short summary that you keep up to date on a dashboard (or the person's Home), redone in place on a schedule by your own background run, which posts nothing in the chat. Use it when someone asks to "keep this updated", "pin this chart", "put it on my Home", "add to the dashboard", "acompanhar", "fixar", or for a number they want to look at every day. \`prompt\` is what to show, in their words (it is your instructions on every update). \`schedule\`: half (every 30 min, the most often), hour, day (08:00), week (Monday 08:00) or manual (only when asked). \`alert\`: a condition in their words ("drops 20% below yesterday"; "" = when something is off) when they want to hear it: you judge it on each update and it goes to their Waiting on you, never the chat. Give \`data\` when you already have the numbers (it shows at once), else your first update builds it soon. Without \`dashboard_id\` it goes on their Home.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: { type: "string", maxLength: 36 },
        title: {
          type: "string",
          minLength: 1,
          maxLength: WIDGET_AGENT_TITLE_MAX,
          description: "A short name: sentence case, in their language, no period at the end, never the ask itself",
        },
        prompt: { type: "string", minLength: 1, maxLength: WIDGET_PROMPT_MAX },
        kind: {
          type: "string",
          enum: [...WIDGET_FORMATS],
          description: "auto (default: you pick on each first build) or the kind they asked for",
        },
        schedule: { type: "string", enum: [...WIDGET_SCHEDULES] },
        alert: { type: "string", maxLength: WIDGET_ALERT_CONDITION_MAX },
        size: { type: "string", enum: [...WIDGET_SIZES], description: "s (1×1), m (2×1) or l (2×2)" },
        data: dataSchema,
        sources: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
      },
      required: ["title", "prompt", "schedule"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const { maker } = await makerOf(ctx);
        const person = await personOf(ctx, maker);
        if (!person) return refusal(NOBODY);
        const named = str(input.dashboard_id).trim();
        let board: DashboardRow | null = null;
        if (named) {
          board = await boardById(ctx, named);
          if (!board || !mayEdit(board, person, ctx.agentId)) {
            return refusal(`No dashboard ${named} that ${person.name} can add widgets to: use list_dashboards.`);
          }
        } else {
          board = await ensureHomeBoard(depsOf(ctx), ctx.orgId, person.userId);
        }
        const agent = await getAgent(ctx.db, ctx.orgId, ctx.agentId);
        if (!agent || !canTalkTo(agent, person.userId, speakerOf(person.membership))) {
          return refusal(`${person.name} can't talk to you, so you can't keep a widget for them.`);
        }
        const format: WidgetFormat = isWidgetFormat(input.kind) ? input.kind : "auto";
        const schedule: WidgetSchedule = isWidgetSchedule(input.schedule) ? input.schedule : "manual";
        let spec: WidgetSpec | null = null;
        if (input.data !== undefined) {
          const check = validateWidgetSpec(input.data);
          if (!check.ok) {
            return refusal(`The data isn't a widget's: ${check.error} Fix it and call create_widget again.`);
          }
          if (format !== "auto" && check.spec.kind !== format) {
            return refusal(`\`kind\` is ${format} but \`data\` is a ${check.spec.kind}: send one kind.`);
          }
          spec = check.spec;
        }
        const alertOn = typeof input.alert === "string";
        const row = await insertWidget(depsOf(ctx), {
          orgId: ctx.orgId,
          dashboardId: board.id,
          agentId: ctx.agentId,
          title: str(input.title),
          prompt: str(input.prompt),
          format,
          schedule,
          ...(isWidgetSize(input.size) ? { size: input.size } : {}),
          alert: { enabled: alertOn, condition: str(input.alert), userId: alertOn ? person.userId : null },
          spec,
          sources: strings(input.sources),
          createdByUserId: null,
          createdByRunId: ctx.runId,
          routineCreatorUserId: person.userId,
        });
        const where = board.kind === "home" ? `${person.name}'s Home` : `the dashboard «${board.title}»`;
        const shows = spec
          ? "It shows your data now."
          : "Your first update builds it in the background shortly: don't build it here, and don't post its numbers in the chat.";
        const alertText = alertOn
          ? ` On each update you judge its alert (${str(input.alert).trim() || "when something is off"}); ${person.name} hears it in Waiting on you.`
          : "";
        return {
          content: `Added widget ${row.id} «${row.title}» to ${where}, updated ${SCHEDULE_WORDS[schedule]}. ${shows}${alertText} Tell ${person.name} where it is.`,
          data: { widget: { id: row.id, dashboardId: board.id } },
        };
      } catch (error) {
        if (explained(error)) return failed(error);
        throw error;
      }
    },
  };

  const shareDashboard: ToolDefinition = {
    name: "share_dashboard",
    description:
      "Change who sees or who edits a dashboard you made (or one the person you work for manages), when they ask. Who sees (`audience`): `private` (only them), `roles` (people with these `roles`) or `workspace`. Showing it to fewer people applies now. Showing it to more people is never yours to do: it becomes a request the person decides in Waiting on you (Publish or Keep only for me), with your `why`; tell them it's waiting there. Who edits (`edit`, `edit_roles`) applies now: only people who see it can edit it. Whoever sees a dashboard sees what you fetched with your connections.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: { type: "string", minLength: 36, maxLength: 36 },
        audience: { type: "string", enum: [...AUDIENCES], description: "Who sees it (leave out to keep it)" },
        roles: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 20, description: "Role names" },
        why: { type: "string", maxLength: 500, description: "Why more people should see it (shown to the person)" },
        ...editSchema,
      },
      required: ["dashboard_id"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      try {
        const { maker } = await makerOf(ctx);
        const person = await personOf(ctx, maker);
        if (!person) return refusal(NOBODY);
        const board = await boardById(ctx, str(input.dashboard_id));
        if (!board || !mayShare(board, person, ctx.agentId)) {
          const id = str(input.dashboard_id);
          return refusal(`No dashboard ${id} that you or ${person.name} may share: use list_dashboards.`);
        }
        if (board.kind === "home") return refusal(`${person.name}'s Home is always only theirs.`);
        const audienceGiven = (AUDIENCES as readonly string[]).includes(str(input.audience));
        const edit = editPolicyIn(input.edit);
        if (!audienceGiven && !edit) return refusal("Give `audience` (who sees it), `edit` (who edits it) or both.");
        // Every check before any change: nothing half applied.
        const editors = edit === "roles" ? await rolesByName(ctx, strings(input.edit_roles)) : null;
        if (editors && editors.ids.length === 0) {
          return refusal(
            `No role matched ${strings(input.edit_roles).join(", ") || "(none given)"} in \`edit_roles\`. The workspace's roles: ${editors.known.join(", ") || "none"}.`,
          );
        }
        const audience = audienceGiven
          ? (str(input.audience) as DashboardAudience)
          : (board.audience as DashboardAudience);
        const roles = audienceGiven && audience === "roles" ? await rolesByName(ctx, strings(input.roles)) : null;
        if (roles && roles.ids.length === 0) {
          return refusal(
            `No role matched ${strings(input.roles).join(", ") || "(none given)"}. The workspace's roles: ${roles.known.join(", ") || "none"}.`,
          );
        }
        const roleIds = audienceGiven ? (roles?.ids ?? []) : board.audienceRoleIds;
        const from = { audience: board.audience, roleIds: board.audienceRoleIds };
        const widens = audienceGiven && widensDashboardAudience(from, { audience, roleIds });
        if (widens && !str(input.why).trim()) {
          return refusal("Say `why` more people should see it: the person reads it before deciding.");
        }
        let edited = "";
        if (edit) {
          await setDashboardEditors(depsOf(ctx), board, edit, editors?.ids ?? []);
          edited = ` It is edited by ${editWords(edit, editors?.names ?? [], person.name)}.`;
        }
        if (!audienceGiven) return { content: `Done:${edited}` };
        if (!widens) {
          const same =
            board.audience === audience &&
            board.audienceRoleIds.length === roleIds.length &&
            roleIds.every((id) => board.audienceRoleIds.includes(id));
          if (!same) await setDashboardAudience(depsOf(ctx), board, audience, roleIds);
          const now = audienceWords({ kind: board.kind, audience }, roles?.names ?? [], person.name);
          return { content: `${same ? "Already so" : "Done"}: «${board.title}» is seen by ${now}.${edited}` };
        }
        await proposeDashboardAudience(depsOf(ctx), {
          orgId: ctx.orgId,
          dashboardId: board.id,
          agentId: ctx.agentId,
          runId: ctx.runId,
          audience: audience as "workspace" | "roles",
          roleIds,
          why: str(input.why),
        });
        const to = audience === "workspace" ? "the whole workspace" : `people with ${roles?.names.join(", ")}`;
        return {
          content: `Asked to show «${board.title}» to ${to}: it waits on ${board.ownerUserId === person.userId ? person.name : "its owner"} in Waiting on you (Publish or Keep only for me). Nothing changed yet in who sees it; tell them.${edited}`,
        };
      } catch (error) {
        if (explained(error)) return failed(error);
        throw error;
      }
    },
  };

  const updateWidget: ToolDefinition = {
    name: UPDATE_WIDGET_TOOL,
    description:
      "Redo the widget this run keeps up to date, in place: its new `data` (one kind's shape, as this run's instructions say; every `note` one short sentence of at most 140 characters; a bars or line chart's unit, like \"runs per day\", goes once in its `unit`, never in each value or label), a one-line `summary` of what changed for its history, and the `sources` you read. Set `alert` (one sentence for the person) only when its alert condition is met. `title` is required on its first build (a short name of at most 40 characters, sentence case, in the person's language, no period at the end, never the ask itself) and allowed only then or when a person asked for a change, never over a title a person gave it; `prompt` only on a change. If you couldn't get the data, give `failed` with why, in the person's words, instead of `data`. Call it once; nothing goes to any chat.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        data: { ...dataSchema, description: "The widget's new data (see this run's instructions)" },
        summary: { type: "string", maxLength: 280 },
        sources: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
        title: { type: "string", minLength: 1, maxLength: WIDGET_AGENT_TITLE_MAX },
        prompt: { type: "string", minLength: 1, maxLength: WIDGET_PROMPT_MAX },
        alert: { type: "string", maxLength: 280 },
        failed: { type: "string", minLength: 1, maxLength: 500 },
      },
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const brief = await briefOf(ctx);
      if (!brief?.widget) return refusal("update_widget belongs to a widget's update run; there is none here.");
      if (input.data === undefined && input.failed === undefined) {
        return refusal("Give the widget's `data` (or `failed` with why you couldn't get it).");
      }
      try {
        const view = await applyWidgetUpdate(depsOf(ctx), {
          orgId: ctx.orgId,
          widgetId: brief.widget.widgetId,
          routineRunId: brief.routineRunId,
          agentRunId: ctx.runId,
          update: {
            ...(input.data !== undefined && input.failed === undefined ? { spec: input.data as WidgetSpec } : {}),
            summary: str(input.summary),
            ...(input.sources !== undefined ? { sources: strings(input.sources) } : {}),
            ...(str(input.title).trim() ? { title: str(input.title) } : {}),
            ...(str(input.prompt).trim() ? { prompt: str(input.prompt) } : {}),
            ...(str(input.alert).trim() ? { alert: str(input.alert) } : {}),
            ...(input.failed !== undefined ? { failed: str(input.failed) } : {}),
          },
        });
        if (view.status === "failed") {
          return {
            content: "Recorded: the widget says it couldn't update, with your words. Finish now; nothing is posted.",
            data: { widget: { id: view.id, status: view.status } },
          };
        }
        return {
          content:
            "Updated: the widget shows it now. Finish now with a one-line record of what you checked (it is not posted), with no title or label.",
          data: { widget: { id: view.id, status: view.status } },
        };
      } catch (error) {
        if (error instanceof ConflictError) return refusal("This run already updated its widget. Finish now.");
        if (error instanceof ValidationError && error.code === "widget.invalid_data") {
          return refusal(`The data isn't valid: ${error.message} Fix it and call update_widget again.`);
        }
        if (error instanceof ValidationError && error.code === "widget.invalid_title") {
          return refusal(`Not saved: ${error.message} Call update_widget again with it.`);
        }
        if (explained(error)) return failed(error);
        throw error;
      }
    },
  };

  return {
    name: "dashboards",
    async tools(ctx) {
      // A widget's refresh run speaks only through update_widget (ADR 0135 §5); no other run has it.
      const brief = await briefOf(ctx);
      if (brief?.widget) return [updateWidget];
      return [listDashboards, createDashboard, createWidget, shareDashboard];
    },
  };
}
