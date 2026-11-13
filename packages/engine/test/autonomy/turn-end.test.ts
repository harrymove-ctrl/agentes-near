import { afterEach, expect } from "bun:test";
import { schema } from "@agenteschat/db";
import { addChannelMember, createChannel, decideApproval, postPersonMessage, runAuthority } from "../../src";
import { ALL_GITHUB_SCOPES, fakeGithub } from "../tool-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { deployTool } from "./tools";

// I2 (no idle end) and its bounds (I6): every turn ends working, waiting on something visible, or done.

afterEach(closeWorlds);

const nudges = async (w: World, kind: string) =>
  (await w.steps((await w.runs()).map((r) => r.id))).filter((s) => s.data.nudged === kind).length;

const openQuestions = async (w: World) =>
  (await w.db.select().from(schema.agentQuestions)).filter((q) => q.status === "open");

scenario("S17", "an unkept promise gets one nudge; a turn that set up its waker is not nudged again", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) => (String(s.reply).startsWith("Agora começo") ? "continue" : "done"),
    },
    script: {
      otto: [
        { text: "Agora começo o #4." },
        {
          text: "Comecei o #4; volto em 30 minutos com o resultado.",
          calls: [{ name: "follow_up", input: { minutes: 30, note: "Ver o #4 e reportar.", about: "o #4" } }],
        },
        { text: "Comecei o #4; volto em 30 minutos com o resultado." },
        { text: "O #4 está pronto: o export agora gera o PDF." },
      ],
    },
  });
  await w.say("@otto e o #4?");
  await w.settle();
  await w.advance(31);
  expect(await nudges(w, "promise")).toBe(1);
  expect(w.judgedAs("follow_through")).toHaveLength(2);
  expect((await w.posts("otto")).at(-1)?.body).toContain("pronto");
  await assertInvariants(w);
});

scenario("S18", "a blocker described, then asked when told: a question card the person is notified of", async () => {
  const blocker =
    "O que falta: 1. Script de migração. 2. Preciso de uma credencial read-only do banco e de um teste no Teams. Termino o script e te mostro.";
  const asked = "Pode me passar uma credencial read-only do banco e rodar um teste no Teams?";
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: () => "ask" },
    script: { otto: [{ text: blocker }, { text: asked }] },
  });
  await w.say("@otto como está a integração com o Teams?");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("waiting_input");
  expect(await openQuestions(w)).toHaveLength(1);
  const notified = (await w.db.select().from(schema.notifications)).filter((n) => n.kind === "agent_question");
  expect(notified.map((n) => n.userId)).toEqual([w.owner.id]);
  await assertInvariants(w);
});

scenario("S31", "a run in circles ends as stuck with Continuar, and nothing continues it", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { stuck: 0.9, followThrough: () => "continue" },
    setup: { toolSources: [deployTool()] },
    script: { otto: () => ({ calls: [{ name: "deploy", input: { env: "prod" } }] }) },
  });
  await w.say("@otto faz o deploy");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("done");
  expect((await w.posts("otto")).map((m) => m.meta.stepLimit)).toEqual([{ stuck: true }]);
  expect(await nudges(w, "promise")).toBe(0);
  await assertInvariants(w);
});

scenario("S32", "a promise repeated without acting: bounded continues, then it ends with no card", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: () => "continue" },
    script: { otto: () => ({ text: "Vou fazer agora." }) },
  });
  await w.say("@otto arruma o teste do login");
  await w.settle();
  expect(w.f.provider.calls.length).toBeLessThanOrEqual(4);
  // A promise asks nothing: posted as it is, never a card a person would answer.
  expect(await openQuestions(w)).toHaveLength(0);
  expect((await w.runs("otto")).map((r) => r.status)).toEqual(["done"]);
  await assertInvariants(w);
});

