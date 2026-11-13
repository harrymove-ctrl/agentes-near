import { describe, expect, test } from "bun:test";
import { parseSvg } from "../scripts/generate-icons";
import { sourceIcons } from "../src/icons/source";

const root = new URL("../../../docs/design/", import.meta.url).pathname;

describe("design source", () => {
  test("tokens.css is a copy of docs/design/design-system/tokens.css", async () => {
    const source = await Bun.file(`${root}design-system/tokens.css`).text();
    const copy = await Bun.file(new URL("../src/styles/tokens.css", import.meta.url).pathname).text();
    // Compared without whitespace: the copy is formatted by Biome.
    const squash = (css: string) => css.replace(/\s+/g, "");
    expect(squash(copy.split("\n").slice(1).join("\n"))).toBe(squash(source));
  });

  test("generated icons match docs/design/icons (run `bun run icons` in packages/ui)", async () => {
    expect(sourceIcons.agent as unknown).toEqual(parseSvg(await Bun.file(`${root}icons/agente.svg`).text()));
    expect(sourceIcons.send as unknown).toEqual(parseSvg(await Bun.file(`${root}icons/enviar.svg`).text()));
    expect(Object.keys(sourceIcons).sort()).toEqual(
      ["agent", "approve", "attach", "channel", "message", "person", "search", "send", "waiting"].sort(),
    );
  });

  test("component styles never use the agent color outside agent identity", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rules = css.split("}").filter((r) => r.includes("var(--agent)"));
    const selectors = rules.map((r) => (r.split("{")[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim());
    for (const selector of selectors) {
      expect(selector).toMatch(/ac-avatar|ac-logo|ac-msg--streaming|ac-btn--agent \.ac-icon|ac-composer__agent/);
    }
  });
});
