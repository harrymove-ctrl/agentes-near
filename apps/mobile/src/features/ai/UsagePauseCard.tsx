import { type CatchUpClosed, keys, type Message, useApi } from "@agenteschat/client";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  answerAnywayOpen,
  mayAnswerAnyway,
  mayContinueUsage,
  usagePauseCardOf,
  usagePauseText,
  usageWaitFix,
  usageWaitOf,
} from "@agenteschat/client/lib/usage-pause";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, EventPillAction, EventPillText, Text } from "@/ui";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { AskDone, AskWaiting } from "../chat/asks";
import { UsageQueueSheet } from "../queue/UsageQueueSheet";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";
import { useSheetIfAny } from "../shared/SheetHost";
import { openAgentAi } from "./AgentAiScreen";

/**
 * "Don't run it" on what waits for a plan's or budget's limit (the web's): cancels the run, so nothing runs when the
 * limit is back; the agent's status and its queue follow.
 */
function useDontRun(runId: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const go = async () => {
    if (!runId) return;
    setPending(true);
    try {
      await api.agents.cancelRun(orgId, runId);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
      void qc.invalidateQueries({ queryKey: keys.agentStatus(orgId) });
    }
  };
  return { pending, go };
}

/**
 * "Don't run it" as words only (a ghost button): put it in `textActs`. Greyed for anyone but the person behind it,
 * the agent's owner and admins.
 */
export function DontRunButton({ runId, may, count = 1 }: { runId: string | null; may: boolean; count?: number }) {
  const { t } = useTranslation();
  const { pending, go } = useDontRun(runId);
  if (!runId) return null;
  return (
    <Button
      variant="text"
      size="sm"
      label={count > 1 ? t("usageCard.dontRunThese", { count }) : t("usageCard.dontRun")}
      loading={pending}
      disabled={!may}
      onPress={() => void go()}
    />
  );
}

/**
 * "Responder mesmo assim" on a catch-up skipped as already handled (ADR 0136, the web's): the agent answers now. Anyone
 * who asked in it, the agent's owner and admins, for a week; anyone else sees it greyed. Words only, like Não rodar.
 */
export function AnswerAnywayButton({
  runId,
  agentId,
  closed,
}: {
  runId: string;
  agentId: string | null;
  closed: CatchUpClosed;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  if (!answerAnywayOpen(closed)) return null;
  const owner = dir.agentById.get(agentId ?? "")?.ownerUserId;
  const may = mayAnswerAnyway(closed, meId, owner, can(org, "manage_agents"));
  return (
    <Button
      variant="ghost"
      size="sm"
      label={t("usageCard.answerAnyway")}
      loading={pending}
      disabled={!may}
      onPress={() => {
        setPending(true);
        api.agents
          .continueRun(orgId, runId)
          .catch(failed)
          .finally(() => {
            setPending(false);
            void qc.invalidateQueries({ queryKey: keys.agentStatus(orgId) });
          });
      }}
    />
  );
}

/**
 * Under an agent's "I'll answer when the plan resets" (the web's): "Don't run it" while the run still waits; once the
 * catch-up was skipped as already handled, "Responder mesmo assim" until someone presses it.
 */
export function UsageWaitCancel({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const sheet = useSheetIfAny();
  const { org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const wait = m.author.type === "agent" ? usageWaitOf(m.meta) : null;
  const skipped = wait?.closed && !wait.continuedByUserId ? wait.closed : null;
  if (!wait || (!skipped && (wait.canceled || wait.ended))) return null;
  const owner = dir.agentById.get(m.author.id ?? "")?.ownerUserId;
  const admin = can(org, "manage_agents");
  const mayStop = mayContinueUsage(wait, meId, owner, admin);
  // Who may press it, under the row, for anyone it is greyed for.
  const forbidden = skipped
    ? answerAnywayOpen(skipped) && !mayAnswerAnyway(skipped, meId, owner, admin)
      ? "usageCard.answerAnywayForbidden"
      : null
    : wait.runId && !mayStop
      ? "usageCard.dontRunForbidden"
      : null;
  const fix = !skipped && m.author.id ? usageWaitFix(m.meta, { admin, owner: owner === meId }) : null;
  return (
    <View style={styles.acts}>
      <View style={styles.textActs}>
        {fix ? (
          <Button
            variant="secondary"
            size="sm"
            label={t(`usageCard.${fix}`)}
            onPress={() => (fix === "raiseBudget" ? openAgentEdit : openAgentAi)(m.author.id ?? "")}
          />
        ) : null}
        {skipped ? (
          <AnswerAnywayButton runId={wait.runId} agentId={m.author.id ?? null} closed={skipped} />
        ) : (
          <DontRunButton runId={wait.runId} may={mayStop} count={wait.count} />
        )}
        {m.author.id && sheet ? (
          <Button
            variant="ghost"
            size="sm"
            label={t("queue.see")}
            onPress={() =>
              sheet.open(<UsageQueueSheet agentId={m.author.id ?? ""} tab={skipped ? "skipped" : undefined} />)
            }
          />
        ) : null}
      </View>
      {forbidden ? (
        <Text variant="footnote" tone="faint">
          {t(forbidden)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The web's pause of long work near its plan's or budget's limit (ADR 0118), in place of its text, as a waiting pill:
 * when it picks up by itself under it, and "Continue now" (tinted) and "Don't run it" for the person behind the work,
 * the agent's owner and admins (anyone else reads who may press them). Then a decided request's pill: who let it go
 * on, or that it picked up, ended or was canceled.
 */
export function UsagePauseCard({ message: m }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = usagePauseCardOf(m.meta);
  const dontRun = useDontRun(card?.runId ?? null);
  if (!card || m.author.type !== "agent") return null;
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const { title, line } = usagePauseText(t, i18n.language, card, name);
  const may = mayContinueUsage(card, meId, agent?.ownerUserId, can(org, "manage_agents"));
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(orgId, m.id);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };
  if (card.state === "continued" && by)
    return (
      <AskDone
        done
        words={
          by === meId
            ? t("stretchCard.continuedByYou", { time })
            : t("stretchCard.continued", { name: dir.memberById.get(by)?.name ?? t("channel.unknownPerson"), time })
        }
      />
    );
  if (card.state === "resumed" || card.state === "ended" || card.state === "canceled")
    return <AskDone done={card.state === "resumed"} words={t(`usageCard.${card.state}`, { agent: name })} />;
  const busy = pending || dontRun.pending;
  return (
    <AskWaiting
      forMe={may}
      mark="pause"
      words={title}
      actions={
        may
          ? [
              <EventPillAction
                key="continue"
                primary
                label={t("usageCard.continue")}
                loading={pending}
                disabled={busy}
                onPress={() => void go()}
              />,
              card.runId ? (
                <EventPillAction
                  key="dontRun"
                  label={t("usageCard.dontRun")}
                  loading={dontRun.pending}
                  disabled={busy}
                  onPress={() => void dontRun.go()}
                />
              ) : null,
            ]
          : null
      }
      below={
        <EventPillText>
          <Text variant="footnote" tone="muted">
            {line}
          </Text>
          {may ? null : (
            <Text variant="footnote" tone="muted">
              {t("usageCard.forbidden")}
            </Text>
          )}
        </EventPillText>
      }
    />
  );
}

const styles = StyleSheet.create({
  acts: { gap: 2, alignItems: "flex-start" },
  // Words-only actions: the ghost buttons' own side padding hangs outside, so their words line up with the text.
  textActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginLeft: -14 },
});
