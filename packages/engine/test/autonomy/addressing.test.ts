import { afterEach, expect } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { removeChannelMember, runAuthority } from "../../src";
import { closeWorlds, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { openPullRequestTool } from "./tools";

// I1 (addressing) and I6 (noise): who a message reaches, and that nobody wakes when nothing needs them.

afterEach(closeWorlds);

const COMPLAINT = "eu mesmo fiz tudo no meu claude code, vocês se enrolaram muito";

/** People ana and bruno with agents Otto and Ada; ana talked to @otto five minutes ago. */
async function afterTalkWithOtto(extra: Parameters<typeof world>[0]["route"] = {}) {
  const w = await world({
    agents: ["otto", "ada"],
    people: ["bruno"],
    route: {
      [COMPLAINT]: { needs: 0.3, scores: { otto: 0.25, ada: 0.2 }, best: ["otto", 0.46] },
      ...extra,
    },
    script: {
      otto: [{ text: "Desculpa, Ana: o build travou no meu lado. Já está corrigido." }, { text: "Sim, entendemos." }],
    },
  });
  await w.past("ana", "@otto sobe o build de hoje?", 6);
  await w.past("@otto", "Subi o build 1.4.2.", 5);
  return w;
}

scenario("S01", "a complaint to the agents as a group gets the agent the person was talking to", async () => {
  const w = await afterTalkWithOtto();
  const complaint = await w.say(COMPLAINT);
  await w.settle();
  expect((await w.runs()).map((r) => w.handleOf(r.agentId))).toEqual(["otto"]);
  // The complaint's own decision: Otto's reply is routed too, and decides later.
  expect((await w.decisions()).find((d) => d.messageId === complaint.id)?.picked).toEqual(["otto"]);
  await assertInvariants(w);
});

scenario("S02", "a short follow-up right after goes to the same agent", async () => {
  const w = await afterTalkWithOtto({ "Entenderam?": { needs: 0.2, scores: { otto: 0.1, ada: 0.1 } } });
  await w.say(COMPLAINT);
  await w.settle();
  await w.say("Entenderam?");
  await w.settle();
  expect((await w.runs()).map((r) => w.handleOf(r.agentId))).toEqual(["otto", "otto"]);
  await assertInvariants(w);
});

scenario("S03", "a request 23 minutes after a talk with Ada, which both agents fit, goes to Ada", async () => {
  const w = await world({
    agents: ["ada", "theo"],
    route: {
      "dá pra subir esse número pra 80?": { needs: 0.7, scores: { ada: 0.55, theo: 0.58 }, best: ["theo", 0.4] },
    },
    script: { ada: [{ text: "Dá: faltam testes no módulo de pagamentos, começo por ele." }] },
  });
  await w.past("ana", "@ada qual a cobertura de testes?", 24);
  await w.past("@ada", "72% no total.", 23);
  await w.say("dá pra subir esse número pra 80?");
  await w.settle();
  expect((await w.runs()).map((r) => w.handleOf(r.agentId))).toEqual(["ada"]);
  await assertInvariants(w);
});

scenario("S04", "the agent a message speaks to answers it, then asks the one it names", async () => {
  const body = "ada, pergunta pro theo quando fecha o sprint";
  const w = await world({
    agents: ["ada", "theo"],
    route: { [body]: { needs: 0.6, scores: { ada: 0.45, theo: 0.7 }, addressee: "ada" } },
    script: {
      ada: [
        { calls: [{ name: "ask_agent", input: { agent: "@theo", question: "Quando fecha o sprint?" } }] },
        { text: "Perguntei ao Theo, já te digo." },
        { text: "O Theo disse que o sprint fecha sexta." },
      ],
      theo: [{ text: "O sprint fecha sexta." }],
    },
  });
  await w.say(body);
  await w.settle();
  expect((await w.decisions())[0]?.picked).toEqual(["ada"]);
  expect((await w.posts("ada")).at(-1)?.body).toContain("sexta");
  await assertInvariants(w);
});

scenario("S05", "a message to every agent gets each of them once, and none wakes another", async () => {
  const body = "bom dia time, cada um diga em que está";
  const w = await world({
    agents: ["otto", "ada"],
    route: { [body]: { needs: 0.9, everyone: 0.9, scores: { otto: 0.8, ada: 0.8 } } },
    script: { otto: [{ text: "Fechando o release." }], ada: [{ text: "Nos testes de pagamento." }] },
  });
  await w.say(body);
  await w.settle();
  expect((await w.runs()).map((r) => w.handleOf(r.agentId)).sort()).toEqual(["ada", "otto"]);
  expect((await w.posts()).length).toBe(2);
  await assertInvariants(w);
});

scenario("S06", "two people talking to each other wake nobody", async () => {
  const w = await world({
    agents: ["otto", "ada"],
    people: ["bruno"],
    route: {
      "consegue revisar até amanhã, Bruno?": { needs: 0.3, scores: { otto: 0.1, ada: 0.1 } },
      "consigo sim": { needs: 0.3, scores: { otto: 0.1, ada: 0.1 } },
    },
  });
  await w.say("consegue revisar até amanhã, Bruno?");
  await w.settle();
  await w.say("consigo sim", { as: "bruno" });
  await w.settle();
  expect(await w.runs()).toEqual([]);
  await assertInvariants(w);
});

scenario("S07", "a greeting to a person wakes nobody", async () => {
  const w = await world({
    agents: ["otto", "ada"],
    people: ["joana"],
    route: { "boa tarde joana": { needs: 0.2, scores: { otto: 0.1, ada: 0.1 } } },
  });
  await w.say("boa tarde joana");
  await w.settle();
  expect(await w.runs()).toEqual([]);
  await assertInvariants(w);
});

scenario("S08", "an ack after the agent answered wakes nobody and posts nothing", async () => {
  const w = await world({
    agents: ["otto", "ada"],
    route: { valeu: { needs: 0.1, scores: { otto: 0.1, ada: 0.05 } } },
  });
  await w.past("ana", "@otto roda os testes", 3);
  await w.past("@otto", "Rodei: 120 passaram.", 2);
  await w.say("valeu");
  await w.settle();
  expect(await w.runs()).toEqual([]);
  expect(await w.posts()).toHaveLength(1);
  await assertInvariants(w);
});

scenario(
  "S09",
  "two messages in a row: each is decided, the agent answers, no routing job ends undecided",
  async () => {
    const w = await world({
      agents: ["otto", "ada"],
      route: {
        "Como estamos com as demandas?": { needs: 0.7, scores: { otto: 0.8, ada: 0.2 } },
        "?": { needs: 0.5, scores: { otto: 0.6, ada: 0.1 } },
      },
      script: { otto: [{ text: "Três abertas: login, export e o bug do PDF." }] },
    });
    const first = await w.say("Como estamos com as demandas?");
    const second = await w.say("?");
    await w.settle();
    const decided = (await w.decisions()).map((d) => d.messageId);
    expect(decided).toContain(first.id);
    expect(decided).toContain(second.id);
    expect((await w.runs()).map((r) => w.handleOf(r.agentId))).toEqual(["otto"]);
    await assertInvariants(w);
  },
);

/** Ada thanks Theo in her answer to ana; the mention judge reads it with `needsNothing`. */
async function thanks(handoff: number, needsNothing: number) {
  const w = await world({
    agents: ["ada", "theo"],
    judge: { mention: { theo: { handoff, needsNothing } } },
    script: {
      ada: [{ text: "Revisou sim. valeu @theo, ficou ótimo" }],
      theo: [{ calls: [{ name: "pass", input: { reason: "Só um agradecimento." } }] }],
    },
  });
  await w.say("@ada o theo já revisou?");
  await w.settle();
  return w;
}

scenario("S10a", "a thanks an agent is sure needs nothing wakes nobody", async () => {
  const w = await thanks(0.05, 0.95);
  expect(await w.runs("theo")).toEqual([]);
  await assertInvariants(w);
});

scenario("S10b", "a thanks the judge is unsure of wakes the agent once, it passes and posts nothing", async () => {
  const w = await thanks(0.3, 0.7);
  expect(await w.runs("theo")).toHaveLength(1);
  expect(await w.posts("theo")).toEqual([]);
  expect(await w.runs()).toHaveLength(2);
  await assertInvariants(w);
});

scenario("S10c", "polite agents whose mention judge is down don't thank each other in a loop", async () => {
  const w = await world({
    agents: ["ada", "theo"],
    judge: { mention: { ada: "fail", theo: "fail" } },
    script: {
      ada: ({ n }) => ({ text: n === 1 ? "Revisou sim. valeu @theo, ficou ótimo" : "👍 @theo" }),
      theo: () => ({ text: "De nada, @ada!" }),
    },
  });
  await w.say("@ada o theo já revisou?");
  await w.settle();
  expect((await w.runs("theo")).length).toBeLessThanOrEqual(1);
  await assertInvariants(w);
});

scenario(
  "S11",
  "a verdict handed back by mention wakes the agent for the person, and the hand-off closes",
  async () => {
    const w = await world({
      agents: ["nina", "otto"],
      judge: { mention: { otto: { handoff: 0.16, needsNothing: 0.3 } } },
      script: {
        nina: [{ text: "Revisei o #227: aprovado com 2 ressalvas (nome da env e um teste). @otto, o resumo é esse" }],
        otto: [{ text: "Ana, ajustei as 2 ressalvas da Nina; o #227 está pronto para merge." }],
      },
    });
    await w.say("@nina revisa o PR #227 do Otto");
    await w.settle();
    const [run] = await w.runs("otto");
    expect(run).toBeDefined();
    expect((await runAuthority(w.db, run as NonNullable<typeof run>)).kind).toBe("person");
    expect(await w.posts("otto")).toHaveLength(1);
    // A hand-off by mention closes in the conversation itself: Otto's answer is there for Nina and the person, so
    // Nina isn't woken again for it (a failure is reported to her instead: S30, ADR 0097).
    expect(await w.runs("nina")).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S12", "a handover by mention wakes the agent, and it can act on it", async () => {
  const w = await world({
    agents: ["otto", "caio"],
    judge: { mention: { caio: { handoff: 0.42, needsNothing: 0.42 } } },
    setup: { toolSources: [openPullRequestTool()] },
    script: {
      otto: [{ text: "@caio, assume o #225 a partir do gate e abre o PR" }],
      caio: [
        { calls: [{ name: "open_pull_request", input: { repo: "acme/app", title: "#225 gate" } }] },
        { text: "Abri o PR do #225." },
      ],
    },
  });
  await w.grant("caio", ["github:pr.write"]);
  await w.say("@otto passa o #225 para o Caio");
  await w.settle();
  const calls = await w.calls("caio");
  expect(calls.map((c) => [c.name, c.isError])).toEqual([["open_pull_request", false]]);
  await assertInvariants(w);
});

scenario(
  "S37",
  "a hand-off by @ to an agent outside a DM reaches nobody, and the author is told to use tell_agent",
  async () => {
    const w = await world({
      agents: ["ada", "nina"],
      dmWith: "ada",
      judge: { followThrough: (s) => (s.unreached ? "continue" : "done") },
      script: {
        ada: [
          { text: "@nina revisa o PR #227" },
          { calls: [{ name: "tell_agent", input: { agent: "@nina", message: "Revisa o PR #227." } }] },
          { text: "Pedi para a Nina revisar o #227." },
          { text: "A Nina aprovou o #227." },
        ],
        nina: [{ text: "Aprovado." }],
      },
    });
    await w.say("pede para a nina revisar o #227");
    await w.settle();
    expect((await w.calls("ada")).map((c) => c.name)).toEqual(["tell_agent"]);
    expect(await w.runs("nina")).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S48", "an agent outside the conversation only named in an answer costs no extra turn", async () => {
  const w = await world({
    agents: ["otto", "vera"],
    dmWith: "otto",
    judge: {
      followThrough: (s) => (String(s.reply).includes("Quem cuida") || s.reply === "Ok." ? "done" : "continue"),
      mention: { vera: { handoff: 0.05, needsNothing: 0.95 } },
    },
    script: { otto: [{ text: "Quem cuida do deploy é a @vera." }, { text: "Ok." }] },
  });
  await w.say("quem cuida do deploy?");
  await w.settle();
  expect((await w.posts("otto")).map((m) => m.body)).toEqual(["Quem cuida do deploy é a @vera."]);
  expect(w.f.provider.calls.filter((c) => !c.request.outputSchema)).toHaveLength(1);
  expect(await w.runs("vera")).toHaveLength(0);
  // Not silent for the author either: its next run reads that the mention reached nobody.
  await w.say("valeu");
  await w.settle();
  expect(JSON.stringify(w.f.provider.calls.filter((c) => !c.request.outputSchema).at(-1)?.request.messages)).toContain(
    "your mention didn't reach it",
  );
  await assertInvariants(w);
});

scenario("S52", "a passing @ of an agent outside a public channel wakes nobody and costs no extra turn", async () => {
  const w = await world({
    agents: ["ada", "nina"],
    judge: { followThrough: () => "done", mention: { nina: { handoff: 0.9, needsNothing: 0.1 } } },
    script: { ada: [{ text: "O arquivo do app vem da @nina." }], nina: [{ text: "Eu de novo." }] },
  });
  await removeChannelMember(w.db, w.owner.id, w.org.id, w.channelId, { agentId: w.agents.nina?.id ?? "" });
  await w.say("@ada de onde vem o arquivo do app?");
  await w.settle();
  expect(await w.runs("nina")).toHaveLength(0);
  const here = (await w.posts("ada")).filter((m) => m.channelId === w.channelId);
  expect(here.map((m) => m.body)).toEqual(["O arquivo do app vem da @nina."]);
  await assertInvariants(w);
});

scenario(
  "S43",
  "a mention dispatch can't wake is recorded and told once to the agent that wrote it, never as a run of its own",
  async () => {
    const w = await world({
      agents: ["ada", "otto"],
      people: ["bia"],
      script: {
        ada: [{ text: "@otto, roda o deploy 88 por favor" }],
      },
    });
    // Otto answers only Bia, its owner: Ana, behind Ada's run, may not talk to it.
    await w.db
      .update(schema.agents)
      .set({ ownerUserId: w.people.bia?.id ?? "", audienceMode: "people", audienceUserIds: [], consultable: false })
      .where(eq(schema.agents.id, w.agents.otto?.id ?? ""));
    await w.say("@ada pede pro otto rodar o deploy 88");
    await w.settle();
    expect(await w.runs("otto")).toEqual([]);
    const [first] = await w.posts("ada");
    const decision = (await w.decisions()).find((d) => d.messageId === first?.id);
    expect(decision?.picked).toEqual(["otto"]);
    expect(decision?.reason).toContain("audience: @otto");
    const notices = (await w.db.select().from(schema.messages)).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "wake_skipped",
    );
    expect(notices).toHaveLength(1);
    // Ada's run had ended: the notice waits for her next turn, the line under her message tells the people.
    expect(await w.runs("ada")).toHaveLength(1);
    expect((await w.posts("ada")).map((m) => m.body)).toEqual(["@otto, roda o deploy 88 por favor"]);
    await assertInvariants(w);
  },
);

