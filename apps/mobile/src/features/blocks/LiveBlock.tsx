import { type BlockChange, useArtifact, useBlockReply, useKeepBlock, useSharedBlock } from "@agenteschat/client";
import { type BlockEvent, blockEvent, blockPage, DRAFT_SETTLE_MS } from "@agenteschat/client/lib/blocks";
import { clockHour } from "@agenteschat/client/lib/format";
import { chartRamp } from "@agenteschat/ui/sky/chart";
import { randomUUID } from "expo-crypto";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { Button, IconButton, Sky, Text, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader, tapHaptic } from "../shared/parts";
import { blockMayLoad, hostScript, INLINE_HEIGHT, themeScript, withLiveBlock } from "./logic";
import { SpecBlock } from "./SpecBlock";

const SYSTEM_FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text",Roboto,system-ui,sans-serif';

interface Kept {
  height?: number;
  open?: boolean;
  sent?: { text: string; at: string };
  /** The person asked this page to run (ADR 0113): it doesn't by itself. */
  run?: boolean;
}

/** What a running page is told: everyone's state, without what this person is still changing. */
type ForPage = { state: Record<string, unknown>; who: Record<string, BlockChange> };

/**
 * What stays when a frame goes away (scrolled out, opened on its screen). Its state is everyone's and lives on the
 * server (`useSharedBlock`); this is only how tall it was, whether it was shown whole and what this person sent from it.
 */
const kept = new Map<string, Kept>();
const keptOf = (key: string): Kept => {
  const found = kept.get(key);
  if (found) return found;
  const fresh: Kept = {};
  kept.set(key, fresh);
  return fresh;
};

/** Which frames may run now (`withLiveBlock`). */
let live: string[] = [];
const listeners = new Set<() => void>();
const liveStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  claim(key: string) {
    live = withLiveBlock(live, key);
    for (const fn of listeners) fn();
  },
  release(key: string) {
    live = live.filter((k) => k !== key);
    for (const fn of listeners) fn();
  },
};

/**
 * The block's page in a web view: no cookies, no storage, no files, no windows, no way off the page, and it scrolls
 * with the conversation instead of holding on to the finger (on Android a web view set to scroll never gives a drag
 * back to the list). As tall as its page (the card cuts it). Off the list, on its own screen, it scrolls by itself.
 */
function BlockWebView({
  blockKey,
  html,
  color,
  scrolls,
  shared,
  rev,
  onEvent,
}: {
  blockKey: string;
  html: string;
  color: Parameters<typeof chartRamp>[0];
  scrolls: boolean;
  /** Everyone's state; the page starts from it and is told each time it moves (`rev`). */
  shared: ForPage | null;
  rev: number;
  onEvent: (e: BlockEvent) => void;
}) {
  const { t, i18n } = useTranslation();
  const { scheme } = useTheme();
  const web = useRef<WebView<object>>(null);
  const [life, setLife] = useState(0);
  const [height, setHeight] = useState(keptOf(blockKey).height ?? 0);
  // Until the page says it started, a spinner over it: a blank box reads as broken.
  const [ready, setReady] = useState(false);
  const c = useColors();
  const theme = scheme === "dark" ? "dark" : "light";
  const sharedRef = useRef(shared);
  sharedRef.current = shared;

  // Built once per block: a new theme is sent to it, and a rebuild would lose what the person set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above; `life`: a page the system ended comes back
  const page = useMemo(
    () =>
      blockPage(html, {
        theme,
        ramp: chartRamp(color),
        locale: i18n.language,
        labels: {
          send: t("mobile.blocks.send"),
          more: t("mobile.blocks.more"),
          thousand: t("mobile.blocks.thousand"),
        },
        state: sharedRef.current?.state,
        who: sharedRef.current?.who,
        font: SYSTEM_FONT,
      }),
    [html, blockKey, life],
  );

  useEffect(() => {
    web.current?.injectJavaScript(themeScript(theme));
  }, [theme]);

  // Someone changed the block: everyone's page shows it at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rev` is when it moved; the values come from the ref
  useEffect(() => {
    if (sharedRef.current) web.current?.injectJavaScript(hostScript(sharedRef.current));
  }, [rev]);

  const restart = () => {
    setReady(false);
    setLife((n) => n + 1);
  };
  return (
    <View style={scrolls ? styles.fill : undefined}>
      <WebView
        key={life}
        ref={web}
        source={{ html: page }}
        // Every address passes this list and is refused below: one that failed here would go to the system to open.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(request) => blockMayLoad(request.url)}
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        domStorageEnabled={false}
        incognito
        cacheEnabled={false}
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        geolocationEnabled={false}
        mediaCapturePermissionGrantType="deny"
        mediaPlaybackRequiresUserAction
        scrollEnabled={scrolls}
        nestedScrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={[styles.web, !scrolls && { height: height || INLINE_HEIGHT }]}
        onMessage={(e) => {
          const event = blockEvent(e.nativeEvent.data);
          if (!event) return;
          if (event.type === "height") {
            keptOf(blockKey).height = event.height;
            setHeight(event.height);
          }
          if (event.type === "ready") {
            setReady(true);
            // What moved while it was starting.
            if (sharedRef.current) web.current?.injectJavaScript(hostScript(sharedRef.current));
          }
          onEvent(event);
        }}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
      {ready ? null : (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.asleep]}>
          <ActivityIndicator color={c.faint} />
        </View>
      )}
    </View>
  );
}

