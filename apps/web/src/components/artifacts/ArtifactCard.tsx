import type { Artifact, ArtifactContent, ArtifactFileContent, ArtifactRef } from "@agenteschat/client";
import { useArtifact } from "@agenteschat/client";
import { documentStart, KIND_ICON, parseDelimited, patchCounts } from "@agenteschat/client/lib/artifacts";
import { fileIcon, formatBytes, previewKind, previewKindOfName } from "@agenteschat/client/lib/files";
import { Button, Icon, type IconName, Menu, Tip } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChoicesCard } from "@/components/blocks/ChoicesCard";
import { LiveBlockCard } from "@/components/blocks/LiveBlock";
import { PollCard } from "@/components/blocks/PollCard";
import { MenuEntries } from "@/components/DesktopMenus";
import { useOrg } from "@/components/org-context";
import { contextMenuHandler, type MenuEntry } from "@/lib/context-menu";
import { Markdown } from "@/lib/markdown";
import { useArtifactDownload, useDeleteArtifact } from "./ArtifactActions";
import { useArtifactViewer } from "./ArtifactViewer";
import { FileVideo, MAX_THUMB_BYTES, usePreviewUrl } from "./FileView";
import { HtmlFrame } from "./HtmlFrame";
import { MermaidDiagram } from "./Mermaid";
import { useFileShare } from "./ShareDialog";

/** What a cover shows of a table, a code change or a text file: the rest is in the viewer. */
const COVER_ROWS = 5;
const COVER_COLUMNS = 3;
const COVER_FILES = 4;
const COVER_LINES = 12;
/** The start of a document drawn on its cover (cut at a line, never mid-word). */
const COVER_CHARS = 1200;

/**
 * An attachment on a message as a tile of one size, so several sit side by side: what it holds drawn small on top
 * (its cover: the start of a document, a table's first rows, a change's files, a diagram, a page) and its name with
 * its kind and size under it. A click opens the viewer; Download and More show over the cover on hover, and the
 * desktop app's right click has the same actions. A picture is only the picture, as is a video its player: their name
 * and size are in their tip and in the viewer's header. A picture alone on its message shows whole inside its tile
 * (CSS: `.artifact-cards > :only-child`). Every tile has its size before what it holds loads (`LoadingTile`).
 */
