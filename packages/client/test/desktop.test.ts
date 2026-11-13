import { describe, expect, test } from "bun:test";
// By path: the client doesn't depend on the adapters, so the package isn't linked here.
import { STREAM_CLOSE } from "../../adapters/src/machine-protocol";
import type { BrowserHandoff, DesktopStatus } from "../src/index";
import {
  askControlWords,
  browserScreenKey,
  browserShowsDesktop,
  DESKTOP_CLOSE,
  desktopCloseState,
  desktopMode,
  desktopRetryMs,
  desktopSocketUrl,
  desktopStatusState,
  desktopSwitch,
  desktopWithHandoff,
  drivesOnDesktop,
  previewGivesUp,
  screenRefusalMs,
} from "../src/index";

const handoff = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h1",
  agentId: "a1",
  runId: null,
  machineId: "m1",
  screen: "desktop",
  kind: "takeover",
  instructions: "",
  status: "active",
  requestedForUserId: null,
  controllerUserId: "me",
  note: null,
  expiresAt: null,
  createdAt: "2026-10-24T10:00:00.000Z",
  resolvedAt: null,
  ...over,
});

const status = (over: Partial<DesktopStatus> = {}): DesktopStatus => ({
  available: true,
  reason: null,
  detail: null,
  running: true,
  startedAt: null,
  controllerUserId: null,
  handoff: null,
  viewers: 0,
  canControl: true,
  held: false,
  ...over,
});

