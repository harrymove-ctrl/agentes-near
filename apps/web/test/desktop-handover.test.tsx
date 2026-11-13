import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AppNotification } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { desktopNotice } from "@/lib/desktop";
import { createFakeApi, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * The desktop app's window, opened on a server by a connect link with a one-time sign-in (ADR 0066): the page
 * takes the token out of the address at once and trades it for a session of the window's own.
 */

const TOKEN = "Qm9vdHN0cmFwLXRva2VuLTEyMzQ1Njc4OTBhYmNkZWY";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function recordAssign() {
  const urls: string[] = [];
  const spy = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    urls.push(String(url));
  });
  return { urls, restore: () => spy.mockRestore() };
}

describe("/desktop/handover", () => {
  test("the token is traded once and leaves the address; then the app opens signed in", async () => {
    const assign = recordAssign();
    const { auth, calls } = createFakeAuth();
    try {
      window.history.replaceState(null, "", `/desktop/handover#token=${TOKEN}`);
      await renderApp(`/desktop/handover#token=${TOKEN}`, { api: createFakeApi(seedState({ me: null })), auth });
      await settle(6);
      expect(calls.filter((c) => c.method === "signInOneTime")).toEqual([{ method: "signInOneTime", args: [TOKEN] }]);
      expect(window.location.hash).toBe("");
      expect(assign.urls).toEqual(["/"]);
    } finally {
      assign.restore();
    }
  });

  test("an expired or used code says so, and leads to the sign-in", async () => {
    const assign = recordAssign();
    const { auth } = createFakeAuth({ oneTime: { ok: false, status: 401, message: "expired" } });
    try {
      window.history.replaceState(null, "", `/desktop/handover#token=${TOKEN}`);
      await renderApp(`/desktop/handover#token=${TOKEN}`, { api: createFakeApi(seedState({ me: null })), auth });
      await settle(6);
      expect(screen().getByRole("heading").textContent).toBe("O código expirou ou já foi usado.");
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Continuar" })));
      expect(assign.urls).toEqual(["/login"]);
    } finally {
      assign.restore();
    }
  });

  test("no token, or not one: nothing is traded", async () => {
    const { auth, calls } = createFakeAuth();
    window.history.replaceState(null, "", "/desktop/handover#token=<script>");
    await renderApp("/desktop/handover#token=<script>", { api: createFakeApi(seedState({ me: null })), auth });
    await settle(6);
    expect(calls.some((c) => c.method === "signInOneTime")).toBe(false);
    expect(screen().getByRole("heading").textContent).toBe("O código expirou ou já foi usado.");
  });
});

describe("the desktop app's notifications", () => {
  const t = createI18n("en").t;
  const n = (over: Partial<AppNotification>): AppNotification =>
    ({
      id: "n1",
      kind: "mention",
      waiting: false,
      actors: [],
      count: 1,
      source: {},
      latest: { text: "Can you  look at\nthe report?" },
      readAt: null,
      doneAt: null,
      snoozedUntil: null,
      createdAt: "",
      updatedAt: "",
      ...over,
    }) as AppNotification;

  test("what a phone would get pushed, new and unread, opening the inbox", () => {
    expect(desktopNotice(t, "o1", n({}))).toEqual({
      title: "You were mentioned",
      body: "Can you look at the report?",
      path: "/org/o1/notifications",
    });
    expect(
      desktopNotice(t, "o1", n({ kind: "approval", latest: { title: "Deploy to production", text: "why" } })),
    ).toMatchObject({ title: "An approval is waiting for you", body: "Deploy to production" });
    expect(desktopNotice(t, "o1", n({ kind: "issue_status", waiting: true }))).toMatchObject({
      title: "Something is waiting for you",
    });
    expect(desktopNotice(t, "o1", n({ latest: { text: "x".repeat(400) } }))?.body).toHaveLength(180);
  });

  test("someone's agent on a phone of mine: who, what for whom, the phone's page and its Stop", () => {
    const inUse = n({
      kind: "device.in_use",
      actors: [{ type: "agent", id: "ag_lia" }],
      source: { phoneId: "p-1", machineId: "m-1", userId: "u_rui", label: "Pixel 8" },
      latest: { title: "Rui Tanaka", text: "Recording a test video" },
    });
    expect(desktopNotice(t, "o1", inUse, (id) => (id === "ag_lia" ? "Lia" : undefined))).toEqual({
      title: "Lia is using Pixel 8",
      body: "Recording a test video for Rui",
      path: "/org/o1/settings/devices/phones/p-1",
      phoneId: "p-1",
    });
    // An agent this page doesn't know yet, and nothing said about what it does.
    expect(desktopNotice(t, "o1", n({ ...inUse, latest: { title: "Rui Tanaka" } }))).toMatchObject({
      title: "An agent is using Pixel 8",
      body: "For Rui",
    });
  });

  test("merged into one already shown, read, done, or not worth a notification: none", () => {
    expect(desktopNotice(t, "o1", n({ count: 2 }))).toBeNull();
    expect(desktopNotice(t, "o1", n({ readAt: "2026-10-25T10:00:00Z" }))).toBeNull();
    expect(desktopNotice(t, "o1", n({ doneAt: "2026-10-25T10:00:00Z" }))).toBeNull();
    expect(desktopNotice(t, "o1", n({ kind: "thread_reply" }))).toBeNull();
  });
});
