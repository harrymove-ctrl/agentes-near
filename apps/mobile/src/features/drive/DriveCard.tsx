import { type Artifact, useArtifact } from "@agenteschat/client";
import { Image } from "expo-image";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet, View } from "react-native";
import { CHROME_MAX_SCALE, Icon, type IconName, PressScale, systemText, Text, useTheme, weights } from "@/ui";
import { router } from "@/ui/navigation";
import { encodeFileList } from "../files/logic";
import { useRemoteFile } from "../files/source";
import { Face } from "../shared/Face";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { MONO, tapHaptic, useSurface } from "../shared/parts";
import { type CardPreview, cardPreview, cardShape, kindKey } from "./logic";

const KIND_ICON: Record<ReturnType<typeof kindKey>, IconName> = {
  document: "doc",
  table: "list",
  diff: "code",
  image: "image",
  file: "file",
};

/** Opens an item: pictures in the picture viewer, the rest in the document viewer. */
export function openDriveItem(a: Pick<Artifact, "id" | "kind" | "title" | "version">) {
  tapHaptic();
  if (cardShape(a) === "image")
    router.push({
      pathname: "/images",
      params: { files: encodeFileList([{ id: a.id, version: a.version }]), at: "0" },
    });
  else router.push({ pathname: "/file/[id]", params: { id: a.id } });
}

/**
 * A Drive card: the real preview at the item's version (a document's
 * first lines under its title, a table's first rows, a diff's first changed lines, the picture itself, a
 * file's type tile) with the kind on a small chip, then the name and who made it, when.
 */
export const DriveCard = memo(function DriveCard({
  artifact: a,
  highlighted = false,
}: {
  artifact: Artifact;
  highlighted?: boolean;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const surface = useSurface();
  const dir = useDirectory();
  const when = useWhen();
  const kind = kindKey(a);
  const author = dir.nameOf(a.createdBy);
  return (
    // The card gives under the finger (the open's own tap is its haptic).
    <PressScale
      to={0.97}
      haptic={false}
      fill={false}
      onPress={() => openDriveItem(a)}
      accessibilityRole="button"
      accessibilityLabel={[a.title, t(`mobile.drive.kind.${kind}`), author, when.short(a.updatedAt)]
        .filter(Boolean)
        .join(", ")}
      style={styles.card}
    >
      <View style={[styles.preview, surface, highlighted && { borderWidth: 2, borderColor: c.ink }]}>
        <Preview artifact={a} />
        <View style={[styles.kind, { backgroundColor: c.raised }]}>
          <Icon name={KIND_ICON[kind]} size={11} color={c.ink2} />
          <RNText maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[styles.kindText, { color: c.ink2 }]}>
            {t(`mobile.drive.kind.${kind}`)}
          </RNText>
        </View>
      </View>
      <Text variant="subhead" numberOfLines={1} style={styles.name}>
        {a.title}
      </Text>
      <View style={styles.by}>
        <Face who={a.createdBy} size={16} live={false} />
        <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.grow}>
          {author ? t("mobile.drive.by", { name: author, when: when.short(a.updatedAt) }) : when.short(a.updatedAt)}
        </Text>
      </View>
    </PressScale>
  );
});

function Preview({ artifact: a }: { artifact: Artifact }) {
  const orgId = useOrgId();
  const image = cardShape(a) === "image";
  // At its exact version: never stale, and shared with the viewer.
  const detail = useArtifact(orgId, image ? null : a.id, a.version);
  if (image) return <ImagePreview artifact={a} />;
  const content = detail.data?.content;
  if (!content) return <Placeholder />;
  const p = cardPreview(a.title, content);
  if (p.kind === "image") return <ImagePreview artifact={a} />;
  return <ContentPreview preview={p} />;
}

