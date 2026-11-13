import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { zoneDisplayName } from "@agenteschat/client/lib/routines";
import { TimezoneSelect } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";

afterEach(() => cleanup());

const labels = {
  search: "Buscar fuso",
  searchPlaceholder: "Cidade",
  noResults: "Nada",
  list: "Fusos horários",
  groups: {
    suggested: "Sugeridos",
    America: "América",
    Europe: "Europa",
    Asia: "Ásia",
    Africa: "África",
    Oceania: "Oceania",
    Antarctica: "Antártida",
    Other: "Outros",
  },
};

function Harness() {
  const [zone, setZone] = useState("America/Sao_Paulo");
  return (
    <TimezoneSelect
      aria-label="Fuso horário"
      value={zone}
      onChange={setZone}
      labels={labels}
      nameOf={(z) => zoneDisplayName(z, "pt-BR")}
      suggested={["America/Sao_Paulo", "UTC"]}
    />
  );
}

describe("TimezoneSelect", () => {
  test("the trigger reads 'Horário de Brasília · UTC−3'; the selected row has a check; search and Enter pick", async () => {
    render(<Harness />);
    const box = document.body.querySelector('[role="combobox"]') as HTMLElement;
    expect(box.textContent).toContain("Horário de Brasília · UTC−3");
    await act(async () => fireEvent.click(box));
    const list = within(document.body).getByRole("listbox", { name: "Fusos horários" });
    const suggested = within(list).getByRole("group", { name: "Sugeridos" });
    const selected = within(suggested)
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Horário de Brasília");
    expect(selected?.querySelector(".ac-tz__check svg")).not.toBeNull();
    const search = within(document.body).getByRole("combobox", { name: "Buscar fuso" });
    await act(async () => fireEvent.change(search, { target: { value: "lisboa" } }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toContain("Lisboa");
  });
});
