import { expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createDesktopI18n } from "../src/i18n";
import { WindowError } from "../src/WindowView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Broken(): null {
  throw new Error("the window broke");
}

test("a window that breaks while drawing says so with Try again, never an empty window", async () => {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", "mac")}>
          <ErrorBoundary fallback={() => <WindowError />}>
            <Broken />
          </ErrorBoundary>
        </I18nextProvider>,
      ),
    );
    expect(el.querySelector(".ac-empty__text")?.textContent).toBe("Something went wrong. Try again.");
    expect(el.textContent).not.toContain("the window broke");
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    await act(async () => retry?.click());
    expect(reload).toHaveBeenCalledTimes(1);
    // Every window is drawn under it (main.tsx).
    const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
    expect(main).toMatch(/<ErrorBoundary fallback=\{\(\) => <WindowError \/>\}>[\s\S]*<WindowView /);
  } finally {
    reload.mockRestore();
    await act(async () => root.unmount());
    el.remove();
  }
});
