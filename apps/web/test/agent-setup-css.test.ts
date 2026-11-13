import { expect, test } from "bun:test";
import path from "node:path";
import { declarations, topLevel } from "./built-css";

const sheet = Bun.file(path.join(import.meta.dir, "../src/components/agent-setup.css")).text();
const last = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a checklist's count stays one line beside its title's first line, even when the title wraps on a phone", async () => {
  const top = topLevel(await sheet);
  expect(last(top, ".setup-cl__head", "align-items")).toBe("baseline");
  expect(last(top, ".setup-cl__head small", "white-space")).toBe("nowrap");
  expect(last(top, ".setup-cl__head small", "flex")).toBe("none");
});
