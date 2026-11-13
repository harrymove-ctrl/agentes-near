import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  addChannelMember,
  createAgentRuns,
  createChannel,
  createOutboxPump,
  insertMessage,
  LOOP_LATE_MS,
  RUN_MEMORY_BYTES,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * What a run costs the process while it waits on its model, the case `laneLimits` sizes the long lane by: real runs
 * through the executor and the gateway, the model held after its first words.
 */

// Many runs on PGlite, on a slow machine.
setDefaultTimeout(180_000);

let f: Fixture;
afterEach(() => f?.close());

test("a run waiting on its model holds less than RUN_MEMORY_BYTES and leaves the event loop free", async () => {
  let open: () => void = () => {};
  const model = new Promise<void>((r) => {
    open = r;
  });
  let waiting = 0;
  f = await setup({
    reply: () => {
      waiting++;
      return { chunks: ["Looking into it", ", done."], hold: model };
    },
  });
  const runs = 100;
  for (let i = 0; i < runs; i++) {
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: `load-${i}` });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: room.id,
      author: { type: "person", userId: f.owner.id },
      body: "What changed in the report since Monday?",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
  }
  const pump = createOutboxPump(f.db, f.handlers, { workerId: "w", maxInFlight: runs * 2 });
  Bun.gc(true);
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const deadline = Date.now() + 150_000;
  while (waiting < runs && Date.now() < deadline) {
    await pump.pump();
    await Bun.sleep(10);
  }
  expect(waiting).toBeGreaterThanOrEqual(runs);
  // The fake keeps a copy of every request: the test's, not the runs'.
  f.provider.calls.splice(0);
  Bun.gc(true);
  const held = process.memoryUsage();
  // How late a 10 ms timer fires while they all wait.
  let late = 0;
  for (let i = 0; i < 50; i++) {
    const t = performance.now();
    await Bun.sleep(10);
    late = Math.max(late, performance.now() - t - 10);
  }
  open();
  while ((await pump.pump()) > 0 || pump.inFlight() > 0) await pump.idle();
  const used = process.cpuUsage(cpu);
  const perRun = {
    heapBytes: Math.round((held.heapUsed - before.heapUsed) / runs),
    rssBytes: Math.round((held.rss - before.rss) / runs),
    // Includes PGlite's own work, in this process here, in the database's on a server.
    cpuMs: Math.round((used.user + used.system) / 1000 / runs),
  };
  console.log("run cost", JSON.stringify({ runs, ...perRun, loopLateMs: Math.round(late) }));
  expect(perRun.heapBytes).toBeLessThan(RUN_MEMORY_BYTES);
  expect(late).toBeLessThan(LOOP_LATE_MS);
});
