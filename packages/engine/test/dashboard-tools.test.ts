import { afterEach, describe, expect, test } from "bun:test";
import type { PubSub } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  createDashboard,
  createDashboardToolSource,
  type DashboardDeps,
  decideDashboardProposal,
  drainOutbox,
  postPersonMessage,
  proposeDashboardAudience,
  runRoutineNow,
  setDashboardAudience,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, notificationsOf, routineDeps } from "./routine-fixtures";

/** ADR 0135 §10, §11: agents make boards and widgets for the person behind the run, and never widen them alone. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

type Call = { name: string; input: Record<string, unknown> };

/**
 * A fixture whose agent, in a run that isn't a widget's, calls `calls` once (in order, one per turn) and then answers
 * that it is done; `results` gets each tool result it read.
 */
async function setupAgent(calls: (req: ModelRequest) => Call[], results: string[] = []) {
  const deps = { db: undefined as unknown as Database, pubsub: undefined as unknown as PubSub } as DashboardDeps;
  const source = createDashboardToolSource(deps);
  f = await setup({
    toolSources: [source],
    reply: (req): FakeReply => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) {
        results.push(last);
        return { chunks: ["Pronto."] };
      }
      const toolUses = calls(req);
      return toolUses.length > 0 ? { chunks: [], toolUses } : { chunks: ["Pronto."] };
    },
  });
  deps.db = f.db;
  deps.pubsub = f.pubsub;
  return results;
}

const dash = (): DashboardDeps => ({ db: f.db, pubsub: f.pubsub, context: f.context });
const isRoutineRun = (req: ModelRequest) => systemText(req.system ?? "").includes("This is a routine run");

async function ask(body: string, userId = f.owner.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body: `@dev ${body}` });
  await drainOutbox(f.db, f.handlers);
}

const boards = () => f.db.select().from(schema.dashboards).orderBy(schema.dashboards.createdAt);
const widgets = () => f.db.select().from(schema.dashboardWidgets).orderBy(schema.dashboardWidgets.createdAt);

async function roleFor(userId: string, name = "Vendas") {
  const [role] = await f.db.insert(schema.orgRoles).values({ orgId: f.org.id, name }).returning();
  if (!role) throw new Error("no role");
  await f.db.insert(schema.organizationMemberRoles).values({ orgId: f.org.id, userId, roleId: role.id });
  return role;
}

const WHY = "O time de vendas acompanha a Black Friday pelo mesmo painel.";

describe("create_dashboard", () => {
  test("a board for the person behind the run, private, by the agent; a wider audience waits on them", async () => {
    const results = await setupAgent((req) =>
      JSON.stringify(req.messages).includes("painel")
        ? [{ name: "create_dashboard", input: { title: "Black Friday", audience: "workspace", why: WHY } }]
        : [],
    );
    await ask("monta um painel da Black Friday para o workspace");
    const [board] = await boards();
    expect(board).toMatchObject({
      title: "Black Friday",
      kind: "board",
      ownerUserId: f.owner.id,
      ownerAgentId: f.agent.id,
      audience: "private",
    });
    expect(board?.proposal).toMatchObject({ audience: "workspace", roleIds: [], agentId: f.agent.id, why: WHY });
    expect(results[0]).toContain("only ana sees it for now");
    expect(results[0]).toContain("waits on ana");

    const [request] = await notificationsOf(f, "dashboard_proposal");
    expect(request).toMatchObject({
      userId: f.owner.id,
      waiting: true,
      source: { dashboardId: board?.id, agentId: f.agent.id, label: "Black Friday" },
    });
    expect(request?.latest).toMatchObject({ statusTo: "workspace", text: WHY });
  });
});

