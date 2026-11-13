import { accountOutOfReach } from "@agenteschat/client/lib/deletion";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button } from "../Button";
import { Text } from "../Text";
import { CENTER } from "./AuthScaffold";

/**
 * Deleting the account, only for someone with no workspace that opens: the Conta page isn't reachable from a closed
 * workspace or the first run for them, and a person must always be able to delete their account (App Store 5.1.1(v)).
 * Under a heading of its own, after Sair, so it can't be read as the way to delete the workspace on screen.
 */
export function WholeAccount({
  orgs,
  onDelete,
  disabled,
}: {
  orgs: Parameters<typeof accountOutOfReach>[0];
  onDelete: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!accountOutOfReach(orgs)) return null;
  return (
    <View style={styles.block}>
      <Text variant="title" accessibilityRole="header" style={CENTER}>
        {t("deleteAccount.whole")}
      </Text>
      <Text tone="muted" style={CENTER}>
        {t("deleteAccount.card.text")}
      </Text>
      <Button variant="ghost" wide label={t("deleteAccount.menu")} disabled={disabled} onPress={onDelete} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: 24, gap: 6 },
});
