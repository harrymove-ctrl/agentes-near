import { describe, expect, test } from "bun:test";
import {
  coverHere,
  FAIL_TEXT,
  failedStep,
  hereBanner,
  hereLine,
  hereView,
  isHereServer,
  type LocalServerStatus,
  NO_SERVER,
  REASON_TEXT,
  STEP_SLOW_MS,
  setupSteps,
  stepClock,
  stepStates,
  UPDATE_SLOW_MS,
} from "../src/control/local-server";
import { menuLabels } from "../src/control/menu-labels";
import { createDesktopI18n } from "../src/i18n";

const LOCAL = "http://127.0.0.1:4310";
const TAILNET = "https://ana-mac.tail1234.ts.net";
const running: LocalServerStatus = {
  ...NO_SERVER,
  bundled: true,
  installed: "app",
  run: true,
  owner: true,
  phase: "running",
  url: LOCAL,
  publicUrl: LOCAL,
  version: "1.4.0",
  dir: "/Users/ana/.agentes",
};
const reached: LocalServerStatus = { ...running, reach: true, publicUrl: TAILNET };

describe("setting it up", () => {
  test("the steps in order, access from other devices only when asked", () => {
    expect(setupSteps(false)).toEqual(["database", "start", "account", "computer"]);
    expect(setupSteps(true)).toEqual(["database", "start", "account", "computer", "reach"]);
  });

  test("each step's state from what arrived; a failure stays on its step", () => {
    const steps = setupSteps(true);
    expect(stepStates(steps, [])).toEqual({
      database: "todo",
      start: "todo",
      account: "todo",
      computer: "todo",
      reach: "todo",
    });
    const states = stepStates(steps, [
      { step: "database", state: "active" },
      { step: "database", state: "done" },
      { step: "start", state: "active" },
      { step: "start", state: "failed" },
    ]);
    expect(states).toMatchObject({ database: "done", start: "failed", account: "todo" });
    // Reach failing is a warning: the rest went on.
    expect(stepStates(steps, [{ step: "reach", state: "warn", reason: { reason: "https", url: null } }]).reach).toBe(
      "warn",
    );
  });

  test("every step, failure and reason has its words in both languages", () => {
    for (const lng of ["en", "pt-BR"] as const) {
      const i18n = createDesktopI18n(lng, "mac");
      const has = (key: string) => i18n.exists(key);
      for (const step of setupSteps(true))
        expect({ step, ok: has(`desktop.here.step.${step}`) }).toEqual({ step, ok: true });
      for (const key of [
        ...Object.values(REASON_TEXT),
        ...Object.values(FAIL_TEXT),
        "desktop.here.slow",
        "desktop.here.copyDetails",
        "desktop.here.serveFix",
        "desktop.here.fail.retry",
      ]) {
        expect({ key, ok: has(key) }).toEqual({ key, ok: true });
      }
      const reason = i18n.t(REASON_TEXT.https);
      expect(i18n.t("desktop.server.reachFailed", { reason })).toContain(reason);
      // Screen readers hear each step's state: the marks on screen are drawn.
      for (const state of ["active", "done", "failed", "warn"])
        expect({ state, ok: has(`desktop.here.stepState.${state}`) }).toEqual({ state, ok: true });
    }
  });

  test("a step's time shows from 10 s, and from 30 s it takes a little longer than expected (two minutes for an update)", () => {
    expect(stepClock(9_999)).toEqual({ time: false, slow: false });
    expect(stepClock(10_000)).toEqual({ time: true, slow: false });
    expect(stepClock(STEP_SLOW_MS - 1)).toEqual({ time: true, slow: false });
    expect(stepClock(30_000)).toEqual({ time: true, slow: true });
    expect(UPDATE_SLOW_MS).toBe(120_000);
    expect(stepClock(30_000, UPDATE_SLOW_MS)).toEqual({ time: true, slow: false });
    expect(stepClock(120_000, UPDATE_SLOW_MS)).toEqual({ time: true, slow: true });
  });

  test("a setup that ended in an error always stops on a step", () => {
    const steps = setupSteps(false);
    const at = (...changes: Parameters<typeof stepStates>[1]) => failedStep(steps, stepStates(steps, changes));
    const done = (step: (typeof steps)[number]) => [
      { step, state: "active" as const },
      { step, state: "done" as const },
    ];
    // The step that said so.
    expect(at(...done("database"), { step: "start", state: "active" }, { step: "start", state: "failed" })).toBe(
      "start",
    );
    // Else the one under way.
    expect(at(...done("database"), ...done("start"), { step: "account", state: "active" })).toBe("account");
    // Else the first one not done, and with every step done, the last.
    expect(at()).toBe("database");
    expect(at(...done("database"), ...done("start"), ...done("account"), ...done("computer"))).toBe("computer");
  });
});

