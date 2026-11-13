import { within } from "@testing-library/react";

/** The ⓘ named "Sobre <label>" (inside `inside`), and the text it holds, hidden until it opens. */
export function hintOf(label: string, inside: HTMLElement = document.body) {
  const button = within(inside).getByRole("button", { name: `Sobre ${label}` });
  const text = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  return { button, text: text?.textContent ?? null, hidden: text?.hidden ?? false };
}

/** What a reader sees of an element: its text without the hints' hidden text. */
export function shownText(el: Element) {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll("[hidden]")) hidden.remove();
  return copy.textContent ?? "";
}
