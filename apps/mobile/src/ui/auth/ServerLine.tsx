import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { setServer, useServer, useServerToReturn } from "@/lib/server";
import { router } from "@/ui/navigation";
import { Text } from "../Text";
import { AuthLink } from "./AuthLink";

/**
 * The quiet line under the sign-in. On the Cloud it says what it's for, "Usa o servidor da sua equipe? Entrar por
 * ele", and opens the camera first: the QR code a team's computer shows ("Abrir no celular" on the web, the server's
 * setup) carries the address and, from the web, a one-time sign-in, so most people never type an address (the camera
 * screen offers typing it). On a team's server it says where this sign-in goes, "Entrando em … · Trocar". The language
 * follows the phone's (and its per-app setting in iOS Settings); signed in, it changes in Você (ADR 0122). Signed in
 * on another server (this one added from Workspaces): "Voltar para …" goes back to it, still signed in there.
 */
export function AuthFootLine() {
  const { t } = useTranslation();
  const server = useServer();
  const back = useServerToReturn();
  const onCloud = serverHost(server) === serverHost(CLOUD_SERVER);
  const open = () => router.push("/scan");
  return (
    <View style={styles.foot}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={
          onCloud
            ? t("common.joinSentences", {
                a: t("mobile.auth.server.footTeam"),
                b: t("mobile.auth.server.footTeamAction"),
              })
            : `${t("mobile.auth.server.footOn", { host: serverHost(server) })}. ${t("mobile.auth.server.footSwitch")}`
        }
        // An 18-point line: 12 of slop above and below reaches the 44-point target.
        hitSlop={12}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        {/* A team's host is cut in the middle (its end says which team); the action never. */}
        <Text variant="footnote" tone="faint" numberOfLines={1} ellipsizeMode="middle" style={styles.host}>
          {onCloud
            ? `${t("mobile.auth.server.footTeam")} `
            : `${t("mobile.auth.server.footOn", { host: serverHost(server) })} · `}
        </Text>
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.bold}>
          {onCloud ? t("mobile.auth.server.footTeamAction") : t("mobile.auth.server.footSwitch")}
        </Text>
      </Pressable>
      {back ? (
        <AuthLink
          label={t("mobile.auth.server.backTo", { host: serverHost(back) })}
          onPress={() => void setServer(back)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { alignItems: "center", gap: 12, alignSelf: "stretch" },
  line: { flexDirection: "row", alignItems: "center", maxWidth: "100%" },
  host: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
});

/** The old name, for anything still importing it: the same line. */
export const ServerLine = AuthFootLine;