// ADR 0131 §1: an offer that ends asking the person waits for their answer, never judged into going ahead.
scenario("S33", "an offer that ends asking waits for the answer", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) =>
        String(s.reply).includes("Quer que eu crie") ? { main: "done", controller: "continue" } : "done",
    },
    script: {
      otto: [
        { text: "Triagem: login e PDF são críticos; export, push e busca podem esperar. Quer que eu crie as issues?" },
        { calls: [{ name: "create_issue", input: { title: "Login falha com SSO" } }] },
        { text: "Criei a issue do login; as outras seguem a mesma triagem." },
      ],
    },
  });
  await w.grant("otto", ["issues:write"]);
  await w.say("@otto faz a triagem desses 5 bugs: login, export, pdf, push, busca");
  await w.settle();
  expect(await w.calls("otto")).toEqual([]);
  await assertInvariants(w);
});

scenario("S34", "an approval waits visibly; after it the agent acts and reports", async () => {
  const github = fakeGithub();
  const w = await world({
    agents: ["otto"],
    setup: { toolSources: [github.source] },
    script: {
      otto: [
        {
          calls: [
            {
              name: "github_merge_pr",
              input: {
                repo: "acme/app",
                pr: 227,
                why: "A Nina aprovou o #227 e o CI passou: o merge fecha o release de hoje.",
              },
            },
          ],
        },
        { text: "Merge feito: o #227 está na main." },
      ],
    },
  });
  await w.grant(
    "otto",
    ALL_GITHUB_SCOPES.map((s) => s.scope),
  );
  await w.say("@otto faz o merge do #227");
  await w.settle();
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("waiting_approval");
  await assertInvariants(w);
  const [approval] = await w.db.select().from(schema.approvals);
  await decideApproval({ db: w.db, pubsub: w.f.pubsub }, w.owner.id, w.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await w.settle();
  expect(github.executed.map((e) => e.tool)).toEqual(["github_merge_pr"]);
  expect((await w.runs("otto"))[0]?.status).toBe("done");
  expect((await w.posts("otto")).at(-1)?.body).toContain("Merge feito");
  await assertInvariants(w);
});

scenario("S41", "a follow-up waits with no nudge, then wakes the agent for the same person", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: (s) => (String(s.reply).includes("volto") ? "continue" : "done") },
    script: {
      otto: [
        {
          text: "O deploy 88 está rodando; volto em 30 minutos.",
          calls: [{ name: "follow_up", input: { minutes: 30, note: "Checar o deploy 88.", about: "o deploy" } }],
        },
        { text: "O deploy 88 está rodando; volto em 30 minutos." },
        { text: "Deploy 88 concluído sem erros." },
      ],
    },
  });
  await w.say("@otto acompanha o deploy 88");
  await w.settle();
  expect(await nudges(w, "promise")).toBe(0);
  await w.advance(31);
  const runs = await w.runs("otto");
  expect(runs).toHaveLength(2);
  expect((await runAuthority(w.db, runs[1] as NonNullable<(typeof runs)[1]>)).kind).toBe("person");
  expect((await w.posts("otto")).at(-1)?.body).toContain("concluído");
  await assertInvariants(w);
});

scenario("S45", "a second promise after real tool work gets its second continue, not an ask", async () => {
  const w = await world({
    agents: ["otto"],
    judge: {
      followThrough: (s) => (/vou criar|criar a do export/.test(String(s.reply)) ? "continue" : "done"),
    },
    script: {
      otto: [
        { text: "Agora vou criar as issues." },
        { calls: [{ name: "create_issue", input: { title: "Login falha com SSO" } }] },
        { text: "Criei a do login; agora vou criar a do export." },
        { calls: [{ name: "create_issue", input: { title: "Export trava com 10 mil linhas" } }] },
        { text: "Criei as duas issues: login e export." },
      ],
    },
  });
  await w.grant("otto", ["issues:write"]);
  await w.say("@otto cria as issues do login e do export");
  await w.settle();
  expect(await nudges(w, "promise")).toBe(2);
  expect(await nudges(w, "ask")).toBe(0);
  expect(await openQuestions(w)).toHaveLength(0);
  expect((await w.calls("otto")).map((c) => c.name)).toEqual(["create_issue", "create_issue"]);
  await assertInvariants(w);
});