export function ArtifactCard({ artifact: ref }: { artifact: ArtifactRef }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const download = useArtifactDownload();
  const share = useFileShare();
  const remove = useDeleteArtifact();
  const query = useArtifact(org.id, ref.deleted ? null : ref.id, ref.version);
  const a = query.data;
  // Deleted (to the trash): a quiet placeholder, never a broken card.
  if (ref.deleted) {
    return (
      <div className="artifact-card artifact-card--removed" role="note">
        <Icon name="trash" size={16} />
        <span className="small muted">{t("artifacts.removedFile")}</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="artifact-card artifact-card--missing">
        <span className="small muted">{t("artifacts.notFound")}</span>
      </div>
    );
  }
  if (!a) return <LoadingTile title={ref.title} />;
  // What lives in the conversation isn't a file: the thing itself, not a tile that opens it (ADR 0113).
  if (a.kind === "block") return <LiveBlockCard id={a.id} version={a.shownVersion} />;
  if (a.kind === "poll") return <PollCard id={a.id} version={a.shownVersion} />;
  if (a.kind === "choices") return <ChoicesCard id={a.id} version={a.shownVersion} />;
  const open = () => viewer.open(a.id, a.shownVersion < a.version ? a.shownVersion : undefined);
  const save = () => void download.save(a, undefined, a.shownVersion, a.content);
  // Open, download, Compartilhar, its link (through the share dialog while only its conversation sees it), and the
  // trash for who may delete it: the right click and the More menu.
  const actions = (): MenuEntry[] => [
    { kind: "item", id: "open", label: t("contextMenu.open"), icon: "eye", run: open },
    { kind: "item", id: "download", label: t("contextMenu.download"), icon: "download", run: save },
    ...(a.inDrive !== false
      ? ([
          { kind: "item", id: "share", label: t("share.button"), icon: "personAdd", run: () => share.open(a) },
        ] as const)
      : []),
    {
      kind: "item",
      id: "copy-link",
      label: t("contextMenu.copyLink"),
      icon: "link",
      run: () => share.copyLink(a, a.shownVersion < a.version ? a.shownVersion : undefined),
    },
    ...(a.canDelete
      ? ([
          { kind: "separator" },
          {
            kind: "item",
            id: "delete",
            label: t("artifacts.delete"),
            icon: "trash",
            danger: true,
            run: () => remove.ask(a),
          },
        ] as const)
      : []),
  ];
  const tile = (props: Pick<TileProps, "icon" | "meta" | "cover" | "media">) => (
    <>
      <Tile artifact={a} actions={actions} onOpen={open} onDownload={save} {...props} />
      {remove.dialog}
      {share.dialog}
    </>
  );
  const content = a.content;
  if (content.kind !== "file")
    return tile({
      icon: KIND_ICON[a.kind],
      meta: metaOf(t, content, a.shownVersion),
      cover: <Cover content={content} title={a.title} />,
    });
  const meta = fileMeta(content, formatBytes(i18n.language, content.size));
  const icon = fileIcon(content.name, content.contentType);
  const kind = previewKind(content.contentType);
  if (kind === "video")
    return (
      <>
        <FileVideo
          content={content}
          artifactId={a.id}
          version={a.shownVersion}
          onOpen={open}
          tip={`${a.title} · ${meta}`}
          actions={<TileActions title={a.title} actions={actions} onDownload={save} />}
          // A video this browser can't play is a file's tile.
          fallback={
            <Tile
              artifact={a}
              actions={actions}
              onOpen={open}
              onDownload={save}
              icon={icon}
              meta={meta}
              cover={<TypeCover content={content} />}
            />
          }
        />
        {remove.dialog}
        {share.dialog}
      </>
    );
  if (kind === "image" && content.size <= MAX_THUMB_BYTES)
    return tile({
      media: true,
      icon: "image",
      meta,
      cover: <PictureCover content={content} artifactId={a.id} version={a.shownVersion} title={a.title} />,
    });
  return tile({ icon, meta, cover: <FileCover content={content} /> });
}

/**
 * A tile before its file's details arrive, in the box it keeps once they do, so the rows around it never move: a
 * picture or a video by its name ("tela.png"), as the phone reads it; anything else a cover over its name, which wraps
 * as it will.
 */
function LoadingTile({ title = "" }: { title?: string }) {
  const kind = previewKindOfName(title);
  if (kind === "video")
    return (
      <div className="artifact-tile artifact-tile--loading" data-kind="video" aria-busy="true">
        <span className="ac-video ac-video--tile">
          <span className="ac-video__media" />
        </span>
      </div>
    );
  return (
    <div className="artifact-tile artifact-tile--loading" data-media={kind === "image" || undefined} aria-busy="true">
      <div className="artifact-tile__cover" />
      {kind !== "image" && (
        <div className="artifact-tile__foot ac-iconline" aria-hidden="true">
          <Icon name={fileIcon(title)} size={16} />
          <span className="artifact-tile__name">
            <span className="artifact-tile__title">{title || "\u00a0"}</span>
            <span className="artifact-tile__meta">{"\u00a0"}</span>
          </span>
        </div>
      )}
    </div>
  );
}

const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";

/** "PDF · 1,2 MB": the file's extension stands for its kind (no word to translate), then its size. */
function fileMeta(content: ArtifactFileContent, size: string) {
  const ext = extOf(content.name).toUpperCase();
  return ext ? `${ext} · ${size}` : size;
}

/** Under a tile's name: its kind and how big it is ("Tabela · 15 linhas", "5 arquivos · +58 −31", "Documento · v2"). */
function metaOf(t: TFunction, content: ArtifactContent, version: number) {
  const kind = t(`artifacts.kind.${content.kind}`);
  switch (content.kind) {
    case "table":
      return `${kind} · ${t("artifacts.rows", { count: content.rows.length })}`;
    case "diff": {
      const total = { added: 0, removed: 0 };
      for (const f of content.files) {
        const c = patchCounts(f.patch);
        total.added += c.added;
        total.removed += c.removed;
      }
      return `${t("artifacts.files", { count: content.files.length })} · ${t("artifacts.counts", total)}`;
    }
    default:
      return `${kind} · ${t("artifacts.version", { version })}`;
  }
}

