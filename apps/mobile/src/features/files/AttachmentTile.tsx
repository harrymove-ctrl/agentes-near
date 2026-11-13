import type { ArtifactContent, ArtifactDetail } from "@agenteschat/client";
import { documentStart, parseDelimited, patchCounts } from "@agenteschat/client/lib/artifacts";
import { formatBytes } from "@agenteschat/client/lib/files";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import { Icon, type IconName, LineIcon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { MessageText } from "../chat/MessageText";
import { useColors, useOrgId } from "../shared/hooks";
import { MONO } from "../shared/parts";
import { encodeFileList, extensionOf, fileInfo } from "./logic";
import { useRemoteFile } from "./source";

/**
 * An attachment as a tile (as on the web): what it holds drawn small on top (its cover: a document's start, a table's
 * first rows, a change's files, a text file's first lines, else its type) and its name, whole, with its kind and size
 * under it. A picture is only the picture: its name and size are what a screen reader hears and what the picture
 * viewer's header says. A tap opens it: a picture in the picture viewer, the rest in the file screen.
 */

/** What a cover shows of a table, a code change or a text file: the rest is in the file screen. */
const COVER_ROWS = 4;
const COVER_COLUMNS = 3;
const COVER_FILES = 3;
const COVER_LINES = 10;
/** The start of a document drawn on its cover (cut at a line). */
const COVER_CHARS = 700;
/** Code files read in the code font; any other text in the app's. */
const CODE_EXT = new Set(
  "ts tsx js jsx mjs cjs json py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh yml yaml toml sql css scss html xml vue svelte lua dart".split(
    " ",
  ),
);
/** A signed percentage ("+12%", "−3%"): its cell takes the up or down tone. */
const SIGNED = /^([+\-−])\s?\d[\d.,]*\s?%$/;
/** A column of numbers, amounts or percentages lines up on the right. */
const NUMBER = /^[+\-−]?\s?(?:[A-Z]{0,3}\$|€|£)?\s?\d[\d.,\s]*%?$/;

const KIND_ICON: Record<Exclude<ArtifactContent["kind"], "file">, IconName> = {
  document: "doc",
  table: "list",
  diff: "code",
  diagram: "chart",
  html: "globe",
  block: "globe",
  poll: "check",
  choices: "check",
};

export interface TileFile {
  id: string;
  version?: number;
  title: string;
}

export function AttachmentTile({
  file,
  detail,
  failed = false,
  picture: seen = false,
  width,
  single = false,
}: {
  file: TileFile;
  detail: ArtifactDetail | undefined;
  failed?: boolean;
  /** Known to be a picture before it loads (by its name), so its tile never sheds a foot once it does. */
  picture?: boolean;
  width: number;
  /** Alone on its message: a taller cover. */
  single?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const info = detail ? fileInfo(detail) : null;
  const content = detail?.content;
  const name = detail?.kind === "file" ? info?.name || file.title : detail?.title || file.title;
  const picture = info ? info.view === "image" : seen;
  const meta = !detail
    ? failed
      ? t("mobile.files.loadFailed")
      : t("mobile.common.loading")
    : metaOf(t, detail, i18n.language || "en");
  const icon: IconName =
    !content || content.kind === "file" ? (picture ? "image" : fileIconOf(info?.type)) : KIND_ICON[content.kind];
  const open = () => {
    if (!detail) return;
    const older = detail.shownVersion < detail.version;
    if (picture)
      router.push({
        pathname: "/images",
        params: { files: encodeFileList([{ id: file.id, version: detail.shownVersion }]), at: "0" },
      });
    else
      router.push({
        pathname: "/file/[id]",
        params: { id: file.id, ...(older ? { v: String(detail.shownVersion) } : {}) },
      });
  };
  return (
    <Pressable
      onPress={open}
      disabled={!detail}
      accessibilityRole={picture ? "imagebutton" : "button"}
      accessibilityLabel={`${name}, ${meta}`}
      style={({ pressed }) => [
        styles.tile,
        { width, backgroundColor: c.raised, borderColor: picture ? c.line : c.line2 },
        pressed && styles.pressed,
      ]}
    >
      <View
        style={[
          styles.cover,
          !picture && styles.coverOverFoot,
          { height: single ? 150 : 104, borderBottomColor: c.line },
        ]}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        {!detail ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.sunken }]}>
            {failed ? <TypeCover icon="file" label={extensionOf(file.title).toUpperCase()} /> : null}
          </View>
        ) : (
          <Cover detail={detail} fileId={file.id} />
        )}
      </View>
      {picture ? null : (
        <View style={styles.foot}>
          <LineIcon name={icon} size={14} color={c.faint} variant="footnote" />
          <View style={styles.grow}>
            <Text variant="footnote" style={styles.title}>
              {name}
            </Text>
            <Text variant="caption" tone="faint">
              {meta}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

function fileIconOf(type: string | undefined): IconName {
  switch (type) {
    case "video":
      return "play";
    case "table":
      return "list";
    case "code":
    case "diff":
      return "code";
    case "archive":
      return "archive";
    case "text":
      return "text";
    case "pdf":
    case "document":
      return "doc";
    default:
      return "file";
  }
}

/** Under a tile's name: its kind and how big it is ("Tabela · 15 linhas", "2 arquivos · +58 −31", "PDF · 1,2 MB"). */
function metaOf(t: TFunction, detail: ArtifactDetail, locale: string) {
  const content = detail.content;
  if (content.kind === "file") {
    const ext = extensionOf(content.name || detail.title).toUpperCase();
    const size = formatBytes(locale, content.size);
    return ext ? `${ext} · ${size}` : size;
  }
  const kind = t(`artifacts.kind.${content.kind}`);
  if (content.kind === "table") return `${kind} · ${t("artifacts.rows", { count: content.rows.length })}`;
  if (content.kind === "diff") {
    const total = { added: 0, removed: 0 };
    for (const f of content.files) {
      const n = patchCounts(f.patch);
      total.added += n.added;
      total.removed += n.removed;
    }
    return `${t("artifacts.files", { count: content.files.length })} · ${t("artifacts.counts", total)}`;
  }
  return `${kind} · ${t("artifacts.version", { version: detail.shownVersion })}`;
}

function Cover({ detail, fileId }: { detail: ArtifactDetail; fileId: string }) {
  const content = detail.content;
  switch (content.kind) {
    case "document":
      return <TextCover markdown={documentStart(content.markdown, COVER_CHARS)} />;
    case "table":
      return <TableCover columns={content.columns} rows={content.rows} />;
    case "diff":
      return <FilesCover files={content.files} />;
    case "file": {
      const info = fileInfo(detail);
      if (info.view === "image") return <PictureCover fileId={fileId} version={detail.shownVersion} />;
      const ext = extensionOf(info.name);
      const text = content.text;
      if (text?.trim()) {
        if (ext === "csv" || ext === "tsv") {
          const [head = [], ...rows] = parseDelimited(text, ext === "tsv" ? "\t" : ",", COVER_ROWS + 1);
          return <TableCover columns={head} rows={rows} />;
        }
        if (info.view === "markdown") return <TextCover markdown={documentStart(text, COVER_CHARS)} />;
        return <LinesCover text={text} code={CODE_EXT.has(ext)} />;
      }
      return <TypeCover icon={fileIconOf(info.type)} label={ext.toUpperCase()} />;
    }
    default:
      // A diagram or a page draws only in the file screen (a web view): here its kind's icon.
      return <TypeCover icon={KIND_ICON[content.kind]} label="" />;
  }
}

/** Fades a cover's text out at its foot. */
function Fade() {
  const c = useColors();
  return <LinearGradient pointerEvents="none" colors={[`${c.raised}00`, c.raised]} style={styles.fade} />;
}

function TextCover({ markdown }: { markdown: string }) {
  return (
    <View style={styles.pad}>
      <MessageText body={markdown} small selectable={false} />
      <Fade />
    </View>
  );
}

function LinesCover({ text, code }: { text: string; code: boolean }) {
  const c = useColors();
  return (
    <View style={styles.pad}>
      <RNText style={[code ? styles.code : styles.lines, { color: c.ink2 }]}>
        {text.split("\n").slice(0, COVER_LINES).join("\n")}
      </RNText>
      <Fade />
    </View>
  );
}

function TableCover({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const c = useColors();
  const cols = columns.slice(0, COVER_COLUMNS);
  const shown = rows.slice(0, COVER_ROWS);
  const numeric = cols.map((_, j) => {
    const cells = shown.map((r) => (r[j] ?? "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((x) => NUMBER.test(x));
  });
  const line = (cells: string[], head: boolean, key: string) => (
    <View key={key} style={[styles.row, { borderBottomColor: c.line }]}>
      {cols.map((_, j) => {
        const cell = (cells[j] ?? "").trim();
        const sign = head ? undefined : SIGNED.exec(cell)?.[1];
        const color = head ? c.faint : sign ? (sign === "+" ? c.ok : c.danger) : c.ink2;
        return (
          <RNText
            // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing
            key={j}
            numberOfLines={1}
            style={[styles.cell, head && styles.head, numeric[j] && styles.num, { color }]}
          >
            {cell}
          </RNText>
        );
      })}
    </View>
  );
  return (
    <View>
      {line(cols, true, "head")}
      {shown.map((r, i) => line(r, false, `r${i}`))}
    </View>
  );
}

function FilesCover({ files }: { files: { path: string; patch: string }[] }) {
  const c = useColors();
  return (
    <View>
      {files.slice(0, COVER_FILES).map((f) => {
        const n = patchCounts(f.patch);
        return (
          <View key={f.path} style={[styles.row, styles.fileRow, { borderBottomColor: c.line }]}>
            <RNText numberOfLines={1} ellipsizeMode="head" style={[styles.path, { color: c.ink2 }]}>
              {f.path}
            </RNText>
            <RNText style={[styles.count, { color: c.ok }]}>+{n.added}</RNText>
            <RNText style={[styles.count, { color: c.danger }]}>−{n.removed}</RNText>
          </View>
        );
      })}
    </View>
  );
}

function PictureCover({ fileId, version }: { fileId: string; version: number }) {
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, fileId, version);
  const [failed, setFailed] = useState(false);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.sunken }]}>
      {link.data && !failed ? (
        <Image
          source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${fileId}@${version}` }}
          recyclingKey={`${fileId}@${version}`}
          contentFit="cover"
          transition={160}
          style={StyleSheet.absoluteFill}
          onError={() => setFailed(true)}
          accessible={false}
        />
      ) : null}
      {failed || link.isError ? <TypeCover icon="image" label="" /> : null}
    </View>
  );
}

/** No preview: the type's icon and its extension, quiet in the middle. */
function TypeCover({ icon, label }: { icon: IconName; label: string }) {
  const c = useColors();
  return (
    <View style={styles.type}>
      <Icon name={icon} size={26} color={c.faint} />
      {label ? <RNText style={[styles.typeLabel, { color: c.faint }]}>{label}</RNText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The shape of every attachment tile (as the web's): rounded, the bottom left corner cut, a hairline.
  tile: {
    overflow: "hidden",
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.85 },
  cover: { overflow: "hidden" },
  coverOverFoot: { borderBottomWidth: StyleSheet.hairlineWidth },
  // The icon on the name's first line, however many lines the name wraps to.
  foot: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600" },
  pad: { flex: 1, paddingHorizontal: 10, paddingTop: 8, overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 36 },
  lines: { fontSize: 12, lineHeight: 17 },
  code: { fontFamily: MONO, fontSize: 10.5, lineHeight: 15 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fileRow: { paddingVertical: 6 },
  cell: { flex: 1, fontSize: 11.5 },
  head: { fontWeight: "600" },
  num: { textAlign: "right", fontVariant: ["tabular-nums"] },
  path: { flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10.5 },
  count: { fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
  type: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  typeLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6 },
});
