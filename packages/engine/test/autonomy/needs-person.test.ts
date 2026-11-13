import { afterEach, describe, expect, test } from "bun:test";
import { askVerdict, HOW_YOU_WORK, type Judge, type ToolSource, turnMeans } from "../../src";
import { continuationVerdict, decideTurnEnd, type TurnEnd, untriedNudge } from "../../src/continuation";
import { HAND_OVER_STEP } from "../../src/tools/directory";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";

// A step that needs the person (a sign-in, a QR code, a code, an approval) is never a blocker (ADR 0097 addendum): the
// agent does everything up to it, hands that step over with its request and goes on. A reply that says it can't
// because of such a step is sent back with the hand-off, in whatever language the conversation is.

afterEach(closeWorlds);

/** The browser hand-off, recorded only (the real one pauses the run until the person is done). */
const handOffs: Record<string, unknown>[] = [];
const fakeBrowserHandOff: ToolSource = {
  name: "browser-handoff",
  tools: async () => [
    {
      name: "browser_ask_person",
      description: "Hand a person the step only they can do in your browser and wait until they're done.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: { instructions: { type: "string" } },
        required: ["instructions"],
        additionalProperties: false,
      },
      execute: async (input) => {
        handOffs.push(input);
        return { content: "The person scanned the QR code: WhatsApp Web is open in your browser." };
      },
    },
  ],
};

/**
 * The judge as the criteria read, by what the run had and did, never by the reply's words: a reply while `means` can
 * hand a step over and `tried` shows no hand-off is `untried`; once the step was handed over, it is done.
 */
const rubric = (state: Record<string, unknown>) => {
  const means = ((state.means ?? []) as string[]).join(" ");
  const tried = ((state.tried ?? []) as string[]).join(" ");
  return means.includes("browser_ask_person") && !tried.includes("browser_ask_person") ? "untried" : "done";
};

const CASES = [
  {
    id: "S65",
    lang: "Portuguese",
    request: "@rui lê minhas mensagens do WhatsApp e me diz o que a Bia pediu",
    giveUp:
      "Pela versão web do WhatsApp eu também não consigo: ela exige você ler o QR code com o celular. Cole aqui o trecho que precisa.",
    instructions: "Escaneie o QR code com o seu celular",
    final: "A Bia pediu o orçamento revisado até sexta.",
  },
  {
    id: "S66",
    lang: "English",
    request: "@rui read my WhatsApp messages and tell me what Bia asked for",
    giveUp:
      "I can't read your WhatsApp: the web version needs you to scan a QR code with your phone. Paste the part you need here.",
    instructions: "Scan the QR code with your phone",
    final: "Bia asked for the revised quote by Friday.",
  },
  {
    id: "S67",
    lang: "Spanish",
    request: "@rui lee mis mensajes de WhatsApp y dime qué pidió Bia",
    giveUp:
      "No puedo leer tu WhatsApp: la versión web exige que escanees un código QR con el móvil. Pega aquí lo que necesites.",
    instructions: "Escanea el código QR con tu móvil",
    final: "Bia pidió el presupuesto revisado para el viernes.",
  },
  {
    id: "S68",
    lang: "French",
    request: "@rui lis mes messages WhatsApp et dis-moi ce que Bia a demandé",
    giveUp:
      "Je ne peux pas lire ton WhatsApp : la version web demande de scanner un QR code avec ton téléphone. Colle ici le passage utile.",
    instructions: "Scanne le QR code avec ton téléphone",
    final: "Bia a demandé le devis révisé pour vendredi.",
  },
];

const nudged = (w: World) =>
  w.f.provider.calls.some((c) =>
    JSON.stringify(c.request.messages).includes("is never a blocker or a reason to say you can't"),
  );

for (const c of CASES) {
  scenario(c.id, `${c.lang}: a "can't, it needs your QR code" is sent back with the hand-off, then done`, async () => {
    handOffs.length = 0;
    const w = await world({
      agents: ["rui"],
      setup: { toolSources: [fakeBrowserHandOff] },
      judge: { followThrough: rubric },
      script: {
        rui: [
          { text: c.giveUp },
          { calls: [{ name: "browser_ask_person", input: { instructions: c.instructions } }] },
          { text: c.final },
        ],
      },
    });
    await w.say(c.request);
    await w.settle();
    // The judge read a hand-off among the means; the give-up was sent back with how to hand the step over.
    const [held] = w.judgedAs("follow_through");
    expect(String(held?.state.reply)).toBe(c.giveUp);
    expect(((held?.state.means ?? []) as string[]).join(" ")).toContain("browser_ask_person");
    expect(nudged(w)).toBe(true);
    expect(handOffs).toEqual([{ instructions: c.instructions }]);
    // Only the final attempt is posted, never the "can't" before it.
    expect((await w.posts("rui")).map((p) => p.body)).toEqual([c.final]);
    await assertInvariants(w);
  });
}

