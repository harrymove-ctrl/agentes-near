import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { actionCardOf } from "../src/lib/action-cards";
import { serverBody } from "../src/lib/message-body";
import { mayContinueUsage, usagePauseCardOf, usagePauseText, usageWaitOf } from "../src/lib/usage-pause";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) => {
  const { defaultValue: _, ...rest } = values;
  return `${key} ${JSON.stringify(rest)}`;
}) as unknown as TFunction;

const meta = (over: Record<string, unknown> = {}) => ({
  actionCard: {
    kind: "usage_paused",
    state: "paused",
    runId: "r1",
    waitId: "w1",
    agentId: "ada",
    forUserId: "bia",
    source: "plan",
    percent: 96,
    window: "seven_day",
    plan: "Claude",
    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
    continuedByUserId: null,
    continuedAt: null,
    ...over,
  },
});

test("a long-work pause's card: read from its message, its words, who may press Continuar agora", () => {
  const card = usagePauseCardOf(meta());
  expect(card?.state).toBe("paused");
  expect(usagePauseCardOf(meta({ state: "ended" }))?.state).toBe("ended");
  expect(actionCardOf(meta())?.kind).toBe("usage_paused");
  expect(usagePauseCardOf({ actionCard: { kind: "stretch_paused" } })).toBeNull();
  if (!card) throw new Error("no card");
  const { title, line } = usagePauseText(t, "en", card, "Ada");
  expect(title).toContain("chat.body.usage_paused ");
  expect(title).toContain('"window":"usageCard.window.seven_day');
  expect(line).toStartWith("usageCard.line ");
  const budget = usagePauseCardOf(meta({ source: "budget", window: undefined }));
  expect(budget && usagePauseText(t, "en", budget, "Ada").line).toStartWith("usageCard.lineBudget");
  const unknown = usagePauseCardOf(meta({ resetsAt: undefined }));
  expect(unknown && usagePauseText(t, "en", unknown, "Ada").line).toStartWith("usageCard.lineUnknown");
  // The person behind the work, the agent's owner, an admin; nobody else.
  expect(mayContinueUsage(card, "bia", "theo", false)).toBe(true);
  expect(mayContinueUsage(card, "theo", "theo", false)).toBe(true);
  expect(mayContinueUsage(card, "mila", "theo", true)).toBe(true);
  expect(mayContinueUsage(card, "mila", "theo", false)).toBe(false);
  expect(mayContinueUsage(card, null, "theo", false)).toBe(false);
});

test("the card's note, shown as text elsewhere, names its window in the reader's words", () => {
  const body = serverBody(t, "fallback", {
    bodyCode: "usage_paused",
    bodyParams: { agent: "Ada", plan: "Claude", percent: "96", window: "five_hour" },
  });
  expect(body).toContain('"window":"usageCard.window.five_hour');
});

test("a run waiting on its limit can be canceled: its note names the run, and says so once canceled", () => {
  const note = {
    bodyCode: "plan_limit_wait",
    bodyParams: { plan: "Claude" },
    usageWait: { code: "plan_limit", runId: "r1", forUserId: "bia" },
  };
  expect(usageWaitOf(note)).toEqual({
    runId: "r1",
    count: 1,
    forUserId: "bia",
    canceled: false,
    ended: false,
    closed: null,
    continuedByUserId: null,
  });
  // Later turns in its conversation it speaks for: its "Don't run it" says how many.
  expect(usageWaitOf({ ...note, usageWait: { ...note.usageWait, runIds: ["r2", "r3"] } })?.count).toBe(3);
  // Back at work: nothing waits to cancel.
  expect(usageWaitOf({ ...note, usageWait: { ...note.usageWait, ended: true } })?.ended).toBe(true);
  // An older note names no run: nothing to cancel from it. A card is canceled from the card.
  expect(usageWaitOf({ usageWait: { code: "plan_limit" } })).toBeNull();
  expect(usageWaitOf(meta())).toBeNull();
  expect(usagePauseCardOf(meta({ state: "canceled" }))?.state).toBe("canceled");
  expect(usagePauseCardOf(meta())?.runId).toBe("r1");
  expect(serverBody(t, "x", note, "en")).not.toContain("usage_wait_canceled");
  const canceled = { ...note, usageWait: { ...note.usageWait, canceled: true } };
  expect(usageWaitOf(canceled)?.canceled).toBe(true);
  expect(serverBody(t, "x", canceled, "en")).toContain("chat.body.usage_wait_canceled");
});
