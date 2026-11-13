import type { ReactNode } from "react";
import { type DiffLine, diffBlocks } from "../diff";

export { type DiffBlock, type DiffKind, type DiffLine, diffBlocks, diffLines } from "../diff";

/**
 * Before and after, as GitHub shows a change: added lines on green with a green bar, removed ones on red, struck
 * through. `prose`: words in Markdown (an agent's instructions, a context), each run of lines rendered as one block by
 * `render`, with no mark column, and long unchanged runs folded to the line beside each change (`folded` says how
 * many). Labels are for screen readers.
 */
export function Diff({
  lines,
  addedLabel,
  removedLabel,
  code,
  prose,
  "aria-label": ariaLabel,
}: {
  lines: DiffLine[];
  addedLabel: string;
  removedLabel: string;
  /** Real code: monospace, whitespace kept. */
  code?: boolean;
  prose?: { render: (text: string) => ReactNode; folded: (count: number) => string };
  "aria-label"?: string;
}) {
  const said = (kind: DiffLine["kind"]) =>
    kind !== "same" && <span className="ac-visually-hidden">{kind === "add" ? addedLabel : removedLabel}</span>;
  if (prose) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: a figure-like group of blocks
      <div className="ac-diff ac-diff--prose" role="group" aria-label={ariaLabel}>
        {diffBlocks(lines).map((b, i) =>
          b.kind === "fold" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks can repeat; order is the identity
            <div key={i} className="ac-diff__fold">
              {prose.folded(b.count)}
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks can repeat; order is the identity
            <div key={i} className={`ac-diff__block${b.kind === "same" ? "" : ` ac-diff__block--${b.kind}`}`}>
              {said(b.kind)}
              {prose.render(b.text)}
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a figure-like group of lines
    <div className={code ? "ac-diff ac-diff--code" : "ac-diff"} role="group" aria-label={ariaLabel}>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; order is the identity
        <div key={i} className={`ac-diff__line${l.kind === "same" ? "" : ` ac-diff__line--${l.kind}`}`}>
          <span className="ac-diff__mark" aria-hidden="true">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
          </span>
          <span className="ac-diff__text">
            {said(l.kind)}
            {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}