function ImagePreview({ artifact: a }: { artifact: Artifact }) {
  const { colors: c } = useTheme();
  const link = useRemoteFile(useOrgId(), a.id, a.version);
  if (!link.data) return <View style={[StyleSheet.absoluteFill, { backgroundColor: c.sunken }]} />;
  return (
    <Image
      source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${a.id}@${a.version}` }}
      recyclingKey={`${a.id}@${a.version}`}
      contentFit="cover"
      transition={160}
      style={StyleSheet.absoluteFill}
      accessible={false}
    />
  );
}

/** Before the content arrives: neutral lines. */
function Placeholder() {
  const { colors: c } = useTheme();
  return (
    <View style={styles.pad}>
      {[90, 75, 82].map((w) => (
        <View key={w} style={[styles.line, { width: `${w}%`, backgroundColor: c.sunken }]} />
      ))}
    </View>
  );
}

function ContentPreview({ preview: p }: { preview: Exclude<CardPreview, { kind: "image" }> }) {
  const { colors: c, fonts } = useTheme();
  switch (p.kind) {
    case "document":
      return (
        <View style={styles.pad}>
          <RNText
            numberOfLines={2}
            maxFontSizeMultiplier={1}
            style={[styles.docHead, { fontFamily: fonts.display, color: c.ink }]}
          >
            {p.head}
          </RNText>
          {p.lines.map((l, i) => (
            <RNText
              // biome-ignore lint/suspicious/noArrayIndexKey: a static preview
              key={i}
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={[styles.docLine, { color: c.muted }]}
            >
              {l}
            </RNText>
          ))}
        </View>
      );
    case "table": {
      const cols = Math.max(1, p.columns.length);
      const cell = (text: string, head: boolean, key: string) => (
        <View
          key={key}
          style={[
            styles.cell,
            { width: `${100 / cols}%`, borderColor: c.line2 },
            head && { backgroundColor: c.sunken },
          ]}
        >
          <RNText
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            style={[styles.cellText, { color: head ? c.ink2 : c.muted }, head && styles.bold]}
          >
            {text}
          </RNText>
        </View>
      );
      return (
        <View style={styles.table}>
          {p.columns.map((h, j) => cell(h, true, `h${j}`))}
          {p.rows.flatMap((r, i) => r.map((v, j) => cell(v, false, `${i}:${j}`)))}
        </View>
      );
    }
    case "diff":
      return (
        <View style={styles.pad}>
          {p.lines.map((l, i) => (
            <RNText
              // biome-ignore lint/suspicious/noArrayIndexKey: a static preview
              key={i}
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={[
                styles.code,
                { fontFamily: MONO, color: l.kind === "add" ? c.ok : l.kind === "del" ? c.danger : c.faint },
              ]}
            >
              {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
              {l.text}
            </RNText>
          ))}
        </View>
      );
    case "file":
      return (
        <View style={styles.fileWrap}>
          <View style={[styles.fileTile, { backgroundColor: c.sunken }]}>
            <RNText maxFontSizeMultiplier={1} style={[styles.fileExt, { color: c.muted }]}>
              {p.ext}
            </RNText>
          </View>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 0 },
  preview: { aspectRatio: 4 / 3, borderRadius: 14, overflow: "hidden" },
  pad: { padding: 12, gap: 4 },
  line: { height: 5, borderRadius: 2, marginBottom: 2 },
  docHead: { fontSize: 15, lineHeight: 17, fontWeight: "300", marginBottom: 4 },
  docLine: { fontSize: 10, lineHeight: 13 },
  table: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  cellText: { fontSize: 9 },
  bold: { fontWeight: "700" },
  code: { fontSize: 9.5, lineHeight: 14 },
  fileWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 16 },
  fileTile: { width: 52, height: 62, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  fileExt: { ...systemText("caption", weights.bold) },
  kind: {
    position: "absolute",
    left: 8,
    bottom: 8,
    height: 20,
    paddingHorizontal: 8,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    opacity: 0.94,
  },
  kindText: { fontSize: 11, fontWeight: "700" },
  name: { fontWeight: "600", marginTop: 8 },
  by: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  grow: { flex: 1, minWidth: 0 },
});
