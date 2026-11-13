import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus, JevKey } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OFF: JevKey = { source: null, hint: null, state: "off", month: { decisions: 0, costUsd: 0 } };
const ON: JevKey = { source: "settings", hint: "9f2c", state: "ok", month: { decisions: 1240, costUsd: 0.13 } };
const routed = (by: NonNullable<AiStatus["routing"]>["by"]): AiStatus => ({
  any: true,
  agents: [],
  routing: { by, mine: by === "plans" ? "plan" : by, model: null, noSmallModel: null },
  apiKey: false,
});

const open = async (patch: Partial<ReturnType<typeof seedState>>) => {
  const state = seedState(patch);
  const r = await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return { ...r, state };
};
const card = () => screen().getByRole("region", { name: "Jev" });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const field = () => within(card()).getByLabelText("Cole aqui") as HTMLInputElement;
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

/** [Portuguese, English] */
type Words = readonly [string, string];
const SECTION: Words = ["Quem escolhe os agentes", "Who picks the agents"];
const HOW_PICKED: Words = ["Como os agentes são escolhidos", "How agents are picked"];
const ABOUT: Words = ["Sobre Jev", "About Jev"];
const HOW_JEV: Words = ["Como o Jev funciona", "How Jev works"];
const THIS_MONTH: Words = [
  "Termina em 9f2c · 1.240 decisões este mês · US$\u00a00,13",
  "Ends in 9f2c · 1,240 decisions this month · $0.13",
];
const REPLACE: Words = ["Trocar a chave", "Replace the key"];
const KEYS_PAGE: Words = ["Abrir as chaves de API", "Open API keys"];
/** Each state of the card: its chip, its key's line, the note under it, its buttons after the ⓘ, its links before "How Jev works". */
const STATES: {
  state: string;
  jev: JevKey;
  chip: Words;
  facts: Words | null;
  note: Words | null;
  buttons: Words[];
  links: Words[];
  text?: Words[];
}[] = [
  {
    state: "off",
    jev: OFF,
    chip: ["Desligado", "Off"],
    facts: null,
    note: null,
    buttons: [["Configurar o Jev", "Set up Jev"]],
    links: [],
    text: [
      ["Ajuda os agentes a trabalhar em equipe.", "Helps your agents work as a team."],
      ["Escolhe quem responde Mesmo sem @menção.", "Picks who answers Even without an @mention."],
      [
        "Organiza a memória Percebe repetições ditas de outro jeito.",
        "Keeps memory tidy Spots repeats said in other words.",
      ],
      [
        "Enxerga a tela Os agentes acham botões pela descrição.",
        "Sees the screen Agents find buttons from a description.",
      ],
    ],
  },
  {
    state: "on",
    jev: ON,
    chip: ["Ligado", "On"],
    facts: THIS_MONTH,
    note: null,
    buttons: [REPLACE, ["Apagar", "Delete"]],
    links: [],
    text: [["Chave da TypeSafe", "TypeSafe key"]],
  },
  {
    state: "key not accepted",
    jev: { ...ON, state: "invalid", month: { decisions: 0, costUsd: 0 } },
    chip: ["Chave recusada", "Key not accepted"],
    facts: ["Termina em 9f2c", "Ends in 9f2c"],
    note: ["A TypeSafe não aceitou esta chave. Crie uma nova.", "TypeSafe didn't accept this key. Create a new one."],
    buttons: [REPLACE],
    links: [KEYS_PAGE],
  },
  {
    state: "out of credit",
    jev: { ...ON, state: "no_credit" },
    chip: ["Sem crédito", "Out of credit"],
    facts: THIS_MONTH,
    note: ["Adicione crédito na TypeSafe. O Jev volta sozinho.", "Add credit at TypeSafe. Jev resumes by itself."],
    buttons: [["Verificar de novo", "Check again"]],
    links: [["Abrir a TypeSafe", "Open TypeSafe"]],
  },
  {
    state: "from .env",
    jev: { ...ON, source: "env" },
    chip: ["Ligado", "On"],
    facts: THIS_MONTH,
    note: [
      "Definida nas configurações deste servidor (TYPESAFE_API_KEY).",
      "Set in this server's settings (TYPESAFE_API_KEY).",
    ],
    buttons: [],
    links: [],
  },
  {
    state: "from .env, not accepted",
    jev: { ...ON, source: "env", state: "invalid" },
    chip: ["Chave recusada", "Key not accepted"],
    facts: THIS_MONTH,
    note: [
      "A TypeSafe não aceitou esta chave. Troque nas configurações deste servidor (TYPESAFE_API_KEY).",
      "TypeSafe didn't accept this key. Change it in this server's settings (TYPESAFE_API_KEY).",
    ],
    buttons: [],
    links: [KEYS_PAGE],
  },
];

