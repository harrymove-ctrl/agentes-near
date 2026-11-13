import { type UsageQueueClosedRow, type UsageQueueRow, useCancelUsageQueue, useUsageQueue } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  usageQueueResuming,
  usageQueueShared,
  usageQueueSkippedWhere,
  usageQueueSkipReason,
  usageQueueStoppable,
  usageQueueTitle,
  usageQueueWhere,
  usageQueueWho,
} from "@agenteschat/client/lib/usage-queue";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button, EmptyState, PixelOrbit, Segmented, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentAi } from "../ai/AgentAiScreen";
import { AnswerAnywayButton, DontRunButton } from "../ai/UsagePauseCard";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { useSheetIfAny } from "../shared/SheetHost";

/** The sheet's two lists: what it picks up when the limit is back, and what it skipped as already handled. */
export type UsageQueueTab = "queued" | "skipped";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118), the web's dialog as a sheet: its face asleep and
 * when it is back as the title, one short row per conversation in the order it picks them up ("Não rodar" where the
 * viewer may use it, "Não rodar nenhuma" and "Change its AI" for its owner and admins) and, behind a switch, what it
 * skipped as already handled (ADR 0136). Opened from its profile's out-of-office line and its waiting note; `tab`
 * "skipped" from a skip.
 */
export function UsageQueueSheet({ agentId, tab: initialTab = "queued" }: { agentId: string; tab?: UsageQueueTab }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const now = useNow(60_000);
  const q = useUsageQueue(orgId, agentId);
  const [chosen, setChosen] = useState<UsageQueueTab>(initialTab);
  const agent = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  if (!q.data)
    return q.isError ? (
      <View style={styles.failed}>
        <Text variant="small" tone="muted">
          {t("mobile.app.failed")}
        </Text>
        <Button variant="secondary" size="sm" label={t("common.retry")} onPress={() => void q.refetch()} />
      </View>
    ) : (
      <ActivityIndicator color={c.muted} style={styles.loading} />
    );
  const queue = q.data;
  const waiting = queue.rows.length + queue.hidden;
  const skipped = queue.closed.length;
  // The switch only when both lists have something: otherwise the one that does.
  const tab: UsageQueueTab = waiting === 0 ? "skipped" : skipped === 0 ? "queued" : chosen;
  const shared = usageQueueShared(
    t,
    queue.plan,
    queue.sharedWith.flatMap((id) => dir.anyAgent(id)?.name ?? []),
  );
  const resuming = usageQueueResuming(queue);
  const queuedList = (
    <>
      <View>
        {queue.rows.map((row, i) => (
          <WaitingRow key={row.runId} n={i + 1} row={row} agentId={agentId} now={now} />
        ))}
        {queue.hidden > 0 ? (
          <Text variant="footnote" tone="faint" style={styles.hidden}>
            {t("usageQueue.hidden", { count: queue.hidden })}
          </Text>
        ) : null}
      </View>
      {queue.mayStopAll ? (
        <View style={styles.owner}>
          {usageQueueStoppable(queue) > 0 ? <StopAll agentId={agentId} count={usageQueueStoppable(queue)} /> : null}
          <View style={styles.ghostActs}>
            <Button
              variant="ghost"
              size="sm"
              label={t("usageQueue.switchAi", agentGrammar(agent))}
              onPress={() => openAgentAi(agentId)}
            />
          </View>
        </View>
      ) : null}
    </>
  );
  const skippedList = (
    <View>
      {queue.closed.map((row) => (
        <SkippedRow key={row.runId} row={row} agentId={agentId} now={now} />
      ))}
    </View>
  );
  return (
    <>
      <SheetTitle
        // Asleep while it waits on the limit, at work once it picks up.
        leading={
          <OpensAgent agentId={agentId}>
            <AgentFace agentId={agentId} size={32} mode={resuming ? "run" : queue.reason ? "sleep" : "idle"} />
          </OpensAgent>
        }
        title={usageQueueTitle(t, i18n.language, agent, queue, new Date(now))}
        hint={shared || undefined}
      />
      {waiting > 0 && skipped > 0 ? (
        <Segmented
          wide
          value={tab}
          onChange={(key) => setChosen(key as UsageQueueTab)}
          items={[
            { key: "queued", label: t("usageQueue.queuedTab"), count: waiting },
            { key: "skipped", label: t("usageQueue.skippedTab"), count: skipped },
          ]}
        />
      ) : null}
      {waiting === 0 && skipped === 0 ? (
        <EmptyState size="inline" title={t("usageQueue.empty")} />
      ) : waiting > 0 && skipped > 0 ? (
        <SameHeight
          shown={tab === "queued" ? queuedList : skippedList}
          other={tab === "queued" ? skippedList : queuedList}
        />
      ) : tab === "queued" ? (
        queuedList
      ) : (
        skippedList
      )}
    </>
  );
}

/**
 * The list shown, with the other laid out unseen under it: the sheet keeps the taller one's height, so its top stays
 * put between the two lists.
 */
function SameHeight({ shown, other }: { shown: ReactNode; other: ReactNode }) {
  const [minHeight, setMinHeight] = useState(0);
  return (
    <View style={[styles.lists, { minHeight }]}>
      {shown}
      <View
        style={[styles.lists, styles.unseen]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(e) => setMinHeight(e.nativeEvent.layout.height)}
      >
        {other}
      </View>
    </View>
  );
}

/** The conversation at the message, with the sheet closed. */
function useOpenConversation() {
  const sheet = useSheetIfAny();
  return (row: { channelId: string; threadId: string | null; messageId: string }) => {
    sheet?.close();
    router.push(chatHref(row.channelId, row.threadId, row.messageId));
  };
}

