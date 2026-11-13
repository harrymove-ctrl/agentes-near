import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { SearchSelect, type SelectOption } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";

afterEach(() => cleanup());

const labels = { search: "Buscar modelos", searchPlaceholder: "Nome", noResults: "Nada", list: "Modelos" };
const OPTIONS: SelectOption[] = [
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Claude" },
  { value: "~z-ai/glm-latest", label: "Z.ai: GLM Latest", group: "OpenRouter · Boas escolhas" },
  { value: "z-ai/glm-5.3", label: "Z.ai: GLM 5.3", group: "OpenRouter", disabled: true },
  { value: "tencent/hy3-preview", label: "Tencent: Hy3 preview", group: "OpenRouter" },
];

function Harness() {
  const [value, setValue] = useState("claude-sonnet-5-5");
  return <SearchSelect aria-label="Modelo" value={value} onValueChange={setValue} options={OPTIONS} labels={labels} />;
}

describe("SearchSelect", () => {
  test("opens on the chosen one; the search reads names, ids and groups; arrows and Enter pick, never a disabled one", async () => {
    render(<Harness />);
    const box = document.body.querySelector('[role="combobox"]') as HTMLElement;
    expect(box.textContent).toBe("Claude Sonnet 5.5");
    await act(async () => fireEvent.keyDown(box, { key: "ArrowDown" }));
    const list = within(document.body).getByRole("listbox", { name: "Modelos" });
    expect(
      within(list)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Claude", "OpenRouter · Boas escolhas", "OpenRouter"]);
    const chosen = within(list)
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(chosen?.hasAttribute("data-active")).toBe(true);
    // The check closes the row, so every name starts at one edge.
    expect(chosen?.lastElementChild?.className).toBe("ac-tz__check");
    expect(chosen?.firstElementChild?.className).toBe("ac-menu__label");
    const search = within(document.body).getByRole("combobox", { name: "Buscar modelos" });
    const shown = () =>
      within(list)
        .queryAllByRole("option")
        .map((o) => o.textContent);
    // By the id's maker, accents and case aside.
    await act(async () => fireEvent.change(search, { target: { value: "Z-AI" } }));
    expect(shown()).toEqual(["Z.ai: GLM Latest", "Z.ai: GLM 5.3"]);
    // The second is disabled: Enter on it does nothing.
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toBe("Claude Sonnet 5.5");
    await act(async () => fireEvent.change(search, { target: { value: "openrouter hy3" } }));
    expect(shown()).toEqual(["Tencent: Hy3 preview"]);
    await act(async () => fireEvent.change(search, { target: { value: "gpt" } }));
    expect(shown()).toEqual([]);
    expect(list.textContent).toBe("Nada");
    await act(async () => fireEvent.change(search, { target: { value: "glm latest" } }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toBe("Z.ai: GLM Latest");
  });
});
