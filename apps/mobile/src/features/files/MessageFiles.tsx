import type { ArtifactDetail } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { keepWhole } from "@agenteschat/client/lib/format";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { ChoicesCard } from "../blocks/ChoicesCard";
import { LiveBlockCard } from "../blocks/LiveBlock";
import { PollCard } from "../blocks/PollCard";
import { useColors, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { AttachmentTile } from "./AttachmentTile";
import { ImageStack } from "./ImageStack";
import {
  encodeFileList,
  extensionOf,
  type FileInfo,
  fileInfo,
  IMAGE_EXT,
  singleImageHeight,
  VIDEO_EXT,
  videoHeight,
} from "./logic";
import { useArtifacts, useRemoteFile } from "./source";
import { VideoPlayer } from "./VideoPlayer";

/**
 * A message's files. Pictures alone: one inline, whole in a box of one shape, or several as a deck to swipe through
 * (`ImageStack`), tapping opens the viewer at that picture. Any other attachment: a tile across the row
 * (`AttachmentTile`: what it holds drawn small, its name, whole, with its kind and size under it), with the pictures
 * beside them as tiles of only the picture, two to a row (as on the web's phone width). A video plays right there (its
 * corner button opens the file screen). `align="end"`: the viewer's own message, its files sit on the right.
 */

export interface MessageFile {
  id: string;
  version?: number;
  title: string;
  deleted: boolean;
}

/** Widest a picture block gets in a message. */
const MAX_WIDTH = 300;
/** Between two tiles in a row. */
const GAP = 8;

export function MessageFiles({ files, align = "start" }: { files: MessageFile[]; align?: "start" | "end" }) {
  const orgId = useOrgId();
  const live = files.filter((f) => !f.deleted);
  const queries = useArtifacts(
    orgId,
    live.map((f) => (f.version !== undefined ? { id: f.id, version: f.version } : { id: f.id })),
  );
  const [width, setWidth] = useState(0);

  const images: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  // What lives in the conversation isn't a file: the thing itself (ADR 0113).
  const blocks: ArtifactDetail[] = [];
  const videos: { file: MessageFile; detail: ArtifactDetail | undefined }[] = [];
  const others: { file: MessageFile; detail: ArtifactDetail | undefined; failed: boolean }[] = [];
  live.forEach((file, i) => {
    const q = queries[i];
    const detail = q?.data;
    if (detail?.kind === "block" || detail?.kind === "poll" || detail?.kind === "choices") {
      blocks.push(detail);
      return;
    }
    // Until it loads, a name like "print.png" already says it's a picture (no jump into the grid).
    const isImage = detail ? fileInfo(detail).view === "image" : !q?.isError && IMAGE_EXT.has(extensionOf(file.title));
    const isVideo = detail ? fileInfo(detail).view === "video" : !q?.isError && VIDEO_EXT.has(extensionOf(file.title));
    if (isImage) images.push({ file, detail });
    else if (isVideo) videos.push({ file, detail });
    else others.push({ file, detail, failed: Boolean(q?.isError) });
  });
  const removed = files.filter((f) => f.deleted);
  const blockWidth = Math.min(width || MAX_WIDTH, MAX_WIDTH);
  // Beside other attachments, pictures are tiles too: one grid, never a deck next to a file.
  const tiles =
    others.length > 0
      ? [
          ...images.map((i) => ({ ...i, failed: false, picture: true })),
          ...others.map((o) => ({ ...o, picture: false })),
        ]
      : [];
  const pictures = tiles.length > 0 ? [] : images;
  // A file's name wraps whole, which half a row would take a word a line: a file takes the row, pictures two to a row.
  const halfWidth = Math.floor((blockWidth - GAP) / 2);

  const [only] = pictures;
  // Opening a file or a picture is plain navigation: the press shows it, with no haptic.
  const openOnly = () => {
    if (!only) return;
    router.push({
      pathname: "/images",
      params: {
        files: encodeFileList([{ id: only.file.id, version: only.detail?.shownVersion ?? only.file.version }]),
        at: "0",
      },
    });
  };

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[styles.wrap, align === "end" && styles.end]}>
      {pictures.length > 1 ? <ImageStack images={pictures} width={blockWidth} /> : null}
      {only && pictures.length === 1 ? (
        <View style={{ width: blockWidth }}>
          <InlineImage
            file={only.file}
            detail={only.detail}
            width={blockWidth}
            label={only.detail?.title || only.file.title}
            onPress={openOnly}
          />
        </View>
      ) : null}
      {videos.map(({ file, detail }) => (
        <InlineVideo key={file.id} file={file} detail={detail} width={blockWidth} />
      ))}
      {blocks.map((b) =>
        b.kind === "poll" ? (
          <PollCard key={b.id} id={b.id} version={b.shownVersion} />
        ) : b.kind === "choices" ? (
          <ChoicesCard key={b.id} id={b.id} version={b.shownVersion} />
        ) : (
          <LiveBlockCard key={b.id} id={b.id} version={b.shownVersion} />
        ),
      )}
      {tiles.length > 0 ? (
        <View style={[styles.grid, { width: blockWidth }, align === "end" && styles.gridEnd]}>
          {tiles.map(({ file, detail, failed, picture }) => (
            <AttachmentTile
              key={file.id}
              file={file}
              detail={detail}
              failed={failed}
              picture={picture}
              width={picture ? halfWidth : blockWidth}
              single={tiles.length === 1}
            />
          ))}
        </View>
      ) : null}
      {removed.map((file) => (
        <RemovedCard key={file.id} />
      ))}
    </View>
  );
}