/** "1 #suporte · Ana e Bruno · há 40 min", then "Não rodar" where the viewer may, or "Respondendo". */
function WaitingRow({ n, row, agentId, now }: { n: number; row: UsageQueueRow; agentId: string; now: number }) {
  const { t, i18n } = useTranslation();
  const meId = useMeId() ?? "";
  const dir = useDirectory();
  const open = useOpenConversation();
  const person = (id: string) =>
    id === meId ? t("common.you") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  const where = usageQueueWhere(t, row, meId, person);
  const who = usageQueueWho(t, i18n.language, row, person, new Date(now));
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.open, pressed && styles.pressed]}
        onPress={() => open(row)}
        accessibilityRole="link"
        accessibilityLabel={`${n}. ${where}, ${who}`}
      >
        <Text variant="small" tone="faint" style={styles.n}>
          {n}
        </Text>
        <Text variant="small" tone="muted" style={styles.what}>
          <Text variant="small" tone="ink" style={styles.name}>
            {where}
          </Text>
          {` · ${who}`}
        </Text>
      </Pressable>
      {row.state === "answering" ? (
        <View style={styles.now}>
          <PixelOrbit color={agentLook(dir.anyAgent(agentId)).color} size={12} />
          <Text variant="footnote" tone="ink2" style={styles.name}>
            {t("usageQueue.answering")}
          </Text>
        </View>
      ) : row.mayStop ? (
        <View style={styles.act}>
          <DontRunButton runId={row.runId} may />
        </View>
      ) : null}
    </View>
  );
}

/** "#financeiro · há 4 min" over "Nina já cuidou disso", then "Responder mesmo assim" for who may. */
function SkippedRow({ row, agentId, now }: { row: UsageQueueClosedRow; agentId: string; now: number }) {
  const { t, i18n } = useTranslation();
  const open = useOpenConversation();
  const where = usageQueueSkippedWhere(t, row);
  const ago = relativeTime(t, i18n.language, row.closed.at, new Date(now));
  const why = usageQueueSkipReason(t, row.closed);
  return (
    <View style={styles.skipped}>
      <Pressable
        style={({ pressed }) => [styles.skippedOpen, pressed && styles.pressed]}
        onPress={() => open(row)}
        accessibilityRole="link"
        accessibilityLabel={`${where}, ${ago}, ${why}`}
      >
        <Text variant="small" tone="muted">
          <Text variant="small" tone="ink" style={styles.name}>
            {where}
          </Text>
          {` · ${ago}`}
        </Text>
        <Text variant="footnote" tone="muted">
          {why}
        </Text>
      </Pressable>
      {row.continuedRunId ? (
        <Text variant="footnote" tone="muted">
          {t("usageQueue.answeredAnyway")}
        </Text>
      ) : row.mayAnswer ? (
        <View style={styles.ghostActs}>
          <AnswerAnywayButton runId={row.runId} agentId={agentId} closed={row.closed} />
        </View>
      ) : null}
    </View>
  );
}

/** "Don't run any", asked once in place. */
function StopAll({ agentId, count }: { agentId: string; count: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const failed = useFailed();
  const stop = useCancelUsageQueue(orgId, agentId);
  const [asking, setAsking] = useState(false);
  if (!asking)
    return <Button variant="secondary" size="sm" label={t("usageQueue.dontRunAll")} onPress={() => setAsking(true)} />;
  return (
    <View style={styles.confirm}>
      <Text variant="small" tone="ink" style={styles.name}>
        {t("usageQueue.confirmAll", { count })}
      </Text>
      <View style={styles.confirmActs}>
        <Button variant="secondary" size="sm" label={t("usageQueue.keep")} onPress={() => setAsking(false)} />
        <Button
          variant="primary"
          size="sm"
          label={t("usageQueue.yesDontRun")}
          loading={stop.isPending}
          onPress={() => stop.mutate(undefined, { onSuccess: () => setAsking(false), onError: failed })}
        />
      </View>
    </View>
  );
}

/** A row's place-in-line column and the gap to its words. */
const N_WIDTH = 16;
const N_GAP = 10;

const styles = StyleSheet.create({
  loading: { marginVertical: 24 },
  failed: { gap: 12, alignItems: "flex-start", marginVertical: 12 },
  // The row is the conversation's link, 44pt tall; "Não rodar" keeps its own target on the right.
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  open: { flex: 1, minWidth: 0, flexDirection: "row", gap: N_GAP, paddingVertical: 12 },
  pressed: { opacity: 0.6 },
  n: { width: N_WIDTH, fontVariant: ["tabular-nums"], fontWeight: "600" },
  what: { flex: 1, minWidth: 0 },
  name: { fontWeight: "600" },
  // The 36pt text button centered on the row's first line (12 above a 20pt line).
  act: { paddingTop: 4 },
  now: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 12 },
  // "+1 que você não vê": under the rows' text, past the number column.
  hidden: { paddingLeft: N_WIDTH + N_GAP, marginTop: -4 },
  skipped: { paddingVertical: 8 },
  skippedOpen: { paddingVertical: 4 },
  // Words-only actions: the ghost button's own side padding hangs outside, so its words line up with the text.
  ghostActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginLeft: -14 },
  owner: { gap: 4, marginTop: 4, alignItems: "flex-start" },
  confirm: { gap: 8 },
  confirmActs: { flexDirection: "row", gap: 8 },
  // The sheet's own gap between its rows (SheetHost).
  lists: { gap: 12 },
  unseen: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0 },
});
