// Runs in the frame where mermaid draws (see mermaid.ts), right after mermaid's own bundle, and alone in the frame that
// tells whether frames run apart from the page (`mermaidRunsApart`). It answers the page that made the frame and no one
// else: `{id, source, dark}` in, `{id, svg}` or `{id, error}` out; `{probe: true}` in, `{at}` out.
{
  const page = parent.parent;
  // The settings a diagram may change for itself (`%%{init}%%`, front matter `config:`): ones that change how it looks,
  // not how big it comes out or how long it takes. `layout` and the sequence's `wrap` are also how mermaid itself gives
  // swimlanes their layout and sequence diagrams their wrapping.
  const OWN = ["look", "layout", "wrap"];
  const OWN_IN = { flowchart: ["curve"], sequence: ["mirrorActors", "showSequenceNumbers", "wrap"] };
  // Mermaid drops a `secure` name at any depth, and the names it doesn't know: so every other top-level name, which
  // takes a whole diagram's section with it, and the other names in the sections above. Kept to those: mermaid copies
  // the list on every read of its settings, in time that grows with its square.
  const secure = (config) => [
    ...Object.keys(config).filter((name) => !OWN.includes(name) && !(name in OWN_IN)),
    ...Object.entries(OWN_IN).flatMap(([section, own]) => Object.keys(config[section]).filter((n) => !own.includes(n))),
  ];
  let count = 0;
  addEventListener("message", async ({ source, data }) => {
    if (source !== page) return;
    if (data?.probe === true) {
      // When it read the question, 25 ms on (by then a page apart from it is well into its own busy spell). Busy, not
      // waiting on a timer: an offscreen frame's timers may be held back.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // Busy.
      }
      page.postMessage({ at: Date.now() }, "*");
      return;
    }
    if (typeof data?.id !== "string" || typeof data.source !== "string") return;
    let answer;
    try {
      // The frame can't reach the network whatever these say; they are a second layer. Labels stay text and nothing
      // is clickable, and a diagram's own settings are only those above: not HTML labels, the sanitizer's settings or
      // anything that reaches CSS, nor knobs such as wrappingWidth, nodeSpacing or bitsPerRow.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        secure: secure(mermaid.mermaidAPI.defaultConfig),
        // Label HTML (math, class labels with math, architecture icon text) goes into the document through this
        // sanitizer, which replaces mermaid's own (that one drops only <style>). The style attribute and inline SVG
        // (its mask and clip-path load another document) go too: in a class label mermaid turns `#108;` into
        // `&#108;`, so `ur#108;(` reads as `url(` once it's markup.
        dompurifyConfig: {
          FORBID_TAGS: [
            "style",
            "svg",
            "img",
            "image",
            "picture",
            "source",
            "video",
            "audio",
            "track",
            "iframe",
            "object",
            "embed",
            "link",
            "input",
            "use",
            "feimage",
          ],
          FORBID_ATTR: [
            "style",
            "src",
            "srcset",
            "href",
            "xlink:href",
            "poster",
            "background",
            "action",
            "formaction",
            "data",
            "ping",
          ],
        },
        // A diagram that doesn't parse rejects, instead of drawing mermaid's error graphic.
        suppressErrorRendering: true,
        theme: data.dark ? "dark" : "neutral",
        // The <img> it ends up in can't use the page's web fonts, and mermaid sizes each box for the font it measured.
        fontFamily: "system-ui, sans-serif",
        // A gantt takes the width of the box it's drawn in: a fixed one fits a card. Not narrower: mermaid puts as
        // many dates on the axis at any width, and at 480 (whose 60% a phone card fits) a long timeline's run together.
        gantt: { useWidth: 720 },
      });
      // Not mermaid.render, which waits its turn in mermaid's own queue: the page already sends one at a time.
      answer = { id: data.id, svg: (await mermaid.mermaidAPI.render(`mmd-${++count}`, data.source)).svg };
    } catch (error) {
      answer = { id: data.id, error: String(error) };
    }
    // What a failed drawing leaves (mermaid's working <div>, a measuring <svg>, KaTeX's and cytoscape's nodes): nothing
    // else lives in this body.
    document.body.replaceChildren();
    page.postMessage(answer, "*");
  });
  page.postMessage({ ready: true }, "*");
}