/** Starts the outbox in the background and waits until a run is working (inside its quiet window, ADR 0112). */
async function settleOnceRunning(w: Awaited<ReturnType<typeof world>>) {
  const settled = w.settle();
  const start = Date.now();
  while (!(await w.runs()).some((r) => r.status === "running")) {
    if (Date.now() - start > 5000) throw new Error("no run started");
    await Bun.sleep(5);
  }
  return settled;
}

scenario("S54", "three messages in a row in a DM get one run and one answer that read them all", async () => {
  const w = await world({
    agents: ["otto"],
    dmWith: "otto",
    setup: { quietMs: 400 },
    script: {
      otto: ({ request }) =>
        JSON.stringify(request.messages).includes("se bate com o quadro")
          ? { text: "Bate: 42 tarefas no relatório e no quadro." }
          : { text: "Oi! Em que posso ajudar?" },
    },
  });
  await w.say("oi");
  const settled = settleOnceRunning(w);
  await w.say("preciso de uma coisa");
  await w.say("olha o relatório de ontem e me diz se bate com o quadro");
  await settled;
  await w.settle();
  expect(await w.runs()).toHaveLength(1);
  expect((await w.posts("otto")).map((m) => m.body)).toEqual(["Bate: 42 tarefas no relatório e no quadro."]);
  await assertInvariants(w);
});

