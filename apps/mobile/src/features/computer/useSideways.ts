import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";

const { OrientationLock } = ScreenOrientation;

/** How long the view stays upright after the button, before the phone may turn it again. */
const SETTLE_MS = 700;

const lock = (to: ScreenOrientation.OrientationLock) => {
  ScreenOrientation.lockAsync(to).catch(() => {});
};

/**
 * The app stands upright; only the agent's screen, in control, may lie down (ADR 0098), and it stands up again as soon
 * as that ends. Turning the phone does it; `lieDown` does it with the phone's own rotation lock on, and `standUp` undoes
 * that, since then turning the phone back can't.
 */
export function useSideways(allowed: boolean) {
  const { width, height } = useWindowDimensions();
  const [turn, setTurn] = useState<"free" | "wide" | "tall">("free");

  useEffect(() => {
    if (!allowed) return;
    if (turn === "wide") return lock(OrientationLock.LANDSCAPE);
    if (turn === "free") return lock(OrientationLock.DEFAULT);
    lock(OrientationLock.PORTRAIT_UP);
    const id = setTimeout(() => setTurn("free"), SETTLE_MS);
    return () => clearTimeout(id);
  }, [allowed, turn]);

  useEffect(() => {
    if (!allowed) return;
    return () => {
      setTurn("free");
      lock(OrientationLock.PORTRAIT_UP);
    };
  }, [allowed]);

  return {
    wide: allowed && width > height,
    /** Lying down by the button, so only the button stands it up. */
    forced: turn === "wide",
    lieDown: () => setTurn("wide"),
    standUp: () => setTurn("tall"),
  };
}