interface TileProps {
  artifact: Artifact;
  icon: IconName;
  meta: string;
  cover: ReactNode;
  /** A picture: only the picture, its name and size in its tip; alone on its message it shows whole. */
  media?: boolean;
  actions: () => MenuEntry[];
  onOpen: () => void;
  onDownload: () => void;
}

function Tile({ artifact: a, icon, meta, cover, media, actions, onOpen, onDownload }: TileProps) {
  const { t } = useTranslation();
  const sizeId = useId();
  // The whole tile opens the viewer; the actions sit above it.
  const open = (
    <button
      type="button"
      className="artifact-tile__open"
      aria-label={t("artifacts.open", { title: a.title })}
      aria-describedby={media ? sizeId : undefined}
      onClick={onOpen}
    />
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right click only; the open button inside is the accessible way
    <div
      className="artifact-tile"
      data-kind={a.kind}
      data-media={media || undefined}
      onContextMenu={contextMenuHandler(() => [{ kind: "header", label: a.title }, ...actions()])}
    >
      {media ? (
        <Tip className="artifact-tile__tip" tip={`${a.title} · ${meta}`} look="ac-msg__tip">
          {open}
          <span id={sizeId} hidden>
            {meta}
          </span>
        </Tip>
      ) : (
        open
      )}
      <div className="artifact-tile__cover">{cover}</div>
      {!media && (
        <div className="artifact-tile__foot ac-iconline" aria-hidden="true">
          <Icon name={icon} size={16} />
          <span className="artifact-tile__name">
            <span className="artifact-tile__title">{a.title}</span>
            <span className="artifact-tile__meta tabular">{meta}</span>
          </span>
        </div>
      )}
      <span className="artifact-tile__acts">
        <TileActions title={a.title} actions={actions} onDownload={onDownload} />
      </span>
    </div>
  );
}

/** Download, then More (the right click's other actions), as small ghost buttons. */
function TileActions({
  title,
  actions,
  onDownload,
}: {
  title: string;
  actions: () => MenuEntry[];
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const label = t("artifacts.more", { title });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="download"
        aria-label={t("artifacts.download")}
        title={t("artifacts.download")}
        onClick={onDownload}
      />
      <Menu
        align="end"
        label={label}
        trigger={
          <Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} title={t("artifacts.moreShort")} />
        }
      >
        <MenuEntries entries={actions().filter((e) => !(e.kind === "item" && e.id === "download"))} />
      </Menu>
    </>
  );
}

