import { act, fireEvent, within } from "@testing-library/react";
import { screen, settle } from "./render";

/** Whose plan or whose key, in an open Connect an AI: the picker's select. */
export const aiSelect = (box: HTMLElement, name: "Plano" | "Provedor" | "Quem pensa" = "Plano") =>
  within(box).getByRole("combobox", { name });

/** That select opened: its rows. */
export async function openAiSelect(box: HTMLElement, name: "Plano" | "Provedor" | "Quem pensa" = "Plano") {
  const select = aiSelect(box, name);
  select.focus();
  await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
  await settle(3);
  return screen().getAllByRole("option");
}

export const closeAiSelect = async () => {
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(2);
};

export const payWith = (box: HTMLElement, name: "Com um plano" | "Com chave de API") =>
  within(box).getByRole("radio", { name });

const clicked = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/** Picks what the old tiles offered: "Chave de API", else a plan by its name, or `maker` the key's maker. */
export async function chooseAi(box: HTMLElement, name: string, maker = false) {
  if (name === "Chave de API") return clicked(payWith(box, "Com chave de API"));
  if (!maker && within(box).queryByRole("combobox", { name: "Plano" }) === null)
    await clicked(payWith(box, "Com um plano"));
  const rows = await openAiSelect(box, maker ? "Provedor" : "Plano");
  const row = rows.find((o) => o.textContent === name || o.textContent?.startsWith(`${name}`)) as Element;
  await clicked(row);
}

/** A row of the "Quem pensa" select of Criar agente by the title it shows. */
export const brainTitle = (option: Element) =>
  option.querySelector(".ac-menu__label > span:first-child")?.textContent ?? "";

/** Picks what thinks in the "Quem pensa" select of Criar agente (the agent's own page has a dialog: below). */
export async function chooseBrain(box: HTMLElement, name: RegExp) {
  const rows = await openAiSelect(box, "Quem pensa");
  await clicked(rows.find((o) => name.test(brainTitle(o))) as Element);
}

/*
 * "Quem pensa" on the agent's page (ADR 0032 §5, addendum 2026-11-10): a dialog of screens, each saving its own
 * change. Its name is the title of the screen it shows ("Quem pensa pela Ada", "Modelo da Ada", "Trocar a conta da
 * Ada"…), so keep the element `brainDialog` returns: it stays the same dialog from screen to screen.
 */

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (name: string | RegExp) => (typeof name === "string" ? new RegExp(`^${escaped(name)}`) : name);

/**
 * Opens "Quem pensa" from the sentence under the agent's name (`button`: that cell's name, in English "Change who
 * thinks"). `name`: the dialog's name on the screen it opens on; at its limit that is "A conta da … está no limite".
 */
export async function brainDialog(name: string | RegExp = /^Quem pensa/, button = "Mudar quem pensa") {
  await clicked(screen().getByRole("button", { name: button }));
  return screen().getByRole("dialog", { name });
}

/** The screen the dialog shows: its title as drawn (the dialog's name follows it). */
export const brainScreen = (d: HTMLElement) => d.querySelector(".arrival-lede__title")?.textContent ?? "";

/**
 * Goes in by a line or a button whose name starts with `line`: "Modelo", "Mais opções", "Trocar de conta",
 * "Computador", "Usar em outros agentes", "Voltar"; on "Mais opções" the lines that open under themselves
 * ("Esforço", "Velocidade", "Janela de contexto").
 */
export async function toScreen(d: HTMLElement, line: string) {
  const [button] = within(d).getAllByRole("button", { name: startsWith(line) });
  await clicked(button as Element);
}

/** The lines of the first screen and of "Mais opções": each setting's name and its value as shown. */
export const brainLines = (d: HTMLElement) =>
  Array.from(d.querySelectorAll(".bd-line")).map((l) => ({
    label: l.querySelector(".bd-line__k")?.textContent ?? "",
    value: l.querySelector(".bd-line__text")?.textContent ?? "",
  }));

/** One row of a screen's list: an account, a key, a model, a computer. */
export interface BrainListRow {
  title: string;
  /** Its lines under the title: what it is or whose, then its state in words. */
  lines: string[];
  checked: boolean;
  /** It can't be picked. */
  off: boolean;
  /** The one in use, only shown (the first screen, the team screen). */
  still: boolean;
  /** The label over its group ("Em uso", "Suas", "Chaves do workspace", a maker…); "" where there is none. */
  group: string;
  /** Its plan's limit as drawn on the row ("40%"); null where nothing says. */
  room: string | null;
  /** Its maker's mark ("claude", "openai", "zai"…); null for a key's plain icon or a model's row. */
  mark: string | null;
}

/** The rows the screen lists, in order. */
export function brainRows(d: HTMLElement): BrainListRow[] {
  return Array.from(d.querySelectorAll<HTMLElement>(".arrival-have__row")).map((r) => {
    let label: Element | null = r.previousElementSibling;
    while (label && !label.classList.contains("arrival-opts__label")) label = label.previousElementSibling;
    return {
      title: r.querySelector(".arrival-have__title")?.textContent ?? "",
      lines: Array.from(r.querySelectorAll(".arrival-have__line")).map((l) => l.textContent ?? ""),
      checked: r.getAttribute("data-state") === "checked",
      off: r.hasAttribute("data-disabled"),
      still: r.hasAttribute("data-still"),
      group: label?.textContent ?? "",
      room: r.querySelector(".arrival-have__pct")?.textContent ?? null,
      mark: r.querySelector(".ac-brand")?.getAttribute("data-mark") ?? null,
    };
  });
}

/**
 * Picks a row: the one whose title starts with `which` (a string) or matches it (a RegExp), or the first `which` holds
 * true for (the computer's own sign-ins share a title: `(r) => r.mark === "claude"`).
 */
export async function pickRow(d: HTMLElement, which: string | RegExp | ((row: BrainListRow) => boolean)) {
  const test = typeof which === "function" ? which : (r: BrainListRow) => startsWith(which).test(r.title);
  const rows = brainRows(d);
  const at = rows.findIndex((r) => !r.still && test(r));
  const row = d.querySelectorAll(".arrival-have__row")[at];
  if (at < 0 || !row) throw new Error(`No row ${which} in: ${rows.map((r) => r.title).join(", ")}`);
  await clicked(row.querySelector('[role="radio"]') as Element);
}

/** The footer's main button ("Trocar para …", "Usar …", "Concluído"), to read or press with `confirmScreen`. */
export const mainButton = (d: HTMLElement) => d.querySelector<HTMLButtonElement>(".ac-dialog__foot .ac-btn--primary");

/** Presses the footer's main button: the screen saves its change (or, on the first and last screens, closes). */
export async function confirmScreen(d: HTMLElement) {
  const button = mainButton(d);
  if (!button) throw new Error(`No main button on "${brainScreen(d)}"`);
  await clicked(button);
}

/** "Concluído": on "Mais opções" it saves; on the first screen and after a switch it closes the dialog. */
export const done = (d: HTMLElement, name = "Concluído") => clicked(within(d).getByRole("button", { name }));
