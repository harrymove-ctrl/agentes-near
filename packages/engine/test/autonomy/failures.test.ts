import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import {
  consultationWait,
  getMessage,
  loadAgentStatuses,
  outageParkedSql,
  receiptsFor,
  runErrorDetail,
} from "../../src";
import { closeWorlds, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";

// I5 (failures reach someone, and work resumes): no failure ends with only a `run.finished` event.

afterEach(closeWorlds);

test("an error of ours at the last try doesn't read as the provider's, and its raw words aren't shown", async () => {
  const w = await world({
    agents: ["otto"],
    script: { otto: () => ({ error: new Error('relation "usage_records" does not exist') }) },
  });
  await w.say("@otto o build passou?");
  await w.settle();
  await w.advance(2);
  const [run] = await w.runs("otto");
  expect(run?.status).toBe("failed");
  expect(runErrorDetail(run?.error)).toEqual({ errorCode: "run.our_error" });
  expect(run?.error).not.toContain("usage_records");
});

scenario("S29", "a provider outage parks the run, which finishes when the provider is back", async () => {
  let down = true;
  const w = await world({
    agents: ["otto"],
    script: {
      otto: () => (down ? { error: new ProviderError("overloaded", true, 529) } : { text: "O build 812 passou." }),
    },
  });
  await w.say("@otto o build passou?");
  await w.settle();
  expect((await w.runs("otto"))[0]?.status).not.toBe("failed");
  // The wait is said once, as the provider's (no question to a person), and stays one note while it lasts.
  await w.advance(2);
  const notes = (await w.posts("otto")).filter((m) => m.meta.bodyCode === "provider_wait_down");
  expect(notes).toHaveLength(1);
  expect(notes[0]?.meta.bodyParams).toEqual({ provider: "Claude", detail: "overloaded" });
  // Nobody reads the park as a wait on a person: hand-off lines, the agent's status and the message's receipt say the
  // provider is down.
  const [parked] = await w.db
    .select({
      status: schema.agentRuns.status,
      waitingMachineId: schema.agentRuns.waitingMachineId,
      outage: outageParkedSql,
      triggerMessageId: schema.agentRuns.triggerMessageId,
    })
    .from(schema.agentRuns);
  expect(parked?.status).toBe("waiting_input");
  expect(consultationWait(parked as NonNullable<typeof parked>)).toBe("outage");
  const [status] = await loadAgentStatuses(w.db, w.org.id, new Date(), [w.agents.otto?.id as string]);
  expect(status?.status?.kind).toBe("provider_down");
  const asked = await getMessage(w.db, w.org.id, parked?.triggerMessageId as string);
  const receipts = await receiptsFor(w.db, w.org.id, asked ? [asked] : []);
  expect(receipts.get(asked?.id as string)?.handled.map((h) => [h.status, h.outage])).toEqual([
    ["waiting_input", true],
  ]);
  down = false;
  await w.advance(60);
  expect((await w.runs("otto")).map((r) => r.status)).toEqual(["done"]);
  expect((await w.posts("otto")).at(-1)?.body).toContain("passou");
  // Its note no longer says a wait is on, in the same place.
  const after = (await w.posts("otto")).find((m) => m.id === notes[0]?.id);
  expect(after?.meta.bodyCode).toBe("provider_back");
  expect(after?.body).toBe("My AI is back.");
  await assertInvariants(w);
});

scenario("S30", "a delegate that fails is reported back to the agent that handed it the work", async () => {
  const w = await world({
    agents: ["ada", "lia"],
    script: {
      ada: [
        { text: "@lia revisa o #227, por favor" },
        { text: "A Lia não conseguiu revisar o #227; revisei eu: aprovado." },
      ],
      lia: () => ({ error: new ProviderError("invalid request", false, 400) }),
    },
  });
  await w.say("@ada pede para a lia revisar o #227");
  await w.settle();
  expect((await w.runs("lia")).map((r) => r.status)).toEqual(["failed"]);
  expect(await w.runs("ada")).toHaveLength(2);
  expect((await w.posts("ada")).at(-1)?.body).toContain("não conseguiu");
  await assertInvariants(w);
});

scenario(
  "S44",
  "a router that fails on a message meant for the agents never leaves it silently unanswered",
  async () => {
    const body = "alguém consegue ver por que o deploy falhou?";
    const w = await world({
      agents: ["otto", "ada"],
      route: { [body]: { needs: 0.9, fail: true } },
      script: { otto: [{ text: "Vi: faltou a variável DATABASE_URL no deploy." }] },
    });
    const events = w.f.listen(w.channelId);
    const message = await w.say(body);
    await w.settle();
    await Bun.sleep(5);
    const [decision] = (await w.decisions()).filter((d) => d.messageId === message.id);
    expect(decision?.error).toContain("router step unavailable");
    // An agent answers it, or the person is told at once that only a mention reaches one now.
    const routed = events.find((e) => e.type === "message.routed" && e.messageId === message.id) as
      | { reason?: string }
      | undefined;
    const answered = (await w.runs()).length > 0;
    expect(answered || routed?.reason === "mention_needed").toBe(true);
    await assertInvariants(w);
  },
);

scenario("S47", "an error that won't pass by waiting fails at once and reaches the person", async () => {
  const w = await world({
    agents: ["otto"],
    script: { otto: () => ({ error: new TypeError("Cannot read properties of undefined") }) },
  });
  await w.say("@otto o build passou?");
  await w.settle();
  expect((await w.runs("otto")).map((r) => r.status)).toEqual(["failed"]);
  expect((await w.posts("otto")).filter((m) => m.meta.bodyCode === "provider_unavailable")).toHaveLength(0);
  const failed = (await w.db.select().from(schema.notifications)).filter((n) => n.kind === "run_failed");
  expect(failed.map((n) => n.userId)).toEqual([w.owner.id]);
  await assertInvariants(w);
});
