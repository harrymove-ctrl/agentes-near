import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Composer, type ComposerWorking, PixelDone, PixelStop, pixelCell, sendChoice } from "../src";

afterEach(() => cleanup());

const body = () => within(document.body);

describe("pixel marks", () => {
  test("pixelCell: the spinner's rule (cell = size / n, gap = max(1, round(cell × .14)))", () => {
    expect(pixelCell(14, 3)).toEqual({ cell: 14 / 3, gap: 1, inner: 4 });
    expect(pixelCell(24, 3)).toEqual({ cell: 8, gap: 1, inner: 7 });
    expect(pixelCell(32, 3)).toEqual({ cell: 32 / 3, gap: 1, inner: 10 });
    expect(pixelCell(13, 2)).toEqual({ cell: 6.5, gap: 1, inner: 6 });
    expect(pixelCell(40, 2)).toEqual({ cell: 20, gap: 3, inner: 17 });
  });

  test("PixelDone: one pixel the size of the center cell, decorative unless labeled", () => {
    const { container, rerender } = render(<PixelDone size={14} />);
    const mark = container.querySelector(".ac-pixdone") as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.style.getPropertyValue("--px")).toBe("4px");
    // Its size for the aim at the capitals' middle in a line of text.
    expect(mark.style.getPropertyValue("--mark-size")).toBe("14px");
    rerender(<PixelDone label="Feito" />);
    expect(body().getByRole("img", { name: "Feito" })).toBeTruthy();
  });

  test("PixelStop: one rounded square; animated while working, dim when stopped", () => {
    const { container, rerender } = render(<PixelStop animated />);
    const mark = container.querySelector(".ac-pixstop") as HTMLElement;
    expect(mark.querySelectorAll("span")).toHaveLength(1);
    expect(mark.style.getPropertyValue("--stop-side")).toBe("10px");
    expect(mark.style.getPropertyValue("--mark-size")).toBe("13px");
    expect(mark.hasAttribute("data-animated")).toBe(true);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    rerender(<PixelStop dim />);
    const still = container.querySelector(".ac-pixstop") as HTMLElement;
    expect(still.hasAttribute("data-animated")).toBe(false);
    expect(still.hasAttribute("data-dim")).toBe(true);
  });
});

describe("Composer while an agent works", () => {
  test("sendChoice: Enter keeps the choice, ⌘/Ctrl+Enter takes the other", () => {
    expect(sendChoice("join", false)).toBe("join");
    expect(sendChoice("join", true)).toBe("interrupt");
    expect(sendChoice("interrupt", false)).toBe("interrupt");
    expect(sendChoice("interrupt", true)).toBe("join");
  });

  const CHOICE = { joinLabel: "Juntar ao que ele faz", interruptLabel: "Parar e mandar", label: "Ao mandar" };

  function Box({
    initial = "",
    working,
    choice = working ? CHOICE : null,
    sent,
  }: {
    initial?: string;
    working: ComposerWorking | null;
    /** The app gives it while an agent works (default: with `working`). */
    choice?: typeof CHOICE | null;
    sent: Array<[string, { interrupt?: boolean } | undefined]>;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <Composer
        value={value}
        onChange={setValue}
        onSend={(text, opts) => {
          sent.push([text, opts]);
          setValue("");
        }}
        label="Mensagem"
        sendLabel="Enviar"
        working={working}
        {...(choice ? { choice } : {})}
      />
    );
  }

  test("empty box: send becomes stop; a click or Esc stops right away", async () => {
    let stops = 0;
    const sent: Array<[string, { interrupt?: boolean } | undefined]> = [];
    render(<Box working={{ stopLabel: "Parar o Theo", onStop: () => stops++ }} sent={sent} />);
    const stop = body().getByRole("button", { name: "Parar o Theo" });
    expect(stop.getAttribute("data-mode")).toBe("stop");
    expect(stop.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(stop));
    expect(stops).toBe(1);
    await act(async () => fireEvent.keyDown(body().getByRole("textbox", { name: "Mensagem" }), { key: "Escape" }));
    expect(stops).toBe(2);
    expect(sent).toHaveLength(0);
    // No choice row without text.
    expect(body().queryByRole("radiogroup", { name: "Ao mandar" })).toBeNull();
  });

  test("with text: the choice row; Enter joins, Ctrl+Enter stops and sends; the choice resets after", async () => {
    const sent: Array<[string, { interrupt?: boolean } | undefined]> = [];
    const working = { stopLabel: "Parar o Theo", onStop: () => {} };
    render(<Box initial="separa por aparelho" working={working} sent={sent} />);
    const box = body().getByRole("textbox", { name: "Mensagem" });
    const group = body().getByRole("radiogroup", { name: "Ao mandar" });
    expect(within(group).getByRole("radio", { name: "Juntar ao que ele faz" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(body().getByRole("button", { name: "Enviar" }).getAttribute("data-mode")).toBe("send");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent.at(-1)).toEqual(["separa por aparelho", { interrupt: false }]);

    await act(async () => fireEvent.change(box, { target: { value: "para tudo" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter", ctrlKey: true }));
    expect(sent.at(-1)).toEqual(["para tudo", { interrupt: true }]);

    // Picking "Parar e mandar" makes Enter interrupt; after the send it is back to join.
    await act(async () => fireEvent.change(box, { target: { value: "agora" } }));
    await act(async () => fireEvent.click(body().getByRole("radio", { name: "Parar e mandar" })));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent.at(-1)).toEqual(["agora", { interrupt: true }]);
    await act(async () => fireEvent.change(box, { target: { value: "de novo" } }));
    expect(body().getByRole("radio", { name: "Juntar ao que ele faz" }).getAttribute("aria-checked")).toBe("true");
  });

  test("without an agent at work: sends as before, no second argument", async () => {
    const sent: Array<[string, { interrupt?: boolean } | undefined]> = [];
    render(<Box initial="oi" working={null} sent={sent} />);
    await act(async () => fireEvent.keyDown(body().getByRole("textbox", { name: "Mensagem" }), { key: "Enter" }));
    expect(sent).toEqual([["oi", undefined]]);
  });

  test("someone who may not stop the agent still chooses; there is just no stop button", async () => {
    const sent: Array<[string, { interrupt?: boolean } | undefined]> = [];
    render(<Box working={null} choice={CHOICE} sent={sent} />);
    const box = body().getByRole("textbox", { name: "Mensagem" });
    // Empty box: the button sends (dim), it never turns into stop.
    expect(body().getByRole("button", { name: "Enviar" }).getAttribute("data-mode")).toBe("send");
    await act(async () => fireEvent.change(box, { target: { value: "para e olha isso" } }));
    expect(body().getByRole("radiogroup", { name: "Ao mandar" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(box, { key: "Enter", ctrlKey: true }));
    expect(sent.at(-1)).toEqual(["para e olha isso", { interrupt: true }]);
    await act(async () => fireEvent.change(box, { target: { value: "junta" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(sent.at(-1)).toEqual(["junta", { interrupt: false }]);
  });
});
