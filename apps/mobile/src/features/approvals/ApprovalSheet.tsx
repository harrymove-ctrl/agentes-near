import { useApproval, useChannels, useDecideApproval } from "@agenteschat/client";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalEffects } from "@agenteschat/client/lib/approval-review";
import {
  aheadEndLine,
  alwaysRoutineName,
  approvalDetail,
  approvalWaitsFor,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel } from "@agenteschat/client/lib/format";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  HoldButton,
  IconButton,
  Locked,
  SheetScreen,
  Text,
  useToast,
} from "@/ui";
import { ExpiryLine } from "../chat/asks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import {
  approvalAction,
  approvalRisk,
  approvalSaid,
  approvalTable,
  approvalTraits,
  approveAlwaysHint,
  approveAlwaysLabel,
  approveAlwaysOffered,
  approveAlwaysToast,
} from "./logic";
import {
  ApprovalAheadLine,
  ApprovalEmailLetter,
  ApprovalUndoChip,
  approvalTitleText,
  traitKey,
  useCancelAhead,
  useConnectorNamer,
  useOriginShort,
} from "./parts";

/** A value longer than this goes under its label, whole, instead of squeezed at the row's end. */
const SHORT_VALUE = 22;

/**
 * A request, from anywhere (deep link `approval/<id>`), as the system's sheets read: its title ("Pedido") and ×, who
 * asks with the action in words and whether it can be undone after it, where and the fuse to its deadline under them
 * at the sheet's width; then the request in groups (why, the service it goes through, the values it runs with, what
 * it affects) and, where its kind allows it, "Aprovar sempre" as a switch for next time. Two buttons side by side:
 * Recusar and Aprovar (held, for high risk). Recusar writes the optional reason in the sheet (the deep link's `refuse`
 * opens there; the cards ask in the system's alert).
 */
