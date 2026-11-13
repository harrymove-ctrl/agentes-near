import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Poll } from "../src/api/types";
import { BLOCK_KIT_CSS, BLOCK_KIT_JS } from "../src/lib/block-kit";
import {
  BLOCK_VIEWPORT,
  blockEvent,
  blockPage,
  newerBlockState,
  pollAnswered,
  pollIsOpen,
  pollTally,
  pollToggle,
  stateChanges,
  stateForPage,
} from "../src/lib/blocks";

const HOST = {
  theme: "dark" as const,
  ramp: ["#111"],
  locale: "pt-BR",
  labels: { send: "Mandar", more: "Mais", thousand: "mil" },
};

describe("a block's page", () => {
  test("the policy comes before the kit, and the kit before what the agent wrote", () => {
    const page = blockPage('<ac-stat label="x"></ac-stat>', HOST);
    const policy = page.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(0);
    expect(page.indexOf('content="off"')).toBeGreaterThan(0);
    expect(page.indexOf('content="off"')).toBeLessThan(policy);
    expect(policy).toBeLessThan(page.indexOf("window.__block"));
    expect(page.indexOf("window.__block")).toBeLessThan(page.indexOf("customElements.define"));
    expect(page.indexOf("customElements.define")).toBeLessThan(page.indexOf('<ac-stat label="x">'));
  });

  test("the page is as wide as the phone's web view shows it, and what it holds stays inside that width", () => {
    const page = blockPage("<p>a</p>", HOST);
    expect(BLOCK_VIEWPORT).toContain('name="viewport"');
    expect(BLOCK_VIEWPORT).toContain("width=device-width");
    // After the policy (nothing comes before it), before what the agent wrote.
    expect(page.indexOf(BLOCK_VIEWPORT)).toBeGreaterThan(page.indexOf("Content-Security-Policy"));
    expect(page.indexOf(BLOCK_VIEWPORT)).toBeLessThan(page.indexOf("<p>a</p>"));
    expect(BLOCK_KIT_CSS).toContain("overflow-wrap:break-word");
    expect(BLOCK_KIT_CSS).toContain(":where(body>*){min-width:0;max-width:100%}");
    // A table wider than the block scrolls inside it instead of being cut at the edge.
    expect(BLOCK_KIT_CSS).toContain("ac-table{overflow-x:auto");
  });

  test("what the person set can't close the script it travels in", () => {
    const page = blockPage("<p>a</p>", { ...HOST, state: { name: "</script><script>x()</script>" } });
    expect(page).not.toContain("</script><script>x()");
  });

  test("the kit can sit in a page's script and speaks to both hosts", () => {
    expect(BLOCK_KIT_JS).not.toContain("</script");
    expect(BLOCK_KIT_JS).toContain("window.ReactNativeWebView");
    expect(BLOCK_KIT_JS).toContain("parent.postMessage");
  });

  test("nothing in the kit outweighs a plain button's look", () => {
    // That look sits in `:where`, which weighs nothing: a bare `button{...}` reset would take its padding and weight.
    expect(BLOCK_KIT_CSS).toContain(":where(button){");
    expect(BLOCK_KIT_CSS).not.toMatch(/(^|[\n}])button\{/);
  });

  test("what the kit shares with the app has the app's values, in both themes", () => {
    const tokens = readFileSync(join(import.meta.dir, "../../ui/src/styles/tokens.css"), "utf8");
    const brief = (v: string | undefined) =>
      v
        ?.toLowerCase()
        .replace(/\s+/g, "")
        .replace(/\b0\./g, ".")
        .replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/, "#$1$2$3");
    const value = (sheet: string, name: string) => new RegExp(`--${name}:\\s*([^;}]+)`).exec(sheet)?.[1];
    const app = tokens.split('[data-theme="dark"]');
    const kit = BLOCK_KIT_CSS.split("html[data-theme=dark]");
    for (const name of "ink ink2 muted faint line line2 raised sunken ok warn danger plate".split(" "))
      for (const [ours = "", theirs = ""] of [
        [kit[0], app[0]],
        [kit[1], app[1]],
      ]) {
        expect(value(ours, name)).toBeDefined();
        expect(brief(value(ours, name))).toBe(brief(value(theirs, name)));
      }
  });

  test("plain HTML wears the app's look at no weight, so an agent's CSS always wins", () => {
    for (const rule of ["h1,h2,h3", "ul,ol", "table:not([class])", "progress,meter", "code,kbd", "label"])
      expect(BLOCK_KIT_CSS).toContain(`:where(${rule})`);
    expect(BLOCK_KIT_CSS).toContain("select:not([class])");
  });

  test("the parts an agent builds from are there, and its tones follow the theme", () => {
    for (const part of ["ac-card", "ac-result"]) expect(BLOCK_KIT_JS).toContain(`E("${part}"`);
    expect(BLOCK_KIT_CSS).toContain("ac-actions{display:flex");
    // The answer keeps the block's width in a centered layout, and its actions follow it.
    expect(BLOCK_KIT_CSS).toContain("ac-result{width:100%}");
    expect(BLOCK_KIT_CSS).toContain("ac-result + ac-actions,ac-actions[align=center]{justify-content:center}");
    expect(BLOCK_KIT_JS).toContain('d.style.setProperty("--s"+(i+1),c)');
  });

  test("a plain button stacked tight under something gets room, measured from the page", () => {
    expect(BLOCK_KIT_CSS).toContain(":where(button[data-air]:not([class])){margin-top:12px}");
    expect(BLOCK_KIT_JS).toContain('b.setAttribute("data-air","")');
  });

  test("the only plain button showing is the block's main action", () => {
    expect(BLOCK_KIT_CSS).toContain(":where(button[data-lead]:not([class])){");
    expect(BLOCK_KIT_JS).toContain('b.toggleAttribute("data-lead",live.length===1&&live[0]===b)');
  });
});