describe("the agent's screen", () => {
  test("the mirror matches the protocol's close codes", () => {
    for (const [name, code] of Object.entries(DESKTOP_CLOSE)) {
      expect(STREAM_CLOSE[name as keyof typeof STREAM_CLOSE]).toBe(code);
    }
  });

  test("close codes: what shows and whether it opens again by itself", () => {
    expect(desktopCloseState(4410)).toEqual({ state: "connecting", retry: "now" });
    expect(desktopCloseState(4409)).toEqual({ state: "hidden", retry: "later" });
    expect(desktopCloseState(4403)).toEqual({ state: "forbidden", retry: "never" });
    expect(desktopCloseState(4404, "no_desktop")).toEqual({ state: "unavailable", retry: "never" });
    expect(desktopCloseState(4429)).toEqual({ state: "busy", retry: "later" });
    expect(desktopCloseState(4503, "offline")).toEqual({ state: "offline", retry: "later" });
    expect(desktopCloseState(1000)).toEqual({ state: "ended", retry: "never" });
    // An older computer refuses a screen that isn't running: the server starts it, so it is opening, never off.
    expect(desktopCloseState(4502, "desktop_off")).toEqual({ state: "connecting", retry: "later" });
    // No memory left for another screen: "Tentar de novo", nothing by itself.
    expect(desktopCloseState(4502, "desktop_busy")).toEqual({ state: "noRoom", retry: "never" });
    expect(desktopCloseState(4502, "machine_paused")).toEqual({ state: "paused", retry: "later" });
    // A held agent's screen that isn't running: nothing starts it, so the held cover, until the hold ends.
    expect(desktopCloseState(4502, "held")).toEqual({ state: "held", retry: "later" });
    expect(desktopCloseState(4502, "runner_outdated")).toEqual({ state: "outdated", retry: "never" });
    expect(desktopCloseState(4502, "not_allowed")).toEqual({ state: "unavailable", retry: "never" });
    expect(desktopCloseState(4502, "internal")).toEqual({ state: "connecting", retry: "later" });
    for (const code of [1001, 1005, 1006, 1011, 1013, 4400, 4408]) {
      expect(desktopCloseState(code)).toEqual({ state: "connecting", retry: "later" });
    }
    expect([0, 1, 2, 3, 9].map(desktopRetryMs)).toEqual([1000, 2000, 5000, 10_000, 10_000]);
  });

  test("its state before a socket: someone else in control, or why it can't show; one not running opens", () => {
    expect(desktopStatusState(status(), "me")).toBeNull();
    // Opening the stream starts it: no "off" before it.
    expect(desktopStatusState(status({ running: false }), "me")).toBeNull();
    expect(desktopStatusState(status({ controllerUserId: "ana" }), "me")).toBe("hidden");
    expect(desktopStatusState(status({ controllerUserId: "me" }), "me")).toBeNull();
    expect(desktopStatusState(status({ available: false, reason: "offline" }), "me")).toBe("offline");
    expect(desktopStatusState(status({ available: false, reason: "runner_outdated" }), "me")).toBe("outdated");
    expect(desktopStatusState(status({ available: false, reason: "not_allowed" }), "me")).toBe("unavailable");
    // Held: a screen that runs may be watched; one that doesn't isn't started, so no socket opens for it.
    expect(desktopStatusState(status({ held: true }), "me")).toBeNull();
    expect(desktopStatusState(status({ held: true, running: false }), "me")).toBe("held");
  });

  test("control only on the desktop's own handoff, active and mine", () => {
    expect(desktopMode(status({ handoff: handoff() }), "me")).toBe("control");
    expect(desktopMode(status({ handoff: handoff({ controllerUserId: "ana" }) }), "me")).toBe("watch");
    expect(desktopMode(status({ handoff: handoff({ status: "pending", controllerUserId: null }) }), "me")).toBe(
      "watch",
    );
    // The browser's handoff, its Chrome showing on the desktop: who may drive the screen helps on it, the others
    // watch it from here (they help in the page).
    expect(desktopMode(status({ handoff: handoff({ screen: "browser" }), canControl: true }), "me")).toBe("control");
    expect(desktopMode(status({ handoff: handoff({ screen: "browser" }), canControl: false }), "me")).toBe("watch");
    expect(desktopMode(status(), "me")).toBe("watch");
  });

  test("a browser request is helped with on the whole screen only by who may drive it, on the screen its window is on", () => {
    const ask = handoff({ id: "h-ask", screen: "browser", status: "pending", controllerUserId: null });
    const on = { available: true, canControl: true, handoff: ask };
    expect(drivesOnDesktop(ask, on)).toBe(true);
    expect(drivesOnDesktop(ask, { ...on, canControl: false })).toBe(false);
    // Its browser on another computer than the screen (the screen holds no handoff of it), or no screen at all.
    expect(drivesOnDesktop(ask, { ...on, handoff: null })).toBe(false);
    expect(drivesOnDesktop(ask, { ...on, available: false })).toBe(false);
    expect(drivesOnDesktop(ask, null)).toBe(false);
    expect(drivesOnDesktop(handoff({ screen: "desktop" }), null)).toBe(true);
  });

  test("a handoff that changed: the desktop's own updates its state; another screen's only when it named it", () => {
    const taken = desktopWithHandoff(status(), handoff());
    expect(taken).toMatchObject({ handoff: { id: "h1" }, controllerUserId: "me" });
    expect(desktopWithHandoff(taken, handoff({ status: "done" }))).toMatchObject({
      handoff: null,
      controllerUserId: null,
    });
    const browsers = handoff({ id: "h2", screen: "browser", controllerUserId: "ana" });
    expect(desktopWithHandoff(status(), browsers)).toEqual(status());
    expect(desktopWithHandoff(status({ handoff: browsers }), { ...browsers, status: "done" })).toMatchObject({
      handoff: null,
    });
    expect(desktopWithHandoff(taken, handoff({ id: "other", status: "done" }))).toBe(taken);
  });

  test("socket addresses: ws or wss on the page's host; no keyboard layout, in either mode", () => {
    const base = { protocol: "https:", host: "agentes.chat" };
    expect(desktopSocketUrl(base, { orgId: "o1", agentId: "a1", mode: "watch" })).toBe(
      "wss://agentes.chat/api/desktop?orgId=o1&agentId=a1&mode=watch",
    );
    expect(desktopSocketUrl("http://localhost:5173/x", { orgId: "o 1", agentId: "a1", mode: "control" })).toBe(
      "ws://localhost:5173/api/desktop?orgId=o%201&agentId=a1&mode=control",
    );
    // One that takes its mode changing in place says so.
    expect(desktopSocketUrl(base, { orgId: "o1", agentId: "a1", mode: "watch", switches: true })).toBe(
      "wss://agentes.chat/api/desktop?orgId=o1&agentId=a1&switch=1&mode=watch",
    );
    // A browser card's view only watches, and never changes mode.
    const card = { orgId: "o1", agentId: "a1", mode: "control", switches: true, preview: true } as const;
    expect(desktopSocketUrl(base, card)).toBe(
      "wss://agentes.chat/api/desktop?orgId=o1&agentId=a1&preview=1&mode=watch",
    );
  });
});