export function ApprovalSheet({
  id,
  refuse: startRefusing = false,
  onClose,
}: {
  id: string;
  refuse?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const c = useColors();
  const now = useNow();
  const toast = useToast();
  const approval = useApproval(orgId, id);
  const channels = useChannels(orgId);
  const decide = useDecideApproval(orgId);
  const cancelAhead = useCancelAhead();
  const [refusing, setRefusing] = useState(startRefusing);
  const [reason, setReason] = useState("");
  const [always, setAlways] = useState(false);
  const a = approval.data;
  const nameOf = useConnectorNamer({ connector: a?.connector ?? null });
  const agent = a ? dir.agentById.get(a.agentId) : undefined;
  const name = agent?.name ?? "";
  const g = genderOf(name);
  const channel = a ? channels.data?.find((x) => x.id === a.channelId) : undefined;
  const origin = useOriginShort({ origin: a?.origin ?? null });
  const runAt = a?.runAt ? nextLabel(i18n.language, a.runAt) : null;

  /** `withAlways`: "Aprovar sempre", this one and the agent's next ones of its kind. */
  const done = (decision: "approve" | "refuse", withAlways = false) => {
    if (!a) return;
    decide.mutate(
      {
        id: a.id,
        decision,
        ...(withAlways ? { always: true } : {}),
        ...(decision === "refuse" && reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            ...(withAlways
              ? approveAlwaysToast(t, name, alwaysRoutineName(t, a))
              : {
                  title: decision === "approve" ? t("mobile.approval.approved") : t("mobile.approval.refused"),
                  subtitle:
                    decision === "approve"
                      ? runAt
                        ? t("mobile.approval.approvedAhead", { when: runAt })
                        : t(`mobile.approval.approvedSub${g}`, { name })
                      : t(`mobile.approval.refusedSub${g}`, { name }),
                }),
            agentId: a.agentId,
          });
          onClose();
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  };

  const head = (
    <View style={styles.bar}>
      <Text variant="body" style={styles.semibold}>
        {t("mobile.approval.sheet.title")}
      </Text>
      <View style={styles.barEnd}>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={onClose} />
      </View>
    </View>
  );

  let body: ReactNode;
  if (!a) {
    body = approval.isError ? (
      <Text tone="muted">{t("mobile.approval.notFound")}</Text>
    ) : (
      <ActivityIndicator color={c.muted} />
    );
  } else {
    const pending = a.status === "pending" && new Date(a.expiresAt).getTime() > now;
    const high = approvalRisk(a) === "high";
    const owner = approvalWaitsFor(a, a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined);
    const requester = requesterDecidesLine(t, a);
    const said = approvalSaid(a);
    const where = [name, channel ? `#${channel.name}` : null, origin].filter(Boolean).join(" · ");
    // The request's facts: through which service, then the values it runs with, whole.
    const facts = approvalTable(a, Number.POSITIVE_INFINITY, nameOf, true);
    // A built-in tool's action in words; a connector's is in its facts, an email is the letter.
    const detail = !a.connector && !a.email ? approvalDetail(a, i18n.language) : null;
    // Whether it can be undone is the chip after the title; what it touches stays in the foot.
    const { undo } = approvalEffects(a);
    const traits = approvalTraits(a)
      .filter((tr) => tr !== undo)
      .map((tr) => t(traitKey(tr, isPersonal(org))));
    const foot = [traits.join(" · "), requester].filter(Boolean).join("\n");
    const who = (
      <View style={styles.who}>
        <View style={styles.whoHead}>
          <AgentFace agentId={a.agentId} size={40} />
          {/* The chip on the title's last line while it fits, under the title otherwise. */}
          <View style={[styles.grow, styles.titleLine]}>
            <Text variant="body" style={[styles.semibold, styles.shrink]}>
              {approvalTitleText(t, a)}
            </Text>
            <ApprovalUndoChip approval={a} />
          </View>
        </View>
        <View style={styles.whereRow}>
          <Text variant="footnote" tone="muted" style={styles.shrink}>
            {where || t("mobile.approval.asksYou")}
          </Text>
          {pending ? <ExpiryLine createdAt={a.createdAt} expiresAt={a.expiresAt} /> : null}
        </View>
      </View>
    );
    body = refusing ? (
      <>
        {who}
        <Text variant="small" tone="muted">
          {t("mobile.approval.refuseTitle")}
        </Text>
        <Locked when={decide.isPending}>
          <TextArea
            value={reason}
            onChangeText={setReason}
            placeholder={t(`mobile.approval.whyPlaceholder${g}`, { name })}
            accessibilityLabel={t(`mobile.approval.whyPlaceholder${g}`, { name })}
            autoFocus
          />
        </Locked>
        <View style={styles.pair}>
          <View style={styles.half}>
            <Button
              variant="secondary"
              wide
              label={t("mobile.common.back")}
              disabled={decide.isPending}
              onPress={() => setRefusing(false)}
            />
          </View>
          <View style={styles.half}>
            <Button
              variant="primary"
              wide
              label={t("mobile.approval.refuse")}
              loading={decide.isPending}
              onPress={() => done("refuse")}
            />
          </View>
        </View>
      </>
    ) : (
      <>
        {who}
        <ApprovalAheadLine approval={a} />
        {a.email ? <ApprovalEmailLetter email={a.email} full /> : null}
        <View>
          <GroupedHeader>{t("mobile.approval.sheet.request")}</GroupedHeader>
          <GroupedList>
            {said ? <GroupedRow key="why" label={t("mobile.approval.sheet.why")} sub={said} subLines={6} /> : null}
            {detail ? <GroupedRow key="detail" label={detail} labelLines={4} /> : null}
            {facts.map((f) => {
              const label = f.label ?? t("mobile.approval.sheet.service");
              return f.value.length > SHORT_VALUE ? (
                <GroupedRow key={label} label={label} sub={f.value} subLines={8} />
              ) : (
                <GroupedRow key={label} label={label} value={f.value} />
              );
            })}
          </GroupedList>
          {foot ? <GroupedFooter>{foot}</GroupedFooter> : null}
        </View>
        {pending && a.canDecide && approveAlwaysOffered(a) ? (
          <View>
            <GroupedHeader>{t("mobile.approval.sheet.nextTime")}</GroupedHeader>
            <GroupedList>
              {/* What it covers behind its ⓘ: the sheet ends on its buttons, not on a paragraph. */}
              <GroupedRow
                label={approveAlwaysLabel(t, a)}
                labelLines={2}
                toggle={always}
                disabled={decide.isPending}
                onPress={() => setAlways((on) => !on)}
                hint={{
                  name: t("common.about", { label: approveAlwaysLabel(t, a) }),
                  text: approveAlwaysHint(t, a, name || t("channel.unknownAgent")),
                }}
              />
            </GroupedList>
          </View>
        ) : null}
        {pending ? (
          a.canDecide ? (
            <View style={styles.pair}>
              <View style={styles.half}>
                <Button
                  variant="secondary"
                  wide
                  label={t("mobile.approval.refuse")}
                  disabled={decide.isPending}
                  onPress={() => setRefusing(true)}
                />
              </View>
              <View style={styles.half}>
                {high ? (
                  <HoldButton
                    label={t("mobile.approval.hold")}
                    disabled={decide.isPending}
                    onConfirm={() => done("approve", always)}
                  />
                ) : (
                  <Button
                    variant="primary"
                    wide
                    label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
                    loading={decide.isPending}
                    onPress={() => done("approve", always)}
                  />
                )}
              </View>
            </View>
          ) : (
            <Text variant="small" tone="muted" style={styles.note}>
              {owner ? t("mobile.approval.onlyOwner", { name: owner }) : t("mobile.approval.onlyAdmins")}
            </Text>
          )
        ) : aheadPhase(a) === "scheduled" && runAt ? (
          <>
            <Text variant="small" tone="muted" style={styles.note}>
              {t("mobile.approval.status.scheduled", { when: runAt })}
            </Text>
            {a.canCancel ? (
              <Button
                variant="secondary"
                wide
                label={t("approval.ahead.cancel")}
                loading={cancelAhead.pending}
                onPress={() => cancelAhead.cancel(a.id, onClose)}
              />
            ) : null}
          </>
        ) : (
          <Text variant="small" tone="muted" style={styles.note}>
            {aheadEndLine(t, a) ?? t(`mobile.approval.status.${a.status === "pending" ? "expired" : a.status}`)}
          </Text>
        )}
      </>
    );
  }

  return (
    <SheetScreen>
      {head}
      <View style={styles.in}>{body}</View>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  // The sheet's own bar: its title centered on the grabber's line, × at the end.
  bar: { height: 44, alignItems: "center", justifyContent: "center", marginTop: -12 },
  barEnd: { position: "absolute", right: -2, top: 0, bottom: 0, justifyContent: "center" },
  semibold: { fontWeight: "600" },
  in: { gap: 24 },
  // The face beside the title alone (never a column beside where and when): those go under, at the sheet's width.
  who: { gap: 8 },
  whoHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  titleLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 },
  whereRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  pair: { flexDirection: "row", gap: 8 },
  half: { flex: 1 },
  note: { textAlign: "center" },
});
