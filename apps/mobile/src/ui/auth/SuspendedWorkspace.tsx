import { useAuthConfig } from "@agenteschat/client";
import { workspaceLabel, workspaceNotes, workspaceOpens } from "@agenteschat/client/lib/deletion";
import { supportLineOf, suspendedText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import type { OrgState } from "@/providers/org";
import { router } from "@/ui/navigation";
import { Button } from "../Button";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { AuthScaffold, CENTER } from "./AuthScaffold";
import { WholeAccount } from "./WholeAccount";

/**
 * The chosen organization is suspended (ADR 0056 §8): say so plainly (why, when the workspace is told), where
 * to ask about it, the person's other organizations and Sair. Apagar conta only for someone with nowhere else to reach
 * it (`WholeAccount`; its screen opens over this one). It covers the app, whose socket stays open underneath (hidden
 * from screen readers meanwhile), so lifting the suspension brings the organization back at once.
 */
export function SuspendedWorkspace({
  state,
  suspended,
}: {
  state: OrgState;
  /** `suspendedOf` the chosen organization. */
  suspended: { reason: string | null; cloud: boolean; others: OrgState["orgs"] };
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const notes = workspaceNotes(t, i18n.language, state.orgs);
  const name = state.orgs.find((o) => o.id === state.orgId)?.name;
  const title = name ? t("standing.screen.titleNamed", { name }) : t("standing.screen.title");
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold title={title} subtitle={suspendedText(t, suspended)}>
        <SupportLine />
        {suspended.others.map((o, i) => (
          <Button
            key={o.id}
            variant={i === 0 && workspaceOpens(o) ? "primary" : "secondary"}
            wide
            label={workspaceLabel(o.name, notes.get(o.id))}
            onPress={() => state.setOrgId(o.id)}
          />
        ))}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
        <WholeAccount orgs={state.orgs} onDelete={() => router.push("/account-delete")} />
      </AuthScaffold>
    </View>
  );
}

/** "Precisa de ajuda? Escreva para …", or to ask who runs the server, as `supportLineOf` says. */
function SupportLine() {
  const { t } = useTranslation();
  const line = supportLineOf(useAuthConfig().data);
  if (!line) return null;
  if (line === "ask")
    return (
      <Text tone="muted" style={CENTER}>
        {t("support.ask")}
      </Text>
    );
  const { email } = line;
  return (
    <Text tone="muted" style={CENTER}>
      {t("support.writeBefore")}
      <Text
        tone="muted"
        accessibilityRole="link"
        style={{ textDecorationLine: "underline" }}
        onPress={() => void Linking.openURL(`mailto:${email}`)}
      >
        {email}
      </Text>
      {t("support.writeAfter")}
    </Text>
  );
}
