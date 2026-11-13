import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

/**
 * TODO(new-event): these tests made `bun test` abort (exit 134, core dumped)
 * in CI right after the calendar proposal test: the "Novo evento" dialog with
 * the new DatePicker / TimeSelect / PeoplePicker, and the DatePicker and
 * TimeSelect interaction tests. They are skipped in the main suite; a
 * separate CI step runs this file alone with RUN_NEW_EVENT=1 and a 20 s
 * timeout, and a failure there fails CI. Bring them back into
 * planning.test.tsx and floating.test.tsx once the main suite runs them
 * without aborting.
 */

import { toYmd } from "@agenteschat/client/lib/format";
import { DatePicker, Field, TimeSelect } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { mondayOf } from "@/pages/CalendarPage";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const body = () => within(document.body);
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const go = async (path: string, api = createFakeApi(seedState())) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, api };
};

describe("DatePicker (interaction)", () => {
  function Harness({ initial = "2026-10-14" }: { initial?: string }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <>
        <Field label="Dia" id="day">
          <DatePicker
            value={value}
            onChange={setValue}
            locale="pt-BR"
            labels={{ previousMonth: "Mês anterior", nextMonth: "Próximo mês", choose: "Escolher data" }}
          />
        </Field>
        <output>{value}</output>
      </>
    );
  }
  const full = (y: number, m: number, d: number) =>
    new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(new Date(y, m - 1, d));

  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "a button with our month grid in a popover, never a native date input",
    async () => {
      const { container } = render(<Harness />);
      expect(container.querySelector('input[type="date"]')).toBeNull();
      const trigger = body().getByRole("button", { name: "Dia" });
      expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
      await click(trigger);
      const pop = body().getByRole("dialog", { name: "Escolher data" });
      expect(pop.textContent).toContain("outubro de 2026");
      expect(
        within(pop)
          .getByRole("button", { name: full(2026, 10, 14) })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await click(within(pop).getByRole("button", { name: "Próximo mês" }));
      expect(pop.textContent).toContain("novembro de 2026");
      await click(within(pop).getByRole("button", { name: full(2026, 11, 3) }));
      expect(document.querySelector("output")?.textContent).toBe("2026-11-03");
      expect(body().queryByRole("dialog", { name: "Escolher data" })).toBeNull();
    },
    10_000,
  );

  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "keyboard: arrows move by day and week, PageDown by month, Enter picks",
    async () => {
      render(<Harness />);
      await click(body().getByRole("button", { name: "Dia" }));
      await act(() => new Promise((r) => setTimeout(r, 0)));
      // happy-dom doesn't move focus inside the popover reliably; follow the roving tabindex instead
      // (the active day is the one with tabindex="0", and it's where the keys go).
      const active = () => {
        const el = document.querySelector<HTMLElement>('[data-day][tabindex="0"]');
        if (!el) throw new Error("no active day in the grid");
        return el;
      };
      expect(active().getAttribute("data-day")).toBe("2026-10-14");
      await key(active(), "ArrowRight");
      expect(active().getAttribute("data-day")).toBe("2026-10-15");
      await key(active(), "ArrowDown");
      expect(active().getAttribute("data-day")).toBe("2026-10-22");
      await key(active(), "PageDown");
      expect(active().getAttribute("data-day")).toBe("2026-11-22");
      await key(active(), "Home");
      expect(active().getAttribute("data-day")).toBe("2026-11-16");
      await key(active(), "Enter");
      expect(document.querySelector("output")?.textContent).toBe("2026-11-16");
    },
    10_000,
  );
});

describe("TimeSelect (interaction)", () => {
  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "a combobox: type and Enter, or pick a 15-minute step from our list",
    async () => {
      function Harness() {
        const [value, setValue] = useState("10:00");
        return (
          <>
            <Field label="Início" id="start">
              <TimeSelect value={value} onChange={setValue} />
            </Field>
            <output>{value}</output>
          </>
        );
      }
      const { container } = render(<Harness />);
      expect(container.querySelector('input[type="time"]')).toBeNull();
      const box = body().getByRole("combobox", { name: "Início" });
      await act(async () => fireEvent.change(box, { target: { value: "1415" } }));
      await key(box, "Enter");
      expect(document.querySelector("output")?.textContent).toBe("14:15");
      await click(box);
      const list = body().getByRole("listbox");
      expect(within(list).getAllByRole("option")).toHaveLength(96);
      // Open: the next step after the current value.
      await key(box, "ArrowDown");
      expect(box.getAttribute("aria-activedescendant")).toBeTruthy();
      await key(box, "Enter");
      expect(document.querySelector("output")?.textContent).toBe("14:30");
      await click(box);
      await click(within(body().getByRole("listbox")).getByRole("option", { name: "08:45" }));
      expect(document.querySelector("output")?.textContent).toBe("08:45");
    },
    10_000,
  );
});

