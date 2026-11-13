import { type ArtifactDetail, useApi, useArtifact } from "@agenteschat/client";
import { formatJson, highlightCode } from "@agenteschat/client/lib/code";
import { isJsonFile } from "@agenteschat/client/lib/files";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, Text as RNText, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Button, CARD_PAD, IconButton, SCREEN_X, Text, ToastHost, useToast } from "@/ui";
import { CodeText, RawToggle } from "../chat/CodeCard";
import { MessageText } from "../chat/MessageText";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { copyText, goBack, MONO } from "../shared/parts";
import { useFileActions } from "./actions";
import { type FileInfo, fileInfo } from "./logic";
import { FileTile, useFileLine } from "./MessageFiles";
import { fileText, useRemoteFile } from "./source";
import { VideoPlayer } from "./VideoPlayer";

/**
 * A file opened from a message: Markdown and text drawn by the
 * app, PDF in a web view (iOS draws PDFs natively there), a video in our player, anything else as its card. Top: close,
 * Copiar texto and the "…", then the name and "Documento · 4 KB · Theo" on a row of their own. Bottom: Enviar and
 * Compartilhar; Ver no Drive in the "…".
 */
export function DocumentViewer({ id, version }: { id: string; version?: number }) {
  return (
    <ToastHost>
      <Viewer id={id} {...(version !== undefined ? { version } : {})} />
    </ToastHost>
  );
}