scenario(
  "S55",
  "a mention then follow-ups without @, two agents in the channel: only that agent, one run",
  async () => {
    const w = await world({
      agents: ["otto", "ada"],
      setup: { quietMs: 400 },
      script: { otto: [{ text: "Bate: 42 tarefas no relatório e no quadro." }] },
    });
    await w.say("@otto oi");
    const settled = settleOnceRunning(w);
    await w.say("preciso de uma coisa");
    await w.say("olha o relatório de ontem e me diz se bate com o quadro");
    await settled;
    await w.settle();
    expect((await w.runs()).map((r) => w.handleOf(r.agentId))).toEqual(["otto"]);
    expect(await w.posts("ada")).toEqual([]);
    await assertInvariants(w);
  },
);

scenario("S56", "an update sent during the agent's model call joins its run and widens the task", async () => {
  let w!: Awaited<ReturnType<typeof world>>;
  w = await world({
    agents: ["otto"],
    dmWith: "otto",
    script: {
      // The update is sent while the first model call is in flight, and that call ends only once it is in.
      otto: ({ n, last }) =>
        n === 1
          ? { text: "Montando o relatório desta semana.", hold: w.say("ah, e inclui a semana passada também") }
          : last.includes("inclui a semana passada")
            ? { text: "Pronto, com a semana passada também." }
            : undefined,
    },
  });
  await w.say("monta o relatório desta semana");
  await w.settle();
  const runs = await w.runs();
  expect(runs).toHaveLength(1);
  expect((runs[0]?.transcript as { request?: string } | null)?.request).toContain("inclui a semana passada");
  expect((await w.posts("otto")).at(-1)?.body).toBe("Pronto, com a semana passada também.");
  await assertInvariants(w);
});
