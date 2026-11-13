import { afterEach, expect } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { expireConsultations, runAuthority, updateAgent } from "../../src";
import { closeWorlds, type Script, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { openPullRequestTool } from "./tools";

// I3 (hand-offs close) and I4 (turns can act): work handed between agents comes back, and every leg can act.

afterEach(closeWorlds);

const consultations = (w: World) => w.db.select().from(schema.agentConsultations);

scenario("S13", "a note's reply comes back to the agent for the person, and both legs can act", async () => {
  const w = await world({
    agents: ["ada", "rui"],
    setup: { toolSources: [openPullRequestTool()] },
    script: {
      ada: [
        { calls: [{ name: "tell_agent", input: { agent: "@rui", message: "Roda a migração 0141, por favor." } }] },
        { text: "Pedi ao Rui para rodar a migração." },
        { text: "Ana, o Rui rodou a migração 0141 e abriu o PR." },
      ],
      rui: [
        { calls: [{ name: "open_pull_request", input: { repo: "acme/app", title: "Migração 0141" } }] },
        { text: "Rodei a migração 0141 e abri o PR #230." },
      ],
    },
  });
  await w.grant("rui", ["github:pr.write"]);
  await w.say("@ada pede pro rui rodar a migração");
  await w.settle();
  expect((await w.calls("rui")).map((c) => [c.name, c.isError])).toEqual([["open_pull_request", false]]);
  const adaRuns = await w.runs("ada");
  expect(adaRuns).toHaveLength(2);
  expect((await runAuthority(w.db, adaRuns[1] as NonNullable<(typeof adaRuns)[1]>)).kind).toBe("person");
  expect((await w.posts("ada")).filter((m) => m.body.includes("rodou"))).toHaveLength(1);
  await assertInvariants(w);
});

/** A link of a chain: asks `next`, says so, and relays what comes back with its own part. */
const relay =
  (next: string | null, part: string): Script =>
  ({ n, last }) => {
    const answer = /\[Reply to your question to [^\]]*\]: (.*)/s.exec(last)?.[1];
    if (answer) return { text: `${part}; ${answer.trim()}` };
    if (!next) return n === 1 ? { text: part } : undefined;
    if (n === 1)
      return { calls: [{ name: "ask_agent", input: { agent: `@${next}`, question: "Prepara o release." } }] };
    if (n === 2) return { text: `Pedi a @${next}; já volto.` };
    return undefined;
  };

scenario("S21", "a three-deep delegation rolls up to the person with every part", async () => {
  const w = await world({
    agents: ["chefe", "rita", "igor", "eva"],
    // "Pedi a @rita; já volto." in the channel tells the people, it hands nothing to Rita there.
    judge: {
      mention: Object.fromEntries(
        ["chefe", "rita", "igor", "eva"].map((h) => [h, { handoff: 0.05, needsNothing: 0.95 }]),
      ),
    },
    script: {
      chefe: relay("rita", "Release"),
      rita: relay("igor", "changelog pronto"),
      igor: relay("eva", "testes ok"),
      eva: relay(null, "notas da versão 2.3 prontas"),
    },
  });
  await w.say("@chefe prepara o release");
  await w.settle();
  const rows = await consultations(w);
  expect(rows.map((r) => r.status)).toEqual(["answered", "answered", "answered"]);
  expect((await w.posts("chefe")).at(-1)?.body).toContain("2.3");
  await assertInvariants(w);
});

