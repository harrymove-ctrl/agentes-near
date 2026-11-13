import { useGithubAccess } from "@agenteschat/client";
import { orgAccessChange } from "@agenteschat/client/lib/connected";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Text } from "@/ui";
import { useOrgId } from "../shared/hooks";

/**
 * The organizations GitHub lets us reach, on Reconectar: its sign-in asks about them only the first time, so more of
 * them are granted on its own page. Back from there, this says what changed.
 */
export function GithubOrgs() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const access = useGithubAccess(orgId);
  const [before, setBefore] = useState<readonly string[] | null>(null);
  const orgs = access.data?.orgs ?? null;
  const manageUrl = access.data?.manageUrl;
  const change = before && orgs && !access.isFetching ? orgAccessChange(t, before, orgs) : null;
  return (
    <View style={styles.box}>
      <Text variant="footnote" tone="faint">
        {t("connectFlow.githubOrgs.title")}
      </Text>
      {access.isPending ? null : (
        <Text variant="small">
          {orgs === null
            ? t("connectFlow.githubOrgs.failed")
            : orgs.length > 0
              ? orgs.join(", ")
              : t("connectFlow.githubOrgs.none")}
        </Text>
      )}
      {!access.isPending && orgs === null ? (
        <Button
          variant="secondary"
          label={t("common.retry")}
          disabled={access.isFetching}
          onPress={() => void access.refetch()}
        />
      ) : null}
      {change ? <Text variant="small">{change}</Text> : null}
      {manageUrl ? (
        <>
          <Text variant="small" tone="muted">
            {t("connectFlow.githubOrgs.lead")}
          </Text>
          <Button
            variant="secondary"
            label={t("connectFlow.githubOrgs.open")}
            onPress={async () => {
              if (orgs) setBefore(orgs);
              await WebBrowser.openBrowserAsync(manageUrl);
              await access.refetch();
            }}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ box: { gap: 8 } });
