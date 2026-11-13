import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { fireEvent, render, within } from "@testing-library/react";
import { EffortPixels, Locked, OptionList } from "../src";

const steps = [
  { value: "low", label: "Baixo" },
  { value: "high", label: "Alto" },
];

describe("what a fieldset can't reach, inside Locked", () => {
  test("the effort slider's keys and look are off", () => {
    let picked = "";
    const { container } = render(
      <Locked when>
        <EffortPixels value="low" onValueChange={(v) => (picked = v)} steps={steps} label="Esforço" />
      </Locked>,
    );
    const slider = within(container).getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(picked).toBe("");
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    expect(slider.tabIndex).toBe(-1);
  });

  test("an option list shows the look of its own disabled state", () => {
    const { container } = render(
      <Locked when>
        <OptionList
          aria-label="Quem"
          value="low"
          onValueChange={() => {}}
          options={steps.map((s) => ({ value: s.value, title: s.label }))}
        />
      </Locked>,
    );
    expect(container.querySelector(".ac-optlist--locked")).not.toBeNull();
  });
});