describe("the browser card on the agent's screen (ADR 0058 §7)", () => {
  const me = { userId: "me", holdsBrowser: false };
  const onDesk = (over: Partial<DesktopStatus> = {}) => status({ browserOnDesktop: true, ...over });

  test("the screen shows only while every condition holds", () => {
    expect(browserShowsDesktop(onDesk(), me)).toBe(true);
    // No status yet, or one from an older server.
    expect(browserShowsDesktop(null, me)).toBe(false);
    expect(browserShowsDesktop(undefined, me)).toBe(false);
    expect(browserShowsDesktop(status(), me)).toBe(false);
    expect(browserShowsDesktop(onDesk({ browserOnDesktop: false }), me)).toBe(false);
    // A card never starts a stopped screen.
    expect(browserShowsDesktop(onDesk({ running: false }), me)).toBe(false);
    expect(browserShowsDesktop(onDesk({ available: false, reason: "offline" }), me)).toBe(false);
    // Someone else in control hides it; this person's own control stays on the frames.
    expect(browserShowsDesktop(onDesk({ controllerUserId: "ana" }), me)).toBe(false);
    expect(browserShowsDesktop(onDesk({ controllerUserId: "me" }), me)).toBe(false);
    expect(browserShowsDesktop(onDesk(), { userId: "me", holdsBrowser: true })).toBe(false);
    // A held agent's running screen may be watched.
    expect(browserShowsDesktop(onDesk({ held: true }), me)).toBe(true);
  });

  test("what of the status lets a card that gave up try again", () => {
    const key = browserScreenKey(onDesk());
    expect(browserScreenKey(onDesk({ viewers: 3, canControl: false }))).toBe(key);
    expect(browserScreenKey(onDesk({ running: false }))).not.toBe(key);
    expect(browserScreenKey(onDesk({ startedAt: "2026-11-05T10:00:00.000Z" }))).not.toBe(key);
    expect(browserScreenKey(onDesk({ browserOnDesktop: false }))).not.toBe(key);
    expect(browserScreenKey(onDesk({ controllerUserId: "ana" }))).not.toBe(key);
    expect(browserScreenKey(onDesk({ available: false, reason: "offline" }))).not.toBe(key);
    // Absent reads as false.
    expect(browserScreenKey(status())).toBe(browserScreenKey(onDesk({ browserOnDesktop: false })));
  });

  test("a card that keeps giving up on one status waits longer each time, up to a quarter of an hour", () => {
    expect(screenRefusalMs(0)).toBe(120_000);
    expect(screenRefusalMs(1)).toBe(240_000);
    expect(screenRefusalMs(3)).toBe(900_000);
    expect(screenRefusalMs(10)).toBe(900_000);
  });

  test("a card's screen gives up on anything but opening and live", () => {
    expect(previewGivesUp("connecting")).toBe(false);
    expect(previewGivesUp("live")).toBe(false);
    for (const state of ["hidden", "offline", "busy", "noRoom", "forbidden", "unavailable", "ended", "held"] as const) {
      expect(previewGivesUp(state)).toBe(true);
    }
  });

  test("its closes: only a dropped socket opens it again, a stopped screen ends it", () => {
    const preview = { preview: true };
    expect(desktopCloseState(4502, "desktop_off", preview)).toEqual({ state: "ended", retry: "never" });
    expect(desktopCloseState(4429, "preview_yield", preview)).toEqual({ state: "busy", retry: "never" });
    expect(desktopCloseState(4409, "", preview)).toEqual({ state: "hidden", retry: "never" });
    expect(desktopCloseState(4503, "offline", preview)).toEqual({ state: "offline", retry: "never" });
    expect(desktopCloseState(4502, "machine_paused", preview)).toEqual({ state: "paused", retry: "never" });
    expect(desktopCloseState(4502, "held", preview)).toEqual({ state: "held", retry: "never" });
    expect(desktopCloseState(4403, "", preview)).toEqual({ state: "forbidden", retry: "never" });
    expect(desktopCloseState(1000, "", preview)).toEqual({ state: "ended", retry: "never" });
    expect(desktopCloseState(4410, "", preview)).toEqual({ state: "connecting", retry: "now" });
    for (const code of [1001, 1006, 4408]) {
      expect(desktopCloseState(code, "", preview)).toEqual({ state: "connecting", retry: "later" });
    }
  });
});

describe("watching, then switching control", () => {
  test("the question: the computer, the browser alone and why, or only watching", () => {
    expect(askControlWords(status(), false, true)).toEqual({
      mayTake: true,
      browserOnly: false,
      title: "desktop.ask.title",
      help: "desktop.ask.working",
    });
    expect(askControlWords(status({ canControl: false, controlRefusal: "role" }), true, true)).toMatchObject({
      browserOnly: true,
      title: "desktop.ask.titleBrowser",
      help: "desktop.browserOnly.role",
    });
    expect(askControlWords(status({ canControl: false }), false, true)).toMatchObject({
      mayTake: false,
      title: "desktop.ask.watching",
      help: null,
    });
  });

  test("a switch shows from the person's step until the screen's session is in the new mode", () => {
    const at = (over: Partial<Parameters<typeof desktopSwitch>[0]>) =>
      desktopSwitch({ taking: false, returning: false, mode: "watch", session: "watch", ...over });
    expect(at({})).toBeNull();
    expect(at({ taking: true })).toBe("taking");
    expect(at({ mode: "control" })).toBe("taking");
    expect(at({ mode: "control", session: "control" })).toBeNull();
    expect(at({ returning: true, session: "control" })).toBe("returning");
    expect(at({ session: "control" })).toBe("returning");
    // A page that never says its session: only the step itself.
    expect(at({ mode: "control", session: null })).toBeNull();
  });
});