describe("what a frame may say", () => {
  test("only what is ours, in bounds", () => {
    expect(blockEvent({ type: "height", height: 10 })).toBeNull();
    expect(blockEvent("not json")).toBeNull();
    expect(blockEvent({ agentes: 1, type: "navigate", to: "x" })).toBeNull();
    expect(blockEvent({ agentes: 1, type: "height", height: -1 })).toBeNull();
    expect(blockEvent({ agentes: 1, type: "height", height: 1e9 })).toEqual({ type: "height", height: 20_000 });
    expect(blockEvent('{"agentes":1,"type":"ready"}')).toEqual({ type: "ready" });
  });

  test("a draft is plain text, cut to size, and empty can't be sent", () => {
    const e = blockEvent({
      agentes: 1,
      type: "draft",
      label: "L".repeat(99),
      text: `a\n\n${"b".repeat(3000)}`,
      ready: true,
    });
    expect(e).toMatchObject({ type: "draft", ready: true });
    if (e?.type !== "draft") throw new Error("no draft");
    expect(e.label).toHaveLength(40);
    expect(e.text).toHaveLength(2000);
    expect(e.text.startsWith("a b")).toBe(true);
    expect(blockEvent({ agentes: 1, type: "draft", label: "Go", text: "  ", ready: true })).toMatchObject({
      ready: false,
    });
    expect(blockEvent({ agentes: 1, type: "draft", text: "x", ready: true })).toBeNull();
  });
});

describe("one state for everyone (ADR 0113)", () => {
  test("a state says whether the person touched the page; a draw counts only then", () => {
    expect(blockEvent({ agentes: 1, type: "state", state: { a: 1 } })).toEqual({
      type: "state",
      state: { a: 1 },
      used: false,
    });
    expect(blockEvent({ agentes: 1, type: "state", state: [1] })).toBeNull();
    const draw = { agentes: 1, type: "draw", name: "nome", options: ["Bento", 2] };
    expect(blockEvent({ ...draw, used: true })).toEqual({ type: "draw", name: "nome", options: ["Bento", "2"] });
    // A page drawing as it opens would draw again for everyone who opens it.
    expect(blockEvent(draw)).toBeNull();
    expect(blockEvent({ ...draw, used: true, options: ["só"] })).toBeNull();
    expect(blockEvent({ ...draw, used: true, name: "no spaces" })).toBeNull();
  });

  test("only what the page changed goes out", () => {
    expect(stateChanges({ a: 1, b: [1, 2], c: "x" }, { a: 1, b: [1, 2] })).toEqual({ c: "x" });
    expect(stateChanges({ a: 1 }, { a: 1 })).toBeNull();
    expect(stateChanges({ "bad name": 1, u: undefined }, {})).toBeNull();
  });

  test("a page isn't told back what the person is still changing; the newest rev wins", () => {
    const block = { id: "b", version: 1, state: { x: 5, y: 2 }, changes: {}, rev: 4 };
    expect(stateForPage(block, new Set(["x"]))).toEqual({ state: { y: 2 }, who: {} });
    expect(newerBlockState({ ...block, rev: 5 }, block).rev).toBe(5);
    expect(newerBlockState(undefined, block)).toBe(block);
  });

  test("the kit shares a value only after the person touched the page, and takes everyone's from the app", () => {
    expect(BLOCK_KIT_JS).toContain('post({type:"state",state:state,used:used})');
    expect(BLOCK_KIT_JS).toContain("draw:function(name,options)");
    expect(BLOCK_KIT_JS).toContain('if(m.state&&typeof m.state==="object"){Object.assign(state,m.state)');
  });
});

