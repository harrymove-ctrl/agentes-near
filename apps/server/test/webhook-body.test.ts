import { expect, test } from "bun:test";
import { readWebhookText } from "../src/routes/webhook-body";

test("public webhook body stops reading at its byte limit", async () => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(4));
    },
  });
  const req = new Request("https://agentes.test/api/webhooks/github/id", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  expect(await readWebhookText(req, 10)).toBeNull();
  expect(reads).toBeLessThan(10);
});

test("public webhook body counts UTF-8 bytes and rejects a declared oversized body", async () => {
  const accepted = new Request("https://agentes.test", { method: "POST", body: "é" });
  expect(await readWebhookText(accepted, 2)).toBe("é");
  const oversized = new Request("https://agentes.test", { method: "POST", body: "é" });
  expect(await readWebhookText(oversized, 1)).toBeNull();
  const declared = new Request("https://agentes.test", {
    method: "POST",
    headers: { "content-length": "100" },
    body: "x",
  });
  expect(await readWebhookText(declared, 10)).toBeNull();
});