describe("the person decides", () => {
  test("Publish shows it to the audience asked for; Keep only for me leaves it; both clear the request", async () => {
    await setupAgent(() => []);
    const maker = { agentId: f.agent.id, runId: null };
    const one = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Um",
      audience: "private",
      editPolicy: "owner",
    });
    await proposeDashboardAudience(dash(), {
      orgId: f.org.id,
      dashboardId: one.id,
      ...maker,
      audience: "workspace",
      roleIds: [],
      why: WHY,
    });
    const published = await decideDashboardProposal(dash(), f.owner.id, f.org.id, one.id, "publish");
    expect(published).toMatchObject({ audience: "workspace", proposal: null });
    expect((await notificationsOf(f, "dashboard_proposal"))[0]?.doneAt).not.toBeNull();
    await expect(decideDashboardProposal(dash(), f.owner.id, f.org.id, one.id, "keep")).rejects.toMatchObject({
      code: "dashboard.proposal_none",
    });

    const two = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Dois",
      audience: "private",
      editPolicy: "owner",
    });
    await proposeDashboardAudience(dash(), {
      orgId: f.org.id,
      dashboardId: two.id,
      ...maker,
      audience: "workspace",
      roleIds: [],
      why: WHY,
    });
    const kept = await decideDashboardProposal(dash(), f.owner.id, f.org.id, two.id, "keep");
    expect(kept).toMatchObject({ audience: "private", proposal: null });
    const [row] = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, two.id));
    expect(row?.proposal).toBeNull();
  });

  test("only the person it was made for decides; a narrower or equal audience isn't a request", async () => {
    await setupAgent(() => []);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const role = await roleFor(bia.id);
    const created = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Vendas",
      audience: "private",
      editPolicy: "owner",
    });
    const [row] = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, created.id));
    if (!row) throw new Error("no board");
    await setDashboardAudience(dash(), row, "roles", [role.id]);
    const propose = (audience: "workspace" | "roles") =>
      proposeDashboardAudience(dash(), {
        orgId: f.org.id,
        dashboardId: created.id,
        agentId: f.agent.id,
        runId: null,
        audience,
        roleIds: [role.id],
        why: WHY,
      });
    // The same roles: nothing to ask.
    await propose("roles");
    expect((await boards())[0]?.proposal).toBeNull();
    await propose("workspace");
    await expect(decideDashboardProposal(dash(), bia.id, f.org.id, created.id, "publish")).rejects.toMatchObject({
      code: "dashboard.proposal_not_yours",
    });
    expect((await notificationsOf(f, "dashboard_proposal")).map((n) => n.userId)).toEqual([f.owner.id]);
  });
});

describe("create_widget", () => {
  test("on the board it is given, with data at once; without data its first build is queued", async () => {
    let boardId = "";
    const results = await setupAgent((req) => {
      const said = JSON.stringify(req.messages);
      if (!said.includes("vendas")) return [];
      return [
        {
          name: "create_widget",
          input: {
            dashboard_id: boardId,
            title: "Vendas hoje",
            prompt: "Quanto vendemos hoje contra ontem",
            schedule: "hour",
            alert: "cair 20% abaixo de ontem",
            data: { kind: "kpi", value: 18420, prefix: "R$" },
          },
        },
        {
          name: "create_widget",
          input: {
            dashboard_id: boardId,
            title: "Pedidos atrasados",
            prompt: "Pedidos atrasados por canal",
            kind: "list",
            schedule: "manual",
          },
        },
      ];
    });
    const created = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Loja",
      audience: "private",
      editPolicy: "owner",
    });
    boardId = created.id;
    await ask("quero acompanhar as vendas da loja no painel Loja");
    const [shown, building] = await widgets();
    expect(shown).toMatchObject({
      dashboardId: created.id,
      agentId: f.agent.id,
      title: "Vendas hoje",
      status: "ok",
      kind: "kpi",
      schedule: "hour",
      alertEnabled: true,
      alertCondition: "cair 20% abaixo de ontem",
      alertUserId: f.owner.id,
      createdByUserId: null,
    });
    expect(shown?.createdByRunId).not.toBeNull();
    expect(shown?.routineId).not.toBeNull();
    const [routine] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, shown?.routineId ?? ""));
    // Its routine runs for the person who asked.
    expect(routine?.createdByUserId).toBe(f.owner.id);
    expect(building).toMatchObject({ dashboardId: created.id, format: "list", schedule: "manual" });
    // Built in the background: its routine and a run were made for it.
    expect(building?.routineId).not.toBeNull();
    expect(results.some((r) => r.includes("It shows your data now"))).toBe(true);
  });

  test("without a board, it goes on the person's Home; a board they can't edit is refused", async () => {
    const results: string[] = [];
    let other = "";
    await setupAgent((req) => {
      const said = JSON.stringify(req.messages.at(-1)?.content);
      if (said.includes("fixa")) {
        return [
          {
            name: "create_widget",
            input: {
              title: "PRs",
              prompt: "PRs esperando revisão",
              schedule: "day",
              data: { kind: "text", items: ["3 PRs"] },
            },
          },
        ];
      }
      if (said.includes("outro")) {
        return [
          {
            name: "create_widget",
            input: { dashboard_id: other, title: "X", prompt: "X", schedule: "manual" },
          },
        ];
      }
      return [];
    }, results);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const hers = await createDashboard(dash(), bia.id, f.org.id, {
      title: "Dela",
      audience: "private",
      editPolicy: "owner",
    });
    other = hers.id;
    await ask("fixa os PRs no meu início");
    const [home] = (await boards()).filter((b) => b.kind === "home");
    if (!home) throw new Error("no home board");
    expect(home.ownerUserId).toBe(f.owner.id);
    expect((await widgets()).map((w) => [w.dashboardId, w.title])).toEqual([[home.id, "PRs"]]);
    await ask("põe no outro painel");
    expect(results.at(-1)).toContain(`No dashboard ${other}`);
    expect(await widgets()).toHaveLength(1);
  });

  test("invalid data is refused with what to fix", async () => {
    const goal = { title: "Meta", prompt: "Meta do mês", schedule: "manual", data: { kind: "goal" } };
    const results = await setupAgent((req) =>
      JSON.stringify(req.messages.at(-1)?.content).includes("meta") ? [{ name: "create_widget", input: goal }] : [],
    );
    await ask("mostra a meta do mês");
    expect(results[0]).toContain("The data isn't a widget's");
    expect(await widgets()).toHaveLength(0);
  });
});

