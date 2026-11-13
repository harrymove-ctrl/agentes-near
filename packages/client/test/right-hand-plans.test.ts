import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { serverBody } from "../src/lib/message-body";
import { noAiCardOf, planLineKey } from "../src/lib/no-ai";

/** The team's right hand on a plan (ADR 0137 §1, §7), as the web and the phone read it. */

const meta = (reason: string) => ({
  bodyCode: "no_ai",
  noAi: { agentId: "lodi", forUserId: null, reason, intent: "task", runId: "r1" },
});

test("its plan's line: the computer away, the limit, a plan for its owner only; anything else is an ordinary card", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  for (const reason of ["computer_away", "plan_limit", "plan_not_shared"]) {
    expect(noAiCardOf(meta(reason))?.planLine).toBe(reason as never);
    expect(serverBody(t, "…", meta(reason))).toBe(`chat.body.no_ai_${reason}`);
  }
  expect(noAiCardOf(meta("no_key"))?.planLine).toBeUndefined();
  expect(noAiCardOf(meta("not_signed_in"))?.planLine).toBeUndefined();
});

test("a runner to update and a CLI with tools of its own are lines of their own, not 'no AI'", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  for (const reason of ["runner_outdated", "plan_tools"]) {
    expect(noAiCardOf(meta(reason))?.planLine).toBe(reason as never);
    expect(serverBody(t, "…", meta(reason))).toBe(`chat.body.no_ai_${reason}`);
  }
});

test("its plan's CLI failing: the line says what the CLI said, in the reader's language", () => {
  const said = (reason: string, why: string) => ({ ...meta(reason), noAi: { ...meta(reason).noAi, why } });
  const card = noAiCardOf(said("cli_failed", "spawn bwrap ENOENT"));
  expect(card).toMatchObject({ planLine: "cli_failed", why: "spawn bwrap ENOENT" });
  // Only a CLI's failure carries its words.
  expect(noAiCardOf(said("computer_away", "x"))?.why).toBeUndefined();
  for (const [lng, line, body] of [
    [
      "pt-BR",
      "Lodi não consegue responder agora: a IA do plano parou com um erro (spawn bwrap ENOENT).",
      "Agora não consigo responder: a IA do meu plano parou com um erro (spawn bwrap ENOENT).",
    ],
    [
      "en",
      "Lodi can't answer now: the plan's AI stopped with an error (spawn bwrap ENOENT).",
      "I can't answer now: my plan's AI stopped with an error (spawn bwrap ENOENT).",
    ],
  ] as const) {
    const i18n = i18next.createInstance();
    void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false });
    const t = i18n.t.bind(i18n) as TFunction;
    expect(t(planLineKey("cli_failed", card?.why), { name: "Lodi", why: card?.why })).toBe(line);
    expect(serverBody(t, "…", said("cli_failed", "spawn bwrap ENOENT"))).toBe(body);
  }
  // A card from before, with no words: its line as it was.
  expect(planLineKey("cli_failed")).toBe("noAi.rightHand.cli_failed");
  const stub = ((key: string) => key) as unknown as TFunction;
  expect(serverBody(stub, "…", meta("cli_failed"))).toBe("chat.body.no_ai_cli_failed");
});