describe("Calendário > Novo evento", () => {
  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "week navigation and Novo evento",
    async () => {
      await go("calendar");
      const label = () => document.querySelector(".ac-pagehead__meta")?.textContent;
      // The week grid only: Próximos lists this week's daily until it ends, whatever week is shown.
      const daily = () =>
        within(screen().getByRole("region", { name: "Grade do calendário" })).queryByRole("button", {
          name: /^Daily de produto/,
        });
      const now = label();
      expect(daily()).not.toBeNull();
      await click(screen().getByRole("button", { name: "Próxima semana" }));
      await settle(4);
      expect(label()).not.toBe(now);
      expect(daily()).toBeNull();
      await click(screen().getByRole("button", { name: "Hoje" }));
      await settle(4);
      expect(label()).toBe(now);

      await click(screen().getByRole("button", { name: "Novo evento" }));
      const dialog = screen().getByRole("dialog", { name: "Novo evento" });
      await type(within(dialog).getByLabelText("Título"), "Planejamento da sprint");
      // Our time select: type and confirm with Enter (no native time input).
      const setTime = async (name: string, value: string) => {
        const box = within(dialog).getByRole("combobox", { name });
        await type(box, value);
        await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
      };
      expect(dialog.querySelector('input[type="time"], input[type="date"], select')).toBeNull();
      await setTime("Fim", "9");
      expect((within(dialog).getByRole("combobox", { name: "Fim" }) as HTMLInputElement).value).toBe("09:00");
      expect(dialog.textContent).toContain("O fim precisa ser depois do início.");
      expect(within(dialog).getByRole("button", { name: "Criar evento" }).hasAttribute("disabled")).toBe(true);
      await setTime("Início", "1400");
      await setTime("Fim", "15h");
      // Our date picker: a month grid in a popover.
      const tuesday = new Date(mondayOf(new Date()).getTime() + 86_400_000 + 3_600_000);
      const dayName = new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(tuesday);
      await click(within(dialog).getByRole("button", { name: "Data de início" }));
      const picker = screen().getByRole("dialog", { name: "Escolher data" });
      await click(within(picker).getByRole("button", { name: dayName }));
      await settle(2);
      expect(picker.isConnected).toBe(false);
      // Participants: what agents taking part get is the label's ⓘ, which also describes the search.
      const about = within(dialog).getByRole("button", { name: "Sobre Participantes" });
      const hint = document.getElementById(about.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toBe("Agentes participantes recebem a pauta e podem preparar um resumo antes.");
      expect(
        within(dialog).getByRole("searchbox", { name: "Buscar pessoas e agentes" }).getAttribute("aria-describedby"),
      ).toBe(hint?.id ?? null);
      // Picked ones become tokens above the search.
      await click(within(dialog).getByRole("checkbox", { name: /Ada/ }));
      expect(within(dialog).getByRole("button", { name: "Remover Ada" })).toBeTruthy();
      await click(within(dialog).getByRole("button", { name: "Criar evento" }));
      await settle(5);
      const col = document.querySelector(`[data-day="${toYmd(tuesday)}"]`) as HTMLElement;
      expect(within(col).getByRole("button", { name: "Planejamento da sprint, 14:00–15:00" })).toBeTruthy();
      // A hang (focus or render loop) fails fast instead of taking the run down.
    },
    20_000,
  );
});

describe("RecurrencePicker (interaction)", () => {
  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "tabs, weekday chips and the end: the rule and the sentence follow",
    async () => {
      const { RecurrencePicker } = await import("@agenteschat/ui");
      const { createI18n } = await import("@/i18n");
      const { recurrenceLabels, ruleSentence } = await import("@/lib/recurrence");
      const i18n = createI18n("pt-BR");
      const t = i18n.t.bind(i18n) as unknown as Parameters<typeof ruleSentence>[0];
      type Rule = Parameters<typeof ruleSentence>[2];
      function Harness() {
        const [rule, setRule] = useState<Rule>({
          freq: "weekly",
          interval: 1,
          byWeekday: ["MO"],
          times: ["09:00"],
          timezone: "America/Sao_Paulo",
          start: "2026-10-12",
        });
        return (
          <>
            <RecurrencePicker
              value={rule}
              onChange={setRule}
              labels={recurrenceLabels(t, "pt-BR", rule)}
              locale="pt-BR"
              summary={ruleSentence(t, "pt-BR", rule, new Date(2026, 9, 15))}
            />
            <output>{JSON.stringify(rule)}</output>
          </>
        );
      }
      render(<Harness />);
      const out = () => JSON.parse(document.querySelector("output")?.textContent ?? "{}");
      await click(body().getByRole("button", { name: "quarta-feira" }));
      expect(out().byWeekday).toEqual(["MO", "WE"]);
      await type(body().getByLabelText("Intervalo"), "2");
      expect(document.querySelector(".ac-recur__summary")?.textContent).toBe(
        "A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília)",
      );
      await click(body().getByRole("radio", { name: "Diária" }));
      expect(out().freq).toBe("daily");
      await click(body().getByRole("radio", { name: "Só dias úteis" }));
      expect(out().byWeekday).toEqual(["MO", "TU", "WE", "TH", "FR"]);
      await click(body().getByRole("radio", { name: "Após" }));
      expect(out().count).toBe(10);
    },
    10_000,
  );
});

describe("Calendário > arrastar para criar", () => {
  test.skipIf(!process.env.RUN_NEW_EVENT)(
    "a drag on an empty column opens Novo evento with that slot",
    async () => {
      await go("calendar");
      const col = document.querySelector(`[data-day="${toYmd(new Date())}"]`) as HTMLElement;
      await act(async () => fireEvent.pointerDown(col, { clientX: 5, clientY: 14 * 44, button: 0 }));
      await act(async () => fireEvent.pointerMove(window, { clientX: 5, clientY: 15 * 44 }));
      await act(async () => fireEvent.pointerUp(window, { clientX: 5, clientY: 15 * 44 }));
      await settle(3);
      const dialog = screen().getByRole("dialog", { name: "Novo evento" });
      expect((within(dialog).getByRole("combobox", { name: "Início" }) as HTMLInputElement).value).toBe("14:00");
      expect((within(dialog).getByRole("combobox", { name: "Fim" }) as HTMLInputElement).value).toBe("15:00");
    },
    20_000,
  );
});
