import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import { HandBackFoot } from "../src/components/computer/control";

afterEach(() => cleanup());

const props = {
  title: "Devolver",
  label: "Devolver",
  grammar: { name: "Lia" },
  note: "Deixei aberto",
  onNote: () => {},
  noteFirst: true,
  onBack: () => {},
  onCancel: () => {},
};

describe("the hand-back bar", () => {
  test("on its way, everything in it is off and the note keeps its words; a failure gives it all back, focus too", () => {
    const { container, rerender } = render(<HandBackFoot {...props} pending={false} />);
    const row = container.querySelector("fieldset") as HTMLFieldSetElement;
    const note = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(row.contains(note)).toBe(true);
    expect(row.querySelectorAll("button").length).toBe(container.querySelectorAll("button").length);
    note.focus();
    rerender(<HandBackFoot {...props} pending />);
    expect(row.disabled).toBe(true);
    expect(note.value).toBe("Deixei aberto");
    note.blur();
    rerender(<HandBackFoot {...props} pending={false} />);
    expect(row.disabled).toBe(false);
    expect(note.value).toBe("Deixei aberto");
    expect(document.activeElement === note).toBe(true);
  });
});