/**
 * A block that is the agent's own page (what no part of ours shows): it runs only when the person asks. Then the frame
 * and, outside it, what would go back to the agent and the button that sends it: the page only proposes.
 */
export function LiveBlock({
  id,
  version,
  html,
  agentId,
  screen = false,
}: {
  id: string;
  version: number;
  html: string;
  agentId: string;
  screen?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const blockKey = `${id}@${version}`;
  const allowed = useSyncExternalStore(
    liveStore.subscribe,
    () => live.includes(blockKey),
    () => false,
  );
  const reply = useBlockReply(orgId, id);
  const shared = useSharedBlock(orgId, id, version);
  const { fromPage, draw } = shared;
  const [draft, setDraft] = useState<Extract<BlockEvent, { type: "draft" }> | null>(null);
  const [sent, setSent] = useState(keptOf(blockKey).sent ?? null);
  const [height, setHeight] = useState(keptOf(blockKey).height ?? 0);
  const [open, setOpen] = useState(keptOf(blockKey).open ?? false);
  const [run, setRun] = useState(screen || (keptOf(blockKey).run ?? false));
  const changedAt = useRef(0);
  // Taller than the card: cut with a fade, "Show all" under it.
  const tall = !screen && height > INLINE_HEIGHT;
  const toggleOpen = () => {
    tapHaptic();
    keptOf(blockKey).open = !open;
    setOpen(!open);
  };

  useEffect(() => {
    if (screen || !run) return;
    liveStore.claim(blockKey);
    return () => liveStore.release(blockKey);
  }, [screen, run, blockKey]);

  const onEvent = useCallback(
    (e: BlockEvent) => {
      if (e.type === "height") setHeight(e.height);
      if (e.type === "state") fromPage(e.state, e.used);
      if (e.type === "draw") void draw(e.name, e.options);
      if (e.type !== "draft") return;
      setDraft((old) => {
        if (old?.text !== e.text) changedAt.current = Date.now();
        return e;
      });
    },
    [fromPage, draw],
  );

  const send = () => {
    if (!draft?.ready || reply.isPending) return;
    // A page can't swap the words under a tap: a text that just changed needs a moment on screen.
    if (Date.now() - changedAt.current < DRAFT_SETTLE_MS) return;
    tapHaptic();
    const text = draft.text;
    reply.mutate(
      { text, clientId: randomUUID() },
      {
        onSuccess: () => {
          const done = { text, at: new Date().toISOString() };
          keptOf(blockKey).sent = done;
          setSent(done);
        },
        onError: () => toast({ title: t("mobile.blocks.sendFailed"), icon: "x" }),
      },
    );
  };

  if (!run) {
    return (
      <View style={styles.gate}>
        <Text variant="subhead" style={styles.bold}>
          {t("mobile.blocks.pageTitle")}
        </Text>
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.pageBody")}
        </Text>
        <Button
          variant="secondary"
          wide
          label={t("mobile.blocks.runPage")}
          onPress={() => {
            tapHaptic();
            keptOf(blockKey).run = true;
            setRun(true);
          }}
        />
      </View>
    );
  }

  const same = sent !== null && sent.text === draft?.text;
  const time = sent
    ? new Intl.DateTimeFormat(i18n.language, { hour: clockHour(i18n.language), minute: "2-digit" }).format(
        new Date(sent.at),
      )
    : "";
  return (
    <View style={screen ? styles.fill : undefined}>
      <View style={screen ? styles.fill : [styles.view, { height: tall && open ? height : INLINE_HEIGHT }]}>
        {(screen || allowed) && !shared.loaded ? (
          // Everyone's state first: a page that started from its own would show something else for a moment.
          <View style={[styles.asleep, styles.fill]}>
            <ActivityIndicator color={c.faint} />
          </View>
        ) : screen || allowed ? (
          <BlockWebView
            blockKey={blockKey}
            html={html}
            color={agentLook(agent).color}
            scrolls={screen}
            shared={shared.forPage}
            rev={shared.block?.rev ?? 0}
            onEvent={onEvent}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => liveStore.claim(blockKey)}
            style={[styles.asleep, styles.fill]}
          >
            <Text variant="footnote" tone="muted">
              {t("mobile.blocks.wake")}
            </Text>
          </Pressable>
        )}
        {tall && !open ? (
          <LinearGradient pointerEvents="none" colors={[`${c.raised}00`, c.raised]} style={styles.fade} />
        ) : null}
      </View>
      {tall ? (
        <View style={styles.more}>
          <Button
            variant="ghost"
            size="sm"
            icon={open ? undefined : "down"}
            label={open ? t("blocks.showLess") : t("blocks.showAll")}
            onPress={toggleOpen}
          />
        </View>
      ) : null}
      {same ? (
        <View style={[styles.foot, { borderTopColor: c.line2 }]}>
          <View style={styles.sent}>
            <View style={[styles.mark, { backgroundColor: c.ok }]} />
            <Text variant="footnote" tone="muted">
              {t("mobile.blocks.sentAt", { time })}
            </Text>
          </View>
        </View>
      ) : draft ? (
        <View style={[styles.foot, { borderTopColor: c.line2 }]}>
          <Text variant="footnote" tone="muted">
            {draft.ready ? `${t("mobile.blocks.goesTo", { name: agent?.name ?? "" })} ${draft.text}` : draft.hint}
          </Text>
          <Button
            variant="primary"
            wide
            label={draft.label}
            disabled={!draft.ready}
            loading={reply.isPending}
            onPress={send}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A block on its message: the agent's card, its title, and the block itself. */
export function LiveBlockCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const query = useArtifact(orgId, id, version);
  const a = query.data;
  if (a?.content.kind !== "block") {
    return (
      <View style={[styles.card, styles.loading, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <ActivityIndicator color={c.faint} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.building")}
        </Text>
      </View>
    );
  }
  const agentId = a.createdBy.id;
  const open = () => {
    tapHaptic();
    router.push({ pathname: "/block/[id]", params: { id: a.id, v: String(a.shownVersion) } });
  };
  return (
    <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <Sky
        color={agentLook(dir.agentById.get(agentId)).color}
        surface="raised"
        depth={0.95}
        fade={0}
        style={styles.sky}
      />
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text variant="subhead" style={styles.bold} numberOfLines={2}>
            {a.title}
          </Text>
          {a.content.subtitle ? (
            <Text variant="footnote" tone="faint" numberOfLines={1}>
              {a.content.subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.headButton}>
          <IconButton icon="expand" label={t("mobile.blocks.openBig")} onPress={open} />
        </View>
      </View>
      {a.content.spec ? (
        <SpecBlock id={a.id} version={a.shownVersion} spec={a.content.spec} agentId={agentId} />
      ) : (
        <LiveBlock id={a.id} version={a.shownVersion} html={a.content.html ?? ""} agentId={agentId} />
      )}
    </View>
  );
}

/** A block on a screen of its own, all of it: pushed from the message, with the native way back. */
export function BlockScreen({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const query = useArtifact(orgId, id, version);
  const keep = useKeepBlock(orgId, id);
  const a = query.data;
  if (a?.content.kind !== "block") {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: c.bg }]}>
        {query.isError ? (
          <Text variant="body" tone="muted">
            {t("mobile.files.loadFailed")}
          </Text>
        ) : (
          <ActivityIndicator color={c.faint} />
        )}
      </View>
    );
  }
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader title={a.title} />
      {a.content.spec ? (
        <ScrollView style={styles.fill} contentContainerStyle={styles.screenBody}>
          <SpecBlock id={a.id} version={a.shownVersion} spec={a.content.spec} agentId={a.createdBy.id} screen />
        </ScrollView>
      ) : (
        <LiveBlock id={a.id} version={a.shownVersion} html={a.content.html ?? ""} agentId={a.createdBy.id} screen />
      )}
      {a.inDrive ? null : (
        <View style={styles.keep}>
          <Button
            variant="secondary"
            wide
            icon="drive"
            label={t("mobile.blocks.keep")}
            loading={keep.isPending}
            onPress={() =>
              keep.mutate(undefined, {
                onSuccess: () => toast({ title: t("mobile.blocks.kept"), icon: "check" }),
                onError: () => toast({ title: t("mobile.blocks.sendFailed"), icon: "x" }),
              })
            }
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // As wide as the message, under what comes before it (the files' cards keep the same gap).
  card: {
    alignSelf: "stretch",
    marginTop: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 4, paddingLeft: 14, paddingRight: 4, paddingTop: 12 },
  titles: { flex: 1, minWidth: 0 },
  // The 40-point button centred on the title's first line: its top sat level with the text, its middle a line lower.
  headButton: { marginTop: -10 },
  bold: { fontWeight: "600" },
  web: { backgroundColor: "transparent" },
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  asleep: { alignItems: "center", justifyContent: "center" },
  view: { overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 56 },
  more: { alignItems: "center", paddingBottom: 8 },
  foot: { gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  sent: { flexDirection: "row", alignItems: "center", gap: 8 },
  mark: { width: 5, height: 5 },
  keep: { paddingHorizontal: 16, paddingVertical: 12 },
  gate: { gap: 8, padding: 14 },
  screenBody: { paddingVertical: 8 },
});