/**
 * The kit run with just enough of a page to start: what it posts is what the app would hear. No parts on it, so no
 * DOM is needed.
 */
function startKit() {
  const posts: { type: string; message?: string }[] = [];
  const window: Record<string, unknown> = {
    __block: { state: {} },
    ReactNativeWebView: { postMessage: (data: string) => posts.push(JSON.parse(data)) },
    localStorage: { length: 0 },
    sessionStorage: { length: 0 },
  };
  const node = () => ({ dataset: {}, style: { setProperty() {} } });
  const document = {
    cookie: "",
    documentElement: node(),
    body: { getBoundingClientRect: () => ({ height: 10 }) },
    querySelectorAll: () => [],
  };
  const run = new Function("window", "document", "customElements", "HTMLElement", "addEventListener", BLOCK_KIT_JS);
  run(window, document, { define() {} }, class {}, () => {});
  const agentes = window.agentes as {
    set: (name: string, value: unknown) => void;
    on: (f: (s: Record<string, number | undefined>) => void) => void;
  };
  const settled = () => new Promise((done) => setTimeout(done, 20));
  return { agentes, settled, of: (type: string) => posts.filter((p) => p.type === type) };
}

describe("a page can't hang on its own redraws", () => {
  test("setting what is already there changes nothing, so a handler that sets settles", async () => {
    const kit = startKit();
    kit.agentes.on(() => kit.agentes.set("top", 3));
    await kit.settled();
    expect(kit.of("state").length).toBeLessThanOrEqual(2);
    expect(kit.of("error")).toEqual([]);
  });

  test("a handler that keeps changing the state stops after a bounded chain and says why", async () => {
    const kit = startKit();
    kit.agentes.on((s) => kit.agentes.set("n", (s.n ?? 0) + 1));
    await kit.settled();
    expect(kit.of("error")).toHaveLength(1);
    expect(kit.of("error")[0]?.message).toContain("agentes.on");
    expect(kit.of("state").length).toBeLessThanOrEqual(52);
  });

  test("the app hears the state only when it changed", async () => {
    const kit = startKit();
    kit.agentes.set("a", [1, 2]);
    await kit.settled();
    kit.agentes.set("a", [1, 2]);
    await kit.settled();
    expect(kit.of("state")).toHaveLength(1);
  });
});

describe("polls", () => {
  const poll: Poll = {
    id: "p",
    closesAt: "2030-01-01T00:00:00.000Z",
    closedAt: null,
    people: 4,
    votes: [
      { userId: "a", option: 0 },
      { userId: "b", option: 0 },
      { userId: "b", option: 1 },
    ],
  };

  test("who marked what, and how many answered", () => {
    expect(pollTally(["X", "Y"], poll)).toEqual([
      { option: 0, label: "X", voters: ["a", "b"], share: 0.5 },
      { option: 1, label: "Y", voters: ["b"], share: 0.25 },
    ]);
    expect(pollAnswered(poll)).toBe(2);
  });

  test("a tap marks, moves or clears", () => {
    expect(pollToggle(poll, "a", 1, false)).toEqual([1]);
    expect(pollToggle(poll, "a", 1, true)).toEqual([0, 1]);
    expect(pollToggle(poll, "b", 0, true)).toEqual([1]);
    expect(pollToggle(poll, "a", 0, false)).toEqual([]);
  });

  test("open until its time or its close", () => {
    expect(pollIsOpen(poll, Date.parse("2029-12-31T00:00:00.000Z"))).toBe(true);
    expect(pollIsOpen(poll, Date.parse("2030-01-02T00:00:00.000Z"))).toBe(false);
    expect(pollIsOpen({ ...poll, closedAt: "2029-01-01T00:00:00.000Z" }, 0)).toBe(false);
  });
});
