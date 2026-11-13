import { HEALTH_PATH } from "@agenteschat/client";
import { useEffect } from "react";

/** How often a screen that couldn't reach the server asks whether it's back. */
const ASK_EVERY_MS = 5000;

/**
 * While `on`: asks the server's health every 5 s while the tab is visible, and as soon as the network is back, and
 * reloads the page once it answers. Plain `fetch`: the screen may stand above the app's providers.
 */
export function useServerBack(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let asking = false;
    const ask = async () => {
      if (asking || document.visibilityState === "hidden") return;
      asking = true;
      try {
        const res = await fetch(HEALTH_PATH, { cache: "no-store", credentials: "same-origin" });
        if (res.status === 200) window.location.reload();
      } catch {
        // Still no answer: the next ask.
      } finally {
        asking = false;
      }
    };
    const timer = setInterval(() => void ask(), ASK_EVERY_MS);
    const online = () => void ask();
    window.addEventListener("online", online);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", online);
    };
  }, [on]);
}
