import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { AgentFace, Face } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { ActionList } from "../shared/parts";
import { chatMatches, mayCreate } from "./logic";

/**
 * Who a conversation can start with, for the words typed: "Agents" and "People", each a card of rows (face, name,
 * role, chevron), or a line when nobody matches. Used by "New"'s search and by "Chat with…"; the parent lays it out
 * in a column with a gap.
 */
export function ChatTargets({
  q,
  onAgent,
  onPerson,
}: {
  q: string;
  onAgent: (agentId: string) => void;
  onPerson: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const found = useMemo(
    () => chatMatches(q, dir.agents, dir.memberById.values(), meId),
    [q, dir.agents, dir.memberById, meId],
  );
  const chevron = <Icon name="right" size={16} color={c.faint} />;
  return (
    <>
      {found.agents.length > 0 ? (
        <>
          <Text variant="label" accessibilityRole="header" style={styles.sec}>
            {t("mobile.find.agents")}
          </Text>
          <ActionList
            items={found.agents.map((a) => ({
              key: a.id,
              leading: <AgentFace agentId={a.id} size={32} live={false} presence ring={c.raised} />,
              label: a.name,
              ...(a.role ? { hint: a.role } : {}),
              trailing: chevron,
              onPress: () => onAgent(a.id),
            }))}
          />
        </>
      ) : null}
      {found.people.length > 0 ? (
        <>
          <Text variant="label" accessibilityRole="header" style={styles.sec}>
            {t("mobile.new.people")}
          </Text>
          <ActionList
            items={found.people.map((p) => ({
              key: p.userId,
              leading: <Face who={{ type: "person", id: p.userId }} size={32} presence ring={c.raised} />,
              label: p.name,
              trailing: chevron,
              onPress: () => onPerson(p.userId),
            }))}
          />
        </>
      ) : null}
      {found.agents.length + found.people.length === 0 && !dir.loading ? (
        q.trim() ? (
          <EmptyState size="inline" title={t("mobile.find.nothing", { q: q.trim() })} />
        ) : (
          <FirstUse
            place="people"
            size="panel"
            acts={mayCreate(org, "invite")}
            label={t("members.inviteTitle")}
            onPress={() => router.push("/invite-people")}
          />
        )
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sec: { paddingHorizontal: 4, paddingTop: 10 },
});
