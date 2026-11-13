import type { DesktopViewState } from "@agenteschat/client";
import { type Ref, useImperativeHandle, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { lastCookie } from "@/lib/auth";
import { reportError } from "@/lib/error-reports";
import {
  type PageCalls,
  pageCall,
  type ScreenEvent,
  screenEvent,
  screenPageStays,
  screenPageUrl,
  sessionAnswer,
  sessionCookieScript,
} from "./screen-page";

/** What the views ask of the page (`pageCall`). */
export type ScreenPageHandle = { call<K extends keyof PageCalls>(method: K, ...args: PageCalls[K]): void };

/**
 * The server's `/screen.html` in a WebView (ADR 0098), for the agent's screen and a browser card's view of it: it
 * loads only that page, keeps nothing, and hands on what the page says. The session goes in before each time the
 * page's socket may open (`sessionAnswer`, `pageCall`).
 */
export function ScreenPage({
  server,
  orgId,
  agentId,
  preview = false,
  onEvent,
  onGone,
  ref,
}: {
  server: string;
  orgId: string;
  agentId: string;
  preview?: boolean;
  onEvent: (event: ScreenEvent) => void;
  /** The page's process ended: mount it again. */
  onGone: () => void;
  ref: Ref<ScreenPageHandle>;
}) {
  const web = useRef<WebView<object>>(null);
  useImperativeHandle(
    ref,
    () => ({
      call: (method, ...args) =>
        web.current?.injectJavaScript(pageCall({ cookie: lastCookie(), server }, method, ...args)),
    }),
    [server],
  );
  return (
    <WebView
      ref={web}
      source={{ uri: screenPageUrl(server, orgId, agentId, preview ? { preview } : {}) }}
      originWhitelist={[new URL(server).origin]}
      onShouldStartLoadWithRequest={(request) => screenPageStays(server, request.url)}
      injectedJavaScriptBeforeContentLoaded={sessionCookieScript(lastCookie(), server)}
      incognito
      javaScriptEnabled
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      textInteractionEnabled={false}
      androidLayerType="hardware"
      style={styles.web}
      onMessage={(e) => {
        const event = screenEvent(server, e.nativeEvent);
        if (!event) return;
        const answer = sessionAnswer(event, lastCookie(), server);
        if (answer) web.current?.injectJavaScript(answer);
        onEvent(event);
      }}
      onContentProcessDidTerminate={onGone}
      onRenderProcessGone={onGone}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
});

/**
 * A view of the agent's screen that never opened is reported (ADR 0104), with how far it got: whether the page said
 * `ready`, its last state, and whether the screen's state (`GET …/desktop`) ever came.
 */
export const reportStuck = (
  view: "computer" | "card",
  agentId: string,
  at: { ready: boolean; page: DesktopViewState; status?: string },
) =>
  reportError(new Error("The agent's screen didn't open"), {
    view,
    agent_id: agentId,
    page_ready: at.ready,
    page_state: at.page,
    desktop_status: at.status,
  });
