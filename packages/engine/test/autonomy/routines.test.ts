import { afterEach, expect } from "bun:test";
import { schema } from "@agenteschat/db";
import { createRoutine, DIGEST_AFTER_MS, executeRoutineRun, postAutonomyDigests, queueRoutineRun } from "../../src";
import { routineDeps, routineRow, routineRunRow } from "../routine-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";
import { openPullRequestTool } from "./tools";

// Routines (ADR 0053) against I3, I4, I6 and I7: what one hands to an agent can be done, what a read one limits is
// said, a quiet one stays quiet, and one that could never fire is refused.

afterEach(closeWorlds);

/** An hourly routine of `handle` reporting to the scenario's channel, fired once now; settles. */
async function fireRoutine(w: World, handle: string, prompt: string, access: "read" | "act") {
  const routine = await createRoutine(routineDeps(w.f), w.owner.id, w.org.id, {
    name: "Sentry",
    agentId: w.agents[handle]?.id ?? "",
    prompt,
    target: { type: "channel", channelId: w.channelId },
    trigger: { type: "schedule", phrase: "a cada hora" },
    access,
  });
  const queued = await queueRoutineRun({ db: w.db }, await routineRow(w.f, routine.id), new Date(), "manual");
  if (!queued) throw new Error("not queued");
  await executeRoutineRun(routineDeps(w.f), queued.id);
  await w.settle();
  return routineRunRow(w.f, queued.id);
}

scenario("S25", "a routine set to act hands an error to an agent, which fixes it", async () => {
  const w = await world({
    agents: ["sentinela", "lia"],
    setup: { toolSources: [openPullRequestTool()] },
    script: {
      sentinela: [
        {
          calls: [
            {
              name: "tell_agent",
              input: { agent: "@lia", message: "Erro novo no Sentry: TypeError em checkout.ts:42." },
            },
          ],
        },
        { calls: [{ name: "hand_off", input: { message: "Passei o TypeError de checkout.ts:42 para a Lia." } }] },
        { text: "Feito." },
        // The run the routine's report wakes, then the one Lia's result wakes in the same conversation.
        { text: "Erro novo no checkout (TypeError em checkout.ts:42): passei para a Lia." },
        { text: "A Lia corrigiu o TypeError do checkout no PR #230." },
      ],
      lia: [
        { calls: [{ name: "open_pull_request", input: { repo: "acme/app", title: "Fix TypeError checkout" } }] },
        { text: "Corrigi o TypeError de checkout.ts:42: PR #230." },
      ],
    },
  });
  await w.grant("lia", ["github:pr.write"]);
  // What a routine the workspace set up hands on is asked-for work: Lia opens the PR without a card (ADR 0131 §3).
  await fireRoutine(w, "sentinela", "Checa o Sentry e passa os erros novos para @lia.", "act");
  expect((await w.calls("sentinela")).find((c) => c.name === "tell_agent")?.isError).toBe(false);
  expect((await w.calls("lia")).map((c) => [c.name, c.isError])).toEqual([["open_pull_request", false]]);
  await assertInvariants(w);
});

