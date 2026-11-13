import { expect, test } from "bun:test";
import path from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const read = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("the menu's last reaction cell fits its two icons with its siblings' room, never squeezed into an emoji's width", async () => {
  const kit = await read("packages/ui/src/styles/components.css");
  const more = ".ac-menu__reaction.ac-menu__reaction--more";
  expect(last(topLevel(kit), ".ac-menu__reaction", "width")).toBe("32px");
  expect(last(topLevel(kit), more, "width")).toBe("auto");
  expect(last(topLevel(kit), more, "padding-inline")).toBe("6px");
  // On touch the emojis are 40px targets: the last cell keeps their wider room too.
  const touch = atRule(kit, "@media (pointer: coarse)");
  expect(last(touch, ".ac-menu__reaction", "width")).toBe("40px");
  expect(last(touch, more, "padding-inline")).toBe("10px");
  expect(last(touch, more, "width")).toBeUndefined();
});

test("every toast glows softly from the right in its tone, as the sidebar's chosen row, in both themes", async () => {
  const kit = await read("packages/ui/src/styles/components.css");
  const top = topLevel(kit);
  const glow = last(top, ".ac-toast", "background-image") ?? "";
  expect(glow).toContain("to left");
  expect(glow).toContain("color-mix(in srgb, var(--toast-tone) var(--toast-glow, 24%), transparent)");
  expect(glow).toContain("transparent 45%");
  // After the glass rules, whose `background` shorthand would clear it.
  const glass = kit.lastIndexOf("background: var(--glass);");
  expect(kit.indexOf("--toast-tone: var(--faint);")).toBeGreaterThan(glass);
  expect(last(top, '[data-theme="dark"] .ac-toast', "--toast-glow")).toBe("30%");
  expect(last(top, ".ac-toast", "--toast-tone")).toBe("var(--faint)");
  expect(last(top, ".ac-toast--success", "--toast-tone")).toBe("var(--ok)");
  expect(last(top, ".ac-toast--info", "--toast-tone")).toBe("var(--info)");
  expect(last(top, ".ac-toast--warning", "--toast-tone")).toBe("var(--warn)");
  expect(last(top, ".ac-toast--error", "--toast-tone")).toBe("var(--danger)");
  expect(last(top, ".ac-toast > .ac-icon", "color")).toBe("var(--toast-tone)");
  // The tones' colors exist in both themes.
  const tokens = await read("packages/ui/src/styles/tokens.css");
  for (const token of ["--ok", "--agent", "--warn", "--danger", "--faint"])
    expect(tokens.match(new RegExp(`\\s${token}:`, "g"))?.length ?? 0).toBeGreaterThanOrEqual(2);
});

test("the floating date sits at the list's top centre, fades out unless shown, and never takes a click", async () => {
  const layout = await read("apps/web/src/layout.css");
  const top = topLevel(layout);
  expect(last(top, ".channel__date", "opacity")).toBe("0");
  expect(last(top, ".channel__date", "pointer-events")).toBe("none");
  expect(last(top, ".channel__date[data-shown]", "opacity")).toBe("1");
  expect(last(top, ".channel__date-pill", "left")).toBe("50%");
  expect(last(top, ".channel__date-pill", "transform")).toBe("translateX(-50%)");
  expect(last(top, ".channel__date-pill", "white-space")).toBe("nowrap");
  expect(last(atRule(layout, "@media (prefers-reduced-motion: reduce)"), ".channel__date", "transition")).toBe("none");
});

test("a toast given no tone is a done confirmation, green like the phone's, never the informational blue", async () => {
  const { createToastStore } = await import("@/lib/toast");
  const store = createToastStore();
  store.show("Link copiado");
  store.show("Pedido enviado", "info");
  expect(store.get().map((x) => x.tone)).toEqual(["success", "info"]);
});
