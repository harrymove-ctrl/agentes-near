import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, CalendarEvent, CalendarRange, Member } from "@agenteschat/client";
import { addDays, mondayOf } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * The calendar with what breaks it (break-ui): a 56-character routine, seven runs at one time beside a meeting, runs
 * a quarter of an hour apart, long and non-Latin names, faces with no photo, an emoji first, a three-day bar, due dates
 * with and without someone, twelve owners, nine items on one day, a reminder at 23:50. CI's geometry check lays out
 * every screen these tests reach, at 1280, 390 and 320.
 */
const monday = mondayOf(new Date());
const on = (day: number, h: number, m = 0) =>
  new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, h, m).toISOString();
const LONG_ROUTINE = "Conferir os boletos vencidos e mandar o resumo para a diretoria";
const LONG_PERSON = "Aleksandra Wiśniewska-Kowalczyk";
const FOX_ID = "00000000-0000-4000-8000-0000000000f0";

const person = (userId: string, name: string): Member => ({
  userId,
  name,
  email: `${userId}@example.com`,
  image: null,
  role: "member",
  joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
  handle: userId,
  timezone: "America/Sao_Paulo",
});
const PEOPLE = [
  person("u-ale", LONG_PERSON),
  person("u-ola", "Ólafur Darri Ólafsson"),
  person("u-bea", "Bea"),
  person("u-caio", "Caio"),
  person("u-dora", "Dora"),
  person("u-enzo", "Enzo"),
  person("u-fe", "Fê"),
];
const event = (
  id: string,
  title: string,
  start: string,
  end: string,
  by: CalendarEvent["createdBy"],
  allDay?: { startDate: string; endDate: string },
): CalendarEvent => ({
  id,
  title,
  description: "",
  start,
  end,
  allDay: Boolean(allDay),
  ...(allDay ?? {}),
  timezone: "America/Sao_Paulo",
  recurrence: "none",
  participants: [],
  rsvp: [],
  channelId: null,
  issueId: null,
  createdBy: by,
});
const SIX: [string, [number, number], [number, number], CalendarEvent["createdBy"]][] = [
  ["Revisão do contrato com o fornecedor de pagamentos", [14, 0], [15, 0], { type: "person", id: "u-ale" }],
  ["Entrevista técnica", [14, 0], [15, 30], { type: "person", id: "u-dora" }],
  ["Conciliação bancária", [14, 15], [15, 0], { type: "agent", id: FOX_ID }],
  ["Plantão", [14, 30], [16, 0], { type: "agent", id: ATLAS_ID }],
  ["1:1", [14, 30], [15, 0], { type: "person", id: "u-enzo" }],
  ["Demo para o cliente", [14, 45], [15, 45], { type: "person", id: "u-fe" }],
];
const runAt = (routineId: string, name: string, agentId: string, at: string): CalendarRange["routines"][number] => ({
  routineId,
  name,
  agentId,
  at,
  target: { type: "channel", channelId: ENG_ID },
});

