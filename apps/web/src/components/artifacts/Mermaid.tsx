import { Button } from "@agenteschat/ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/CodeBlock";
import { useDarkTheme } from "@/lib/grow";
import { type Drawing, drawWithMermaid, mermaidDrawable, mermaidRunsApart, svgDrawing } from "@/lib/mermaid";

/** Source → SVG markup in the page's theme. Swappable for tests (the real one needs a browser layout engine). */
export type MermaidRenderer = (id: string, source: string, dark: boolean) => Promise<string>;

let renderer: MermaidRenderer = drawWithMermaid;
let runsApart = mermaidRunsApart;
let counter = 0;
/** One drawing at a time: mermaid keeps its settings (the theme) in one global, read while it draws. */
let queue: Promise<void> = Promise.resolve();

/**
 * Diagrams already drawn, by theme and source, and those mermaid couldn't draw (null): shown again (the streamed answer
 * giving way to the message, a page opened again) they show at once, and mermaid isn't asked again.
 */
const drawn = new Map<string, Drawing | null>();

/** Tests: a renderer in mermaid's place (null for mermaid), and whether it draws unasked (see `mermaidRunsApart`). */
export function setMermaidRenderer(next: MermaidRenderer | null, apart = true) {
  renderer = next ?? drawWithMermaid;
  runsApart = next ? async () => apart : mermaidRunsApart;
  drawn.clear();
}

/**
 * The diagram in the page's theme: `drawing` is undefined until it's drawn, null when it can't be (mermaid refuses it,
 * it doesn't go to mermaid: see `mermaidDrawable`, or it's too big to show: see `svgDrawing`). While another source or
 * theme is being drawn, the block keeps what it showed last. Where mermaid would draw on the page's own thread
 * (`mermaidRunsApart`) a diagram waits for the viewer: `asked`, or `draw` while it's set.
 */
function useMermaid(source: string, asked = false): { drawing: Drawing | null | undefined; draw?: () => void } {
  const dark = useDarkTheme();
  const key = `${dark ? "dark" : "light"}\n${source}`;
  const drawable = mermaidDrawable(source);
  const [last, setLast] = useState<Drawing | null | undefined>(() => drawn.get(key));
  const [pressed, setPressed] = useState(false);
  const wanted = asked || pressed;
  const [held, setHeld] = useState(false);
  const typed = useRef<string | undefined>(undefined);
  useEffect(() => {
    // A source being edited (the wiki's side-by-side preview) is drawn once the typing stops. Noted before the early
    // returns: a block that mounts with its drawing already made still waits on the first edit.
    const wait = typed.current === undefined || typed.current === key ? 0 : 300;
    typed.current = key;
    if (!drawable) return;
    if (drawn.has(key)) {
      setLast(drawn.get(key));
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      queue = queue.then(async () => {
        // Checked when its turn comes: the block may be gone, another one may have drawn the same diagram, or one
        // before it may have timed out.
        if (!live) return;
        if (drawn.has(key)) {
          setLast(drawn.get(key));
          return;
        }
        if (!wanted && !(await runsApart())) {
          if (live) setHeld(true);
          return;
        }
        let drawing: Drawing | null;
        try {
          drawing = svgDrawing(await renderer(`mmd-${++counter}`, source, dark));
        } catch {
          drawing = null;
        }
        drawn.set(key, drawing);
        // ponytail: the last 100, oldest out first; move a hit to the end (least recently used) if pages ever show
        // more diagrams than that.
        for (const old of drawn.keys()) {
          if (drawn.size <= 100) break;
          drawn.delete(old);
        }
        if (live) setLast(drawing);
      });
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, source, dark, drawable, wanted]);
  if (!drawable) return { drawing: null };
  if (held && !wanted) return { drawing: undefined, draw: () => setPressed(true) };
  return { drawing: drawn.has(key) ? drawn.get(key) : last };
}

/**
 * A Mermaid diagram drawn as an image: the SVG goes into an `<img>` (data URL), never into our DOM, so nothing in it can
 * run. If drawing fails, the source is shown as code. Opened on its own it's drawn; a thumbnail (`compact`) shows its
 * code while it waits for the viewer (`mermaidRunsApart`), who opens it to see it drawn.
 */
export function MermaidDiagram({ source, label, compact }: { source: string; label: string; compact?: boolean }) {
  const { t } = useTranslation();
  const { drawing, draw } = useMermaid(source, !compact);
  if (drawing === null || draw) {
    return (
      <div className="artifact-diagram artifact-diagram--failed">
        {!compact && <p className="small muted">{t("artifacts.diagramFailed")}</p>}
        <pre className="md__code">
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className={compact ? "artifact-diagram artifact-diagram--compact" : "artifact-diagram"}>
      {drawing ? (
        <img src={drawing.src} alt={drawing.title ?? label} aria-description={drawing.description} />
      ) : (
        <span className="small muted" role="status">
          {t("artifacts.rendering")}
        </span>
      )}
    </div>
  );
}

/**
 * A ```mermaid block in a message or page: its code card shows the diagram ("Código" flips to the source, copy is
 * always there). Until it's drawn, or when it can't be, the card shows the code like any other block, and "Ver
 * diagrama" while the drawing waits for the viewer (`mermaidRunsApart`).
 */
export function MermaidOrCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const { drawing, draw } = useMermaid(text);
  return (
    <CodeBlock
      lang="mermaid"
      text={text}
      action={
        draw && (
          <Button variant="ghost" size="sm" onClick={draw}>
            {t("artifacts.showDiagram")}
          </Button>
        )
      }
      preview={
        drawing ? (
          <img
            src={drawing.src}
            alt={drawing.title ?? t("artifacts.kind.diagram")}
            aria-description={drawing.description}
            style={drawing.width ? ({ "--w": `${drawing.width}px` } as CSSProperties) : undefined}
          />
        ) : undefined
      }
    />
  );
}
