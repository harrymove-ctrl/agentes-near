import { describe, expect, test } from "bun:test";
import type { ChannelEvent } from "../src/api/types";
import {
  applyConsultEvent,
  CONSULT_ASKING_MAX_MS,
  type ConsultsState,
  consultsIn,
  reconcileConsults,
} from "../src/realtime/consults";

type Ev = Parameters<typeof applyConsultEvent>[1];
const at = 1_000;
const asked = (runId: string) =>
  ({
    type: "agent.consulting",
    channelId: "c1",
    threadId: "t1",
    runId,
    agentId: "theo",
    consultedAgentId: "ada",
  }) as Ev;
const answered = (runId: string) =>
  ({
    type: "agent.consulted",
    channelId: "c1",
    threadId: "t1",
    runId,
    agentId: "theo",
    consultedAgentId: "ada",
    status: "answered",
  }) as Ev;
const apply = (events: Ev[]) => events.reduce<ConsultsState>((s, e) => applyConsultEvent(s, e, at), {});

describe("live consultations", () => {
  test("the answer woke another run of the asker: that run writing ends the line", () => {
    const back = apply([asked("r1"), answered("r1")]);
    expect(consultsIn(back, "c1", at)).toHaveLength(1);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r2", agentId: "theo" } as Ev;
    expect(consultsIn(applyConsultEvent(back, delta, at), "c1", at)).toEqual([]);
  });

  test("the asker's message from another run ends the line; the notice itself does not", () => {
    const back = apply([asked("r1"), answered("r1")]);
    const message = (agentRunId: string | null) =>
      ({
        type: "message.created",
        channelId: "c1",
        messageId: "m1",
        message: { channelId: "c1", author: { type: "agent", id: "theo" }, agentRunId },
      }) as unknown as ChannelEvent;
    expect(consultsIn(applyConsultEvent(back, message(null), at), "c1", at)).toHaveLength(1);
    expect(consultsIn(applyConsultEvent(back, message("r2"), at), "c1", at)).toEqual([]);
  });

  test("a question still out stays while another run of the asker writes", () => {
    const out = apply([asked("r1")]);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r2", agentId: "theo" } as Ev;
    expect(consultsIn(applyConsultEvent(out, delta, at), "c1", at)).toHaveLength(1);
  });

  test("another agent writing in the channel leaves the line", () => {
    const back = apply([asked("r1"), answered("r1")]);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r9", agentId: "lisa" } as Ev;
    expect(consultsIn(applyConsultEvent(back, delta, at), "c1", at)).toHaveLength(1);
  });

  test("work handed off never takes the line: the reply that handed it shows where it is", () => {
    const note = (e: Ev) => ({ ...e, kind: "note" }) as Ev;
    expect(apply([note(asked("r1"))])).toEqual({});
    expect(apply([asked("r1"), note(answered("r1"))])).toEqual(apply([asked("r1")]));
  });

  test("a question whose colleague is still at it stays past the usual window: each word of it renews the line", () => {
    const later = at + CONSULT_ASKING_MAX_MS - 1000;
    const still = { type: "agent.consultation", channelId: "c1", threadId: "t1", runId: "r1", consultationId: "k1" };
    const kept = applyConsultEvent(apply([asked("r1")]), still as Ev, later);
    expect(consultsIn(kept, "c1", at + CONSULT_ASKING_MAX_MS + 1000)).toHaveLength(1);
    expect(consultsIn(apply([asked("r1")]), "c1", at + CONSULT_ASKING_MAX_MS + 1000)).toEqual([]);
    // Nothing out under that run: nothing to keep.
    expect(applyConsultEvent({}, still as Ev, later)).toEqual({});
  });
});

describe("questions still out, from the server (load, reconnect)", () => {
  const open = (runId: string, since = "2026-10-25T12:00:00.000Z") => ({
    runId,
    agentId: "dev",
    consultedAgentId: "infra",
    channelId: "c1",
    threadId: "t1",
    since,
  });

  test("after a reload the line comes back with its real clock", () => {
    const s = reconcileConsults({}, "c1", [open("r1")], at, at);
    expect(consultsIn(s, "c1", at)).toEqual([
      expect.objectContaining({ runId: "r1", status: "asking", since: Date.parse("2026-10-25T12:00:00.000Z") }),
    ]);
  });

  test("a line the server no longer has (answered while away) goes; one heard after the request stays", () => {
    const s = apply([asked("r1")]);
    expect(reconcileConsults(s, "c1", [], at + 1, at + 2)).toEqual({});
    expect(reconcileConsults(s, "c1", [], at, at + 2).r1?.status).toBe("asking");
    // Another channel's lines are left alone.
    expect(reconcileConsults(s, "c2", [], at + 1, at + 2).r1?.status).toBe("asking");
  });

  test("an answer heard live is not turned back into a question", () => {
    const s = apply([asked("r1"), answered("r1")]);
    expect(reconcileConsults(s, "c1", [open("r1")], at + 1, at + 2).r1?.status).toBe("answered");
  });
});
