import { type Issue, type IssueActivity, useIssueActivity, useIssueLive } from "@agenteschat/client";
import { whenAt } from "@agenteschat/client/lib/format";
import { issueEventText } from "@agenteschat/client/lib/issues";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { Chip, Icon, type IconName, SCREEN_X, SectionHeader, Text, useReducedMotion } from "@/ui";
import { MessageText } from "../chat/MessageText";
import { MessageFiles } from "../files/MessageFiles";
import { Face } from "../shared/Face";
import { useColors, useConnection, useDirectory, useOrgId } from "../shared/hooks";

const eventIcon = (a: IssueActivity): IconName => (a.event === "agent_asked" ? "agent" : "clock");

/** "Atividade": what happened to the task, in order, with the comments between the events. */
export function IssueActivityFeed({ issue }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const orgId = useOrgId();
  const activity = useIssueActivity(orgId, issue.id);
  // A comment or a change from someone else (a person, an agent) shows up while the task is open.
  useIssueLive(orgId, useConnection(), issue);
  const list = activity.data ?? [];
  const when = (iso: string) => whenAt(t, i18n.language, iso);
  // A comment or a change that arrives while the task is open fades in; what was there when it loaded doesn't.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), layout: LinearTransition.duration(220) };
  return (
    <>
      <SectionHeader title={t("issues.activity")} count={list.length} />
      {activity.isSuccess && list.length === 0 ? (
        <Text variant="subhead" tone="faint" style={styles.none}>
          {t("issues.noActivity")}
        </Text>
      ) : null}
      <LayoutAnimationConfig skipEntering>
        {list.map((a) =>
          a.kind === "event" ? (
            <Animated.View key={a.id} {...fade} style={styles.event}>
              <Icon name={eventIcon(a)} size={15} color={c.faint} />
              <Text variant="small" tone="muted" style={styles.grow}>
                <Text variant="small" tone="ink2" style={styles.bold}>
                  {dir.nameOf(a.author)}
                </Text>
                {` ${issueEventText(t, a)} · ${when(a.createdAt)}`}
              </Text>
              {a.auto ? <Chip label={t("issues.auto")} /> : null}
            </Animated.View>
          ) : (
            <Animated.View key={a.id} {...fade} style={styles.comment}>
              <Face who={a.author} size={34} live={false} />
              <View style={styles.grow}>
                <Text variant="callout" style={styles.bold}>
                  {dir.nameOf(a.author)}{" "}
                  <Text variant="footnote" tone="faint">
                    {when(a.createdAt)}
                  </Text>
                </Text>
                {a.text ? <MessageText body={a.text} /> : null}
                {a.attachments?.length ? (
                  // The chat's files: a print at its own shape (tap opens the viewer), other files as a card.
                  <View style={styles.files}>
                    <MessageFiles files={a.attachments.map((f) => ({ id: f.id, title: f.title, deleted: false }))} />
                  </View>
                ) : null}
              </View>
            </Animated.View>
          ),
        )}
      </LayoutAnimationConfig>
    </>
  );
}

const styles = StyleSheet.create({
  files: { marginTop: 8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  none: { paddingHorizontal: SCREEN_X },
  event: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: SCREEN_X, paddingVertical: 6 },
  comment: { flexDirection: "row", gap: 10, paddingHorizontal: SCREEN_X, paddingVertical: 10 },
});
