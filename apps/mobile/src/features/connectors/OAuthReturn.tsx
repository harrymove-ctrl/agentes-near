import {
  type Connection,
  type CustomServer,
  keys,
  useCatalog,
  useCompleteGitHubApp,
  useCompleteOAuth,
} from "@agenteschat/client";
import { connectedItems, outcomeText } from "@agenteschat/client/lib/connected";
import { knownErrorText, oauthReturnText } from "@agenteschat/client/lib/errors";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, goBack, successHaptic } from "../shared/parts";
import { installationIdOf, isFinishing } from "./logic";
import { returnHref } from "./review";

/**
 * A connector's sign-in that came back to the app through its link (Android opens the app with it; iOS hands
 * it to the open sheet). When the sheet that started it is still finishing, this screen just steps aside;
 * otherwise (the app was closed meanwhile) it finishes here and lands on Conectores, on a new account's tools
 * (a new sign-in for an account, or the same account again, lands on that account's screen). The agentes.chat
 * GitHub app's install comes back with its `installation_id` and lands on Conectores.
 */
export function ConnectorOAuthReturn() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const complete = useCompleteOAuth(orgId);
  const completeApp = useCompleteGitHubApp(orgId);
  const params = useLocalSearchParams<{ state?: string; code?: string; error?: string; installation_id?: string }>();
  const { state, code, error } = params;
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const leave = () => goBack("/connectors");
    if (state && isFinishing(state)) return leave();
    if (error || !state || !code) {
      // The GitHub account's owner was asked to install: news, not a failure.
      if (error !== "requested") errorHaptic();
      toast({
        title: error ? oauthReturnText(t, error) : t("mobile.connectors.failed"),
        icon: error === "requested" ? "info" : "x",
      });
      return void router.replace("/connectors");
    }
    const installationId = installationIdOf(params.installation_id);
    if (installationId) {
      return completeApp.mutate(
        { state, code, installationId },
        {
          onSettled: (_done, failed) => {
            if (failed) errorHaptic();
            else successHaptic();
            toast(
              failed
                ? { title: knownErrorText(t, failed) ?? t("mobile.connectors.failed"), icon: "x" }
                : { title: t("githubApp.installed") },
            );
            router.replace("/connectors");
          },
        },
      );
    }
    complete.mutate(
      { state, code },
      {
        onSettled: (done, failed) => {
          if (failed || !done) {
            errorHaptic();
            toast({ title: knownErrorText(t, failed) ?? t("mobile.connectors.failed"), icon: "x" });
            return void router.replace("/connectors");
          }
          successHaptic();
          const outcome = done.outcome ?? "connected";
          // The lists were read again on the way: the account's own name.
          const item = connectedItems(
            qc.getQueryData<Connection[]>(keys.connections(orgId)) ?? [],
            qc.getQueryData<CustomServer[]>(keys.customServers(orgId)) ?? [],
            catalog.data?.connectors ?? [],
          ).find((i) => i.id === done.connectionId);
          toast({ title: item ? outcomeText(t, outcome, item) : t("mobile.connectors.connectedDone") });
          // A new account on its tools, as the web lands on "O que faz" for the connection that came in.
          if (outcome === "connected") router.replace(returnHref(done.connectionId));
          else router.replace(`/connectors/${done.connectionId}`);
        },
      },
    );
  }, [state, code, error, params.installation_id, complete, completeApp, toast, t, qc, orgId, catalog.data]);
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center" },
});
