import { afterEach, expect, test } from "bun:test";
import { currentQueryCount } from "@agenteschat/db";
import {
  createChannel,
  createJobHandlers,
  drainOutbox,
  enableCaches,
  issueFromMessage,
  postPersonMessage,
  type StageTiming,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { until } from "./stream-fixtures";

let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  await f?.close();
});

/**
 * Round-trip budget of the hot path (the database may be ~185 ms away): a mention run on warm caches, as a running
 * server makes it. Counts SQL statements; transaction BEGIN/COMMIT are not counted. Raise these only on purpose.
 */
async function mentionRun(options: { askAgent?: boolean } = {}) {
  let beforeModel = -1;
  const statusPicked = new Set<string>();
  f = await setup({
    ...options,
    reply: (req) => {
      // The agent's call only: the router's (structured output) may run after an agent's answer (ADR 0034).
      if (!req.outputSchema) beforeModel = currentQueryCount();
      return { chunks: [req.outputSchema ? '{"needs_agent":0,"scores":[],"reason":"none"}' : "ok"] };
    },
    judge: (kind, _id, _state, _question, request) => {
      if (kind === "agent_status" && request.runId) statusPicked.add(request.runId);
      return undefined;
    },
  });
  // Its open tasks from private channels it isn't in: hidden from #general, in the same one statement.
  const deps = { db: f.db, pubsub: f.pubsub };
  for (const n of [1, 2, 3]) {
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: `secreto-${n}`, visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: `Cofre ${n}` });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, issue.id, {
      assignee: { type: "agent", id: f.agent.id },
    });
  }
  enableCaches();
  let profile: { runId: string; stages: StageTiming[]; total: { queries: number } } | null = null;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    onRunProfile: (p) => {
      profile = p;
    },
  });
  // Warm the caches like a running server would have them (agent, org, channel, scopes).
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev warm up" });
  await drainOutbox(f.db, handlers);

  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
  await drainOutbox(f.db, handlers);
  expect(beforeModel).toBeGreaterThan(0);
  expect(profile).not.toBeNull();
  const p = profile as unknown as { runId: string; stages: StageTiming[]; total: { queries: number } };
  expect(p.stages.map((s) => s.stage)).toEqual(["claim", "context", "model#1", "persist", "events"]);
  // Its status line is still picked, in a request of its own beside the run (ADR 0084 §8), counted in neither.
  await until(() => statusPicked.has(p.runId), "the run's status pick");
  return { beforeModel, total: p.total.queries };
}

test("claim → model request stays within 18 statements; a whole mention run within 39", async () => {
  const run = await mentionRun();
  // 11 since every agent has a budget (ADR 0026): the call always reserves (one statement on the fast path).
  // 12 since the run stores the brain it runs with (ADR 0053 §10).
  // 13 since a run's context lists the agent's open tasks (one statement however many, read while the thread is).
  // 14 since it lists the work the agent handed off from this conversation (ADR 0095; one statement, read beside them).
  // 15 since it says what the agent's other runs here hold (`heldHere`, one statement).
  // 16 since it names the secrets on its computer (one statement, ADR 0017). Who is behind a person's message is
  // that person, so its how-tos and their preferences (ADR 0120) cost no read of their own.
  // 17 since it lists the agent's background work in this conversation (ADR 0121; one statement, read beside them).
  // 18 since it says the person's app language (ADR 0122; one statement, read with the rest, no round trip of its own).
  expect(run.beforeModel).toBeLessThanOrEqual(18);
  // 22 since the reply carries how many tool calls the run made, so the apps leave "Ver o que ele fez" out at 0.
  // 23 with the open tasks, 24 with the work handed off, 25 with what other runs here hold.
  // 30 since every turn's end is decided and recorded (ADR 0097): the judgment through the gateway, its step, and
  // clearing the agent's `run_failed` notification there.
  // 31 since a run's browser profile turns end with it (ADR 0110 §4): one update on its terminal transition, which
  // can't wait for the turn's own expiry or the profile stays held from the people and agents who share it.
  // 34 since a reply says whether its run read outside text (ADR 0117, `runReadOutside`): its results (1), then the
  // message that woke it and its conversation (2), until the run is known to have read some.
  // 38 since a finished turn counts the how-tos it reused and decides whether it taught something (ADR 0120): its
  // calls and its how-tos (2), in the background after the reply; and the read before the model call above.
  // 38 with the background work read before the model call above.
  // 39 with the app language read before the model call above.
  expect(run.total).toBeLessThanOrEqual(39);
});

test("with tools, as every production run has them (find_agent among them): within 23 before the model call, 44 in all", async () => {
  const run = await mentionRun({ askAgent: true });
  // 4 more, all for the tool list and the prompt: who is behind the run (2, the Tool Gateway's policy), the connectors
  // it lacks (1) and whether the person may talk to agents ("# Your team", 1, beside the context's other reads).
  // 20 with the open requests it can withdraw (`withdraw_request`, one statement for its help, secrets and questions).
  // 20 with the secrets on its computer (ADR 0017), since who is behind the message is read once however many of the
  // run's parallel reads ask (`messageRoot`).
  // 21 with the background work in this conversation (ADR 0121).
  // 22 with the person's app language (ADR 0122).
  // 23 with the devices people connected (one statement the prompt's list and the tool lists share, `deviceRoster`).
  expect(run.beforeModel).toBeLessThanOrEqual(23);
  // 36: the browser profile release above, and the turn-end judge naming the teammates the person may reach (ADR 0109):
  // whether they may talk to agents, read again because a resumed run has no context of its own to carry it from.
  // Who is behind the run comes from the run in memory, and the calls it tried are read only when it made some.
  // 40 with the open requests (1) and the reply's read-outside check above (3).
  // 42 with the secrets above and the finished turn's learning reads (ADR 0120).
  // 43 with the background work read before the model call above.
  // 44 with the app language read before the model call above.
  expect(run.total).toBeLessThanOrEqual(44);
});
