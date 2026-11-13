import { useAuthConfig, useClosingMe, useRestoreAccount } from "@agenteschat/client";
import { accountDeletingText } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { Button } from "../Button";
import { Text } from "../Text";
import { useToast } from "../Toast";
import { useTheme } from "../theme";
import { AuthScaffold, CENTER } from "./AuthScaffold";

/**
 * The account was deleted and waits for its date: this screen covers the app, since no workspace answers it. When it
 * goes, what happens until then, Restaurar and Sair. Past the date only the wait is left. `GET /me` is asked again
 * meanwhile: once the account is gone, the session ends.
 */
export function DeletingAccount({ dueAt }: { dueAt: string | null }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const toast = useToast();
  const restore = useRestoreAccount();
  const billing = Boolean(useAuthConfig().data?.billingUrl);
  useClosingMe();
  const due = !!dueAt && Date.parse(dueAt) > Date.now();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold title={t("accountDeleting.title")} subtitle={accountDeletingText(t, i18n.language, dueAt)}>
        {due ? (
          <Text tone="muted" style={CENTER}>
            {t("accountDeleting.what")}
          </Text>
        ) : null}
        {due && billing ? (
          <Text tone="muted" style={CENTER}>
            {t("accountDeleting.plans")}
          </Text>
        ) : null}
        {due ? (
          <Button
            variant="primary"
            wide
            label={t("accountDeleting.restore")}
            loading={restore.isPending}
            disabled={restore.isPending}
            onPress={() =>
              restore.mutate(undefined, {
                onSuccess: () => toast({ title: t("accountDeleting.restored") }),
                onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
              })
            }
          />
        ) : null}
        <Button
          variant="ghost"
          wide
          label={t("mobile.org.signOut")}
          disabled={restore.isPending}
          onPress={() => void signOut()}
        />
      </AuthScaffold>
    </View>
  );
}
