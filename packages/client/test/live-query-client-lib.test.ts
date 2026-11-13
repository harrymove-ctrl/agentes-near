import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { LiveQueryClient } from "../src/lib/live-query-client";

/** A list whose first read the server answered before a change, delivered after the change's event. */
async function firstReadThenEvent(qc: QueryClient) {
  let server = "before";
  const reads: string[] = [];
  let deliver = () => {};
  const held = new Promise<void>((r) => (deliver = r));
  const observer = new QueryObserver(qc, {
    queryKey: ["people"],
    queryFn: async () => {
      const answer = server;
      reads.push(answer);
      if (reads.length === 1) await held;
      return answer;
    },
  });
  const off = observer.subscribe(() => {});
  await Bun.sleep(0);
  server = "after";
  void qc.invalidateQueries({ queryKey: ["people"] });
  deliver();
  await Bun.sleep(20);
  const data = observer.getCurrentResult().data;
  off();
  return { data, reads };
}

describe("LiveQueryClient", () => {
  test("an invalidation during a first read reads again once it lands", async () => {
    expect(await firstReadThenEvent(new LiveQueryClient())).toEqual({ data: "after", reads: ["before", "after"] });
  });

  test("TanStack alone keeps the first read's answer (the loss this fixes)", async () => {
    expect((await firstReadThenEvent(new QueryClient())).data).toBe("before");
  });

  test("a list with data refetches once, as before", async () => {
    const qc = new LiveQueryClient();
    let n = 0;
    const observer = new QueryObserver(qc, { queryKey: ["x"], queryFn: async () => ++n });
    const off = observer.subscribe(() => {});
    await Bun.sleep(5);
    await qc.invalidateQueries({ queryKey: ["x"] });
    await Bun.sleep(5);
    expect(n).toBe(2);
    off();
  });
});
