import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { systemText, textOf } from "@agenteschat/providers";
import { closeWorlds, type World, world } from "./autonomy/harness";
import { assertInvariants } from "./autonomy/invariants";

// The turn-end controller (ADR 0097, addendum 2026-11-10) never loses a reply it held back, and never nudges a promise
// something already keeps. On the autonomy harness: the real engine, the fake provider, scripted judgments.

afterEach(closeWorlds);

const nudges = async (w: World, kind: string) =>
  (await w.steps((await w.runs()).map((r) => r.id))).filter((s) => s.data.nudged === kind).length;

/** The messages each model call of `handle` read, in order. */
const requestsOf = (w: World, handle: string) =>
  w.f.provider.calls
    .filter((c) => new RegExp(`You are [^\\n]*? \\(@${handle}\\)`).test(systemText(c.request.system)))
    .map((c) => c.request.messages);

describe("a reply held back as untried", () => {
  const SALES =
    "Vendas de novembro no Stripe: R$ 48.200 brutos em 312 cobranças, R$ 1.150 em reembolsos, R$ 47.050 líquidos. A API não separa por produto.";
  const NOTHING_TO_ADD = "Sem nada a acrescentar: a consulta já foi respondida acima.";
  /** The complete answer read as a give-up, the false positive this guards against; anything else is done. */
  const salesUntried = (s: Record<string, unknown>) =>
    String(s.reply).startsWith("Vendas de novembro") ? "untried" : "done";

  test("a follow-up's answer, then a pass after the nudge: the answer is posted once", async () => {
    const w = await world({
      agents: ["rui"],
      judge: { followThrough: salesUntried },
      script: {
        rui: [
          {
            calls: [
              {
                name: "follow_up",
                input: { minutes: 3, note: "Mandar os números da consulta de vendas do Stripe.", about: "as vendas" },
              },
            ],
          },
          { text: "A consulta do Stripe ainda está processando; volto em uns 3 minutos." },
          { text: SALES },
          { text: NOTHING_TO_ADD, calls: [{ name: "pass", input: { reason: "" } }] },
        ],
      },
    });
    await w.say("@rui quanto vendemos em novembro no Stripe?");
    await w.settle();
    await w.advance(4);
    expect((await w.posts("rui")).map((p) => p.body)).toEqual([
      "A consulta do Stripe ainda está processando; volto em uns 3 minutos.",
      SALES,
    ]);
    expect(await nudges(w, "untried")).toBe(1);
    // The turn after the nudge read its draft as unseen.
    const after = requestsOf(w, "rui").at(-1) ?? [];
    expect(textOf(after.at(-2)?.content ?? "")).toBe(SALES);
    expect(textOf(after.at(-1)?.content ?? "")).toContain("Not posted yet: nobody has seen your reply above.");
    const back = (await w.runs("rui"))[1];
    expect(back?.status).toBe("done");
    expect((back?.transcript as { held?: string } | undefined)?.held).toBeUndefined();
    await assertInvariants(w);
  });

  test("'nothing to add' from a run that must answer: the held answer goes out instead", async () => {
    const w = await world({
      agents: ["rui"],
      judge: {
        followThrough: salesUntried,
        heldReply: (s) => (String(s.reply).startsWith("Sem nada") ? "held" : "reply"),
      },
      script: { rui: [{ text: SALES }, { text: NOTHING_TO_ADD }] },
    });
    await w.say("@rui quanto vendemos em novembro no Stripe?");
    await w.settle();
    expect((await w.posts("rui")).map((p) => p.body)).toEqual([SALES]);
    const [read] = w.judgedAs("held_reply");
    expect(read?.state).toMatchObject({ held: SALES, reply: NOTHING_TO_ADD });
    // The held answer was judged already: the turn that added nothing isn't judged again.
    expect(w.judgedAs("follow_through")).toHaveLength(1);
    await assertInvariants(w);
  });

  test("a reply that builds on the held answer goes out with it", async () => {
    const more = "Conferi também: nenhum reembolso pendente.";
    const w = await world({
      agents: ["rui"],
      judge: { followThrough: salesUntried, heldReply: () => "both" },
      script: { rui: [{ text: SALES }, { text: more }] },
    });
    await w.say("@rui quanto vendemos em novembro no Stripe?");
    await w.settle();
    expect((await w.posts("rui")).map((p) => p.body)).toEqual([`${SALES}\n\n${more}`]);
    await assertInvariants(w);
  });
});

describe("a promise something already keeps", () => {
  const printPromise = (s: Record<string, unknown>) =>
    /mando o print|volto/.test(String(s.reply)) ? "continue" : "done";

  test("a follow-up set earlier: no nudge and no second status", async () => {
    const w = await world({
      agents: ["otto"],
      judge: { followThrough: printPromise },
      script: {
        otto: [
          { calls: [{ name: "follow_up", input: { minutes: 15, note: "Mandar o print do app.", about: "o print" } }] },
          { text: "O app ainda está abrindo; volto às 22:05 com o print." },
          { text: "Assim que o app abrir, mando o print aqui." },
          { text: "Ainda na fila: por volta das 22:06 eu volto." },
        ],
      },
    });
    await w.say("@otto manda um print do app");
    await w.settle();
    await w.say("@otto e o print?");
    await w.settle();
    expect(await nudges(w, "promise")).toBe(0);
    expect((await w.posts("otto")).map((p) => p.body)).toEqual([
      "O app ainda está abrindo; volto às 22:05 com o print.",
      "Assim que o app abrir, mando o print aqui.",
    ]);
    const second = (await w.runs("otto"))[1];
    expect((second?.transcript as { followThroughVerdict?: string } | undefined)?.followThroughVerdict).toBe("waiting");
    await assertInvariants(w);
  });

  test("its long work running in that thread: no nudge and no second status", async () => {
    const w = await world({
      agents: ["otto"],
      judge: { followThrough: printPromise },
      script: {
        otto: [{ text: "Assim que o app abrir, mando o print aqui." }, { text: "Ainda na fila: volto já." }],
      },
    });
    const anchor = await w.past("@otto", "Vou cuidar do print do app em segundo plano.", 5);
    await w.db.insert(schema.agentWorks).values({
      orgId: w.org.id,
      agentId: w.agents.otto?.id ?? "",
      channelId: w.channelId,
      anchorMessageId: anchor.id,
      title: "Print do app",
      ownThread: true,
      how: "agent",
      lastUpdateAt: new Date(),
      status: "live",
    });
    await w.say("@otto e o print?", { threadId: anchor.id });
    await w.settle();
    expect(await nudges(w, "promise")).toBe(0);
    expect((await w.posts("otto")).map((p) => p.body)).toEqual([
      "Vou cuidar do print do app em segundo plano.",
      "Assim que o app abrir, mando o print aqui.",
    ]);
    await assertInvariants(w);
  });
});
