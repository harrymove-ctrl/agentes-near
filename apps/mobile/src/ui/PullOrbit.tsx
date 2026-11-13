import { Platform } from "react-native";
import { PixelOrbit } from "@/agent/PixelOrbit";

/**
 * The pull-down's mark on a large-title screen (`LargeTitleScreen`'s `pullMark`): the app's pixel orbit, still while
 * the finger pulls and turning once the list reloads, where the system's wheel would be. On iOS the wheel is hidden
 * (`PULL_TINT` on the refresh control); Android keeps its own, which draws over the content.
 */
export function PullOrbit({ refreshing }: { refreshing: boolean }) {
  return <PixelOrbit color="sky" size={20} still={!refreshing} />;
}

/** The refresh control's tint where the orbit stands in for the wheel. */
export const PULL_TINT = Platform.OS === "ios" ? "transparent" : undefined;
