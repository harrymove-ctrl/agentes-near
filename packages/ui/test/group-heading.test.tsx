import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { GroupHeading } from "../src";

describe("GroupHeading", () => {
  test("a heading with its count and an aside at its end; an h3 under another heading", () => {
    const { container } = render(
      <>
        <GroupHeading title="Decididos há pouco" count={3} aside={<a href="#historico">Ver histórico</a>} />
        <GroupHeading title="Hoje" level={3} />
        <GroupHeading title="Meus painéis" count={2} note="ninguém mais vê" />
      </>,
    );
    const [first, second, third] = [...container.querySelectorAll(".ac-grouphead")];
    expect(first?.querySelector("h2.ac-grouphead__title")?.firstChild?.textContent).toBe("Decididos há pouco");
    expect(first?.querySelector(".ac-grouphead__title > .ac-grouphead__count")?.textContent).toBe("3");
    expect(first?.querySelector(".ac-grouphead__aside > a")?.textContent).toBe("Ver histórico");
    // The aside goes under the title, from its edge, when they don't share the line: the title is the line's words.
    expect(first?.matches(".ac-actline")).toBe(true);
    expect(first?.firstElementChild?.matches(".ac-grouphead__title")).toBe(true);
    expect(second?.querySelector("h3.ac-grouphead__title")?.textContent).toBe("Hoje");
    expect(second?.querySelector(".ac-grouphead__count, .ac-grouphead__aside")).toBeNull();
    expect(second?.matches(".ac-actline")).toBe(false);
    // A note follows the count on the title's line.
    expect(third?.querySelector(".ac-grouphead__count + .ac-grouphead__note")?.textContent).toBe("ninguém mais vê");
  });
});
