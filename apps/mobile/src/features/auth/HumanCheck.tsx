import { useAuthConfig } from "@agenteschat/client";
import { createHumanCheck, type HumanAction, type HumanCheck } from "@agenteschat/client/lib/human-check";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackHandler, Keyboard, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useServer } from "@/lib/server";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import {
  CheckCancelled,
  type CheckPage,
  checkEvent,
  FRESH_PAGE,
  humanCheckEvent,
  humanCheckOrigins,
  humanCheckStays,
  humanCheckUrl,
  loadsAgain,
} from "./human-check";

/** Turnstile's checkbox: 65 px tall, and at least 300 px wide at its `flexible` size. */
const WIDGET_HEIGHT = 65;
const WIDGET_MIN_WIDTH = 300;
/** The open sheet's gap to the window's sides, and its padding. */
const SHEET_INSET = 8;
const SHEET_PADDING = 18;

/**
 * The bot check of a public form (ADR 0075), when the server has a site key: Cloudflare Turnstile in a WebView on
 * the server's own `/human-check.html`, so Cloudflare sees the server's host. Hidden at one pixel, it makes a token
 * before the person presses anything. When Cloudflare wants a click while a call waits for the token, the same
 * WebView rises as a sheet with Cancel, which ends that call quietly. `view` goes in `AuthScaffold`'s `overlay`,
 * outside the steps, so a step's change never reloads it. `check` is null without a site key or an `action`.
 */
export function useHumanCheck(action: HumanAction | null): { check: HumanCheck | null; view: ReactNode } {
  const { t, i18n } = useTranslation();
  const { colors, shadows, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const server = useServer();
  const siteKey = useAuthConfig().data?.turnstileSiteKey ?? null;
  const url =
    siteKey && action ? humanCheckUrl(server, { siteKey, action, theme: scheme, language: i18n.language }) : null;
  // A page and its tokens per action: a token passes only for the action it was made for.
  const tokens = useMemo(() => (url ? createHumanCheck() : null), [url]);
  const page = useRef<CheckPage>(FRESH_PAGE);
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(0);
  // Bumped for a new WebView: when the system ends the page's process (after a long while in the background), and
  // when a press finds the page broken.
  const [life, setLife] = useState(0);
  const web = useRef<WebView<object>>(null);
  const cancels = useRef(new Set<() => void>());
  const stop = () => {
    for (const cancel of cancels.current) cancel();
  };
  const settle = (next: CheckPage) => {
    page.current = next;
    setAsking(next.asking);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh page for new tokens, and the calls on the old end
  useEffect(() => {
    settle(FRESH_PAGE);
    return stop;
  }, [tokens]);

  const check = useMemo<HumanCheck | null>(
    () =>
      tokens && {
        token: () => {
          if (loadsAgain(tokens, page.current)) {
            page.current = FRESH_PAGE;
            setLife((n) => n + 1);
          }
          let cancel!: () => void;
          const cancelled = new Promise<never>((_, reject) => {
            cancel = () => reject(new CheckCancelled());
          });
          cancels.current.add(cancel);
          setWaiting((n) => n + 1);
          return Promise.race([tokens.token(), cancelled]).finally(() => {
            cancels.current.delete(cancel);
            setWaiting((n) => n - 1);
          });
        },
        reset: () => {
          tokens.reset();
          web.current?.injectJavaScript("window.resetCheck?.(); true;");
        },
      },
    [tokens],
  );

  // Only while a call waits on Cloudflare's click: a page that asks before anyone presses stays out of the way.
  const open = asking && waiting > 0;
  // A narrower phone would cut the checkbox at the sheet's padding: there it spans the sheet (304 px at 320 pt).
  const narrow = width - 2 * (SHEET_INSET + SHEET_PADDING) < WIDGET_MIN_WIDTH;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only while the sheet is open
  useEffect(() => {
    if (!open) return;
    Keyboard.dismiss();
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      stop();
      return true;
    });
    return () => back.remove();
  }, [open]);

  if (!url || !tokens) return { check, view: null };
  const fail = () => settle(checkEvent(tokens, page.current, { type: "error" }));
  const reload = () => {
    settle(FRESH_PAGE);
    setLife((n) => n + 1);
  };
  // One tree whether hidden or open, so the WebView and the challenge in it stay the same: only styles change.
  const view = (
    <View
      style={open ? StyleSheet.absoluteFill : styles.hidden}
      pointerEvents={open ? "auto" : "none"}
      accessibilityViewIsModal={open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      {open ? (
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
          onPress={stop}
          accessibilityLabel={t("mobile.common.cancel")}
        />
      ) : null}
      <View
        style={
          open
            ? [styles.sheet, { bottom: insets.bottom + 8, backgroundColor: colors.bg, boxShadow: shadows.e3 }]
            : styles.pixel
        }
      >
        {open ? (
          <Text variant="title" accessibilityRole="header" style={CENTER}>
            {t("mobile.humanCheck.title")}
          </Text>
        ) : null}
        <WebView
          // A new WebView per page: a message still on its way from the last one never reaches these tokens.
          key={`${url}#${life}`}
          ref={web}
          source={{ uri: url }}
          originWhitelist={humanCheckOrigins(server)}
          onShouldStartLoadWithRequest={(request) => humanCheckStays(server, request.url)}
          onMessage={(e) => {
            const event = humanCheckEvent(server, e.nativeEvent);
            if (event) settle(checkEvent(tokens, page.current, event));
          }}
          onError={fail}
          onHttpError={fail}
          onContentProcessDidTerminate={reload}
          onRenderProcessGone={reload}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          scrollEnabled={false}
          style={styles.web}
          containerStyle={open ? [styles.widget, narrow && styles.edgeToEdge] : styles.pixel}
        />
        {open ? <Button variant="secondary" wide label={t("mobile.common.cancel")} onPress={stop} /> : null}
      </View>
    </View>
  );
  return { check, view };
}

const styles = StyleSheet.create({
  // One invisible pixel in the window, so the page runs the challenge while the person types.
  hidden: { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  pixel: { flex: 0, width: 1, height: 1 },
  sheet: {
    position: "absolute",
    left: SHEET_INSET,
    right: SHEET_INSET,
    borderRadius: 34,
    padding: SHEET_PADDING,
    gap: 14,
  },
  widget: { flex: 0, height: WIDGET_HEIGHT, alignSelf: "stretch" },
  edgeToEdge: { marginHorizontal: -SHEET_PADDING },
  web: { backgroundColor: "transparent" },
});