describe("Jev's key in Configurações › IA e uso", () => {
  test("nobody but the server's owner sees it: who picks, and no Jev", async () => {
    await open({ aiStatus: routed("plans") });
    const section = screen().getByRole("region", { name: "Quem escolhe os agentes" });
    expect(section.textContent).toContain("Cada plano escolhe só nas mensagens de quem o conectou.");
    expect(within(section).getByRole("link", { name: "Como os agentes são escolhidos" }).getAttribute("href")).toBe(
      "https://agentes.chat/pt/docs/who-answers",
    );
    expect(screen().queryByRole("region", { name: "Jev" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/jev|typesafe/i);
  });

  test("its state sits on its name's first line, however many lines its name and line take", async () => {
    await open({ aiStatus: routed("rules"), jev: OFF });
    const head = card().querySelector(".jev__head") as HTMLElement;
    // A MediaRow: its logo, its name and its state on one line, what it does under them at the row's width.
    expect(head.classList.contains("ac-mediarow")).toBe(true);
    expect(head.querySelector(":scope > .ac-mediarow__face > .ac-brand--sm")).toBeTruthy();
    expect(head.querySelector(":scope > .ac-mediarow__head .jev__title")).toBeTruthy();
    expect(head.querySelector(":scope > .ac-mediarow__end > .ac-chip")).toBeTruthy();
    expect(head.querySelector(":scope > .ac-mediarow__body")?.textContent).toBeTruthy();
    const layout = (await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // Nothing moves the chip off that line, and no rule of the page lays the head out on its own.
    expect(layout).not.toMatch(/\.jev__head > \.ac-chip/);
    expect(layout).not.toMatch(/\.jev__head[^{]*\{/);
  });

  test("off: why it helps, then its steps in place, each with its link; a short key isn't offered", async () => {
    const { state } = await open({ aiStatus: routed("rules"), jev: OFF });
    // Under who picks now, in the same section.
    const section = screen().getByRole("region", { name: "Quem escolhe os agentes" });
    expect(section.contains(card())).toBe(true);
    expect(section.textContent).toContain("Os agentes respondem a menções, respostas e continuações.");
    expect(card().querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("typesafe");
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(card().textContent).toContain("Ajuda os agentes a trabalhar em equipe.");
    for (const why of [
      "Escolhe quem responde Mesmo sem @menção.",
      "Organiza a memória Percebe repetições ditas de outro jeito.",
      "Enxerga a tela Os agentes acham botões pela descrição.",
    ])
      expect(card().textContent).toContain(why);
    expect(within(card()).getByRole("link", { name: "Como o Jev funciona" }).getAttribute("href")).toBe(
      "https://agentes.chat/pt/docs/jev",
    );
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();

    await click(within(card()).getByRole("button", { name: "Configurar o Jev" }));
    // The button pressed gives way to the steps: the field takes the focus.
    expect(document.activeElement === field()).toBe(true);
    const site = within(card()).getByRole("link", { name: "Abrir a TypeSafe" });
    const keys = within(card()).getByRole("link", { name: "Abrir as chaves de API" });
    expect([site.getAttribute("href"), keys.getAttribute("href")]).toEqual([
      "https://console.typesafe.ai",
      "https://console.typesafe.ai/keys",
    ]);
    // The way on is TypeSafe's console until a key is typed.
    expect(site.className).toContain("ac-btn--primary");
    // What it costs, behind the first step's ⓘ, in this language's numbers.
    const hint = within(card()).getByRole("button", { name: "Sobre Crie uma conta na TypeSafe e adicione crédito" });
    expect(document.getElementById(hint.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "O Jev é pré-pago: US$ 0,042 por milhão de tokens. Escolher quem responde custa cerca de US$ 0,0001.",
    );
    expect(field().type).toBe("password");
    expect(field().getAttribute("placeholder")).toBe("A sua chave da TypeSafe");
    expect(document.getElementById(field().getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Cifrada neste servidor. Nunca mais aparece.",
    );
    const save = () => within(card()).getByRole("button", { name: "Salvar chave" });
    await type(field(), "ts_1234");
    expect(save().hasAttribute("disabled")).toBe(true);
    expect(site.className).not.toContain("ac-btn--primary");
    await type(field(), "  ts_live_9f2c  ");
    expect(save().hasAttribute("disabled")).toBe(false);
    await click(save(), 6);
    expect(calls(state, "system.saveJev")).toEqual([["ts_live_9f2c"]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Termina em 9f2c");
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();
    expect(document.activeElement === within(card()).getByRole("button", { name: "Trocar a chave" })).toBe(true);
    // The key itself is never on the page.
    expect(document.body.innerHTML).not.toContain("ts_live_9f2c");
  });

  test("a key TypeSafe refuses: said under the field, nothing kept; Cancel closes the steps", async () => {
    const { state } = await open({ jev: OFF, jevVerdicts: { ts_wrong_0000: "invalid" } });
    await click(within(card()).getByRole("button", { name: "Configurar o Jev" }));
    await type(field(), "ts_wrong_0000");
    await click(within(card()).getByRole("button", { name: "Salvar chave" }), 6);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field().getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "A TypeSafe não aceitou esta chave. Copie de novo na página de chaves.",
    );
    expect(state.jev?.source).toBeNull();
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    // No toast on top of the line under the field.
    expect(document.querySelector(".ac-toast")).toBeNull();
    await type(field(), "ts_other_1111");
    expect(field().hasAttribute("aria-invalid")).toBe(false);
    await click(within(card()).getByRole("button", { name: "Cancelar" }));
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();
    expect(document.activeElement === within(card()).getByRole("button", { name: "Configurar o Jev" })).toBe(true);
  });

  test("on: its last 4 and this month's use; Trocar a chave asks only for the new key; Apagar asks first", async () => {
    const { state } = await open({ aiStatus: routed("jev"), jev: ON });
    expect(screen().getByRole("region", { name: "Quem escolhe os agentes" }).textContent).toContain(
      "O Jev escolhe quem responde cada mensagem sem menção.",
    );
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Chave da TypeSafe");
    expect(card().textContent).toContain("Termina em 9f2c · 1.240 decisões este mês · US$\u00a00,13");
    expect(card().querySelector(".ac-setnote")).toBeNull();

    await click(within(card()).getByRole("button", { name: "Trocar a chave" }));
    expect(document.activeElement === field()).toBe(true);
    // Steps ② and ③ only, numbered 1 and 2.
    expect(within(card()).queryByRole("link", { name: "Abrir a TypeSafe" })).toBeNull();
    expect([...card().querySelectorAll(".agp-addacct__step > i")].map((n) => n.textContent)).toEqual(["1", "2"]);
    await type(field(), "ts_new_key_7777");
    await click(within(card()).getByRole("button", { name: "Salvar chave" }), 6);
    expect(calls(state, "system.saveJev")).toEqual([["ts_new_key_7777"]]);
    expect(card().textContent).toContain("Termina em 7777");

    // Removed with Trocar a chave open and a key half typed: the card starts over, its steps closed and empty.
    await click(within(card()).getByRole("button", { name: "Trocar a chave" }));
    await type(field(), "ts_half_typed");
    await click(within(card()).getByRole("button", { name: "Apagar" }));
    const ask = screen().getByRole("dialog", { name: "Remover a chave do Jev?" });
    expect(ask.textContent).toContain("Os agentes continuam trabalhando sem ele.");
    expect(calls(state, "system.removeJev")).toEqual([]);
    await click(within(ask).getByRole("button", { name: "Apagar" }), 6);
    expect(calls(state, "system.removeJev")).toEqual([[]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(within(card()).queryByLabelText("Cole aqui")).toBeNull();
    expect(document.activeElement === within(card()).getByRole("button", { name: "Configurar o Jev" })).toBe(true);
    await click(within(card()).getByRole("button", { name: "Configurar o Jev" }));
    expect(field().value).toBe("");
  });

  test("with the router off nothing picks who answers, so no reason says Jev does, for an owner who isn't an admin too", async () => {
    const state = seedState({ aiStatus: routed("off"), jev: OFF });
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect([...card().querySelectorAll(".jev-why b")].map((b) => b.textContent)).toEqual([
      "Organiza a memória",
      "Enxerga a tela",
    ]);
    // Who picks now is said to admins only.
    expect(screen().getByRole("region", { name: "Quem escolhe os agentes" }).querySelector(".who-line")).toBeNull();
  });

  test("a key not accepted, out of credit: the state, what to do, and the console where it's done", async () => {
    const { state } = await open({ jev: { ...ON, state: "invalid", month: { decisions: 0, costUsd: 0 } } });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Chave recusada");
    expect(card().querySelector(".ac-chip")?.className).toContain("ac-chip--waiting");
    expect(card().textContent).toContain("A TypeSafe não aceitou esta chave. Crie uma nova.");
    // No month line with nothing this month.
    expect(card().textContent).not.toContain("este mês");
    expect(within(card()).getByRole("link", { name: "Abrir as chaves de API" }).getAttribute("href")).toBe(
      "https://console.typesafe.ai/keys",
    );
    expect(within(card()).getByRole("button", { name: "Trocar a chave" })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Apagar" })).toBeNull();
    cleanup();

    state.jev = { ...ON, state: "no_credit" };
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Sem crédito");
    expect(card().textContent).toContain("Adicione crédito na TypeSafe. O Jev volta sozinho.");
    expect(within(card()).getByRole("link", { name: "Abrir a TypeSafe" }).getAttribute("href")).toBe(
      "https://console.typesafe.ai",
    );
    await click(within(card()).getByRole("button", { name: "Verificar de novo" }));
    expect(calls(state, "system.checkJev")).toEqual([[]]);
  });

  test("a limit or an outage is no state of the card: TypeSafe's view says On", async () => {
    // The server shows `ok` while TypeSafe limits requests or doesn't answer.
    await open({ jev: ON });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).not.toMatch(/limite|fora do ar/i);
  });

  test("from the server's settings: no Replace or Delete, where it's set instead; refused: the keys page alone", async () => {
    const env: JevKey = { ...ON, source: "env" };
    const { state } = await open({ jev: env });
    expect(card().textContent).toContain("Definida nas configurações deste servidor (TYPESAFE_API_KEY).");
    expect(within(card()).queryByRole("button", { name: "Trocar a chave" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(
      within(card())
        .queryAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Como o Jev funciona"]);
    cleanup();

    state.jev = { ...env, state: "invalid" };
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect(card().textContent).toContain(
      "A TypeSafe não aceitou esta chave. Troque nas configurações deste servidor (TYPESAFE_API_KEY).",
    );
    expect(
      within(card())
        .queryAllByRole("button")
        .map((b) => b.textContent),
    ).not.toContain("Trocar a chave");
    expect(within(card()).getByRole("link", { name: "Abrir as chaves de API" })).toBeTruthy();
  });

  for (const [i, lang] of [
    [0, "pt-BR"],
    [1, "en"],
  ] as const) {
    test(`each state's chip, line, note, buttons and links, in ${lang}`, async () => {
      for (const c of STATES) {
        const { services } = await open({ aiStatus: routed("jev"), jev: c.jev });
        if (lang === "en") {
          await act(async () => {
            await services.i18n.changeLanguage("en");
          });
          await settle(3);
        }
        const section = screen().getByRole("region", { name: SECTION[i] });
        expect(within(section).getByRole("link", { name: HOW_PICKED[i] })).toBeTruthy();
        expect({
          state: c.state,
          chip: card().querySelector(".ac-chip")?.textContent,
          facts: card().querySelector(".jev__key .list-col > .small")?.textContent ?? null,
          note: card().querySelector(".ac-setnote")?.textContent ?? null,
          buttons: within(card())
            .queryAllByRole("button")
            .map((b) => b.getAttribute("aria-label") ?? b.textContent),
          links: within(card())
            .queryAllByRole("link")
            .map((l) => l.textContent),
        }).toEqual({
          state: c.state,
          chip: c.chip[i],
          facts: c.facts?.[i] ?? null,
          note: c.note?.[i] ?? null,
          buttons: [ABOUT[i], ...c.buttons.map((b) => b[i])],
          links: [...c.links.map((l) => l[i]), HOW_JEV[i]],
        });
        for (const text of c.text ?? []) expect(card().textContent).toContain(text[i]);
        cleanup();
      }
    });
  }

  test("?open=jev lands on it, scrolled to and focused", async () => {
    const state = seedState({ jev: ON });
    const { router } = await renderApp("/?open=jev", { api: createFakeApi(state) });
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/usage`);
    expect(router.state.location.hash).toBe("jev");
    expect(document.activeElement === card()).toBe(true);
  });
});
