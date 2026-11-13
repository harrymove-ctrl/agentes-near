import type { ApprovalCoverInput } from "@agenteschat/client";
import { useApprovalCovers, useDeclineApprovalCover, useSetApprovalCover } from "@agenteschat/client";
import { coveringLine } from "@agenteschat/client/lib/approval-words";
import { endOfDay, formatShortDate, toYmd } from "@agenteschat/client/lib/format";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { DUE_CHOICES, dueDateOf } from "../issues/logic";
import { openRightHandSettings } from "../right-hand/SettingsScreen";
import { usePersonalView } from "../settings/hooks";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useMeId } from "../shared/hooks";
import { Page } from "./parts";

/**
 * Perfil › Aprovações (ADR 0139), the web's Configurações › Você › Aprovações: who approves for me (one person or
 * no one), when (only while my status says out, or always), until when and whether risky actions are in, each saved
 * as it is tapped; then whom I approve for, each with Não quero cobrir. In a personal workspace it is listed in
 * Settings › Advanced (ADR 0159 §3), and alone there the cover part waits until someone joins or one is set. What the
 * right hand does without asking is on its own settings, a row away.
 */
export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const covers = useApprovalCovers(orgId);
  const set = useSetApprovalCover(orgId, meId);
  const decline = useDeclineApprovalCover(orgId);
  const failed = () => toast({ title: t("approvalCover.failed"), icon: "x" });
  const cover = covers.data?.cover ?? null;
  const { solo } = usePersonalView();
  const rightHand = rightHandOf(dir.agents);
  const save = (patch: Partial<ApprovalCoverInput>) => {
    const next = {
      mode: cover?.mode ?? "while_out",
      risky: cover?.risky ?? false,
      endsAt: cover?.endsAt ?? null,
      userId: cover?.userId ?? "",
      ...patch,
    };
    set.mutate(next.userId ? next : null, { onError: failed });
  };
  const people = [...dir.memberById.values()].filter((m) => m.userId !== meId);
  const endDay = cover?.endsAt ? toYmd(new Date(cover.endsAt)) : null;
  const days = DUE_CHOICES.filter((c) => c !== "none").map((c) => ({ choice: c, day: dueDateOf(c) as string }));
  return (
    <Page title={t("settings.section.approvals")}>
      {/* Alone in a personal workspace there is no one to approve for you (ADR 0159), unless a cover is already set,
          which always shows. */}
      {solo && !cover ? null : (
        <>
          <GroupedHeader>{t("approvalCover.title")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t("approvalCover.nobody")}
              checked={!cover}
              onPress={() => cover && save({ userId: "" })}
            />
            {people.map((m) => (
              <GroupedRow
                key={m.userId}
                leading={<Face who={{ type: "person", id: m.userId }} size={28} />}
                label={m.name}
                checked={cover?.userId === m.userId}
                onPress={() => save({ userId: m.userId })}
              />
            ))}
          </GroupedList>
          <GroupedFooter>{t("approvalCover.subtitle")}</GroupedFooter>
          {cover ? (
            <>
              <GroupedHeader
                hint={{
                  name: t("common.about", { label: t("approvalCover.when") }),
                  text: t("approvalCover.whenHelp"),
                }}
              >
                {t("approvalCover.when")}
              </GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.whileOut")}
                  checked={cover.mode === "while_out"}
                  onPress={() => save({ mode: "while_out" })}
                />
                <GroupedRow
                  label={t("approvalCover.always")}
                  checked={cover.mode === "always"}
                  onPress={() => save({ mode: "always" })}
                />
              </GroupedList>
              <GroupedHeader>{t("approvalCover.until")}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.noDate")}
                  checked={!endDay}
                  onPress={() => save({ endsAt: null })}
                />
                {days.map(({ choice, day }) => (
                  <GroupedRow
                    key={choice}
                    label={t(`mobile.issues.form.dueChoice.${choice}`)}
                    value={formatShortDate(i18n.language, endOfDay(day))}
                    checked={endDay === day}
                    onPress={() => save({ endsAt: endOfDay(day) })}
                  />
                ))}
                {endDay && !days.some((d) => d.day === endDay) ? (
                  <GroupedRow label={formatShortDate(i18n.language, cover.endsAt as string)} checked />
                ) : null}
              </GroupedList>
              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  label={t("approvalCover.risky")}
                  labelLines={2}
                  sub={t("approvalCover.riskyOn")}
                  subLines={2}
                  toggle={cover.risky}
                  onPress={() => save({ risky: !cover.risky })}
                />
              </GroupedList>
            </>
          ) : null}
          <GroupedFooter>{t("approvalCover.lock")}</GroupedFooter>
        </>
      )}
      {rightHand ? (
        <>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              leading={<AgentFace agentId={rightHand.id} size={28} live={false} />}
              label={t("rightHandApprovals.title", { name: rightHand.name })}
              labelLines={2}
              chevron
              onPress={openRightHandSettings}
            />
          </GroupedList>
        </>
      ) : null}
      {(covers.data?.covering ?? []).length > 0 ? (
        <>
          <GroupedHeader>{t("approvalCover.coveringTitle")}</GroupedHeader>
          {covers.data?.covering.map((c) => (
            <View key={c.userId} style={styles.covering}>
              <GroupedList>
                <GroupedRow
                  leading={<Face who={{ type: "person", id: c.userId }} size={28} />}
                  label={dir.memberById.get(c.userId)?.name ?? ""}
                  sub={coveringLine(t, i18n.language, c)}
                />
                <GroupedRow
                  label={t("approvalCover.decline")}
                  danger
                  disabled={decline.isPending}
                  onPress={() => decline.mutate(c.userId, { onError: failed })}
                />
              </GroupedList>
            </View>
          ))}
          <GroupedFooter>{t("approvalCover.coveringSubtitle")}</GroupedFooter>
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 16 },
  covering: { marginBottom: 12 },
});
