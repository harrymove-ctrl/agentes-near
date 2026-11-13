import { expect, test } from "bun:test";
import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/http";
import type { Message } from "../src/api/types";
import { retryAnswer } from "../src/lib/retry-answer";

const message = { id: "m1", body: "resume o canal" } as Message;
const apiWith = (answerNow: () => Promise<{ runs: { agentId: string; runId: string }[] }>) =>
  ({ chat: { answerNow } }) as unknown as ApiClient;

test("Tentar de novo answers the same message again: nothing is sent", async () => {
  let resent = 0;
  await retryAnswer(
    apiWith(async () => ({ runs: [{ agentId: "a", runId: "r2" }] })),
    "o",
    message,
    () => resent++,
  );
  expect(resent).toBe(0);
});

test("only when it can't (no run of its own, or one that already did things) do the words go again", async () => {
  let resent = 0;
  await retryAnswer(
    apiWith(async () => ({ runs: [] })),
    "o",
    message,
    () => resent++,
  );
  const worked = new ApiError(409, "run.not_restartable", "already started");
  await retryAnswer(
    apiWith(() => Promise.reject(worked)),
    "o",
    message,
    () => resent++,
  );
  expect(resent).toBe(2);
  const forbidden = new ApiError(403, "run.answer_forbidden", "no");
  await expect(
    retryAnswer(
      apiWith(() => Promise.reject(forbidden)),
      "o",
      message,
      () => resent++,
    ),
  ).rejects.toBe(forbidden);
  expect(resent).toBe(2);
});

test("a second tap while the first is on its way asks nothing and sends nothing", async () => {
  let calls = 0;
  let resent = 0;
  const api = apiWith(async () => {
    calls++;
    return { runs: [] };
  });
  await Promise.all([retryAnswer(api, "o", message, () => resent++), retryAnswer(api, "o", message, () => resent++)]);
  expect({ calls, resent }).toEqual({ calls: 1, resent: 1 });
});

test("the second tap settles when the first does, so its line says it is trying until then; only the first says why it failed", async () => {
  let fail: (e: unknown) => void = () => {};
  const api = apiWith(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const order: string[] = [];
  const first = retryAnswer(api, "o", message, () => {}).catch(() => order.push("first refused"));
  const second = retryAnswer(api, "o", message, () => {}).then(() => order.push("second settled"));
  await Promise.resolve();
  expect(order).toEqual([]);
  fail(new ApiError(403, "run.answer_forbidden", "no"));
  await Promise.all([first, second]);
  expect(order).toEqual(["first refused", "second settled"]);
});

test("a voice message that can't start over is never sent again as text, nor dropped in silence: it says to record it", async () => {
  const voice = { ...message, id: "m-voice", meta: { voice: { clipId: "clip-1", durationMs: 4000, peaks: [] } } };
  let resent = 0;
  for (const answer of [
    async () => ({ runs: [] }),
    () => Promise.reject(new ApiError(409, "run.not_restartable", "already started")),
  ]) {
    const refused = await retryAnswer(apiWith(answer), "o", voice as Message, () => resent++).catch((e) => e);
    expect(refused).toMatchObject({ name: "ApiError", code: "run.not_restartable_voice" });
  }
  expect(resent).toBe(0);
  // Started again: nothing to say.
  await retryAnswer(
    apiWith(async () => ({ runs: [{ agentId: "a", runId: "r2" }] })),
    "o",
    voice as Message,
    () => resent++,
  );
  expect(resent).toBe(0);
});
