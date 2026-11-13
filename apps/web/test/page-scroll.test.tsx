import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ROUTES = join(import.meta.dir, "..", "src", "routes");

/** The page column scrolls; nothing left a lock on the body (a dialog, a sheet). */
function expectScrollable() {
  const main = document.querySelector("main.shell__main") as HTMLElement;
  expect(main).toBeTruthy();
  expect(main.classList.contains("shell__main--chat")).toBe(false);
  expect(main.style.overflow).not.toBe("hidden");
  expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.body.style.overflow).not.toBe("hidden");
}

describe("every page scrolls", () => {
  test("only chat-like pages use the clipped chat column (it scrolls inside its message list)", () => {
    // The Issues board used the chat column and its tall "A fazer" column could not be reached.
    const chat = readdirSync(ROUTES).filter((f) => readFileSync(join(ROUTES, f), "utf8").includes("shell__main--chat"));
    expect(chat).toEqual(["org.$orgId.calendar.tsx"]);
  });

  test("Issues: the board scrolls in the main column, also after a details dialog opens and closes", async () => {
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(8);
    expectScrollable();
    await act(async () =>
      fireEvent.click(screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" })),
    );
    await settle(4);
    expect(screen().getByRole("dialog")).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(3);
    expect(screen().queryByRole("dialog")).toBeNull();
    expectScrollable();
  });

  test("Threads, Rotinas and the Drive scroll in the main column too", async () => {
    for (const path of ["threads", "routines", "drive"]) {
      await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(seedState()) });
      await settle(6);
      expectScrollable();
      cleanup();
    }
  });
});