/** A document, table, code change, diagram or page, drawn small. */
function Cover({ content, title }: { content: ArtifactContent; title: string }) {
  const { t } = useTranslation();
  switch (content.kind) {
    case "document":
      // Its own headings, paragraphs and lists, smaller, fading at the foot; a first heading equal to the title isn't
      // drawn again.
      return (
        <Markdown
          source={documentStart(content.markdown, COVER_CHARS)}
          title={title}
          excerpt
          className="artifact-tile__doc"
        />
      );
    case "table":
      return <CoverTable columns={content.columns} rows={content.rows} />;
    case "diff":
      return (
        <ul className="artifact-tile__files">
          {content.files.slice(0, COVER_FILES).map((f) => {
            const c = patchCounts(f.patch);
            return (
              <li key={f.path}>
                <code>
                  {f.path.includes("/") && (
                    <span className="artifact-tile__dir">{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span>
                  )}
                  <span>{f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
                </code>
                <span className="artifact-tile__added tabular">+{c.added}</span>
                <span className="artifact-tile__removed tabular">−{c.removed}</span>
              </li>
            );
          })}
        </ul>
      );
    case "diagram":
      return <MermaidDiagram source={content.mermaid} label={t("artifacts.diagramLabel", { title })} compact />;
    case "html":
      return (
        <PageThumbnail
          html={content.html}
          label={t("artifacts.htmlPreview")}
          title={t("artifacts.htmlFrame", { title })}
        />
      );
    default:
      return null;
  }
}

/** A signed percentage ("+12%", "−3%"): its cell takes the up or down tone. */
const SIGNED = /^([+\-−])\s?\d[\d.,]*\s?%$/;
/** A column of numbers, amounts or percentages lines up on the right. */
const NUMBER = /^[+\-−]?\s?(?:[A-Z]{0,3}\$|€|£)?\s?\d[\d.,\s]*%?$/;

function CoverTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const cols = columns.slice(0, COVER_COLUMNS);
  const shown = rows.slice(0, COVER_ROWS);
  const numeric = cols.map((_, j) => {
    const cells = shown.map((r) => (r[j] ?? "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((c) => NUMBER.test(c));
  });
  return (
    <table className="artifact-tile__table">
      <thead>
        <tr>
          {cols.map((c, j) => (
            <th key={c} className={numeric[j] ? "is-num" : undefined}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          // A static drawing of a few rows: the row's own text is its key.
          <tr key={r.join("\u001f")}>
            {cols.map((_, j) => {
              const cell = (r[j] ?? "").trim();
              const sign = SIGNED.exec(cell)?.[1];
              const tone = sign ? (sign === "+" ? "is-up" : "is-down") : "";
              return (
                <td key={cols[j]} className={[numeric[j] ? "is-num" : "", tone].filter(Boolean).join(" ") || undefined}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A picture's cover: its box is the tile's from the first paint, the picture comes into it. */
function PictureCover({
  content,
  artifactId,
  version,
  title,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
}) {
  const { t } = useTranslation();
  const { url, failed } = usePreviewUrl(artifactId, version, content.contentType, true);
  if (failed) return <TypeCover content={content} />;
  return (
    <span className="artifact-tile__picture">{url && <img src={url} alt={t("files.imageAlt", { title })} />}</span>
  );
}

/** Code files read in the code font; any other text in the app's. */
const CODE_EXT = new Set(
  "ts tsx js jsx mjs cjs json py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh yml yaml toml sql css scss html xml vue svelte lua dart".split(
    " ",
  ),
);

/** An uploaded file's cover: a CSV as its table, a small text file as its first lines, anything else its type. */
function FileCover({ content }: { content: ArtifactFileContent }) {
  const ext = extOf(content.name);
  const text = content.text;
  if (text === undefined || !text.trim()) return <TypeCover content={content} />;
  if (ext === "csv" || ext === "tsv") {
    const [head = [], ...rows] = parseDelimited(text, ext === "tsv" ? "\t" : ",", COVER_ROWS + 1);
    return <CoverTable columns={head} rows={rows} />;
  }
  if (ext === "md" || ext === "markdown")
    return <Markdown source={documentStart(text, COVER_CHARS)} excerpt className="artifact-tile__doc" />;
  const lines = text.split("\n").slice(0, COVER_LINES).join("\n");
  return CODE_EXT.has(ext) ? (
    <pre className="artifact-tile__code">
      <code>{lines}</code>
    </pre>
  ) : (
    <p className="artifact-tile__text">{lines}</p>
  );
}

/** No preview: the type's icon and its extension, quiet in the middle. */
function TypeCover({ content }: { content: ArtifactFileContent }) {
  const ext = extOf(content.name).toUpperCase();
  return (
    <span className="artifact-tile__type">
      <Icon name={fileIcon(content.name, content.contentType)} size={20} />
      {ext && <span>{ext}</span>}
    </span>
  );
}

/** The page drawn at `PAGE_WIDTH` and scaled to the tile's width. */
const PAGE_WIDTH = 1000;
function PageThumbnail({ html, label, title }: { html: string; label: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const measure = () => {
      if (el.clientWidth > 0) setScale(el.clientWidth / PAGE_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      className="artifact-tile__page"
      role="img"
      aria-label={label}
      style={{ "--page-scale": scale } as CSSProperties}
    >
      <HtmlFrame html={html} title={title} className="artifact-tile__page-frame" thumbnail />
    </div>
  );
}