function Viewer({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const line = useFileLine();
  const query = useArtifact(orgId, id, version);
  const detail = query.data;
  const actions = useFileActions(detail);
  const toast = useToast();
  const info = detail ? fileInfo(detail) : null;
  const textual = info?.view === "markdown" || info?.view === "text";
  // The page's own text, read once for the page and for Copiar texto.
  const text = useFileText(detail, textual);
  const close = () => goBack();
  const copy = () => {
    if (text.data === undefined) return;
    void copyText(text.data).then((ok) =>
      toast(ok ? { title: t("contextMenu.textCopied"), icon: "copy" } : { title: t("mobile.app.failed"), icon: "x" }),
    );
  };
  // A PDF is drawn in the web view on iOS only (Android's WebView has no PDF viewer).
  const pdf = info?.view === "pdf" && Platform.OS === "ios";

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={close} />
        <View style={styles.spacer} />
        {textual ? (
          <IconButton
            icon="copy"
            plate
            label={t("contextMenu.copyText")}
            onPress={copy}
            disabled={text.data === undefined}
          />
        ) : null}
        <IconButton
          icon="more"
          plate
          label={t("mobile.files.more")}
          onPress={() => actions.more(false)}
          disabled={!detail}
        />
      </View>
      {/* The name and its line under the buttons, the screen's whole width: never cut to one line beside them. */}
      <View style={styles.heading}>
        <Text variant="body" style={styles.bold} numberOfLines={3}>
          {info?.name ?? ""}
        </Text>
        <Text variant="footnote" tone="faint">
          {info && detail ? line(info, [dir.nameOf(detail.createdBy)]) : ""}
        </Text>
      </View>

      <View style={styles.body}>
        {query.isError ? (
          <Center>
            <Text variant="body" tone="muted">
              {t("mobile.files.loadFailed")}
            </Text>
          </Center>
        ) : !detail || !info ? (
          <Center>
            <ActivityIndicator color={c.faint} />
          </Center>
        ) : info.view === "markdown" || info.view === "text" ? (
          <TextPage detail={detail} markdown={info.view === "markdown"} json={isJsonFile(info.name, info.mime)} />
        ) : pdf ? (
          <PdfPage detail={detail} />
        ) : info.view === "video" ? (
          <VideoPage detail={detail} info={info} />
        ) : info.view === "image" ? (
          <ImagePage detail={detail} info={info} />
        ) : (
          <BigCard info={info} />
        )}
      </View>

      <View style={[styles.bar, { paddingBottom: insets.bottom + 12, borderTopColor: c.line2, backgroundColor: c.bg }]}>
        <View style={styles.half}>
          <Button
            variant="secondary"
            wide
            icon="share"
            label={t("mobile.files.send")}
            disabled={!detail || actions.busy !== null}
            onPress={actions.share}
          />
        </View>
        {detail?.inDrive !== false ? (
          <View style={styles.half}>
            <Button
              variant="primary"
              wide
              icon="person"
              label={t("share.button")}
              disabled={!detail}
              onPress={actions.shareSheet}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

/** A Markdown or text file's text, loaded once per version. */
function useFileText(detail: ArtifactDetail | undefined, enabled: boolean) {
  const api = useApi();
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["org", orgId, "artifacts", "text", detail?.id, detail?.shownVersion] as const,
    queryFn: () => fileText(api, orgId, detail as ArtifactDetail),
    enabled: enabled && detail !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Markdown with the messages' renderer, plain text in mono, on a raised page. JSON formatted and colored as a code
 * block reads it, the text as written one press away ("Original").
 */
function TextPage({ detail, markdown, json }: { detail: ArtifactDetail; markdown: boolean; json: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const text = useFileText(detail, true);
  const formatted = useMemo(() => (json && text.data !== undefined ? formatJson(text.data) : null), [json, text.data]);
  const [raw, setRaw] = useState(false);
  return (
    <View style={[styles.page, { backgroundColor: c.raised }]}>
      {text.data !== undefined ? (
        <ScrollView contentContainerStyle={styles.pageInner}>
          {markdown ? (
            <MessageText body={text.data} />
          ) : formatted !== null ? (
            <View style={styles.json}>
              {formatted !== text.data.trim() ? <RawToggle on={raw} onPress={() => setRaw((r) => !r)} /> : null}
              <CodeText lines={highlightCode(raw ? text.data : formatted, "json")} wrap />
            </View>
          ) : (
            <RNText selectable style={[styles.mono, { color: c.ink2 }]}>
              {text.data}
            </RNText>
          )}
        </ScrollView>
      ) : text.isError ? (
        <Center>
          <Text variant="body" tone="muted">
            {t("mobile.files.loadFailed")}
          </Text>
        </Center>
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

/** A PDF from its short-lived link (with the session when the link is ours). */
function PdfPage({ detail }: { detail: ArtifactDetail }) {
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, detail.id, detail.shownVersion);
  return (
    <View style={[styles.page, styles.clip, { backgroundColor: c.raised }]}>
      {link.data ? (
        <WebView
          source={{ uri: link.data.uri, headers: link.data.headers }}
          originWhitelist={["https://*", "http://*"]}
          javaScriptEnabled={false}
          startInLoadingState
          renderLoading={() => (
            <Center>
              <ActivityIndicator color={c.faint} />
            </Center>
          )}
          style={styles.web}
        />
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

/** A video, filling the screen between the top and the bar; one this phone can't play shows its card. */
/** A picture, whole on the page (the picture viewer, with its zoom, opens from the chat and the Drive's cards). */
function ImagePage({ detail, info }: { detail: ArtifactDetail; info: FileInfo }) {
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, detail.id, detail.shownVersion);
  const [failed, setFailed] = useState(false);
  if (failed || link.isError) return <BigCard info={info} />;
  return (
    <View style={[styles.page, styles.clip, styles.picture, { backgroundColor: c.sunken }]}>
      {link.data ? (
        <Image
          source={{ uri: link.data.uri, headers: link.data.headers, cacheKey: `${detail.id}@${detail.shownVersion}` }}
          contentFit="contain"
          transition={160}
          style={StyleSheet.absoluteFill}
          onError={() => setFailed(true)}
          accessibilityLabel={info.name}
        />
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

function VideoPage({ detail, info }: { detail: ArtifactDetail; info: FileInfo }) {
  const orgId = useOrgId();
  const c = useColors();
  const link = useRemoteFile(orgId, detail.id, detail.shownVersion);
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => (link.data ? { uri: link.data.uri, ...(link.data.headers ? { headers: link.data.headers } : {}) } : null),
    [link.data],
  );
  if (failed || link.isError) return <BigCard info={info} />;
  return (
    <View style={[styles.page, styles.clip, styles.video]}>
      {source ? (
        <VideoPlayer
          key={source.uri}
          variant="screen"
          source={source}
          name={info.name}
          onFailed={() => setFailed(true)}
        />
      ) : (
        <Center>
          <ActivityIndicator color={c.faint} />
        </Center>
      )}
    </View>
  );
}

/** A type the app doesn't draw: its card, big, and Compartilhar opens it elsewhere. */
function BigCard({ info }: { info: FileInfo }) {
  const { t } = useTranslation();
  const line = useFileLine();
  return (
    <Center>
      <FileTile ext={info.ext} size="lg" />
      <Text variant="title" style={styles.bigName} numberOfLines={3}>
        {info.name}
      </Text>
      <Text variant="footnote" tone="faint">
        {line(info)}
      </Text>
      <Text variant="small" tone="muted" style={styles.note}>
        {t("mobile.files.noPreview")}
      </Text>
    </Center>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingBottom: 10 },
  spacer: { flex: 1 },
  heading: { gap: 2, paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  bold: { fontWeight: "600" },
  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 6 },
  page: { flex: 1, marginTop: 4, marginHorizontal: 16, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  clip: { overflow: "hidden" },
  pageInner: { paddingHorizontal: CARD_PAD, paddingTop: CARD_PAD, paddingBottom: 32 },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  json: { gap: 10, alignItems: "flex-start" },
  web: { flex: 1, backgroundColor: "transparent" },
  video: { backgroundColor: "#000", borderBottomLeftRadius: 14, borderBottomRightRadius: 14, marginBottom: 12 },
  picture: { borderBottomLeftRadius: 14, borderBottomRightRadius: 14, marginBottom: 12 },
  bigName: { marginTop: 14, textAlign: "center" },
  note: { marginTop: 10, textAlign: "center" },
  bar: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  half: { flex: 1 },
});
