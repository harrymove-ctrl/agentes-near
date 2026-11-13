import type { ArtifactContent, ArtifactDiffFile } from "@agenteschat/client";
import { parsePatch, patchCounts, sideBySide, sortRows } from "@agenteschat/client/lib/artifacts";
import { Button, Icon, Input, Segmented } from "@agenteschat/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoicesCard } from "@/components/blocks/ChoicesCard";
import { LiveBlock } from "@/components/blocks/LiveBlock";
import { PollCard } from "@/components/blocks/PollCard";
import { SpecBlock } from "@/components/blocks/SpecBlock";
import { Markdown } from "@/lib/markdown";
import { FileSummary, FileView } from "./FileView";
import { HtmlFrame } from "./HtmlFrame";
import { MermaidOrCode } from "./Mermaid";

/** Read-only view of one artifact version, per kind. `source`: which artifact and version (uploaded files load from it). */
export function ArtifactContentView({
  content,
  title,
  source,
  onSwipe,
}: {
  content: ArtifactContent;
  title: string;
  source?: { id: string; version: number; agentId?: string };
  /** A picture: a finger's sideways swipe moves to the next or previous one. */
  onSwipe?: ((dir: 1 | -1) => void) | undefined;
}) {
  const { t } = useTranslation();
  switch (content.kind) {
    case "document":
      return <Markdown source={content.markdown} />;
    case "table":
      return <TableView columns={content.columns} rows={content.rows} />;
    case "diff":
      return <DiffView files={content.files} />;
    case "diagram":
      // Same card as a ```mermaid fence in Markdown: drawn by itself where the frame runs apart from the page, code with
      // "Show diagram" (and Copy) where it shares the thread, so opening a big diagram can't freeze the tab there.
      return <MermaidOrCode text={content.mermaid} />;
    case "html":
      return (
        <div className="stack-4" style={{ gap: 8, height: "100%" }}>
          <p className="small muted">{t("artifacts.htmlNote")}</p>
          <HtmlFrame html={content.html} title={t("artifacts.htmlFrame", { title })} />
        </div>
      );
    case "block":
      if (!source) return null;
      return content.spec ? (
        <SpecBlock id={source.id} version={source.version} spec={content.spec} agentId={source.agentId ?? ""} big />
      ) : (
        <LiveBlock
          id={source.id}
          version={source.version}
          title={title}
          html={content.html ?? ""}
          agentId={source.agentId ?? ""}
          big
        />
      );
    case "poll":
      return source ? <PollCard id={source.id} version={source.version} /> : null;
    case "choices":
      return source ? <ChoicesCard id={source.id} version={source.version} /> : null;
    case "file":
      return source ? (
        <FileView content={content} artifactId={source.id} version={source.version} title={title} onSwipe={onSwipe} />
      ) : (
        <FileSummary content={content} />
      );
  }
}