describe("a step that needs the person is never a blocker", () => {
  test("the prompt carries the rule and the consent of a person's own request", () => {
    expect(HOW_YOU_WORK).toContain(`- ${HAND_OVER_STEP} If nothing you have can hand it over`);
    expect(HOW_YOU_WORK).toContain("consents to the access it needs: don't ask again or warn about privacy");
    expect(HOW_YOU_WORK).toContain("Someone else's account is not consent; passwords never come through the chat");
    expect(HOW_YOU_WORK).not.toContain("A real blocker is only");
  });

  test("an approval the person gives is no `request_approval`, which asks someone else", () => {
    expect(HAND_OVER_STEP).toContain("an approval only someone else can give: `request_approval`");
  });

  test("the means name the browser for a service's web version, and the hand-offs the run has", () => {
    const means = turnMeans(new Set(["browser_do", "browser_ask_person", "request_secret"])).join("\n");
    expect(means).toContain("(a service with no connector but a web version)");
    expect(means).toContain("scan a QR code");
    expect(means).toContain("`browser_ask_person`, `request_secret`, then go on");
    expect(turnMeans(new Set(["browser_do"])).join("\n")).not.toContain("hand a person");
  });

  test("the untried nudge hands the step over instead of stopping on it", async () => {
    const t: TurnEnd = {
      state: { count: 0 },
      kind: "conversation",
      executed: 0,
      bound: null,
      quiet: false,
      decided: null,
      unanswered: false,
      unreached: "",
      judged: "I can't: it needs you to sign in.",
      mission: false,
      wakesLater: async () => false,
      verdict: async () => "untried",
      evidence: { means: turnMeans(new Set(["browser_do", "browser_ask_person"])), tried: [] },
    };
    const d = await decideTurnEnd(t);
    expect(d).toMatchObject({ outcome: "continue", rule: "untried" });
    expect(d.nudge).toContain(HAND_OVER_STEP);
    expect(d.nudge).toContain("`browser_ask_person`");
  });

  const capture = () => {
    const asked: { questions: Record<string, { criteria: Record<string, string> }> }[] = [];
    const judge = {
      name: "fake",
      ask: async (q: (typeof asked)[number]) => {
        asked.push(q);
        return { verdict: { choice: "person", probabilities: { person: 0.9 } } };
      },
    } as unknown as Judge;
    return { judge, asked };
  };

  test("the turn-end judge: a stop on a step the means can hand over is untried, never done", async () => {
    const { judge, asked } = capture();
    await continuationVerdict(judge, {
      orgId: "o",
      agentId: "a",
      runId: "r",
      request: "read my messages",
      reply: "I can't: it needs a QR code.",
      means: [],
      tried: [],
      runKind: "conversation",
    });
    const criteria = asked[0]?.questions.verdict?.criteria ?? {};
    expect(criteria.done).toContain("is not done while `means` can hand that step to them: that is untried");
    expect(criteria.untried).toContain("a step that needs the person is never a blocker");
    // Asking first stays right when the way is open, and someone else's account is no consent.
    expect(criteria.done).toContain("one direct question offering to start a way it names");
    expect(criteria.done).toContain("someone else's, not the asking person's own, is done");
    expect(criteria.ask).toContain("A way to do the request itself, even worded 'only if you want'");
    // "Nobody has access, someone please…" without looking in the workspace first is untried.
    expect(criteria.done).toContain("without having looked in the workspace");
    expect(criteria.untried).toContain("without first looking in the workspace");
    expect(untriedNudge([], [])).toContain("Look in the workspace first");
  });

  test("the question check: a way to do the request, however it is worded, is no optional offer", async () => {
    const { judge, asked } = capture();
    await askVerdict(judge, {
      orgId: "o",
      agentId: "a",
      runId: "r",
      question: "I could open WhatsApp Web and you'd scan the QR code, only if you want.",
      request: "read my messages",
      means: [],
      tried: [],
    });
    expect(asked[0]?.questions.verdict?.criteria.none).toContain(
      "A way to do the request itself, or the step it needs from them (a sign-in, a QR code, their consent to their own account), is never this",
    );
  });
});
