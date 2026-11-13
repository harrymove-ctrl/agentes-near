import { checkServer, isTailnet, type ServerCheck, serverHost } from "@agenteschat/client/lib/server";
import { useNetworkState } from "expo-network";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { serverUrl } from "@/lib/server";
import { Button, LineIcon, Text } from "@/ui";
import { problemText } from "../server";
import { RETRY_EVERY_MS, RetryWick } from "../server/ServerDown";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useSurface } from "../shared/parts";
import { serverTrouble } from "./logic";

/**
 * Why Conversas can't load, in the person's words: no internet on the phone, or the server's own check (`GET
 * /api/instance`: Tailscale, a certificate, a version), or plainly "didn't answer". Mounted only while it fails. It
 * asks again on its own every `RETRY_EVERY_MS` and says when (`nextRetryAt`).
 */
function useServerTrouble(retry: () => Promise<unknown>) {
  const { t } = useTranslation();
  const network = useNetworkState();
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [nextRetryAt, setNextRetryAt] = useState(() => Date.now() + RETRY_EVERY_MS);

  const latest = useRef(retry);
  latest.current = retry;

  useEffect(() => {
    let alive = true;
    void checkServer(serverUrl()).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNextRetryAt(Date.now() + RETRY_EVERY_MS);
      void latest.current();
    }, RETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  const server = check?.server ?? serverUrl();
  const host = serverHost(server);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const trouble = serverTrouble({ offline, check, tailnet: isTailnet(server) });
  const plain = trouble.kind === "down";
  const title =
    trouble.kind === "offline"
      ? t("mobile.chats.serverError.offline")
      : trouble.kind === "answered"
        ? t("mobile.chats.serverError.answered", { host })
        : trouble.kind === "down"
          ? t("mobile.auth.server.down.line", { host })
          : t(problemText(trouble.problem, server), { host });
  const again = () => {
    setChecking(true);
    setNextRetryAt(Date.now() + RETRY_EVERY_MS);
    void Promise.allSettled([checkServer(serverUrl()).then(setCheck), retry()]).then(() => setChecking(false));
  };
  return { title, plain, checking, nextRetryAt, again };
}

/**
 * Conversas when its list failed to load with nothing kept on the phone: the team's right hand asleep where an icon
 * would be (the team is still there, only out of reach), what is wrong (no internet, the server didn't answer, or
 * why its check says it can't be used, or "answered, but the conversations didn't load"), the wick to the next try
 * it makes on its own, and "Tentar agora". Without this a failed load read as an empty workspace and invited the
 * first agent.
 */
export function HomeServerError({ retry }: { retry: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const trouble = useServerTrouble(retry);
  const dir = useDirectory();
  // The right hand when the directory has it; the app's own agent before anything loaded.
  const rightHand = dir.agents.find((a) => a.builtin === "right_hand");
  const look = rightHand
    ? { ...agentLook(rightHand), id: rightHand.id }
    : { color: "sky" as const, eyes: "round" as const, id: "agentes" };
  return (
    <View style={styles.full} accessibilityLiveRegion="polite">
      <AgentAvatar agent={look} size={96} mode="sleep" framed={false} />
      <Text variant="body" style={[styles.center, styles.bold, styles.title]}>
        {trouble.title}
      </Text>
      {trouble.plain ? (
        <Text variant="subhead" tone="muted" style={styles.center}>
          {t("mobile.chats.serverError.text")}
        </Text>
      ) : null}
      <View style={styles.wick}>
        <RetryWick nextRetryAt={trouble.nextRetryAt} checking={trouble.checking} />
      </View>
      <Button
        variant="secondary"
        size="sm"
        label={t("mobile.auth.server.down.tryNow")}
        disabled={trouble.checking}
        onPress={trouble.again}
      />
    </View>
  );
}

/**
 * Over Conversas' kept rows when loading them again failed: a neutral card (the color only on its icon), the
 * same words as the full state and "Tentar de novo"; it goes once a load works.
 */
export function HomeServerNotice({ retry }: { retry: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const trouble = useServerTrouble(retry);
  return (
    <View style={styles.list}>
      <View style={[styles.card, surface]} accessibilityLiveRegion="polite">
        <View style={styles.line} accessible accessibilityRole="summary">
          {/* Not something that waits on the person: muted, never the waiting amber. */}
          <LineIcon name="wifi" variant="callout" size={16} color={c.muted} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold} numberOfLines={3}>
              {trouble.title}
            </Text>
            <Text variant="small" tone="muted" numberOfLines={2}>
              {t("mobile.chats.serverError.kept")}
            </Text>
          </View>
        </View>
        <Button
          variant="secondary"
          size="sm"
          wide
          label={trouble.checking ? t("mobile.auth.server.checking") : t("mobile.common.retry")}
          disabled={trouble.checking}
          onPress={trouble.again}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { paddingTop: 96, paddingHorizontal: 32, alignItems: "center", gap: 8 },
  title: { marginTop: 8 },
  center: { textAlign: "center" },
  wick: { marginTop: 8 },
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
