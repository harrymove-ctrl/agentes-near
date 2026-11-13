import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { waitsForComputer } from "../src/lib/machine-outages";
import { serverBody } from "../src/lib/message-body";
import { modelLimitText, usageWhen } from "../src/lib/plan-usage";
import { usageWaitFix } from "../src/lib/usage-pause";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) => {
  const { defaultValue: _, ...rest } = values;
  return `${key} ${JSON.stringify(rest)}`;
}) as unknown as TFunction;

test("a note about a plan's limit or the budget says when, in the reader's zone", () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000).toISOString();
  const body = serverBody(
    t,
    "fallback",
    { bodyCode: "plan_limit_cut", bodyParams: { plan: "Claude" }, usageWait: { code: "plan_limit", resetsAt: soon } },
    "en",
  );
  expect(body.startsWith("chat.body.plan_limit_cut ")).toBe(true);
  expect(body).toContain('"plan":"Claude"');
  expect(body).toContain("chat.usageWhen.");
  // Not known: the note's own words, with no time.
  expect(serverBody(t, "x", { bodyCode: "plan_limit_wait_unknown", bodyParams: { plan: "Kimi" } }, "en")).toBe(
    'chat.body.plan_limit_wait_unknown {"plan":"Kimi","when":""}',
  );
  // An older note about the limit, sent as the computer being unavailable, says the plan's words.
  expect(
    serverBody(t, "x", {
      bodyCode: "brain_unavailable",
      bodyParams: { brain: "Codex" },
      brainUnavailable: { code: "plan_limit" },
    }),
  ).toBe('chat.body.plan_limit_wait_unknown {"plan":"ChatGPT"}');
});

test("usageWhen: the time today, the weekday this week, else the date", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  expect(usageWhen(t, "en", "2026-11-04T15:40:00Z", now)).toStartWith("chat.usageWhen.at");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).toStartWith("chat.usageWhen.on");
  expect(usageWhen(t, "pt-BR", "2026-11-06T13:00:00Z", now)).not.toContain("-feira");
  expect(usageWhen(t, "pt-BR", "2026-12-01T12:00:00Z", now)).toContain("1º de dezembro");
});

test("a plan's limit never becomes the waiting card that says the computer is back", () => {
  expect(waitsForComputer({ machineId: "m1", code: "machine_offline" })).toBe(true);
  expect(waitsForComputer({ machineId: "m1", code: "plan_limit" })).toBe(false);
  expect(waitsForComputer({ machineId: "m1", code: "busy" })).toBe(false);
  expect(waitsForComputer({ machineId: null, code: "machine_offline" })).toBe(false);
});

test("a catch-up skipped as already handled says why in place of its promise, and who asked for an answer anyway", () => {
  const usageWait = {
    code: "plan_limit",
    runId: "r1",
    ended: true,
    closed: { reason: "solved", who: { name: "Nina" }, askers: ["u1"], at: new Date().toISOString() },
  };
  const meta = { bodyCode: "plan_limit_wait", bodyParams: { plan: "Claude" }, usageWait };
  expect(serverBody(t, "x", meta, "en")).toBe('chat.body.usage_wait_closed_solved {"name":"Nina"}');
  expect(
    serverBody(t, "x", { ...meta, usageWait: { ...usageWait, continuedByUserId: "u1", continuedByName: "Ana" } }, "en"),
  ).toBe('chat.body.usage_wait_closed_solved {"name":"Nina"}\n\n_chat.body.usage_wait_anyway {"name":"Ana"}_');
  // A reason the app doesn't know: the note keeps its own words.
  const odd = { ...meta, usageWait: { ...usageWait, closed: { reason: "weird" } } };
  expect(serverBody(t, "x", odd, "en").startsWith("chat.body.plan_limit_wait ")).toBe(true);
});

