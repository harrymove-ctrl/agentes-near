import { type DesktopViewState, keys } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useServer } from "@/lib/server";
import { useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { Cover } from "./Cover";
import { reportStuck, ScreenPage, type ScreenPageHandle } from "./ScreenPage";
import { DEFAULT_DESKTOP, fitScale, type Size } from "./screen-view";

/** How long the screen may stay opening: a socket refused before it opens never closes with a code. */
const STUCK_MS = 30_000;

export interface ScreenWatchHandle {
  retry(): void;
}

/**
 * The agent's whole screen in its browser card (ADR 0058 §7): the server's page in a WebView at the desktop's own
 * size, scaled into the box, never cropped. Watch only and no touch reaches it; the card falls back to its browser's
 * frames on any state but opening or live (`onState`).
 */
export function ScreenWatch({
  agentId,
  connect,
  parked = false,
  onState,
  style,
  ref,
}: {
  agentId: string;
  /** The stream may be open now (the card is open and the app in front, or just left). */
  connect: boolean;
  /** Kept loaded but out of sight (the card folded while the stream lingers): a quick reopen reuses the page. */
  parked?: boolean;
  onState: (state: DesktopViewState) => void;
  style?: StyleProp<ViewStyle>;
  ref?: Ref<ScreenWatchHandle>;
}) {
  const { t } = useTranslation();
  const server = useServer();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const agent = useDirectory().agentById.get(agentId);
  const { color } = agentLook(agent);
  const g = agentGrammar(agent?.name ?? "");
  const web = useRef<ScreenPageHandle>(null);
  const [life, setLife] = useState(0);
  const [ready, setReady] = useState(false);
  const readyNow = useRef(ready);
  readyNow.current = ready;
  const [page, setPage] = useState<DesktopViewState>("connecting");
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [desk, setDesk] = useState<Size>(DEFAULT_DESKTOP);
  const said = useRef(onState);
  said.current = onState;

  useEffect(() => {
    if (ready) web.current?.call("set", { connect, mode: "watch" });
  }, [ready, connect]);

  useEffect(() => {
    said.current(page);
  }, [page]);

  // Opening for too long counts as offline: the card goes back to its browser's frames.
  useEffect(() => {
    if (!connect || page !== "connecting") return;
    const id = setTimeout(() => {
      reportStuck("card", agentId, { ready: readyNow.current, page: "connecting" });
      setPage("offline");
    }, STUCK_MS);
    return () => clearTimeout(id);
  }, [connect, page, agentId]);

  useImperativeHandle(
    ref,
    () => ({
      retry: () => {
        setPage("connecting");
        if (ready) web.current?.call("retry");
        else setLife((n) => n + 1);
      },
    }),
    [ready],
  );

  const restart = () => {
    setReady(false);
    setLife((n) => n + 1);
  };
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
  };
  const scale = box.width > 0 && box.height > 0 ? fitScale(box, desk) : 1;

  return (
    <View
      onLayout={onLayout}
      pointerEvents={parked ? "none" : undefined}
      style={[styles.box, style, { aspectRatio: desk.width / desk.height }, parked && styles.parked]}
      accessible={!parked}
      accessibilityElementsHidden={parked}
      importantForAccessibility={parked ? "no-hide-descendants" : undefined}
      accessibilityRole="image"
      accessibilityLabel={page === "live" ? t("agentComputer.screen", g) : t("agentComputer.state.opening", g)}
    >
      <View
        pointerEvents="none"
        style={[styles.frame, { width: desk.width, height: desk.height, transform: [{ scale }] }]}
      >
        <ScreenPage
          key={life}
          ref={web}
          server={server}
          orgId={orgId}
          agentId={agentId}
          preview
          onEvent={(event) => {
            if (event.type === "ready") setReady(true);
            else if (event.type === "view") setPage(event.state);
            else if (event.type === "size") setDesk({ width: event.width, height: event.height });
            else if (event.type === "changed") {
              void qc.invalidateQueries({ queryKey: keys.agentDesktop(orgId, agentId) });
            }
          }}
          onGone={restart}
        />
      </View>
      {page === "live" ? null : <Cover fill sky spinner color={color} text={t("agentComputer.state.opening", g)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: "hidden", backgroundColor: "#101010" },
  // Out of the layout and out of sight, still rendering (a zero size could stop the page).
  parked: { position: "absolute", left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  frame: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
});