export function TableView({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const { t, i18n } = useTranslation();
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const shown = useMemo(
    () => (sort ? sortRows(rows, sort.col, sort.dir, i18n.language) : rows),
    [rows, sort, i18n.language],
  );
  return (
    <div className="artifact-table">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => {
              const active = sort?.col === i;
              return (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns can repeat; position is the identity
                  key={i}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="artifact-table__sort"
                    aria-label={t("artifacts.sortBy", { column: c })}
                    onClick={() =>
                      setSort((s) =>
                        s?.col === i ? { col: i, dir: s.dir === "asc" ? "desc" : "asc" } : { col: i, dir: "asc" },
                      )
                    }
                  >
                    <span>{c}</span>
                    {active && (
                      <Icon
                        name="chevronDown"
                        size={16}
                        style={sort.dir === "asc" ? { transform: "rotate(180deg)" } : undefined}
                      />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
            <tr key={i}>
              {columns.map((_, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells by column
                <td key={j}>{r[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DiffView({ files }: { files: ArtifactDiffFile[] }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  return (
    <div className="stack-4" style={{ gap: 16 }}>
      {/* One view of the diff at a time: the app's switch for that. */}
      <Segmented
        size="sm"
        className="artifact-diff__mode"
        label={t("artifacts.diffView")}
        value={mode}
        onValueChange={setMode}
        options={(["unified", "split"] as const).map((m) => ({ value: m, label: t(`artifacts.${m}`) }))}
      />
      {files.map((f) => (
        <FileDiff key={f.path} file={f} mode={mode} />
      ))}
    </div>
  );
}

function FileDiff({ file, mode }: { file: ArtifactDiffFile; mode: "unified" | "split" }) {
  const { t } = useTranslation();
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const counts = patchCounts(file.patch);
  const hidden = (kind: string) =>
    kind === "add" || kind === "del" ? (
      <span className="ac-visually-hidden">{kind === "add" ? t("artifacts.added") : t("artifacts.removed")}</span>
    ) : null;
  return (
    <section className="artifact-file" aria-label={t("artifacts.fileDiff", { path: file.path })}>
      <header className="artifact-file__head">
        <code>{file.path}</code>
        <span className="small muted tabular" title={t("artifacts.countsLabel", counts)}>
          {t("artifacts.counts", counts)}
        </span>
      </header>
      {mode === "unified" ? (
        <div className="ac-diff ac-diff--code" data-mode="unified">
          {lines.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity
              key={i}
              className={`ac-diff__line${l.kind === "same" ? "" : l.kind === "hunk" ? " ac-diff__line--gap" : ` ac-diff__line--${l.kind}`}`}
            >
              <span className="artifact-ln" aria-hidden="true">
                {l.old ?? ""}
              </span>
              <span className="artifact-ln" aria-hidden="true">
                {l.new ?? ""}
              </span>
              <span className="ac-diff__mark" aria-hidden="true">
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
              </span>
              <span className="ac-diff__text">
                {hidden(l.kind)}
                {l.text}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="ac-diff ac-diff--code artifact-split" data-mode="split">
          {sideBySide(lines).map((row, i) =>
            row.hunk !== undefined ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity
              <div key={i} className="ac-diff__line ac-diff__line--gap artifact-split__hunk">
                <span className="ac-diff__text">{row.hunk}</span>
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity
              <div key={i} className="artifact-split__row">
                {[row.left, row.right].map((cell, side) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: two fixed sides
                    key={side}
                    className={`ac-diff__line${!cell ? " artifact-split__empty" : cell.kind === "same" ? "" : ` ac-diff__line--${cell.kind}`}`}
                  >
                    <span className="artifact-ln" aria-hidden="true">
                      {cell?.n ?? ""}
                    </span>
                    <span className="ac-diff__mark" aria-hidden="true">
                      {cell?.kind === "add" ? "+" : cell?.kind === "del" ? "−" : ""}
                    </span>
                    <span className="ac-diff__text">
                      {cell && hidden(cell.kind)}
                      {cell?.text}
                    </span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** Editable table (new version on save). */
export function TableEditor({
  columns,
  rows,
  onChange,
}: {
  columns: string[];
  rows: string[][];
  onChange: (rows: string[][]) => void;
}) {
  const { t } = useTranslation();
  const setCell = (r: number, c: number, v: string) =>
    onChange(rows.map((row, i) => (i === r ? columns.map((_, j) => (j === c ? v : (row[j] ?? ""))) : row)));
  return (
    <div className="stack-4" style={{ gap: 8 }}>
      <div className="artifact-table artifact-table--edit">
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                <th key={i} scope="col">
                  {c}
                </th>
              ))}
              <td />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
              <tr key={i}>
                {columns.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells by column
                  <td key={j}>
                    <Input
                      value={r[j] ?? ""}
                      aria-label={t("artifacts.cell", { column: c, n: i + 1 })}
                      onChange={(e) => setCell(i, j, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="close"
                    aria-label={t("artifacts.removeRow", { n: i + 1 })}
                    onClick={() => onChange(rows.filter((_, x) => x !== i))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <Button size="sm" icon="plus" onClick={() => onChange([...rows, columns.map(() => "")])}>
          {t("artifacts.addRow")}
        </Button>
      </div>
    </div>
  );
}
