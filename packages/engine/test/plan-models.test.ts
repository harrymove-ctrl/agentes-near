import { afterEach, expect, test } from "bun:test";
import { CODING_PLANS, learnPlanModels, planOf } from "@agenteschat/providers/plans";
import { refreshPlanModels } from "../src/plan-models";

const table = CODING_PLANS.opencode.claudeCode.models;
const models = () => planOf("opencode")?.claudeCode.models.map((m) => m.id);
const answers = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const NEW_MODEL = {
  data: [
    {
      id: "glm-6",
      name: "GLM-6",
      type: "chat",
      canonical_id: "zhipuai/glm-6",
      capabilities: { tools: { supported: true } },
    },
  ],
};

afterEach(() => learnPlanModels({ opencode: table }));

test("what the list adds shows up, and only the plans with a list are read", async () => {
  const asked: string[] = [];
  await refreshPlanModels((async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(NEW_MODEL));
  }) as unknown as typeof fetch);
  expect(asked).toEqual([CODING_PLANS.opencode.modelsUrl]);
  expect(models()).toContain("glm-6");
});

test("a list that's down, refusing or unreadable keeps what the plan last said", async () => {
  await refreshPlanModels(answers(NEW_MODEL));
  const before = models();
  await refreshPlanModels((async () => {
    throw new Error("down");
  }) as unknown as typeof fetch);
  await refreshPlanModels(answers({ error: "no" }, 503));
  await refreshPlanModels((async () => new Response("<html>")) as unknown as typeof fetch);
  await refreshPlanModels(answers({ data: [] }));
  expect(models()).toEqual(before);
});

test("a list too big to be one, or one that breaks off, keeps what the plan last said", async () => {
  await refreshPlanModels(answers(NEW_MODEL));
  const before = models();
  const huge = { data: [...NEW_MODEL.data, { id: "glm-7", type: "chat", name: "x".repeat(3_000_000) }] };
  await refreshPlanModels(answers(huge));
  const cut = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"data":['));
      c.error(new Error("timed out"));
    },
  });
  await refreshPlanModels((async () => new Response(cut)) as unknown as typeof fetch);
  expect(models()).toEqual(before);
});

test("never read: the table", () => {
  expect(models()).toEqual(table.map((m) => m.id));
});