const go = async (view?: "Dia" | "Mês" | "Agenda") => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID) as Agent;
  state.agents.push({
    ...ada,
    id: FOX_ID,
    name: "🦊 Fox",
    handle: "fox",
    role: "Financeiro",
    appearance: { color: "amber" },
  });
  state.members.push(...PEOPLE);
  const api = createFakeApi(state);
  const range = api.calendar.range;
  api.calendar.range = async (...args) => {
    const out = await range(...args);
    const tuesday = [ADA_ID, ATLAS_ID, FOX_ID, ADA_ID, ATLAS_ID, FOX_ID, ADA_ID].map((agent, i) =>
      runAt(`rt-tue-${i}`, `Conferência ${i + 1}`, agent, on(1, 9)),
    );
    return {
      ...out,
      events: [
        ...out.events,
        event("ev-tue", "Planejamento trimestral", on(1, 9), on(1, 10), { type: "person", id: "u-bea" }),
        event("ev-tue-late", "Retro", on(1, 16), on(1, 17), { type: "person", id: "u-caio" }),
        event("ev-ja", "予約確認のメッセージが二重に送信される問題を修正する打ち合わせ", on(3, 14), on(3, 15), {
          type: "person",
          id: "u-ola",
        }),
        event("ev-short", "Alinhamento rápido com o time de atendimento", on(3, 16), on(3, 16, 30), {
          type: "person",
          id: "u-dora",
        }),
        event("ev-enzo", "Café", on(2, 15), on(2, 16), { type: "person", id: "u-enzo" }),
        event("ev-fe", "Entrevista", on(4, 10), on(4, 11), { type: "person", id: "u-fe" }),
        // Six meetings at once on Saturday, people's and agents': six side by side.
        ...SIX.map(([title, from, to, by], i) => event(`ev-six-${i}`, title, on(5, ...from), on(5, ...to), by)),
        event(
          "ev-trip",
          "Viagem da equipe para o encontro anual de planejamento em Florianópolis",
          on(4, 0),
          on(6, 23, 59),
          { type: "person", id: "u-ale" },
          {
            startDate: toYmd(addDays(monday, 4)),
            endDate: toYmd(addDays(monday, 6)),
          },
        ),
      ],
      routines: [
        ...out.routines,
        ...tuesday,
        runAt("rt-long", LONG_ROUTINE, FOX_ID, on(3, 7)),
        runAt("rt-early", "Bom dia", ADA_ID, on(2, 9)),
        runAt("rt-quarter", "Fila do suporte", ATLAS_ID, on(2, 9, 15)),
      ],
      reminders: [
        {
          id: "rem-late",
          message: "Mandar o fechamento do mês para a contabilidade",
          at: on(5, 23, 50),
          forUserId: "u-walter",
          channelId: ENG_ID,
          threadId: null,
          agentId: FOX_ID,
          createdBy: "u-walter",
          canCancel: true,
        },
      ],
      deadlines: [
        ...out.deadlines,
        {
          issueId: "iss-none",
          number: 4521,
          title: "Ninguém pegou esta tarefa ainda",
          date: toYmd(monday),
          assignee: null,
        },
        {
          issueId: "iss-person",
          number: 10942,
          title: "Revisar o contrato de 2027",
          date: toYmd(addDays(monday, 1)),
          assignee: { type: "person", id: "u-ale" },
        },
      ],
    };
  };
  await renderApp(`/org/${ORG_ID}/calendar`, { api });
  await settle(8);
  if (view) {
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: view })));
    await settle(4);
  }
};
const col = (day: number) =>
  document.querySelector(`.cal-week__col[data-day="${toYmd(addDays(monday, day))}"]`) as HTMLElement;

