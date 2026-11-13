import { describe, expect, test } from "bun:test";
import {
  endsWithSentinel,
  isSentinelOnly,
  pauseLead,
  replyPolicyFor,
  stripSentinel,
  visibleText,
  WHY_YOU_WERE_CALLED,
} from "../src/reply-policy";

const run = (over: Partial<{ trigger: "mention" | "router" | "dm"; background: boolean; hop: number }> = {}) => ({
  agentId: "a1",
  trigger: "router" as const,
  background: false,
  hop: 1,
  ...over,
});
const person = (meta: Record<string, unknown> = {}) => ({ authorType: "person" as const, meta });

describe("replyPolicyFor", () => {
  test("only runs nobody called by name may pass", () => {
    expect(replyPolicyFor(run(), person())).toEqual({ mayPass: true, background: false });
    // Brought in after another agent spoke (`meta.joined`).
    expect(replyPolicyFor(run(), { authorType: "agent", meta: {} }).mayPass).toBe(true);
    for (const trigger of ["mention", "dm"] as const)
      expect(replyPolicyFor(run({ trigger }), person()).mayPass).toBe(false);
  });

  test("another agent's @mention may pass; a person's click on it, or the agent's own line, must answer", () => {
    const byQa = { authorType: "agent" as const, authorAgentId: "a2", meta: {} };
    expect(replyPolicyFor(run({ trigger: "mention", hop: 2 }), byQa)).toEqual({ mayPass: true, background: false });
    // Continuar on a pause card or "Responder agora" starts it at hop 1, in a fresh stretch.
    expect(replyPolicyFor(run({ trigger: "mention", hop: 1 }), byQa).mayPass).toBe(false);
    // Its own line (a task's end, a follow-up) is no other agent calling it.
    const own = { authorType: "agent" as const, authorAgentId: "a1", meta: {} };
    expect(replyPolicyFor(run({ trigger: "mention", hop: 2 }), own).mayPass).toBe(false);
    expect(replyPolicyFor(run({ trigger: "mention", hop: 2 }), byQa, { answerOwed: true }).mayPass).toBe(false);
  });

  test("never a quote reply to it, a follow-up, a routine's call or a run a person answered", () => {
    expect(replyPolicyFor(run(), person({ replyTo: { author: { type: "agent", id: "a1" } } })).mayPass).toBe(false);
    // Quoting another agent: still brought in.
    expect(replyPolicyFor(run(), person({ replyTo: { author: { type: "agent", id: "a2" } } })).mayPass).toBe(true);
    expect(replyPolicyFor(run(), person(), { followUp: true }).mayPass).toBe(false);
    expect(replyPolicyFor(run(), person({ routine: { id: "r", name: "x" } })).mayPass).toBe(false);
    expect(replyPolicyFor(run(), person(), { answerOwed: true }).mayPass).toBe(false);
  });

  test("a request of its own withdrawn as moot lets it stay quiet, called by name or not, unless a person is owed", () => {
    expect(replyPolicyFor(run({ trigger: "mention" }), person(), { moot: true }).mayPass).toBe(true);
    expect(replyPolicyFor(run({ trigger: "dm" }), person(), { moot: true }).mayPass).toBe(true);
    expect(replyPolicyFor(run({ trigger: "mention" }), person(), { moot: true, answerOwed: true }).mayPass).toBe(false);
    expect(replyPolicyFor(run({ background: true }), person(), { moot: true })).toEqual({
      mayPass: false,
      background: true,
    });
  });

  test("another agent's message about its routine's report: an agent the router brings in may still pass", () => {
    const report = { routine: { id: "r", name: "Sentry", runId: "rr" } };
    expect(replyPolicyFor(run(), { authorType: "agent", meta: report }).mayPass).toBe(true);
    // A routine's own call (a person's message written for its creator) never.
    expect(replyPolicyFor(run(), person(report)).mayPass).toBe(false);
  });

  test("a run brought in passes on a thanks without looking anything up first", () => {
    // Eval 2026-10-23 (router-pass-already-answered): on "perfeito, obrigada!" after another agent
    // answered, the run re-checked the deploy instead of passing.
    expect(WHY_YOU_WERE_CALLED).toContain("call pass");
    expect(WHY_YOU_WERE_CALLED).toContain("A thanks, an ok");
    expect(WHY_YOU_WERE_CALLED).toContain("without looking anything up");
    expect(WHY_YOU_WERE_CALLED).toContain("without re-checking an answer already given");
  });

  test("a run the router woke on a greeting or an 'alô???' answers in one short line", () => {
    expect(WHY_YOU_WERE_CALLED).toContain(
      'A greeting, or someone asking whether anyone is there because nobody answered ("alô???"), gets one short friendly line back, nothing more.',
    );
  });

  test("a run a note, a late result, its own fast reply, its follow-up or a news-only report woke may pass; an answer may not", () => {
    const notice = (kind: string) => ({ authorType: "agent" as const, meta: { notice: { kind, text: "x" } } });
    for (const kind of ["agent_note", "wait_result", "talker_reply", "follow_up"])
      expect(replyPolicyFor(run({ trigger: "mention" }), notice(kind))).toEqual({ mayPass: true, background: false });
    expect(replyPolicyFor(run({ trigger: "mention" }), notice("consult_reply")).mayPass).toBe(false);
    // A routine's report: quiet allowed when it speaks only on news; one that reports every time always posts.
    const report = (report: string) => ({
      authorType: "agent" as const,
      meta: { notice: { kind: "routine_handoff", text: "x", refs: { report } } },
    });
    expect(replyPolicyFor(run({ trigger: "mention" }), report("when_new")).mayPass).toBe(true);
    expect(replyPolicyFor(run({ trigger: "mention" }), report("always")).mayPass).toBe(false);
    // A person wrote into it meanwhile: it owes them an answer.
    expect(replyPolicyFor(run({ trigger: "mention" }), notice("agent_note"), { answerOwed: true }).mayPass).toBe(false);
  });

  test("background runs never post their answer", () => {
    expect(replyPolicyFor(run({ trigger: "mention", background: true }), person())).toEqual({
      mayPass: false,
      background: true,
    });
  });
});

