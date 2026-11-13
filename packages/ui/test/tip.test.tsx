import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render } from "@testing-library/react";
import { TIP_HOLD_MS, Tip } from "../src/components/Tip";

const tip = () => document.querySelector(".ac-tip");
const pressEscape = () => act(async () => fireEvent.keyDown(window, { key: "Escape" }));

describe("a tip closes with Escape, without moving the pointer or the focus", () => {
  test("one the keys' focus opened", async () => {
    const { container, unmount } = render(
      <Tip tip="sábado, 7 de novembro de 2026 às 23:40" look="ac-msg__tip">
        <button type="button">23:40</button>
      </Tip>,
    );
    const time = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      time.focus();
    });
    expect(tip()?.textContent).toBe("sábado, 7 de novembro de 2026 às 23:40");
    await pressEscape();
    expect(tip()).toBeNull();
    // The focus never moved: it opens again from its element, after it is left.
    expect(document.activeElement).toBe(time);
    await act(async () => {
      time.blur();
      time.focus();
    });
    expect(tip()).not.toBeNull();
    unmount();
  });

  test("one held open stays closed until `open` changes", async () => {
    const view = (open: boolean) => (
      <Tip tip="Detalhes" look="ac-msg__tip" open={open}>
        <span>23:40</span>
      </Tip>
    );
    const { rerender, unmount } = render(view(true));
    expect(tip()).not.toBeNull();
    await pressEscape();
    expect(tip()).toBeNull();
    rerender(view(true));
    expect(tip()).toBeNull();
    rerender(view(false));
    rerender(view(true));
    expect(tip()).not.toBeNull();
    unmount();
  });
});

describe("a button's tip (`button`)", () => {
  const HINT = "Resumo da semana faz Enviar e-mail sozinha de agora em diante.";
  const view = (onClick: () => void) =>
    render(
      <div className="row">
        <Tip tip={HINT} look="ac-hint__bubble ac-glass" button delay={0}>
          <button type="button" onClick={onClick}>
            Sempre nesta rotina
          </button>
        </Tip>
      </div>,
    );
  const touch = { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 };

  test("no wrapper: the button stays its row's child, and its words are the button's description", () => {
    const { container, unmount } = view(() => {});
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.parentElement).toBe(container.querySelector(".row"));
    expect(button.getAttribute("aria-description")).toBe(HINT);
    expect(tip()).toBeNull();
    unmount();
  });

  test("a resting mouse opens it, a press anywhere closes it, and the click still acts", async () => {
    let clicks = 0;
    const { container, unmount } = view(() => clicks++);
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerEnter(button, { pointerType: "mouse" });
      await Bun.sleep(5);
    });
    expect(tip()?.textContent).toBe(HINT);
    await act(async () => {
      fireEvent.pointerDown(button, { pointerType: "mouse", pointerId: 1 });
      fireEvent.click(button);
    });
    expect(tip()).toBeNull();
    expect(clicks).toBe(1);
    unmount();
  });

  test("a finger's tap acts and opens nothing; its long press opens it and doesn't act", async () => {
    let clicks = 0;
    const { container, unmount } = view(() => clicks++);
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerDown(button, touch);
      fireEvent.pointerUp(button, touch);
      fireEvent.click(button);
    });
    expect(clicks).toBe(1);
    expect(tip()).toBeNull();
    await act(async () => {
      fireEvent.pointerDown(button, touch);
      await Bun.sleep(TIP_HOLD_MS + 50);
    });
    expect(tip()?.textContent).toBe(HINT);
    await act(async () => {
      fireEvent.pointerUp(button, touch);
      fireEvent.click(button);
    });
    expect(clicks).toBe(1);
    expect(tip()?.textContent).toBe(HINT);
    // The next tap is a tap again: the tip goes and the button acts.
    await act(async () => {
      fireEvent.pointerDown(button, touch);
      fireEvent.pointerUp(button, touch);
      fireEvent.click(button);
    });
    expect(tip()).toBeNull();
    expect(clicks).toBe(2);
    unmount();
  });

  test("a finger that moves is a scroll: no tip, and the button stays as it was", async () => {
    let clicks = 0;
    const { container, unmount } = view(() => clicks++);
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerDown(button, touch);
      fireEvent.pointerMove(button, { ...touch, clientY: 40 });
      await Bun.sleep(TIP_HOLD_MS + 50);
    });
    expect(tip()).toBeNull();
    expect(clicks).toBe(0);
    unmount();
  });
});