scenario(
  "S46",
  "at the cap, a turn that asks in its text after the ask nudge still becomes the question card",
  async () => {
    const w = await world({
      agents: ["otto"],
      judge: {
        followThrough: (s) => {
          const reply = String(s.reply);
          if (reply.includes("token")) return "ask";
          return /Vou começar|vou criar a próxima/.test(reply) ? "continue" : "done";
        },
      },
      script: {
        otto: [
          { text: "Vou começar pelas issues." },
          { calls: [{ name: "create_issue", input: { title: "Sentry: erro 500 no login" } }] },
          { text: "Criei uma; vou criar a próxima." },
          { calls: [{ name: "create_issue", input: { title: "Sentry: timeout no export" } }] },
          { text: "Para ligar o alerta falta o token do Sentry e acesso ao banco." },
          { text: "Pode me passar o token do Sentry e o acesso ao banco?" },
        ],
      },
    });
    await w.grant("otto", ["issues:write"]);
    await w.say("@otto liga os alertas do Sentry");
    await w.settle();
    expect(await nudges(w, "promise")).toBe(2);
    expect(await nudges(w, "ask")).toBe(1);
    const [run] = await w.runs("otto");
    expect(run?.status).toBe("waiting_input");
    expect(await openQuestions(w)).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S53", "a person's 'don't do that again' becomes a lasting lesson the agent reads in later runs", async () => {
  const lesson = "Não encaminhar pedidos a outros agentes sem a pessoa pedir; resolver eu mesmo ou perguntar.";
  const w = await world({
    agents: ["otto"],
    setup: { contextTools: true },
    script: {
      otto: [
        { calls: [{ name: "remember", input: { content: lesson, kind: "preference" } }] },
        { text: "Combinado: não encaminho mais pedidos a outros agentes." },
        { text: "O relatório de vendas de outubro está pronto: R$ 182 mil, 12% acima de setembro." },
      ],
    },
  });
  await w.say("@otto não encaminhe isso para outros agentes, não faça mais isso.");
  await w.settle();
  // The memory tool tells the agent such a correction is something to remember.
  const offered = w.f.provider.calls[0]?.request.tools?.find((t) => t.name === "remember");
  expect(offered?.description).toContain("not to do something again");
  const saved = (await w.db.select().from(schema.contextItems)).filter((i) => i.agentId === w.agents.otto?.id);
  expect(saved.map((i) => [i.kind, i.content])).toEqual([["preference", lesson]]);

  await w.say("@otto me manda o relatório de vendas de outubro.");
  await w.settle();
  // A later run reads the lesson in its prompt.
  expect(w.prompts("otto").at(-1)).toContain(lesson);
  expect((await w.posts("otto")).at(-1)?.body).toContain("relatório");
  await assertInvariants(w);
});

scenario("S53b", "a 'don't do that again' said in a DM holds in the agent's runs in other channels", async () => {
  const lesson = "Não encaminhar pedidos a outros agentes sem a pessoa pedir; resolver eu mesmo ou perguntar.";
  const w = await world({
    agents: ["otto"],
    dmWith: "otto",
    setup: { contextTools: true },
    script: {
      otto: [
        { calls: [{ name: "remember", input: { content: lesson, kind: "preference", everywhere: true } }] },
        { text: "Combinado: não encaminho mais pedidos a outros agentes." },
        { text: "O relatório de vendas de outubro está pronto." },
      ],
    },
  });
  await w.say("@otto não encaminhe isso para outros agentes, não faça mais isso.");
  await w.settle();
  const offered = w.f.provider.calls[0]?.request.tools?.find((t) => t.name === "remember");
  expect(offered?.description).toContain("everywhere: true");

  const other = await createChannel(w.db, w.owner.id, w.org.id, { name: "suporte" });
  await addChannelMember(w.db, w.owner.id, w.org.id, other.id, { agentId: w.agents.otto?.id ?? "" });
  await postPersonMessage({ db: w.db, pubsub: w.f.pubsub, judge: w.f.context.judge }, w.owner.id, w.org.id, other.id, {
    body: "@otto me manda o relatório de vendas de outubro.",
    threadId: null,
  });
  await w.settle();
  expect(w.prompts("otto").at(-1)).toContain(lesson);
  await assertInvariants(w);
});
