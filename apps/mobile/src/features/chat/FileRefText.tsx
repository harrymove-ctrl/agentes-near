import { useArtifact } from "@agenteschat/client";
import { type FileLink, filePath } from "@agenteschat/client/lib/message-links";
import type { Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { Icon } from "@/ui";
import { router } from "@/ui/navigation";
import { appLinkFromUrl } from "../links/app-links";
import { useColors } from "../shared/hooks";

/**
 * A file's pill in a message, wherever it came from (a file's link, `FileRefText`; an id, `IdRefText`), as the web's
 * `FilePill`: the file's name that opens it in the app. Another workspace's file goes through `/link`, which switches
 * to it first.
 */
export function FilePillText({
  orgId,
  id,
  title,
  version,
}: {
  orgId: string;
  id: string;
  title: string;
  version?: number | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const here = useOrg().orgId;
  const open = () => {
    if (orgId === here) {
      router.push({ pathname: "/file/[id]", params: { id, ...(version ? { v: String(version) } : {}) } });
      return;
    }
    const other = appLinkFromUrl(`${serverUrl().replace(/\/+$/, "")}${filePath(orgId, id, version)}`);
    if (other && "href" in other) router.push(other.href as Href);
  };
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("share.fileRef", { title })}
      onPress={open}
      style={[styles.ref, { backgroundColor: c.sunken, color: c.ink }]}
    >
      <Icon name="file" size={14} color={c.ink} /> {title}
    </RNText>
  );
}

/**
 * A file's link in a message (the web's `FileRef`: the app's address, or the API's address of its bytes), as its
 * `FilePillText`. One the reader can't open, deleted or out of reach, is the same plain "Arquivo sem acesso".
 */
export function FileRefText({ link }: { link: FileLink }) {
  const { t } = useTranslation();
  const c = useColors();
  const query = useArtifact(link.orgId, link.artifactId, link.version ?? undefined);
  if (query.isPending) {
    return (
      <RNText accessibilityLabel={t("share.fileRefNone")} style={[styles.ref, { backgroundColor: c.sunken }]}>
        <Icon name="file" size={14} color={c.ink} />
      </RNText>
    );
  }
  const a = query.data;
  if (!a) {
    return (
      <RNText style={[styles.ref, { backgroundColor: c.sunken, color: c.muted }]}>{t("share.fileRefNone")}</RNText>
    );
  }
  return <FilePillText orgId={link.orgId} id={a.id} title={a.title} version={link.version} />;
}

const styles = StyleSheet.create({
  ref: { fontWeight: "600", borderRadius: 4 },
});
