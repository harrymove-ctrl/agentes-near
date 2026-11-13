import { type OrgDeletion, type OrgSummary, useClosingMe, useRestoreWorkspace } from "@agenteschat/client";
import { deletedByText, deletingText, restorable } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";

/**
 * On top of Conversas while the workspace is being deleted (ADR 0088 §7), in the outage notices' style: when it goes
 * and who deleted it, then Restaurar for its owners (the others read that only an owner can). The workspace reads as
 * ever meanwhile and takes no message, which its message boxes say. Nobody hears of a restore, so `GET /me` is asked
 * again: a restore takes the notice away, and once it's gone for good it leaves the list.
 */
export function DeletingNotice() {
  const { org } = useOrg();
  return org?.deletion ? <Deleting org={org} deletion={org.deletion} /> : null;
}

function Deleting({ org, deletion }: { org: OrgSummary; deletion: OrgDeletion }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const restore = useRestoreWorkspace(org.id);
  const me = useClosingMe().data;
  const owner = restorable(org);
  const due = !!deletion.dueAt && Date.parse(deletion.dueAt) > Date.now();
  const title = deletingText(t, i18n.language, org.name, deletion);
  const sub = [deletedByText(t, i18n.language, deletion, me?.user.id), due && !owner ? t("deleting.membersOnly") : null]
    .filter(Boolean)
    .join(" ");
  return (
    <View style={styles.list}>
      <View style={[styles.card, surface]}>
        <View
          style={styles.line}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={sub ? `${title}. ${sub}` : title}
        >
          <LineIcon name="trash" variant="callout" size={16} color={c.amber} />
          <View style={styles.tx}>
            <Text variant="callout" tone="ink" style={styles.bold}>
              {title}
            </Text>
            {sub ? (
              <Text variant="small" tone="muted">
                {sub}
              </Text>
            ) : null}
          </View>
        </View>
        {owner ? (
          <Button
            variant="primary"
            size="sm"
            wide
            label={t("deleting.restore")}
            loading={restore.isPending}
            disabled={restore.isPending}
            onPress={() =>
              restore.mutate(undefined, {
                onSuccess: () => toast({ title: t("deleting.restored", { name: org.name }) }),
                onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
              })
            }
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  card: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
});
