import type { Artifact, ArtifactContent, ArtifactFileContent } from "@agenteschat/client";
import { useArtifact } from "@agenteschat/client";
import { documentPreview, parsePatch, patchCounts } from "@agenteschat/client/lib/artifacts";
import { previewKind } from "@agenteschat/client/lib/files";
import { cx } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_THUMB_BYTES, usePreviewUrl } from "@/components/artifacts/FileView";
import { MermaidDiagram } from "@/components/artifacts/Mermaid";
import { useOrg } from "@/components/org-context";

const DOC_LINES = 8;
const TABLE_ROWS = 5;
const TABLE_COLS = 4;
const DIFF_LINES = 9;

/**
 * Once the element has been on screen (or there's no IntersectionObserver),
 * true for good: cards load their content only when seen.
 */
function useSeen<T extends Element>() {
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  return [setEl, seen] as const;
}

const extensionOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").slice(0, 4).toUpperCase();

/**
 * A real preview of a Drive item: the first
 * lines of a document, a mini table, the diff's first lines, the diagram,
 * a page's frame, an image's thumbnail, a PDF's sheet or the file's type.
 * Scales with its box (container units). Neutral placeholder until loaded.
 */
export function DrivePreview({ artifact, size = "md" }: { artifact: Artifact; size?: "sm" | "md" | "lg" }) {
  const { org } = useOrg();
  const [ref, seen] = useSeen<HTMLDivElement>();
  // At its exact version: never stale, and shared by every card of that version.
  const query = useArtifact(org.id, seen || size === "lg" ? artifact.id : null, artifact.version);
  const content = query.data?.content;
  return (
    <div
      ref={ref}
      className={cx("drive-pv", `drive-pv--${size}`, !content && "drive-pv--loading")}
      data-kind={artifact.kind}
      aria-hidden="true"
    >
      {content && <PreviewBody content={content} artifact={artifact} size={size} />}
    </div>
  );
}

function PreviewBody({
  content,
  artifact,
  size,
}: {
  content: ArtifactContent;
  artifact: Artifact;
  size: "sm" | "md" | "lg";
}) {
  const { t } = useTranslation();
  // The small list thumbnail stays simple: diagrams and pages by their shape.
  switch (content.kind) {
    case "document": {
      const [head, ...lines] = documentPreview(content.markdown, DOC_LINES);
      return (
        <div className="drive-pv__sheet drive-pv__paper">
          {head && <span className="drive-pv__h">{head}</span>}
          {lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview
            <span key={i} className="drive-pv__p">
              {l}
            </span>
          ))}
        </div>
      );
    }
    case "table": {
      const cols = content.columns.slice(0, TABLE_COLS);
      return (
        <div className="drive-pv__sheet drive-pv__table">
          <table>
            <thead>
              <tr>
                {cols.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.rows.slice(0, TABLE_ROWS).map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                <tr key={i}>
                  {cols.map((_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "diff": {
      const first = content.files[0];
      const total = content.files.reduce(
        (sum, f) => {
          const c = patchCounts(f.patch);
          return { added: sum.added + c.added, removed: sum.removed + c.removed };
        },
        { added: 0, removed: 0 },
      );
      return (
        <div className="drive-pv__sheet drive-pv__code">
          <div className="drive-pv__file">
            <span>{first?.path}</span>
            <em className="tabular">{t("artifacts.counts", total)}</em>
          </div>
          {(first ? parsePatch(first.patch) : []).slice(0, DIFF_LINES).map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview
            <code key={i} className="drive-pv__line" data-line={l.kind}>
              {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : l.kind === "same" ? "  " : ""}
              {l.text}
            </code>
          ))}
        </div>
      );
    }
    case "diagram":
      return size === "sm" ? (
        <span className="drive-pv__glyph drive-pv__glyph--diagram" />
      ) : (
        <div className="drive-pv__diagram">
          <MermaidDiagram
            source={content.mermaid}
            label={t("artifacts.diagramLabel", { title: artifact.title })}
            compact
          />
        </div>
      );
    case "html":
    case "block":
    case "poll":
    case "choices":
      return (
        <div className="drive-pv__sheet drive-pv__browser">
          <span className="drive-pv__bar">
            <i />
            <i />
            <i />
          </span>
          <span className="drive-pv__hero">{artifact.title}</span>
          <span className="drive-pv__blocks">
            <i />
            <i />
            <i />
          </span>
        </div>
      );
    case "file":
      return <FilePreview content={content} artifact={artifact} />;
  }
}

function FilePreview({ content, artifact }: { content: ArtifactFileContent; artifact: Artifact }) {
  const { t } = useTranslation();
  const kind = previewKind(content.contentType);
  const image = kind === "image" && content.size <= MAX_THUMB_BYTES;
  const { url, failed } = usePreviewUrl(artifact.id, artifact.version, content.contentType, image);
  const ext = extensionOf(content.name) || t("drive.fileBadge");
  if (image && !failed) return url ? <img src={url} alt="" /> : null;
  if (kind === "pdf" || content.text !== undefined) {
    const lines =
      content.text
        ?.split("\n")
        .filter((l) => l.trim())
        .slice(0, DOC_LINES) ?? [];
    return (
      <>
        <div className="drive-pv__sheet drive-pv__paper">
          {lines.length > 0
            ? lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                <span key={i} className="drive-pv__p">
                  {l}
                </span>
              ))
            : [64, 38, 96, 90, 94, 70, 92, 60].map((w, i) => (
                <i
                  key={w}
                  className={i === 0 ? "drive-pv__ln drive-pv__ln--h" : "drive-pv__ln"}
                  style={{ width: `${w}%` }}
                />
              ))}
        </div>
        <span className="drive-pv__tag">{ext}</span>
      </>
    );
  }
  return (
    <span className="drive-pv__glyph">
      <span className="drive-pv__ext">{ext}</span>
    </span>
  );
}