function InlineImage({
  file,
  detail,
  width,
  label,
  onPress,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  width: number;
  label: string;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const version = detail?.shownVersion ?? file.version;
  const link = useRemoteFile(orgId, file.id, version);
  const [failed, setFailed] = useState(false);
  const height = singleImageHeight(width);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={label || t("mobile.files.openImage")}
      accessibilityHint={t("mobile.files.openImage")}
      style={({ pressed }) => [
        styles.shot,
        { width, height, backgroundColor: c.sunken, borderColor: c.line2 },
        pressed && styles.pressed,
      ]}
    >
      {link.data && !failed ? (
        <Image
          source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${file.id}@${version ?? "latest"}` }}
          recyclingKey={`${file.id}@${version ?? "latest"}`}
          contentFit="contain"
          transition={160}
          style={StyleSheet.absoluteFill}
          onError={() => setFailed(true)}
          accessible={false}
        />
      ) : null}
      {failed || link.isError ? (
        <View style={styles.center}>
          <Icon name="image" size={22} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A video on a message: it plays in place; one this phone can't play becomes the file's card. */
function InlineVideo({
  file,
  detail,
  width,
}: {
  file: MessageFile;
  detail: ArtifactDetail | undefined;
  width: number;
}) {
  const orgId = useOrgId();
  const c = useColors();
  const version = detail?.shownVersion ?? file.version;
  const link = useRemoteFile(orgId, file.id, version);
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => (link.data ? { uri: link.data.uri, ...(link.data.headers ? { headers: link.data.headers } : {}) } : null),
    [link.data],
  );
  if (failed || link.isError) return <AttachmentTile file={file} detail={detail} width={width} single />;
  const info = detail ? fileInfo(detail) : null;
  const open = () => {
    if (!detail) return;
    router.push({
      pathname: "/file/[id]",
      params: { id: file.id, ...(detail.shownVersion < detail.version ? { v: String(detail.shownVersion) } : {}) },
    });
  };
  return (
    <View>
      {source ? (
        <VideoPlayer
          key={source.uri}
          source={source}
          name={info?.name || file.title}
          width={width}
          onOpen={detail ? open : undefined}
          onFailed={() => setFailed(true)}
        />
      ) : (
        <View
          style={[styles.shot, { width, height: videoHeight(width), backgroundColor: c.sunken, borderColor: c.line2 }]}
        />
      )}
    </View>
  );
}

/** The type and size line: "Documento · 4 KB". */
export function useFileLine() {
  const { t, i18n } = useTranslation();
  // Each fact whole: a narrow line breaks between them, never inside "4 KB" or a name.
  return (info: FileInfo, extra: string[] = []) =>
    [
      t(`mobile.files.type.${info.type}`),
      ...(info.size !== null ? [formatBytes(i18n.language || "en", info.size)] : []),
      ...extra.filter(Boolean),
    ]
      .map(keepWhole)
      .join(" · ");
}

/** The file type's tile: the extension in capitals on a folded page (or the file icon without one). */
export function FileTile({ ext, size = "md" }: { ext: string; size?: "md" | "lg" }) {
  const c = useColors();
  const lg = size === "lg";
  return (
    <View
      style={[styles.tile, lg && styles.tileLg, { backgroundColor: c.sunken }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.fold, lg && styles.foldLg, { backgroundColor: c.line2, borderColor: c.bg }]} />
      {ext ? (
        <Text variant="caption" tone="muted" style={[styles.ext, lg && styles.extLg]} numberOfLines={1}>
          {ext}
        </Text>
      ) : (
        <Icon name="file" size={lg ? 30 : 19} color={c.muted} />
      )}
    </View>
  );
}

function RemovedCard() {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name="file" size={20} color={c.faint} />
      </View>
      <Text variant="body" tone="faint" style={styles.grow}>
        {t("mobile.chat.fileDeleted")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  gridEnd: { justifyContent: "flex-end" },
  end: { alignItems: "flex-end" },
  shot: { borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.85 },
  card: {
    maxWidth: MAX_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    // As the pictures' beside it.
    borderRadius: 14,
  },
  tile: { width: 40, height: 48, borderRadius: 8, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tileLg: { width: 84, height: 100, borderRadius: 14 },
  fold: {
    position: "absolute",
    top: -1,
    right: -1,
    width: 13,
    height: 13,
    borderBottomLeftRadius: 3,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
  },
  foldLg: { width: 24, height: 24, borderBottomLeftRadius: 5 },
  ext: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  extLg: { fontSize: 17, letterSpacing: 0.6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
