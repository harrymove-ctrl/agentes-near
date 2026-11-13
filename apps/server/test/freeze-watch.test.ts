import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The freeze watch, in a child process that blocks its own event loop: the watch's thread must say so while the loop
 * is stuck, naming what was in flight, then say when it came back.
 */

const SERVER = join(import.meta.dir, "..");
const DEADLINE_MS = 20_000;

const CHILD = `
const { startFreezeWatch } = await import(${JSON.stringify(join(SERVER, "src/freeze-watch.ts"))});
const { startInFlight } = await import("@agenteschat/adapters/in-flight");
startFreezeWatch({ logLevel: "info", freezeMs: 1000 });
startInFlight("job agent.run", "run-1");
const done = startInFlight("tool browser_do", "run-1");
startInFlight("tool web_search", "run-2")();
await Bun.sleep(500);
const until = Date.now() + 3000;
while (Date.now() < until) {}
await Bun.sleep(1500);
done();
`;

test(
  "a stuck event loop is reported from the watch's thread with the jobs and tool calls in flight",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", CHILD], { cwd: SERVER, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(killer);
    expect(code).toBe(0);
    const lines = `${out}\n${err}`
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const stuck = lines.filter((l) => l.msg === "event loop stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ level: "error", tool: "browser_do", kind: "agent.run", runId: "run-1" });
    // The newest first; an operation that ended is gone.
    expect(stuck[0]?.inFlight).toEqual([
      expect.stringMatching(/^tool browser_do \(run run-1\) for \d+ s$/),
      expect.stringMatching(/^job agent\.run \(run run-1\) for \d+ s$/),
    ]);
    expect(String(stuck[0]?.error)).toStartWith("Error: event loop stuck for ");
    const back = lines.find((l) => l.msg === "event loop back");
    expect(back).toMatchObject({ level: "warn" });
    expect(Number(back?.stuckMs)).toBeGreaterThanOrEqual(1000);
  },
  DEADLINE_MS + 10_000,
);