test("a model's own limit: the note names the model and the way out, the brain card says it under the plan's meters", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const until = "2026-11-05T05:44:00.000Z";
  const note = serverBody(
    t,
    "x",
    {
      bodyCode: "plan_model_limit_wait",
      bodyParams: { plan: "OpenCode Go", model: "DeepSeek V4.1 Flash", agent: "Lia" },
      usageWait: { code: "plan_limit", resetsAt: until },
    },
    "en",
  );
  expect(note.startsWith("chat.body.plan_model_limit_wait ")).toBe(true);
  expect(note).toContain('"model":"DeepSeek V4.1 Flash","agent":"Lia"');
  expect(serverBody(t, "x", { bodyCode: "plan_model_region_wait", bodyParams: { model: "DeepSeek V4.1 Flash" } })).toBe(
    'chat.body.plan_model_region_wait {"model":"DeepSeek V4.1 Flash","when":""}',
  );
  const at = now.toISOString();
  const models = { "deepseek-v4.1-flash": { at, until } };
  const usage = { models };
  expect(modelLimitText(t, "en", usage, "opencode", "deepseek-v4.1-flash", now)).toStartWith("brain.modelLimit ");
  expect(modelLimitText(t, "en", usage, "opencode", "glm-5.3", now)).toBeNull();
  // Only a plan whose models have their own limits, and only while the limit holds.
  expect(modelLimitText(t, "en", usage, "zai", "deepseek-v4.1-flash", now)).toBeNull();
  expect(modelLimitText(t, "en", usage, "opencode", "deepseek-v4.1-flash", new Date(until))).toBeNull();
  const region = { models: { "deepseek-v4.1-flash": { at, region: true as const } } };
  expect(modelLimitText(t, "en", region, "opencode", "deepseek-v4.1-flash", now)).toBe(
    'brain.modelRegion {"model":"DeepSeek V4.1 Flash"}',
  );
  expect(
    modelLimitText(t, "en", region, "opencode", "deepseek-v4.1-flash", new Date(now.getTime() + 3600_000)),
  ).toBeNull();
  // Refused for the key: the model or the account switched off in OpenCode.
  const off = { models: { "minimax-m3": { at, off: true as const } } };
  expect(modelLimitText(t, "en", off, "opencode", "sonnet", now)).toBe('brain.modelOff {"model":"MiniMax M3"}');
  expect(
    serverBody(t, "x", { bodyCode: "plan_model_off_wait", bodyParams: { model: "MiniMax M3", agent: "Lia" } }),
  ).toBe('chat.body.plan_model_off_wait {"model":"MiniMax M3","agent":"Lia","when":""}');
  // No active Go subscription on the key's account: the account's words, and no other model offered.
  const inactive = { models: { "minimax-m3": { at, inactive: true as const } } };
  expect(modelLimitText(t, "en", inactive, "opencode", "sonnet", now)).toBe("brain.planInactive {}");
  expect(serverBody(t, "x", { bodyCode: "plan_inactive_wait", bodyParams: { model: "MiniMax M3" } })).toBe(
    'chat.body.plan_inactive_wait {"model":"MiniMax M3","when":""}',
  );
  expect(usageWaitFix({ bodyCode: "plan_inactive_wait" }, { admin: true, owner: true })).toBeNull();
});

test("a wait's way out: another model for its owner or an admin, a higher budget for an admin, none for a plan's limit", () => {
  const anyone = { admin: false, owner: false };
  const owner = { admin: false, owner: true };
  const admin = { admin: true, owner: false };
  for (const bodyCode of [
    "plan_model_limit_wait",
    "plan_model_limit_wait_unknown",
    "plan_model_region_wait",
    "plan_model_off_wait",
  ]) {
    expect(usageWaitFix({ bodyCode }, owner)).toBe("changeModel");
    expect(usageWaitFix({ bodyCode }, admin)).toBe("changeModel");
    expect(usageWaitFix({ bodyCode }, anyone)).toBeNull();
  }
  expect(usageWaitFix({ bodyCode: "budget_wait" }, admin)).toBe("raiseBudget");
  expect(usageWaitFix({ bodyCode: "budget_wait" }, owner)).toBeNull();
  expect(usageWaitFix({ bodyCode: "plan_limit_wait" }, admin)).toBeNull();
});
