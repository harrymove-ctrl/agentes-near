import { act, fireEvent } from "@testing-library/react";
import { screen, settle } from "./render";

/** Driving "Criar agente" (a stepped flow) in screen tests. */

export const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
export const typeIn = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
export const press = async (el: Element, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => fireEvent.keyDown(el, { key, ...init }));
  await settle(2);
};

/** The step's title (h1). */
export const title = () => screen().getByRole("heading", { level: 1 }).textContent ?? "";

export const continueButton = () => screen().getByRole("button", { name: "Continuar" });

/** "Continuar" `times` times. */
export async function proceed(times = 1) {
  for (let i = 0; i < times; i++) await click(continueButton());
}

/** Picks a role on the first step and goes on to Identidade. */
export async function startAs(role: string) {
  await click(screen().getByRole("button", { name: new RegExp(`^${role}`) }));
  await proceed();
}

/** A step on the rail ("Papel", "Ferramentas e acesso"…). */
export const railStep = (name: string) =>
  screen().getByRole("button", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;

/** From Identidade to the last step (Revisar e criar). */
export const toReview = () => proceed(5);

/** A Select (Radix): open it with the keyboard, pick the option. */
export async function pick(combobox: HTMLElement, option: RegExp | string) {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
  await settle();
}
