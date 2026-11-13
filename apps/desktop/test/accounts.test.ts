import { describe, expect, test } from "bun:test";
import type { RunnerAccountInfo } from "@agenteschat/adapters/machine-protocol";
import type { ControlRequest } from "@agenteschat/adapters/runner-control";
import {
  type AccountsRequest,
  accountsOf,
  isUnsupported,
  type LoginView,
  planLabel,
  startAccountLogin,
} from "../src/control/accounts";
import { ControlError } from "../src/control/client";

const ID1 = "4b1f2c3d-0000-4000-8000-000000000001";
const ID2 = "4b1f2c3d-0000-4000-8000-000000000002";
const ID3 = "4b1f2c3d-0000-4000-8000-000000000003";

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Manual timers: `fire()` runs every pending timeout. */
function fakeTimers() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

/** A runner that answers `account.*` from `answers` (a function per request type). */
function runner(answers: Partial<Record<ControlRequest["type"], (req: ControlRequest) => unknown>>) {
  const sent: ControlRequest[] = [];
  const request = (async (req: ControlRequest) => {
    sent.push(req);
    const answer = answers[req.type];
    if (!answer) throw new ControlError("bad_request", "unknown");
    return answer(req);
  }) as AccountsRequest;
  return { request, sent };
}

function login(answers: Parameters<typeof runner>[0], kind: "claude_code" | "codex" = "claude_code") {
  const { request, sent } = runner(answers);
  const timers = fakeTimers();
  const views: LoginView[] = [];
  const handle = startAccountLogin({
    request,
    kind,
    onChange: (v) => views.push(v),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { handle, sent, timers, views };
}

describe("accounts", () => {
  test("accountsOf keeps one CLI, signed-in first, then by email", () => {
    const list: RunnerAccountInfo[] = [
      { id: ID1, kind: "claude_code", loggedIn: false, email: "a@acme.com" },
      { id: ID2, kind: "codex", loggedIn: true, email: "b@acme.com" },
      { id: ID3, kind: "claude_code", loggedIn: true, email: "z@acme.com" },
    ];
    expect(accountsOf(list, "claude_code").map((a) => a.id)).toEqual([ID3, ID1]);
    expect(accountsOf(list, "codex").map((a) => a.id)).toEqual([ID2]);
  });

  test("planLabel capitalizes the CLI's word and drops an empty one", () => {
    expect(planLabel("max")).toBe("Max");
    expect(planLabel(" team ")).toBe("Team");
    expect(planLabel("")).toBeNull();
    expect(planLabel(undefined)).toBeNull();
  });

  test("only bad_request means an older runner", () => {
    expect(isUnsupported(new ControlError("bad_request", "x"))).toBe(true);
    expect(isUnsupported(new ControlError("timeout", "x"))).toBe(false);
    expect(isUnsupported(new Error("x"))).toBe(false);
  });
});

describe("startAccountLogin", () => {
  test("begins, shows the link and code, polls until done", async () => {
    let polls = 0;
    const account: RunnerAccountInfo = { id: ID1, kind: "codex", loggedIn: true, email: "voce@acme.com", plan: "plus" };
    const { sent, timers, views } = login(
      {
        "account.begin": () => ({ loginId: ID1, url: "https://example.com/device", userCode: "ABCD-EFGHI" }),
        "account.status": () => (++polls < 2 ? { state: "waiting" } : { state: "done", account }),
      },
      "codex",
    );
    expect(views[0]).toEqual({ phase: "starting" });
    await flush();
    expect(sent[0]).toEqual({ type: "account.begin", kind: "codex" });
    expect(views.at(-1)).toEqual({
      phase: "waiting",
      loginId: ID1,
      url: "https://example.com/device",
      userCode: "ABCD-EFGHI",
    });
    timers.fire();
    await flush();
    expect(views.at(-1)?.phase).toBe("waiting");
    expect(timers.size).toBe(1);
    timers.fire();
    await flush();
    expect(views.at(-1)).toEqual({ phase: "done", account });
    expect(timers.size).toBe(0);
  });

  test("expired and failed end the wait", async () => {
    for (const state of ["expired", "failed"] as const) {
      const { timers, views } = login({
        "account.begin": () => ({ loginId: ID1, url: "https://example.com" }),
        "account.status": () => ({ state }),
      });
      await flush();
      timers.fire();
      await flush();
      expect(views.at(-1)).toEqual({ phase: "failed", reason: state });
      expect(timers.size).toBe(0);
    }
  });

  test("a begin that fails is an error", async () => {
    const { views } = login({});
    await flush();
    expect(views.at(-1)).toEqual({ phase: "failed", reason: "error" });
  });

  test("a slow status is asked again; a lost sign-in stops", async () => {
    let polls = 0;
    const { timers, views } = login({
      "account.begin": () => ({ loginId: ID1, url: "https://example.com" }),
      "account.status": () => {
        polls += 1;
        throw new ControlError(polls === 1 ? "timeout" : "not_found", "x");
      },
    });
    await flush();
    timers.fire();
    await flush();
    expect(views.at(-1)?.phase).toBe("waiting");
    expect(timers.size).toBe(1);
    timers.fire();
    await flush();
    expect(views.at(-1)).toEqual({ phase: "failed", reason: "error" });
  });

  test("cancel stops polling and cancels the sign-in on the runner", async () => {
    const { handle, sent, timers, views } = login({
      "account.begin": () => ({ loginId: ID1, url: "https://example.com" }),
      "account.status": () => ({ state: "waiting" }),
      "account.cancel": () => ({ canceled: true }),
    });
    await flush();
    handle.cancel();
    await flush();
    expect(timers.size).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "account.cancel", loginId: ID1 });
    const seen = views.length;
    timers.fire();
    await flush();
    expect(views.length).toBe(seen);
  });

  test("canceled before the runner answered: the sign-in it started is canceled too", async () => {
    const { handle, sent, views } = login({
      "account.begin": () => ({ loginId: ID2, url: "https://example.com" }),
      "account.cancel": () => ({ canceled: true }),
    });
    handle.cancel();
    await flush();
    expect(sent.map((r) => r.type)).toEqual(["account.begin", "account.cancel"]);
    expect(views).toEqual([{ phase: "starting" }]);
  });

  test("no cancel after it is done", async () => {
    const { handle, sent, timers } = login({
      "account.begin": () => ({ loginId: ID1, url: "https://example.com" }),
      "account.status": () => ({ state: "done" }),
    });
    await flush();
    timers.fire();
    await flush();
    handle.cancel();
    await flush();
    expect(sent.map((r) => r.type)).toEqual(["account.begin", "account.status"]);
  });
});
