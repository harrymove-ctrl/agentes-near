import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  Dialog,
  DialogBody,
  Field,
  Message,
  MessageText,
  monthGrid,
  normalizeTime,
  Popover,
  Select,
  Token,
  timeOptions,
} from "../src";
import { TIP_OPEN_MS } from "../src/components/Tip";
import { EDGE_ROOM, placeTip, pullToFit, TIP_GAP } from "../src/floating";

const body = () => within(document.body);
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const css = (file: string) => Bun.file(new URL(`../src/styles/${file}`, import.meta.url).pathname).text();

describe("floating layers", () => {
  test("one layering scale: dialogs, sheets and what floats share one layer, so what opens later stacks above", async () => {
    const layers = await css("layers.css");
    const z = (name: string) => Number(layers.match(new RegExp(`--z-${name}:\\s*(\\d+)`))?.[1]);
    expect(z("floating")).toBe(z("dialog"));
    expect(z("scrim")).toBe(z("dialog"));
    expect(z("toast")).toBeGreaterThan(z("floating"));
    const components = await css("components.css");
    // No raw z-index numbers: everything uses the scale.
    for (const m of components.matchAll(/z-index:\s*([^;]+);/g)) expect(m[1]).toMatch(/^var\(--z-/);
    const rule = (selector: string) => components.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-menu")).toContain("z-index: var(--z-floating)");
    expect(rule(".ac-dialog")).toContain("z-index: var(--z-dialog)");
    expect(rule(".ac-details")).toContain("z-index: var(--z-dialog)");
    expect(await css("index.css")).toContain('@import "./layers.css"');
  });

  test("a dialog opened from a popover comes after it in the page, so on their one layer it paints above it", async () => {
    function Card() {
      const [asking, setAsking] = useState(false);
      return (
        <Popover open label="Bento" trigger={<button type="button">Bento</button>}>
          <button type="button" onClick={() => setAsking(true)}>
            Salvar
          </button>
          <Dialog open={asking} onOpenChange={setAsking} title="Usar o plano de Wagner?" closeLabel="Fechar">
            <p>O Bento passa a pensar com ele.</p>
          </Dialog>
        </Popover>
      );
    }
    render(<Card />);
    const card = body().getByRole("dialog", { name: "Bento" });
    await click(within(card).getByRole("button", { name: "Salvar" }));
    const ask = body().getByRole("dialog", { name: "Usar o plano de Wagner?" });
    expect(card.contains(ask)).toBe(false);
    expect(card.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("every anchored layer keeps room from the viewport's edges", async () => {
    const dir = new URL("../src/components/", import.meta.url).pathname;
    // `=>` inside an attribute (an arrow function) doesn't end the tag.
    const anchored =
      /<(?:RPopover|DropdownMenu|RSelect|Tooltip|HoverCard|ContextMenu)\.(?:Sub)?Content\b(?:=>|[^>])*?>/gs;
    let seen = 0;
    for await (const name of new Bun.Glob("**/*.tsx").scan(dir)) {
      for (const [tag] of (await Bun.file(dir + name).text()).matchAll(anchored)) {
        seen++;
        const pad = /collisionPadding=\{(EDGE_ROOM|\d+)\}/.exec(tag)?.[1];
        const room = pad === "EDGE_ROOM" ? EDGE_ROOM : Number(pad ?? 0);
        expect({ name, room: room >= EDGE_ROOM }).toEqual({ name, room: true });
      }
    }
    expect(seen).toBeGreaterThanOrEqual(12);
    expect(EDGE_ROOM).toBeGreaterThanOrEqual(8);
    expect(await css("components.css")).toContain(`max-width: calc(100vw - ${2 * EDGE_ROOM}px)`);
  });

  test("a Select inside an open Dialog opens and picks an option", async () => {
    function Harness() {
      const [value, setValue] = useState("none");
      return (
        <Dialog open onOpenChange={() => {}} title="Novo evento" closeLabel="Fechar">
          <DialogBody>
            <Field label="Repetir" id="rep">
              <Select
                value={value}
                onValueChange={setValue}
                options={[
                  { value: "none", label: "Não repete" },
                  { value: "weekly", label: "Toda semana" },
                ]}
              />
            </Field>
          </DialogBody>
        </Dialog>
      );
    }
    render(<Harness />);
    const dialog = body().getByRole("dialog", { name: "Novo evento" });
    const trigger = within(dialog).getByRole("combobox", { name: "Repetir" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    // The list portals out of the dialog, onto the floating layer.
    expect(dialog.contains(listbox)).toBe(false);
    await click(within(listbox).getByRole("option", { name: "Toda semana" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(within(dialog).getByRole("combobox", { name: "Repetir" }).textContent).toContain("Toda semana");
  }, 10_000);

  test("a card the room on its side cuts moves over its trigger by what it lacks, never past the window's edges", () => {
    const card = { scroll: 473, client: 420, height: 420, room: 420, base: 420, window: 900 };
    expect(pullToFit(card)).toBe(53);
    // Placed again: it fits, nothing more to gain.
    expect(pullToFit({ ...card, scroll: 473, client: 473, height: 473, room: 473 })).toBe(0);
    expect(pullToFit({ ...card, window: 460 })).toBe(460 - 2 * EDGE_ROOM - 420);
    expect(pullToFit({ ...card, room: 876, base: 876 })).toBe(0);
    expect(pullToFit({ ...card, scroll: 420 })).toBe(0);
    // A menu at its own 280px cap scrolls where it is.
    expect(pullToFit({ ...card, client: 280, height: 280 })).toBe(0);
    expect(pullToFit({ ...card, room: Number.NaN })).toBe(0);
  });

  test("a message's time details open on the floating layer: in <body>, over the row's bar, never cut by a pane", async () => {
    // The longest they get: a full date, a custom provider's model id, a million tokens.
    const meta =
      "quarta-feira, 30 de setembro de 2026 às 23:59 · accounts/fireworks/models/qwen3-coder-480b-a35b-instruct · 1.048.576 tokens";
    const { container, unmount } = render(
      // A side pane's column: narrower than the details, and it clips.
      <div style={{ width: 360, overflow: "hidden" }}>
        <Message author="Ada" time="23:59" meta={meta} agent>
          <MessageText>Rodei a suíte inteira de novo.</MessageText>
          <div className="ac-msg__actions" role="toolbar" aria-label="Ações" />
        </Message>
      </div>,
    );
    const time = container.querySelector(".ac-msg__time--details") as HTMLElement;
    // Closed, the time is still described by its details.
    expect(document.getElementById(time.getAttribute("aria-describedby") ?? "")?.textContent).toBe(meta);
    expect(document.querySelector(".ac-tip")).toBeNull();
    await act(async () => fireEvent.pointerEnter(time, { pointerType: "mouse" }));
    await act(() => new Promise((r) => setTimeout(r, TIP_OPEN_MS + 10)));
    const tip = document.querySelector<HTMLElement>(".ac-tip.ac-msg__tip");
    expect(tip?.textContent).toBe(meta);
    expect(tip?.parentElement).toBe(document.body);
    expect(container.contains(tip)).toBe(false);
    const rule = (await css("components.css")).split(".ac-tip {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("z-index: var(--z-floating)");
    // As wide as the window allows, and a word longer than that (a mailbox in a connector's tip) breaks inside it.
    expect(rule).toContain(`max-width: calc(100vw - ${2 * EDGE_ROOM}px)`);
    expect(rule).toContain("overflow-wrap: anywhere");
    // Wider than a phone, a time's details stop at a reading width; a phone keeps the window's.
    expect(await css("components.css")).toMatch(
      /@media \(min-width: 641px\) \{\s*\.ac-msg__tip \{\s*max-width: 420px;/,
    );
    await act(async () => fireEvent.pointerLeave(time, { pointerType: "mouse" }));
    expect(document.querySelector(".ac-tip")).toBeNull();
    unmount();
  });

  test("the keys' focus in my row opens its time's details, its head being hidden", async () => {
    const { unmount } = render(
      <Message own author="João" time="23:40" meta="sábado, 7 de novembro de 2026 às 23:40">
        <MessageText>Fizemos um ajuste na conexão.</MessageText>
        <div className="ac-msg__actions">
          <button type="button">Reagir</button>
        </div>
      </Message>,
    );
    const react = body().getByRole("button", { name: "Reagir" });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      react.focus();
    });
    expect(document.querySelector(".ac-tip")?.textContent).toBe("sábado, 7 de novembro de 2026 às 23:40");
    await act(async () => react.blur());
    expect(document.querySelector(".ac-tip")).toBeNull();
    unmount();
  });

  test("on a touch screen a tap shows the time's details, which stay as the finger leaves, until the focus goes", async () => {
    const was = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === "(hover: none)" })) as typeof window.matchMedia;
    try {
      const { container, unmount } = render(
        <Message author="Ada" time="23:59" meta="quarta-feira, 30 de setembro de 2026 às 23:59" agent>
          <MessageText>Pronto.</MessageText>
        </Message>,
      );
      const time = container.querySelector(".ac-msg__time--details") as HTMLElement;
      // A finger: no hover, and not the keys.
      await act(async () => {
        fireEvent.pointerDown(document.body, { pointerType: "touch" });
        fireEvent.pointerEnter(time, { pointerType: "touch" });
        time.focus();
        fireEvent.pointerLeave(time, { pointerType: "touch" });
      });
      expect(document.querySelector(".ac-tip")?.textContent).toBe("quarta-feira, 30 de setembro de 2026 às 23:59");
      await act(async () => time.blur());
      expect(document.querySelector(".ac-tip")).toBeNull();
      unmount();
    } finally {
      window.matchMedia = was;
    }
  });

  test("a tip stands over its element, under it with no room over it, and moves along only to stay inside the window", () => {
    const time = { left: 894, top: 520, right: 925, bottom: 536 };
    // Wider than the room right of the time: moved left, `EDGE_ROOM` inside the window.
    expect(placeTip(time, { width: 394, height: 26 }, "start", 1280)).toEqual({
      left: 1280 - EDGE_ROOM - 394,
      top: 520 - TIP_GAP - 26,
    });
    expect(placeTip(time, { width: 200, height: 26 }, "start", 1280).left).toBe(894);
    // At the window's top: under it.
    expect(placeTip({ ...time, top: 20, bottom: 36 }, { width: 200, height: 26 }, "start", 1280).top).toBe(
      36 + TIP_GAP,
    );
    // A bubble's time ends it: the tip's end on the time's, moved right when a short bubble on the left has no room.
    expect(placeTip(time, { width: 300, height: 26 }, "end", 1280).left).toBe(925 - 300);
    expect(placeTip({ ...time, left: 40, right: 70 }, { width: 300, height: 26 }, "end", 390).left).toBe(EDGE_ROOM);
    // A note's reason: centered on it.
    expect(placeTip({ ...time, left: 100, right: 160 }, { width: 100, height: 20 }, "center", 1280).left).toBe(80);
  });
});

describe("DatePicker", () => {
  test("month grid starts on Monday and has 6 weeks", () => {
    const days = monthGrid(new Date(2026, 9, 1));
    expect(days).toHaveLength(42);
    expect(days[0]?.getDay()).toBe(1);
    expect(days[0]?.getDate()).toBe(28); // Mon 28 Sep 2026
  });
});

describe("TimeSelect", () => {
  test("parses what people type", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime("930")).toBe("09:30");
    expect(normalizeTime("9h15")).toBe("09:15");
    expect(normalizeTime("14:05")).toBe("14:05");
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("abc")).toBeNull();
    expect(timeOptions(15)).toHaveLength(96);
  });
});

describe("Token", () => {
  test("shows the item and a labelled remove button", async () => {
    const removed: string[] = [];
    render(
      <Token removeLabel="Remover Ada" onRemove={() => removed.push("ada")}>
        Ada
      </Token>,
    );
    await click(body().getByRole("button", { name: "Remover Ada" }));
    expect(removed).toEqual(["ada"]);
  });
});
