import {
  checkServer,
  isTailnet,
  type ServerCheck,
  type ServerProblem,
  serverHost,
} from "@agenteschat/client/lib/server";
import { useNetworkState } from "expo-network";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { useNow } from "@/features/shared/hooks";
import { SERVER_GIVE_UP_MS, SERVER_STUCK_MS, serverDownOf } from "@/lib/org-choice";
import { serverUrl, setServer, useServerToReturn } from "@/lib/server";
import { useOrgGate } from "@/providers/org";
import { Fuse } from "@/sky/Fuse";
import { AuthLink } from "@/ui/auth/AuthLink";
import { CENTER } from "@/ui/auth/AuthScaffold";
import { Button } from "@/ui/Button";
import { Text } from "@/ui/Text";
import { problemText } from "./index";
import { ServerAddress } from "./ServerAddress";

/** While it waits, the account is asked for again this often (the app opens on its own once it answers). */
export const RETRY_EVERY_MS = 15_000;

export interface ServerDown {
  problem: ServerProblem;
  /** The address that failed (a server's own address can differ from the one saved). */
  server: string;
  checking: boolean;
  /** When it asks again on its own (ms since the epoch): the wait, shown as a wick burning down. */
  nextRetryAt: number;
  retry: () => void;
}

/**
 * Whether the server the app is signed in to can't be opened (`serverDownOf`): the account failed to load with
 * nothing cached, or it is still loading after `SERVER_STUCK_MS` and the server doesn't answer. Without this a
 * failed load read as "no organization" and opened the first run. Past `SERVER_GIVE_UP_MS` it counts as failed
 * whatever the server says, and from `SERVER_STUCK_MS` on the account is asked for again, which replaces a request
 * that hung: nobody waits on a screen with no way out. `active`: signed in, the session read.
 */
export function useServerDown(active: boolean): ServerDown | null {
  const org = useOrgGate();
  const [stuck, setStuck] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [nextRetryAt, setNextRetryAt] = useState(0);

  const waiting = active && org.loading;
  useEffect(() => {
    setStuck(false);
    setGaveUp(false);
    if (!waiting) return;
    const asks = setTimeout(() => setStuck(true), SERVER_STUCK_MS);
    const ends = setTimeout(() => setGaveUp(true), SERVER_GIVE_UP_MS);
    return () => {
      clearTimeout(asks);
      clearTimeout(ends);
    };
  }, [waiting]);

  // Asks the server itself once something looks wrong: its answer says why (Tailscale, a certificate, a version).
  const asking = active && (org.unreachable || stuck);
  useEffect(() => {
    setCheck(null);
    if (!asking) return;
    let alive = true;
    void checkServer(serverUrl()).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [asking]);

  const problem = active ? serverDownOf(org.unreachable || gaveUp, stuck, check) : null;
  const orgRetry = org.retry;
  const retry = useCallback(() => {
    setChecking(true);
    setNextRetryAt(Date.now() + RETRY_EVERY_MS);
    void Promise.all([checkServer(serverUrl()), orgRetry()]).then(([c]) => {
      setCheck(c);
      setChecking(false);
    });
  }, [orgRetry]);

  // Every try, by hand or on its own, starts the wait for the next one over.
  useEffect(() => {
    if (!problem && !stuck) return;
    setNextRetryAt(Date.now() + RETRY_EVERY_MS);
    const timer = setInterval(() => {
      setNextRetryAt(Date.now() + RETRY_EVERY_MS);
      void orgRetry();
    }, RETRY_EVERY_MS);
    return () => clearInterval(timer);
  }, [problem, stuck, orgRetry]);

  if (!problem) return null;
  return { problem, server: check?.server ?? serverUrl(), checking, nextRetryAt, retry };
}

/**
 * Under the launch splash's name while the server doesn't answer (`LaunchSplash`'s `waiting`): what happened, with
 * the reason when the server's check found one; the wait for the next try as a wick burning down ("tenta de novo em
 * 12 s": it always tried on its own, now it shows); "Tentar agora"; and the quiet ways out: back to another server
 * this phone is signed in to (ADR 0154), "Trocar de servidor" (fix the address without leaving the account), or Sair.
 */
export function ServerDownPanel({ down }: { down: ServerDown }) {
  const { t } = useTranslation();
  const network = useNetworkState();
  const back = useServerToReturn();
  const [switching, setSwitching] = useState(false);
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const host = serverHost(down.server);
  // Off a tailnet, "unreachable" here is a server that worked before: down, not a wrong address.
  const plain = !offline && down.problem === "unreachable" && !isTailnet(down.server);
  const line = offline
    ? t("mobile.auth.errors.network")
    : plain
      ? t("mobile.auth.server.down.line", { host })
      : t(problemText(down.problem, down.server), { host });
  return (
    <View style={styles.panel} accessibilityLiveRegion="polite">
      <View style={styles.words}>
        <Text variant="body" style={[CENTER, styles.bold]}>
          {line}
        </Text>
        {plain ? (
          <Text variant="subhead" tone="muted" style={CENTER}>
            {t("mobile.auth.server.down.text")}
          </Text>
        ) : null}
      </View>
      <RetryWick nextRetryAt={down.nextRetryAt} checking={down.checking} />
      <Button
        variant="primary"
        wide
        label={down.checking ? t("mobile.auth.server.checking") : t("mobile.auth.server.down.tryNow")}
        disabled={down.checking}
        onPress={down.retry}
      />
      <View style={styles.links}>
        {back ? (
          <AuthLink
            label={t("mobile.auth.server.backTo", { host: serverHost(back) })}
            onPress={() => void setServer(back)}
          />
        ) : null}
        <AuthLink label={t("mobile.auth.server.down.switchServer")} onPress={() => setSwitching(true)} />
        <AuthLink label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </View>
      {/* Over the splash, which covers the navigator: the address screen comes up whole, its back circle closing it. */}
      <Modal
        visible={switching}
        animationType="slide"
        supportedOrientations={["portrait", "landscape"]}
        onRequestClose={() => setSwitching(false)}
      >
        <ServerAddress onDone={() => setSwitching(false)} scan={false} />
      </Modal>
    </View>
  );
}

/**
 * "tenta de novo em 12 s" with the wick: the time to the next try, burning down linearly (time passes linearly; a
 * curve here would lie), repainted once a second. While a try runs, it says so instead.
 */
export function RetryWick({ nextRetryAt, checking }: { nextRetryAt: number; checking: boolean }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const left = Math.max(0, nextRetryAt - now);
  const seconds = Math.ceil(left / 1000);
  return (
    <View style={styles.wick} accessibilityLiveRegion="none">
      <Fuse color="sky" remaining={left / RETRY_EVERY_MS} style={styles.fuse} />
      <Text variant="footnote" tone="muted" style={styles.tabular}>
        {checking ? t("mobile.auth.server.checking") : t("mobile.auth.server.down.retryIn", { count: seconds })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  words: { gap: 4, marginBottom: 8, paddingHorizontal: 8 },
  bold: { fontWeight: "600" },
  wick: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingBottom: 8 },
  fuse: { width: 56, flex: 0 },
  tabular: { fontVariant: ["tabular-nums"] },
  links: { paddingTop: 8, flexDirection: "row", justifyContent: "center", columnGap: 16, rowGap: 12, flexWrap: "wrap" },
});
