import { describe, expect, test } from "bun:test";
import type { ControlBrowser, ControlJob, ControlStatus } from "@agenteschat/adapters/runner-control";
import {
  browserBadgeOf,
  browserRowState,
  browsersOf,
  helpRequestKeys,
  newHelpRequests,
  siteLink,
} from "../src/control/browser";
import { type TrayInput, trayStateOf } from "../src/control/tray";

const status = (browsers: ControlBrowser[], over: Partial<ControlStatus> = {}): ControlStatus => ({
  paired: true,
  connection: "online",
  version: "0.3.3",
  protocol: 12,
  paused: { paused: false },
  executors: {},
  agents: [],
  org: { id: "o1", name: "Acme" },
  browsers,
  ...over,
});
const using: ControlBrowser = {
  agentId: "a1",
  open: true,
  host: "app.acme.example",
  doing: "filling",
  link: "/org/o1/c/c1",
};
const asking: ControlBrowser = {
  agentId: "a1",
  open: true,
  host: "app.acme.example",
  handoff: { status: "pending", request: "Entrar na Acme", link: "/org/o1/c/c1?m=h1" },
};
const job: ControlJob = { id: "j", kind: "brain", summary: "pensando", startedAt: "2026-10-19T20:00:00Z" };
const home = (s: ControlStatus, jobs: ControlJob[] = []): TrayInput => ({ running: true, status: s, jobs });

describe("the tray icon", () => {
  test("a ring while an agent is in its browser, over working", () => {
    expect(trayStateOf([home(status([using]), [job])], false)).toBe("browsing");
  });
  test("a dot when an agent needs a person, even paused", () => {
    expect(trayStateOf([home(status([asking], { paused: { paused: true, until: null } }))], false)).toBe("needs");
  });
  test("paused beats the ring; nothing open is the usual icon", () => {
    expect(trayStateOf([home(status([using], { paused: { paused: true, until: null } }))], false)).toBe("paused");
    expect(trayStateOf([home(status([{ ...using, open: false }]))], false)).toBe("idle");
    expect(browserBadgeOf([status([])])).toBeNull();
  });
});

describe("the agent's row", () => {
  test("using, someone in control, or needs you", () => {
    expect(browserRowState(using)).toEqual({ kind: "using", link: "/org/o1/c/c1" });
    expect(browserRowState({ ...using, handoff: { status: "active", controller: "Walter" } })).toEqual({
      kind: "control",
      controller: "Walter",
      link: "/org/o1/c/c1",
    });
    expect(browserRowState(asking)).toEqual({
      kind: "needs",
      request: "Entrar na Acme",
      link: "/org/o1/c/c1?m=h1",
    });
  });
  test("a closed browser shows only while a person's turn is open", () => {
    expect(browsersOf(status([{ agentId: "a2", open: false }]))).toEqual([]);
    expect(browsersOf(status([{ agentId: "a2", open: false, handoff: { status: "pending" } }]))).toHaveLength(1);
  });
  test("links go only to the runner's server, and only to /org paths", () => {
    expect(siteLink("https://app.agentes.chat", "/org/o1/c/c1?m=h1", "home")).toBe(
      "https://app.agentes.chat/org/o1/c/c1?m=h1",
    );
    expect(siteLink("https://app.agentes.chat", "//evil.example/x", "home")).toBe("home");
    expect(siteLink("https://app.agentes.chat", "https://evil.example/org/x/", "home")).toBe("home");
    expect(siteLink("http://agentes.chat", "/org/o1/c/c1", "home")).toBe("home");
    expect(siteLink(undefined, "/org/o1/c/c1", "home")).toBe("home");
  });
});

describe("notifications", () => {
  test("each new request once; ones already there don't notify", () => {
    const before = helpRequestKeys([status([])]);
    const fresh = newHelpRequests(before, [status([asking])]);
    expect(fresh.map((r) => r.agentId)).toEqual(["a1"]);
    const after = helpRequestKeys([status([asking])]);
    expect(newHelpRequests(after, [status([asking])])).toEqual([]);
  });
});