describe("share_dashboard and list_dashboards", () => {
  test("narrower applies at once; wider waits on the person; list_dashboards shows who sees each", async () => {
    let boardId = "";
    let step = "";
    const results = await setupAgent(() => {
      if (step === "narrow") {
        return [{ name: "share_dashboard", input: { dashboard_id: boardId, audience: "private" } }];
      }
      if (step === "widen") {
        const input = { dashboard_id: boardId, audience: "roles", roles: ["vendas"], why: WHY };
        return [{ name: "share_dashboard", input }];
      }
      if (step === "list") return [{ name: "list_dashboards", input: {} }];
      return [];
    });
    await roleFor(f.owner.id);
    const created = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Metas",
      audience: "workspace",
      editPolicy: "owner",
    });
    boardId = created.id;
    step = "narrow";
    await ask("deixa o painel só para mim");
    expect((await boards())[0]).toMatchObject({ audience: "private", proposal: null });
    expect(results.at(-1)).toContain("Done");

    step = "widen";
    await ask("mostra para o time de vendas");
    const [after] = await boards();
    expect(after).toMatchObject({ audience: "private" });
    expect(after?.proposal).toMatchObject({ audience: "roles", why: WHY });
    expect(results.at(-1)).toContain("Nothing changed yet");

    step = "list";
    await ask("quais painéis eu tenho?");
    expect(results.at(-1)).toContain(boardId);
    expect(results.at(-1)).toContain("Home has no widgets yet");
  });

  test("who edits: by roles on create; share_dashboard changes it at once, alone, never a request", async () => {
    let boardId = "";
    let step = "";
    const results = await setupAgent(() => {
      if (step === "create") {
        const input = { title: "Pipeline", edit: "roles", edit_roles: ["vendas"] };
        return [{ name: "create_dashboard", input }];
      }
      if (step === "nobody") {
        const input = { dashboard_id: boardId, edit: "roles", edit_roles: ["Marketing"] };
        return [{ name: "share_dashboard", input }];
      }
      if (step === "viewers") return [{ name: "share_dashboard", input: { dashboard_id: boardId, edit: "viewers" } }];
      return [];
    });
    const sales = await roleFor(f.owner.id);
    step = "create";
    await ask("cria um painel do pipeline que o time de vendas edita");
    const [made] = await boards();
    boardId = made?.id ?? "";
    expect(made).toMatchObject({ audience: "private", editPolicy: "roles", editRoleIds: [sales.id], proposal: null });
    expect(results.at(-1)).toContain("people with the role Vendas who see it");

    step = "nobody";
    await ask("deixa o marketing editar");
    expect((await boards())[0]).toMatchObject({ editPolicy: "roles", editRoleIds: [sales.id] });
    expect(results.at(-1)).toContain("No role matched Marketing");

    step = "viewers";
    await ask("quem vê pode editar");
    expect((await boards())[0]).toMatchObject({
      audience: "private",
      editPolicy: "viewers",
      editRoleIds: [],
      proposal: null,
    });
    expect(results.at(-1)).toContain("edited by whoever sees it");
    expect(await notificationsOf(f, "dashboard_proposal")).toHaveLength(0);
  });

  test("a routine's run never widens a board: it only asks", async () => {
    let boardId = "";
    await setupAgent((req) =>
      isRoutineRun(req)
        ? [{ name: "share_dashboard", input: { dashboard_id: boardId, audience: "workspace", why: WHY } }]
        : [],
    );
    const created = await createDashboard(dash(), f.owner.id, f.org.id, {
      title: "Diário",
      audience: "private",
      editPolicy: "owner",
    });
    boardId = created.id;
    const routine = await channelRoutine(f, { prompt: "Publique o painel diário para o workspace." });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [board] = await boards();
    expect(board).toMatchObject({ audience: "private" });
    expect(board?.proposal).toMatchObject({ audience: "workspace" });
    expect((await notificationsOf(f, "dashboard_proposal")).map((n) => n.userId)).toEqual([f.owner.id]);
  });
});
