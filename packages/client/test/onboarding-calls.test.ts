import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ApiClient } from "../src/api/client";
import { keys } from "../src/api/keys";
import { addDm } from "../src/api/queries";
import type { DirectMessage, Me } from "../src/api/types";
import { finishOnboarding } from "../src/lib/right-hand";

const ME: Me = { user: { id: "u1", name: "Walter", email: "walter@example.com", image: null }, organizations: [] };

/** A server that answers only what finishing a workspace asks, each call written down. `old`: one that says neither. */
function server(old = false) {
  const calls: string[] = [];
  const opened = old ? {} : { rightHandId: "lodi", me: ME };
  const api = {
    orgs: {
      saveOnboarding: async (orgId: string, input: object) => {
        calls.push(`orgs.saveOnboarding ${orgId} ${JSON.stringify(input)}`);
        return { step: "done", finished: true, ...opened };
      },
    },
    agents: {
      list: async () => {
        calls.push("agents.list");
        return [{ id: "ada" }, { id: "lodi", builtin: "right_hand" }];
      },
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe("opening a workspace in round trips (#1)", () => {
  test("finishing one is one call, its answer saying where it opens and who the person is now", async () => {
    const { api, calls } = server();
    expect(await finishOnboarding(api, "o1")).toEqual({ orgId: "o1", agentId: "lodi", me: ME });
    expect(calls).toEqual(['orgs.saveOnboarding o1 {"finished":true}']);
  });

  test("an older server that says neither: its agents say which is the right hand", async () => {
    const { api, calls } = server(true);
    expect(await finishOnboarding(api, "o1")).toEqual({ orgId: "o1", agentId: "lodi", me: null });
    expect(calls).toEqual(['orgs.saveOnboarding o1 {"finished":true}', "agents.list"]);
  });
});

describe("a DM opened from its own answer, the list not read again for it (#1)", () => {
  const dm = {
    channelId: "d-lodi",
    with: { type: "agent", id: "lodi", name: "Lodi", handle: "lodi" },
  } as DirectMessage;
  const watch = (qc: QueryClient, answer: () => Promise<DirectMessage[]>) => {
    let reads = 0;
    const observer = new QueryObserver(qc, {
      queryKey: keys.dms("o1"),
      queryFn: () => {
        reads++;
        return answer();
      },
    });
    return { off: observer.subscribe(() => {}), reads: () => reads };
  };

  test("a loaded list gains it at once", async () => {
    const qc = new QueryClient();
    const list = watch(qc, async () => []);
    await Bun.sleep(0);
    addDm(qc, "o1", dm);
    addDm(qc, "o1", dm);
    expect(qc.getQueryData(keys.dms("o1"))).toEqual([dm]);
    await Bun.sleep(0);
    expect(list.reads()).toBe(1);
    list.off();
  });

  test("the sidebar's read still on its way, sent before the DM existed: it goes in once that read lands", async () => {
    const qc = new QueryClient();
    let land: (dms: DirectMessage[]) => void = () => {};
    const list = watch(qc, () => new Promise((resolve) => (land = resolve)));
    await Bun.sleep(0);
    addDm(qc, "o1", dm);
    land([]);
    await Bun.sleep(0);
    expect(qc.getQueryData(keys.dms("o1"))).toEqual([dm]);
    expect(list.reads()).toBe(1);
    list.off();
  });

  test("no list loaded or on its way: nothing cached, the list loads whole when something shows it", async () => {
    const qc = new QueryClient();
    addDm(qc, "o1", dm);
    await Bun.sleep(0);
    expect(qc.getQueryData(keys.dms("o1"))).toBeUndefined();
  });
});