scenario(
  "S64",
  "a Sentry routine sends 10 alerts: the agent fixes the 2 new ones without asking, the rest wait",
  async () => {
    const sentry = (id: number, what: string) => `Sentry: ${what} https://sentry.example.com/issues/${id}/`;
    const fresh = [sentry(101, "TypeError em checkout.ts:42"), sentry(102, "Falha ao gravar pedido em orders.ts:88")];
    const old = [201, 202, 203, 204, 205, 206].map((id) => sentry(id, `Timeout conhecido no relatório ${id}`));
    // The same two items again, as Sentry sends another event of each while they are being fixed.
    const again = [
      sentry(101, "TypeError em checkout.ts:42 (mais 12 eventos)"),
      sentry(102, "Falha ao gravar pedido (mais 3 eventos)"),
    ];
    const opened = new Set<string>();
    const w = await world({
      agents: ["sentinela", "lia"],
      setup: { toolSources: [openPullRequestTool()] },
      judge: { triage: (state) => (/conhecido/.test(String(state.message)) ? "noise" : "work") },
      script: {
        sentinela: ({ n }) =>
          n === 1
            ? {
                calls: [...fresh, ...old, ...again].map((message) => ({
                  name: "tell_agent",
                  input: { agent: "@lia", message },
                })),
              }
            : n === 2
              ? { calls: [{ name: "hand_off", input: { message: "Passei os erros do Sentry para a Lia." } }] }
              : { text: "Feito." },
        lia: ({ request }) => {
          const seen = JSON.stringify(request.messages);
          for (const id of ["101", "102"])
            if (seen.includes(`issues/${id}`) && !opened.has(id)) {
              opened.add(id);
              return { calls: [{ name: "open_pull_request", input: { repo: "acme/app", title: `Fix Sentry ${id}` } }] };
            }
          return { text: "Corrigido, PR aberto." };
        },
      },
    });
    await w.grant("lia", ["github:pr.write"]);
    await fireRoutine(w, "sentinela", "Quando o Sentry mandar um erro, passe para @lia corrigir.", "act");
    const prs = (await w.calls("lia")).filter((c) => c.name === "open_pull_request");
    // Asked-for work (a source the workspace set up): no card, no refusal, one PR per new item.
    expect(prs.map((c) => c.isError)).toEqual([false, false]);
    expect([...opened].sort()).toEqual(["101", "102"]);
    const cards = (await w.db.select().from(schema.messages)).filter(
      (m) => (m.meta as { actionCard?: { kind?: string } }).actionCard?.kind === "autonomy_proposal",
    );
    expect(cards).toEqual([]);
    const signals = await w.db.select().from(schema.autonomySignals);
    const of = (kind: string) => signals.filter((x) => x.kind === kind).length;
    expect({ wake: of("wake"), digest: of("digest"), linked: of("linked") }).toEqual({ wake: 2, digest: 6, linked: 2 });
    // An hour later the 6 known ones go to a person in one summary, where the routine reports.
    expect(await postAutonomyDigests({ db: w.db }, new Date(Date.now() + 2 * DIGEST_AFTER_MS))).toBe(1);
    const digest = (await w.db.select().from(schema.messages)).find(
      (m) => (m.meta as { bodyCode?: string }).bodyCode === "autonomy_digest",
    );
    expect(digest?.channelId).toBe(w.channelId);
    expect(digest?.body.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(6);
    // It is for a person: nobody is routed to it.
    await w.settle();
    expect((await w.runs()).filter((r) => r.triggerMessageId === digest?.id)).toEqual([]);
    await assertInvariants(w);
  },
);

scenario("S26", "a routine says whose reach it works within, and its report run can still ask", async () => {
  const w = await world({
    agents: ["otto"],
    script: {
      otto: ({ system, n }) => {
        if (n === 1)
          // A decision for the people there (whether the routine may fix them): `wake_me`, so a report run asks it.
          return {
            calls: [{ name: "hand_off", input: { message: "3 erros novos no checkout desde as 9h.", wake_me: true } }],
          };
        if (n === 2) return { text: "Entreguei." };
        if (system.includes("routine") && n === 3)
          return {
            calls: [
              {
                name: "ask_user",
                input: {
                  question: "Quer que essa rotina passe a corrigir sozinha os erros do checkout?",
                  choices: ["Sim", "Não"],
                  why: "A rotina só olha: os 3 erros do checkout ficam abertos até alguém corrigir.",
                },
              },
            ],
          };
        return undefined;
      },
    },
  });
  await fireRoutine(w, "otto", "Checa os erros novos do checkout.", "read");
  const background = w.prompts("otto")[0] ?? "";
  // The run is told whose rooms and agents it reaches (I7).
  expect(/What it may do: [^\n]*\bana\b/i.test(background)).toBe(true);
  const asks = (await w.calls("otto")).filter((c) => c.name === "ask_user");
  expect(asks.map((c) => [c.isError, c.result])).toEqual([[false, expect.any(String)]]);
  await assertInvariants(w);
});

scenario("S27", "a routine with nothing new posts nothing and wakes nobody", async () => {
  const w = await world({
    agents: ["sentinela", "lia"],
    script: { sentinela: [{ text: "Nada novo desde ontem.\n\nNO_REPLY" }] },
  });
  const ledger = await fireRoutine(w, "sentinela", "Checa o Sentry.", "read");
  expect(ledger.status).not.toBe("failed");
  expect(await w.posts()).toEqual([]);
  expect((await w.runs()).length).toBe(1);
  await assertInvariants(w);
});

scenario(
  "S39",
  "an event routine nothing can ever fire is refused when it is created, with the setup step",
  async () => {
    const w = await world({
      agents: ["otto"],
      script: {
        otto: [
          {
            calls: [
              {
                name: "create_routine",
                input: { prompt: "Revisa cada PR novo.", trigger: { type: "event", event: "github.pr_opened" } },
              },
            ],
          },
          { text: "Não consegui criar: falta conectar o GitHub ao workspace." },
        ],
      },
    });
    await w.say("@otto revisa cada PR novo que abrirem");
    await w.settle();
    const [call] = (await w.calls("otto")).filter((c) => c.name === "create_routine");
    expect(call?.isError).toBe(true);
    expect(await w.db.select().from(schema.routines)).toEqual([]);
    await assertInvariants(w);
  },
);

scenario("S50", "a routine told to go on keeps what its first turn found in its record", async () => {
  const w = await world({
    agents: ["otto"],
    judge: { followThrough: (s) => (String(s.reply).includes("Vou abrir") ? "continue" : "done") },
    script: {
      otto: [
        { text: "Achei 3 erros novos no Sentry: login, export e push. Vou abrir as issues." },
        { text: "Issues abertas." },
      ],
    },
  });
  const run = await fireRoutine(w, "otto", "Checa o Sentry e abre issues dos erros novos.", "act");
  expect(run?.summary).toContain("Achei 3 erros novos");
  expect(run?.summary).toContain("Issues abertas.");
  await assertInvariants(w);
});

scenario(
  "S51",
  "a routine that already posted ends there: a next check named in its record is no promise",
  async () => {
    const w = await world({
      agents: ["otto"],
      judge: { followThrough: (s) => (String(s.reply).includes("amanhã") ? "continue" : "done") },
      script: {
        otto: [
          { calls: [{ name: "hand_off", input: { message: "Bom dia! Nenhum erro novo no Sentry." } }] },
          { text: "Resumo postado. Checo de novo amanhã às 8h." },
          { text: "A conversation run should not have run." },
        ],
      },
    });
    const run = await fireRoutine(w, "otto", "Me dê um bom dia com o resumo do Sentry.", "act");
    expect(run?.status).toBe("reported");
    // Only its report was judged before it posted (ADR 0109); the turn after it isn't.
    expect(w.judgedAs("follow_through")).toHaveLength(1);
    expect((await w.calls("otto")).map((c) => c.name)).toEqual(["hand_off"]);
    expect((await w.posts()).map((p) => p.body)).toEqual(["Bom dia! Nenhum erro novo no Sentry."]);
    await assertInvariants(w);
  },
);