describe("the sentinel", () => {
  test("alone, in any wrapping, is sentinel-only", () => {
    for (const t of [
      "NO_REPLY",
      " NO_REPLY. ",
      "**NO_REPLY**",
      "`NO_REPLY`",
      "no_reply",
      "NO-REPLY",
      "NOREPLY",
      "[NO_REPLY]",
      '"NO_REPLY"',
      "NO REPLY",
      "\n\nNO_REPLY\n",
      "NO_REPLY\nNO_REPLY",
      "NO",
      "NO_RE",
    ])
      expect(isSentinelOnly(t)).toBe(true);
  });

  test("real answers are never the sentinel", () => {
    for (const t of ["", "  ", "No reply.", "No", "no", "Não.", "Sem NO_REPLY_COUNT aqui", "NOW"])
      expect(isSentinelOnly(t)).toBe(false);
  });

  test("stripped anywhere on its own line, or glued to the start or end of real text", () => {
    expect(stripSentinel("Nada novo.\n\nNO_REPLY")).toBe("Nada novo.");
    expect(stripSentinel("NO_REPLY\n\nNovidade: 3 avaliações.")).toBe("Novidade: 3 avaliações.");
    expect(stripSentinel("Primeiro.\n`NO_REPLY`\nSegundo.")).toBe("Primeiro.\nSegundo.");
    expect(stripSentinel("NO_REPLY Claro, aqui está.")).toBe("Claro, aqui está.");
    expect(stripSentinel("NO_REPLYClaro.")).toBe("Claro.");
    expect(stripSentinel("Feito. NO_REPLY")).toBe("Feito.");
    expect(stripSentinel("Feito.NO_REPLY")).toBe("Feito.");
    expect(stripSentinel("Feito. **NO_REPLY**")).toBe("Feito.");
    // Part of an identifier, or another word: left alone.
    expect(stripSentinel("A flag SEND_NO_REPLY está ligada.")).toBe("A flag SEND_NO_REPLY está ligada.");
    expect(stripSentinel("NO_REPLY_COUNT é 3")).toBe("NO_REPLY_COUNT é 3");
    expect(stripSentinel("No reply from the client yet.")).toBe("No reply from the client yet.");
    expect(stripSentinel("NO")).toBe("");
  });

  test("endsWithSentinel: the model meant silence (alone, or closing a note)", () => {
    expect(endsWithSentinel("NO_REPLY")).toBe(true);
    expect(endsWithSentinel("Nada novo desde ontem.\n\nNO_REPLY")).toBe(true);
    expect(endsWithSentinel("Nada novo. NO_REPLY")).toBe(true);
    expect(endsWithSentinel("NO_REPLY\n\nNovidade: 3 avaliações.")).toBe(false);
    expect(endsWithSentinel("Novidade.")).toBe(false);
  });

  test("streaming: held while it could still be the word, never shown, and what was shown only grows", () => {
    const stream = (chunks: string[]) => {
      let all = "";
      let shown = "";
      const seen: string[] = [];
      for (const c of chunks) {
        all += c;
        const v = visibleText(all, false);
        expect(v.startsWith(shown)).toBe(true);
        shown = v;
        seen.push(v);
      }
      const end = visibleText(all, true);
      if (end.startsWith(shown)) shown = end;
      return { shown, seen };
    };
    for (const chunks of [
      ["NO", "_REP", "LY"],
      ["**NO_", "REPLY**", "."],
      ["N", "O"],
    ]) {
      const { shown, seen } = stream(chunks);
      expect(shown.trim()).toBe("");
      for (const s of seen) expect(s).not.toContain("NO");
    }
    const glued = stream(["NO_REP", "LY Claro", ", aqui."]);
    expect(glued.shown).toBe("Claro, aqui.");
    const closing = stream(["Nada ", "novo.\n\n", "NO_R", "EPLY"]);
    expect(closing.shown.trim()).toBe("Nada novo.");
    for (const s of closing.seen) expect(s).not.toContain("NO");
    const suffix = stream(["Feito. ", "NO_", "REPLY"]);
    expect(suffix.shown.trim()).toBe("Feito.");
    for (const s of suffix.seen) expect(s).not.toContain("NO");
    // Ordinary text streams at once (a word that only starts like it is shown as soon as it isn't).
    const plain = stream(["Os builds ", "rodam no ", "GitHub Actions."]);
    expect(plain.seen).toEqual(["Os builds ", "Os builds rodam no ", "Os builds rodam no GitHub Actions."]);
    expect(stream(["NOW ", "is fine"]).shown).toBe("NOW is fine");
  });
});

describe("what a run posts beside the request it stops on", () => {
  test("a line that only announces the card stays out; real work written in the same step is posted", () => {
    expect(pauseLead("Vou pedir `calendar:read`, que é só leitura. Pode aprovar ou recusar à vontade.")).toBe("");
    expect(pauseLead("")).toBe("");
    const analysis = "Comparei os três fornecedores e o segundo sai mais barato por causa do frete. ".repeat(5);
    expect(pauseLead(analysis)).toBe(analysis);
  });
});