describe("which screen", () => {
  test("nothing here yet: the form with the owner's name and email", () => {
    expect(hereView({ ...NO_SERVER, bundled: true }, null)).toEqual({ kind: "form", ask: true });
  });

  test("the app's own server from before: started again without asking who", () => {
    expect(hereView({ ...running, run: false, phase: "off" }, null)).toEqual({ kind: "form", ask: false });
    // Set up but its owner never made (the first try stopped there): the form asks again.
    expect(hereView({ ...running, run: false, owner: false, phase: "off" }, null)).toEqual({ kind: "form", ask: true });
  });

  test("one installed from the terminal, or another answering here: use it, with its claim while it waits", () => {
    const terminal = { ...NO_SERVER, installed: "terminal" as const, url: LOCAL, serving: true };
    expect(hereView({ ...terminal, claim: "c".repeat(43) }, null)).toEqual({
      kind: "already",
      server: LOCAL,
      claim: "c".repeat(43),
    });
    expect(hereView({ ...NO_SERVER, bundled: true }, "http://127.0.0.1:3000")).toEqual({
      kind: "already",
      server: "http://127.0.0.1:3000",
      claim: null,
    });
    // The app's own server isn't "another one".
    expect(hereView(running, "http://127.0.0.1:3000").kind).toBe("running");
  });

  test("a terminal install that isn't running: it starts where it was installed, nothing to use yet", () => {
    expect(hereView({ ...NO_SERVER, installed: "terminal", url: LOCAL, serving: false }, null)).toEqual({
      kind: "stopped",
    });
    expect(hereView({ ...NO_SERVER, installed: "terminal", url: null }, "http://127.0.0.1:3000")).toEqual({
      kind: "stopped",
    });
  });

  test("the app runs it already: open it, never set it up again", () => {
    expect(hereView(running, null)).toEqual({ kind: "running", server: LOCAL });
    expect(hereView(reached, null)).toEqual({ kind: "running", server: TAILNET });
    expect(hereView({ ...running, phase: "failing" }, null).kind).toBe("running");
  });
});

describe("what the popover, the cover and Preferences say", () => {
  test("its state in a few words", () => {
    expect(hereLine(running)).toBe("desktop.server.onlyHere");
    expect(hereLine(reached)).toBe("desktop.server.onTailnet");
    expect(hereLine({ ...running, phase: "starting" })).toBe("desktop.server.starting");
    expect(hereLine({ ...running, phase: "updating" })).toBe("desktop.server.updating");
    expect(hereLine({ ...running, phase: "failing" })).toBe("desktop.server.failing");
    expect(hereLine({ ...running, phase: "stopped" })).toBe("desktop.server.stopped");
    // Starting again by itself is never "stopped"; Tailscale off here means nobody else reaches it.
    expect(hereLine({ ...running, phase: "restarting" })).toBe("desktop.server.restarting");
    expect(hereLine({ ...reached, tailnetDown: true })).toBe("desktop.server.tailnetDown");
  });

  test("the popover's banners", () => {
    expect(hereBanner(running)).toBeNull();
    expect(hereBanner({ ...running, phase: "stopped" })).toBe("stopped");
    expect(hereBanner({ ...running, phase: "failing" })).toBe("failing");
    expect(hereBanner({ ...running, phase: "restarting" })).toBeNull();
    expect(hereBanner({ ...running, backTo: "0.6.0" })).toBe("back");
    expect(hereBanner({ ...running, run: false, phase: "off" })).toBeNull();
  });

  test("the server here, at either of its addresses", () => {
    expect(isHereServer(running, LOCAL)).toBe(true);
    expect(isHereServer(reached, TAILNET)).toBe(true);
    expect(isHereServer(reached, LOCAL)).toBe(true);
    expect(isHereServer(running, "https://app.agentes.chat")).toBe(false);
    expect(isHereServer({ ...running, run: false }, LOCAL)).toBe(false);
  });

  test("the cover: each state over the server here, and Tailscale not connected at its Tailscale address", () => {
    expect(coverHere({ ...running, phase: "starting" }, LOCAL, false)).toBe("starting");
    expect(coverHere({ ...running, phase: "restarting" }, LOCAL, false)).toBe("starting");
    expect(coverHere({ ...running, phase: "updating" }, LOCAL, false)).toBe("migrating");
    expect(coverHere({ ...running, phase: "stopped" }, LOCAL, false)).toBe("stopped");
    expect(coverHere({ ...running, phase: "failing" }, LOCAL, false)).toBe("failing");
    expect(coverHere(running, LOCAL, true)).toBeNull();
    expect(coverHere(reached, TAILNET, false)).toBe("tailnetOff");
    expect(coverHere(reached, TAILNET, true)).toBeNull();
    // Another server: the cover's own reachability words, not these.
    expect(coverHere({ ...running, phase: "stopped" }, "https://app.agentes.chat", false)).toBeNull();
  });

  test("Rust's labels for the tray line and the notifications, with {version} left for Rust", () => {
    const labels = menuLabels(createDesktopI18n("en", "linux").t);
    expect(labels.serverTitle).toBe("agentes.chat on this computer");
    expect(labels.serverStop).toBe("Stop");
    expect(labels.hereBack).toBe("The update didn't start. agentes.chat is back on {version}.");
  });

  test("Rust's notification for a setup that failed while its window was closed, in both languages", () => {
    const en = menuLabels(createDesktopI18n("en", "mac").t);
    expect([en.setupFailed, en.setupFailedBody]).toEqual([
      "Setting up agentes.chat on this Mac didn't finish",
      "Open agentes.chat to see what happened.",
    ]);
    const pt = menuLabels(createDesktopI18n("pt-BR", "windows").t);
    expect([pt.setupFailed, pt.setupFailedBody]).toEqual([
      "A preparação do agentes.chat neste PC não terminou",
      "Abra o agentes.chat para ver o que aconteceu.",
    ]);
  });
});
