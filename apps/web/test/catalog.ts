import { act, fireEvent, within } from "@testing-library/react";
import { screen, settle } from "./render";

/** A service opened from "Adicionar conector": its dialog over the catalog, named after it. */
export const service = (name: string) => screen().getByRole("dialog", { name });

/** A connected account's ⋯ in Conectores, open (Radix opens a menu from the keyboard here): its menu. */
export async function rowMenu(name: string) {
  const button = screen().getByRole("button", { name: `Mais ações de ${name}` });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
}

/** Picks a service in "Adicionar conector" (its tile or suggestion) and presses Conectar in its dialog. */
export async function pick(catalog: HTMLElement, name: string) {
  await act(async () => fireEvent.click(within(catalog).getByRole("button", { name })));
  await act(async () => fireEvent.click(within(service(name)).getByRole("button", { name: `Conectar ${name}` })));
}
