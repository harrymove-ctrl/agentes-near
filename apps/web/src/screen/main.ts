import { type ScreenEvent, ScreenSession } from "./session";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(text: string): void };
    /** What the phone app calls with `injectJavaScript`. */
    agentScreen?: ScreenSession;
  }
}

const post = (event: ScreenEvent) => window.ReactNativeWebView?.postMessage(JSON.stringify(event));
const target = document.getElementById("screen");
const query = new URLSearchParams(window.location.search);
const orgId = query.get("o");
const agentId = query.get("a");
// A browser card's view of the screen (ADR 0058 §7): watch only.
const preview = query.get("p") === "1";

// noVNC loads apart, as on the web. The app waits for `ready` before it asks for anything.
if (target && orgId && agentId) {
  void import("@novnc/novnc").then(({ default: RFB }) => {
    window.agentScreen = new ScreenSession(
      target,
      { orgId, agentId, base: window.location, ...(preview ? { preview } : {}) },
      {
        createRfb: (el, channel) => new RFB(el, channel, { shared: true }),
        createSocket: (url) => new WebSocket(url),
        post,
      },
    );
    post({ type: "ready" });
  });
}
