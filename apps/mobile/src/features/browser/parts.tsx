import {
  ApiError,
  type BrowserFrame,
  type BrowserInputEvent,
  browserFrameDataUrl,
  createBrowserLiveConnection,
  createTouchInput,
  frameMetadata,
  inputProblem,
  keyEvents,
  PASTE_MAX_BYTES,
  pasteBytes,
  pasteEvents,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { openRefusalKey } from "@agenteschat/client/lib/sites";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, GestureStateManager, type TouchData, useManualGesture } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { fieldText, Icon, Locked, Text } from "@/ui";
import { useColors, useConnection } from "../shared/hooks";
import { tapHaptic, useSurface } from "../shared/parts";
import { keyPastDraft, LIVE_KEYS, type LiveKey, type PageGap, touchOnPage } from "./logic";

/** Why the page can't be shown: the server's reason, or the stream ended / not allowed. */
export type Unavailable = PageGap | null;

/**
 * The page as a picture. For the person in control, fingers on it are the page's mouse
 * (`createTouchInput`): a tap clicks, a finger that moves drags (a slider follows it), two fingers
 * scroll, with a line saying so while they move.
 */
export function FrameView({
  frame,
  enabled,
  onInput,
}: {
  frame: BrowserFrame;
  enabled: boolean;
  onInput: (events: BrowserInputEvent[]) => void;
}) {
  const { t } = useTranslation();
  const raised = useSurface("e2");
  const [view, setView] = useState({ width: 0, height: 0 });
  const [sliding, setSliding] = useState(false);
  const meta = useMemo(() => frameMetadata(frame), [frame]);
  const now = useRef({ meta, view, enabled, onInput });
  now.current = { meta, view, enabled, onInput };
  const [{ down, move, up, cancel }] = useState(() => {
    const fingers = createTouchInput((p, clamp) => touchOnPage(p, now.current.view, now.current.meta, clamp));
    const send = (events: BrowserInputEvent[]) => {
      if (events.length > 0 && now.current.enabled) now.current.onInput(events);
      setSliding(fingers.mode === "drag" || fingers.mode === "scroll");
    };
    return {
      down: (touches: TouchData[]) => {
        for (const p of touches) send(fingers.down(p.id, p));
      },
      move: (touches: TouchData[]) => {
        for (const p of touches) send(fingers.move(p.id, p));
      },
      up: (touches: TouchData[]) => {
        for (const p of touches) {
          const tap = fingers.mode === "pending";
          const events = fingers.up(p.id, p);
          if (tap && events.length > 0) tapHaptic();
          send(events);
        }
      },
      cancel: () => send(fingers.cancel()),
    };
  });
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);
  const gesture = useManualGesture({
    enabled,
    onTouchesDown: (e) => {
      "worklet";
      // Taken at once, on the UI thread: the conversation never scrolls under a finger on the page.
      GestureStateManager.activate(e.handlerTag);
      scheduleOnRN(down, e.changedTouches);
    },
    onTouchesMove: (e) => {
      "worklet";
      scheduleOnRN(move, e.changedTouches);
    },
    onTouchesUp: (e) => {
      "worklet";
      if (e.numberOfTouches === 0) GestureStateManager.deactivate(e.handlerTag);
      scheduleOnRN(up, e.changedTouches);
    },
    onTouchesCancel: () => {
      "worklet";
      scheduleOnRN(cancel);
    },
  });
  const onLayout = (e: LayoutChangeEvent) =>
    setView({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.frame} onLayout={onLayout} accessible accessibilityLabel={t("mobile.browser.live.page")}>
        <Image
          source={{ uri: browserFrameDataUrl(frame) ?? undefined }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          fadeDuration={0}
        />
        {sliding ? (
          <View pointerEvents="none" style={styles.hintRow}>
            <View style={[styles.hint, raised]}>
              <Text variant="caption" tone="ink2" numberOfLines={1} style={styles.semibold}>
                {t("browser.inCard.touchHint")}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

/** The keycaps (symbols; the key names are their labels), as on the web. */
const KEYCAP: Record<LiveKey, string> = { Tab: "⇥", Enter: "↵", Backspace: "⌫", Escape: "esc" };

/**
 * Typing into the page: one quiet field like the composer, whole text into
 * the page's focused field (tap it on the page first). The lock hides it and makes it a password field,
 * so the phone offers the saved passwords; the keyboard button shows the special keys; send is round.
 */
export function TypeBar({
  onText,
  onKey,
  autoFocus,
  secret: startSecret = false,
}: {
  onText: (text: string) => void;
  onKey: (key: LiveKey) => void;
  autoFocus?: boolean;
  /** Opens in its password mode. */
  secret?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(startSecret);
  const [keys, setKeys] = useState(false);
  // The draft as typed, read by a held Backspace's repeats before the state catches up.
  const draft = useRef("");
  const edit = (next: string) => {
    draft.current = next;
    setText(next);
  };
  const send = () => {
    if (!text) {
      // Return with nothing drafted: Enter in the field there (a form's submit, a new line).
      if (keyPastDraft(draft.current, "Enter")) onKey("Enter");
      return;
    }
    onText(text);
    edit("");
  };
  const key = (k: LiveKey) => {
    tapHaptic();
    onKey(k);
  };
  /** Colar: what the person copied, into the page's focused field as it is (the field's own paste waits for Send). */
  const paste = async () => {
    tapHaptic();
    const copied = await Clipboard.getStringAsync().catch(() => "");
    if (copied) onText(copied);
  };
  const tool = (on: boolean) => [styles.tool, { backgroundColor: on ? c.sunken : "transparent" }];
  return (
    <View style={styles.typeWrap}>
      {keys ? (
        <View style={styles.keys} accessibilityLabel={t("mobile.browser.live.keys")}>
          {LIVE_KEYS.map((k) => (
            <Pressable
              key={k}
              onPress={() => key(k)}
              accessibilityRole="button"
              accessibilityLabel={t(`mobile.browser.live.key.${k}`)}
              hitSlop={KEY_SLOP}
              style={({ pressed }) => [styles.keyCap, { backgroundColor: c.sunken }, pressed && styles.pressed]}
            >
              <Text variant="footnote" tone="ink2" style={styles.medium}>
                {KEYCAP[k]}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => void paste()}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.browser.live.pasteHint")}
            hitSlop={KEY_SLOP}
            style={({ pressed }) => [styles.keyCap, { backgroundColor: c.sunken }, pressed && styles.pressed]}
          >
            <Text variant="footnote" tone="ink2" style={styles.medium}>
              {t("mobile.browser.live.paste")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line }]}>
        <TextInput
          value={text}
          onChangeText={edit}
          onKeyPress={(e) => {
            // Only Backspace here: Return comes through `send`, so Enter never goes twice.
            if (e.nativeEvent.key === "Backspace" && keyPastDraft(draft.current, "Backspace")) onKey("Backspace");
          }}
          autoFocus={autoFocus}
          placeholder={secret ? t("mobile.browser.live.typeMarkedSecret") : t("mobile.browser.live.typeMarked")}
          placeholderTextColor={c.faint}
          style={[fieldText("body"), styles.input, { color: c.ink }]}
          secureTextEntry={secret}
          textContentType={secret ? "password" : "none"}
          autoComplete={secret ? "current-password" : "off"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={send}
          submitBehavior="submit"
        />
        <Pressable
          onPress={() => setSecret((s) => !s)}
          accessibilityRole="switch"
          accessibilityState={{ checked: secret }}
          accessibilityLabel={secret ? t("mobile.browser.live.secureOn") : t("mobile.browser.live.secureOff")}
          hitSlop={4}
          style={({ pressed }) => tool(secret || pressed)}
        >
          <Icon name="lock" size={18} color={secret ? c.ink : c.muted} />
        </Pressable>
        <Pressable
          onPress={() => setKeys((k) => !k)}
          accessibilityRole="button"
          accessibilityState={{ expanded: keys }}
          accessibilityLabel={t("mobile.browser.live.keys")}
          hitSlop={4}
          style={({ pressed }) => tool(keys || pressed)}
        >
          <Icon name="keyboard" size={18} color={keys ? c.ink : c.muted} />
        </Pressable>
        <Pressable
          onPress={send}
          disabled={!text}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.browser.live.send")}
          style={({ pressed }) => [styles.send, { backgroundColor: c.ink, opacity: !text ? 0.35 : pressed ? 0.8 : 1 }]}
        >
          <Icon name="send" size={18} color={c.bg} />
        </Pressable>
      </View>
    </View>
  );
}

/** `TypeBar` on the agent's page: its text and keys as the page's input events; a text too long is refused whole. */
export const browserTyping = (send: (events: BrowserInputEvent[]) => void, tooLong: () => void) => ({
  onText: (text: string) => {
    if (pasteBytes(text) > PASTE_MAX_BYTES) return tooLong();
    const events = pasteEvents(text);
    if (events.length) send(events);
  },
  onKey: (key: LiveKey) => send(keyEvents(key)),
});

/**
 * The address of the agent's browser while a person is in control of its page full screen: the site
 * opens there (a closed browser starts, to sign in ahead of time); a refusal (outside the agent's sites,
 * not an address, a page that didn't load) is said under the field, as on the web.
 */
export function AddressBar({
  name,
  cloud,
  onOpen,
}: {
  name: string;
  /** The workspace's own computer: its refusals never say it is off. */
  cloud: boolean;
  /** Opens the typed address; rejects with the server's refusal. */
  onOpen: (url: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const typed = url.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onOpen(typed);
      setUrl("");
    } catch (e) {
      setError(t(openRefusalKey(e instanceof ApiError ? e.code : undefined, cloud), agentGrammar(name)));
    } finally {
      setBusy(false);
    }
  };
  const ready = url.trim().length > 0 && !busy;
  return (
    <View style={styles.typeWrap}>
      <Locked when={busy}>
        <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line }]}>
          <Icon name="globe" size={16} color={c.muted} />
          <TextInput
            value={url}
            onChangeText={(v) => {
              setUrl(v);
              setError(null);
            }}
            placeholder={t("browser.inCard.goPlaceholder")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("browser.inCard.goLabel")}
            style={[fieldText("body"), styles.input, { color: c.ink }]}
            keyboardType="url"
            textContentType="URL"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2048}
            returnKeyType="go"
            onSubmitEditing={() => void go()}
          />
          <Pressable
            onPress={() => void go()}
            disabled={!ready}
            accessibilityRole="button"
            accessibilityLabel={t("browser.inCard.go")}
            style={({ pressed }) => [
              styles.send,
              { backgroundColor: c.ink, opacity: !ready ? 0.35 : pressed ? 0.8 : 1 },
            ]}
          >
            <Icon name="right" size={18} color={c.bg} />
          </Pressable>
        </View>
      </Locked>
      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export interface LiveState {
  frame: BrowserFrame | null;
  unavailable: Unavailable;
  controllerUserId: string | null;
  /** The handoff the last status carried (undefined until a status arrives). */
  handoff: { controllerUserId: string | null } | null | undefined;
  /** Someone else is in control: no page reaches this view until they hand it back. */
  hidden: boolean;
  sendInput: (events: BrowserInputEvent[]) => void;
  /** Watches again now (Try again for someone who only watches). */
  retry: () => void;
  /** The app's own socket is open: only then can a page come (its "reconnecting" isn't the computer's). */
  online: boolean;
  /** The last of a person's clicks or keys that didn't reach the page: a new object each time. */
  lost: { words: NonNullable<ReturnType<typeof inputProblem>> } | null;
}

/**
 * Watches the agent's browser on the app's realtime socket while `enabled` (the card is open), as the
 * web's `useBrowserLive`: frames, who is in control, why it can't be shown. Watches again after the
 * socket reconnects; the shared connection retries on its own while the computer is "reconnecting".
 * `maxFps`: the frames a second this view needs (`BROWSER_FPS.preview` for a small picture; none for the
 * stream's own rate), changed in place as the card opens or closes (ADR 0040 §7.1).
 */
export function useLiveConnection(agentId: string, enabled: boolean, maxFps?: number): LiveState {
  const connection = useConnection();
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable>(null);
  const [controllerUserId, setControllerUserId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ controllerUserId: string | null } | null | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const [online, setOnline] = useState(false);
  const [lost, setLost] = useState<LiveState["lost"]>(null);
  const liveRef = useRef<ReturnType<typeof createBrowserLiveConnection> | null>(null);
  // The rate when the watch starts; a change later goes through `setMaxFps` (never a new watch).
  const fps = useRef(maxFps);
  fps.current = maxFps;

  useEffect(() => {
    if (!connection || !enabled) return;
    setOnline(connection.isOpen);
    const live = createBrowserLiveConnection({
      send: (frameOut) => connection.sendBrowserFrame(frameOut),
      // Shared per socket: one watch per agent however often the card re-renders or remounts.
      watcher: connection.browserWatcher,
      agentId,
      maxFps: fps.current,
      onFrame: (f) => {
        setUnavailable(null);
        setFrame(f);
      },
      onStatus: (st) => {
        // Every retry on a closed browser gets a status first: only a frame says it's open again.
        setUnavailable((u) => (u === "closed" || u === "ended" ? u : null));
        setControllerUserId(st.controllerUserId);
        setHandoff(st.handoff ? { controllerUserId: st.handoff.controllerUserId } : null);
        setHidden(st.hidden);
        // What the person in control does isn't ours to keep on screen either.
        if (st.hidden) setFrame(null);
      },
      onUnavailable: (reason) => setUnavailable(reason),
      onEnded: () => setUnavailable("ended"),
      onError: (code) => {
        if (code === "forbidden" || code === "not_found") setUnavailable("forbidden");
        else if (code === "too_many_browsers") setUnavailable("tooMany");
        else {
          const words = inputProblem(code);
          if (words) setLost({ words });
        }
      },
    });
    liveRef.current = live;
    const offFrames = connection.onBrowserFrame((m) => live.handleMessage(m));
    // The server forgets the watch when the socket drops: watch again once it is back.
    const offStatus = connection.onStatus((status) => {
      setOnline(status === "open");
      if (status === "open") {
        // A card that opened while the socket was down (a push opening the app) starts watching now.
        live.start();
        live.resume();
      } else if (status === "reconnecting")
        setUnavailable((u) => (u === "ended" || u === "forbidden" ? u : "reconnecting"));
    });
    if (connection.isOpen) live.start();
    return () => {
      offFrames();
      offStatus();
      live.close();
      liveRef.current = null;
      // Unwatched, the rest goes stale (the last frame stays as the card's picture).
      setUnavailable(null);
      setControllerUserId(null);
      setHandoff(undefined);
      setHidden(false);
    };
  }, [connection, agentId, enabled]);

  useEffect(() => {
    liveRef.current?.setMaxFps(maxFps);
  }, [maxFps]);

  const sendInput = useCallback((events: BrowserInputEvent[]) => {
    liveRef.current?.sendInput(events);
  }, []);
  const retry = useCallback(() => liveRef.current?.retry(), []);
  return { frame, unavailable, controllerUserId, handoff, hidden, sendInput, retry, online, lost };
}

/** The field's height and its round buttons: the send button sits concentric in its pill end. */
const FIELD = 44;
const FIELD_BUTTON = 34;
/** A key cap's taps reach the 44 pt the finger needs, above and below (beside it are the other keys). */
const KEY_SLOP = { top: 5, bottom: 5 };

const styles = StyleSheet.create({
  frame: { flex: 1 },
  hintRow: { position: "absolute", top: 8, left: 8, right: 8, alignItems: "center" },
  hint: { maxWidth: "100%", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  medium: { fontWeight: "500" },
  semibold: { fontWeight: "600" },
  typeWrap: { gap: 8 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    borderRadius: FIELD / 2,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: (FIELD - FIELD_BUTTON) / 2,
    minHeight: FIELD,
  },
  input: { flex: 1, paddingVertical: 10 },
  tool: { width: FIELD_BUTTON, height: FIELD_BUTTON, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  send: {
    width: FIELD_BUTTON,
    height: FIELD_BUTTON,
    borderRadius: FIELD_BUTTON / 2,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  keys: { flexDirection: "row", gap: 6, justifyContent: "flex-end" },
  keyCap: { minWidth: 44, alignItems: "center", paddingVertical: 8, paddingHorizontal: 8, borderRadius: 10 },
  pressed: { opacity: 0.6 },
});