scenario(
  "S22",
  "a review that takes 25 minutes is neither expired nor killed, and its verdict comes back once",
  async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = await world({
      agents: ["lia", "nina"],
      script: {
        lia: [
          {
            calls: [
              { name: "ask_agent", input: { agent: "@nina", question: "Revisa o PR #227: posso fazer o merge?" } },
            ],
          },
          { text: "Abri o #227 e pedi revisão à Nina." },
          { text: "A Nina aprovou o #227 com 1 ressalva: renomear a env." },
        ],
        nina: [{ text: "Aprovado com 1 ressalva: renomear a env.", hold: gate }],
      },
    });
    await w.say("@lia abre o PR do #227 e pede revisão à Nina");
    const draining = w.settle();
    for (let i = 0; i < 500 && w.prompts("nina").length === 0; i++) await Bun.sleep(10);
    expect(w.prompts("nina")).toHaveLength(1);
    // 25 minutes later, Nina still working.
    await expireConsultations({ db: w.db, pubsub: w.f.pubsub }, new Date(Date.now() + 25 * 60_000));
    release();
    await draining;
    await w.settle();
    const [row] = await consultations(w);
    expect(row?.status).toBe("answered");
    expect((await w.runs("nina"))[0]?.status).toBe("done");
    expect((await w.posts("lia")).filter((m) => m.body.includes("aprovou"))).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S40", "a renamed agent's old @handle still reaches it", async () => {
  const caio: Script = [{ text: "Anotado: deploy às 18h." }];
  const w = await world({
    agents: ["otto", "agent-801fab"],
    script: {
      otto: [
        { calls: [{ name: "tell_agent", input: { agent: "@agent-801fab", message: "O deploy é às 18h." } }] },
        { text: "Avisei o Caio." },
        { text: "O Caio confirmou o deploy às 18h." },
      ],
      caio,
      "agent-801fab": caio,
    },
  });
  const renamed = await updateAgent(w.db, w.owner.id, w.org.id, w.agents["agent-801fab"]?.id ?? "", {
    name: "Caio",
    handle: "caio",
  } as Parameters<typeof updateAgent>[4]);
  expect(renamed.handle).toBe("caio");
  await w.say("@otto avisa o agent-801fab que o deploy é às 18h");
  await w.settle();
  expect((await w.calls("otto")).map((c) => [c.name, c.isError])).toEqual([["tell_agent", false]]);
  expect(await w.runs("agent-801fab")).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S38", "a teammate's AI status in the context is the live one, not a stale no-AI card", async () => {
  const w = await world({
    agents: ["lia", "fred"],
    script: {
      lia: [
        { calls: [{ name: "tell_agent", input: { agent: "@fred", message: "Revisa o PR #231, por favor." } }] },
        { text: "Passei a revisão do #231 para o Fred." },
        { text: "O Fred aprovou o #231." },
      ],
      fred: [{ text: "Aprovado." }],
    },
  });
  // Yesterday's card: Fred had no AI then. He has one now.
  const card = await w.past("@fred", "Fred ainda não tem uma IA conectada.", 24 * 60);
  await w.db
    .update(schema.messages)
    .set({ meta: { noAi: { agentId: w.agents.fred?.id ?? "", reason: "no_key" } } })
    .where(eq(schema.messages.id, card.id));
  await w.say("@lia pede pro fred revisar o #231");
  await w.settle();
  const prompt = w.prompts("lia")[0] ?? "";
  expect(prompt).toContain("# Your teammates now");
  expect(prompt).toMatch(/- @fred: has an AI, answers when called/);
  expect(await w.runs("fred")).toHaveLength(1);
  await assertInvariants(w);
});

scenario(
  "S49",
  "a hand-off's failed run is told where the work came from, not as a notice into the agents' DM",
  async () => {
    const w = await world({
      agents: ["bia", "vera"],
      script: {
        bia: [
          { calls: [{ name: "tell_agent", input: { agent: "@vera", message: "Gera as imagens do release." } }] },
          { text: "Pedi à Vera as imagens." },
          { text: "A Vera não conseguiu gerar as imagens; faço eu." },
        ],
        vera: () => ({ error: new ProviderError("invalid request", false, 400) }),
      },
    });
    await w.say("@bia pede para a vera gerar as imagens do release");
    await w.settle();
    expect((await w.runs("vera")).map((r) => r.status)).toEqual(["failed"]);
    expect((await consultations(w)).map((c) => c.status)).toEqual(["failed"]);
    const failed = (await w.db.select().from(schema.notifications)).filter((n) => n.kind === "run_failed");
    expect(failed).toEqual([]);
    expect((await w.posts("bia")).at(-1)?.body).toContain("não conseguiu");
    await assertInvariants(w);
  },
);
