import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** Whether the app is in front: a stream the person can't see is let go. */
export function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}