describe("Calendário at its worst", () => {
  test("week: seven runs at 09:00 show two and +5, beside the meeting at 09:00; the 56-character name whole", async () => {
    await go();
    // How many days, for the CSS: a phone's week of 7 draws its bars as faces too.
    expect(document.querySelector<HTMLElement>(".cal-week")?.dataset.days).toBe("7");
    const tuesday = col(1);
    const stack = [...tuesday.querySelectorAll<HTMLElement>(".cal-week__runs")].find((s) =>
      s.textContent?.includes("Conferência 1"),
    ) as HTMLElement;
    expect(stack.querySelectorAll(".cal-chip--run")).toHaveLength(2);
    expect(within(stack).getByRole("button", { name: "+5 rotinas" })).toBeTruthy();
    // Beside the meeting, never under it: the runs are the narrow column, the meeting keeps room for its name.
    const meeting = within(tuesday).getByRole("button", { name: "Planejamento trimestral, 09:00–10:00" });
    expect(stack.style.getPropertyValue("--cols")).toBe("2");
    expect(meeting.style.getPropertyValue("--col")).not.toBe(stack.style.getPropertyValue("--col"));
    expect(stack.hasAttribute("data-thin")).toBe(true);
    // Never "…": the whole name is there to wrap.
    expect(within(col(3)).getByRole("button", { name: `Rotina ${LONG_ROUTINE}, 07:00` }).textContent).toContain(
      LONG_ROUTINE,
    );
    // A quarter of an hour apart: one stack of two rows, not two stacks over each other.
    const wednesday = [...col(2).querySelectorAll(".cal-week__runs")].filter((s) => s.textContent?.includes("Bom dia"));
    expect(wednesday).toHaveLength(1);
    expect(wednesday[0]?.textContent).toContain("Fila do suporte");
  });

  test("six meetings at once sit side by side, each its own column, its owner's face first", async () => {
    await go();
    const blocks = [...col(5).querySelectorAll<HTMLElement>(".cal-chip--block")].filter((b) =>
      SIX.some(([title]) => b.getAttribute("aria-label")?.startsWith(title)),
    );
    expect(blocks).toHaveLength(6);
    expect(new Set(blocks.map((b) => b.style.getPropertyValue("--cols")))).toEqual(new Set(["6"]));
    expect(new Set(blocks.map((b) => b.style.getPropertyValue("--col"))).size).toBe(6);
    for (const b of blocks) expect(b.querySelector(".cal-chip__title > .ac-who")).not.toBeNull();
  });

  test("week with the panel open: twelve owners in Agentes e pessoas, agents first", async () => {
    await go();
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await act(async () => fireEvent.click(show));
    await settle(3);
    const owners = screen().getByRole("region", { name: "Agentes e pessoas" });
    const names = [...owners.querySelectorAll(".cal-owner .ac-who b")].map((b) => b.textContent);
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(names.slice(0, 3).sort()).toEqual(["Ada", "Atlas", "🦊 Fox"]);
    expect(names).toContain(LONG_PERSON);
    // A person with no photo: the initial, Ó.
    const ola = [...owners.querySelectorAll(".cal-owner")].find((r) => r.textContent?.includes("Ólafur"));
    expect(ola?.querySelector(".ac-avatar__initials")?.textContent).toBe("ÓÓ");
  });

  test("day: the owner's name after the time where the column has room", async () => {
    await go("Dia");
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(1);
    expect(document.querySelector<HTMLElement>(".cal-week")?.dataset.days).toBe("1");
  });

  test("month: a day of a dozen items shows three, then +N mais; the three-day trip a bar on its days", async () => {
    await go("Mês");
    const cell = document.querySelector(`.cal-month__cell[data-day="${toYmd(addDays(monday, 1))}"]`) as HTMLElement;
    expect(cell.querySelectorAll(":scope > .cal-chip--line")).toHaveLength(3);
    const more = within(cell).getByRole("button", { name: /^\+\d+ mais$/ });
    expect(Number(/\d+/.exec(more.textContent ?? "")?.[0])).toBeGreaterThanOrEqual(6);
    const trip = document.querySelectorAll('.cal-chip--line[data-allday][aria-label^="Viagem da equipe"]');
    expect(trip.length).toBe(3);
  });

  test("a stack drawn taller than a line (a name that wraps) puts the meeting under it beside it", async () => {
    // A layout engine's height for the stacks: the run's long name on several lines.
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.measure?.startsWith("runs-") ? 120 : 0;
      },
    });
    try {
      await go();
      const first = col(0);
      const stack = first.querySelector(".cal-week__runs") as HTMLElement;
      const daily = within(first).getByRole("button", { name: "Daily de produto, 10:00–11:00" });
      expect(stack.textContent).toContain("Resumo da semana");
      expect(daily.style.getPropertyValue("--cols")).toBe("2");
      expect(daily.style.getPropertyValue("--col")).not.toBe(stack.style.getPropertyValue("--col"));
    } finally {
      if (was) Object.defineProperty(HTMLElement.prototype, "offsetHeight", was);
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    }
  });

  test("agenda: every day's rows, a reminder at 23:50 among them", async () => {
    await go("Agenda");
    expect(document.querySelector(".cal-agenda")).not.toBeNull();
  });
});
