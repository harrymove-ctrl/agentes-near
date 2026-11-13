import type { UsageQueue, UsageQueueClosedRow } from "@agenteschat/client";
import { useCancelUsageQueue, useUsageQueue } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  usageQueueMeta,
  usageQueueResuming,
  usageQueueShared,
  usageQueueSkippedWhere,
  usageQueueSkipReason,
  usageQueueStoppable,
  usageQueueTitle,
  usageQueueWhere,
  usageQueueWho,
  usageWaitingText,
} from "@agenteschat/client/lib/usage-queue";
import { Button, Chip, Dialog, DialogBody, DialogFooter, InfoHint, Segmented, useNow } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { AnswerAnywayButton, DontRunButton, TextAction } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useAgentPresence } from "@/hooks/usePresence";
import { useToast } from "@/lib/toast";
import "./computer-queue.css";

/** The dialog's two lists: what it picks up when the limit is back, and what it skipped as already handled. */
export type UsageQueueTab = "queued" | "skipped";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118): one short row per conversation in the order it
 * picks them up, "Não rodar" where the viewer may use it ("Não rodar nenhuma" and "Change its AI" for its owner and
 * admins), and, in a second list, what it skipped as already handled (ADR 0136). A dialog over the page the person is
 * on, opened from its waiting note, its out-of-office line, its page and its owner's notice; `tab` "skipped" from a
 * skip.
 */
export function SeeUsageQueue({ agentId, tab }: { agentId: string; tab?: UsageQueueTab }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextAction onClick={() => setOpen(true)}>{t("queue.see")}</TextAction>
      {open && <UsageQueueDialog agentId={agentId} open={open} onOpenChange={setOpen} tab={tab} />}
    </>
  );
}
/** On the agent's page, out of office with conversations waiting: "Sem limite no plano · 7 conversas esperando". */
export function UsageQueueChip({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const line = useAgentPresence(agentId)?.line;
  const [open, setOpen] = useState(false);
  const kind = line?.kind === "out_of_plan" || line?.kind === "out_of_budget" ? line.kind : null;
  const count = kind ? (line?.count ?? 0) : 0;
  if (!kind || count === 0) return null;
  return (
    <>
      <button type="button" className="noai-chip" title={t("queue.see")} onClick={() => setOpen(true)}>
        <Chip icon="waiting" tone="waiting">
          {`${t(`presence.agent.${kind}`)} · ${usageWaitingText(t, count)}`}
        </Chip>
      </button>
      {open && <UsageQueueDialog agentId={agentId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function UsageQueueDialog({
  agentId,
  open,
  onOpenChange,
  tab: initialTab = "queued",
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The list it opens on, when both have something. */
  tab?: UsageQueueTab;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const q = useUsageQueue(org.id, agentId, open);
  const now = useNow(open ? 60_000 : false);
  const agent = dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const queue = q.data;
  const waiting = queue ? queue.rows.length + queue.hidden : 0;
  const skipped = queue?.closed.length ?? 0;
  const [chosen, setChosen] = useState<UsageQueueTab>(initialTab);
  // The switch only when both lists have something: otherwise the one that does.
  const tab: UsageQueueTab = waiting === 0 ? "skipped" : skipped === 0 ? "queued" : chosen;
  const leave = () => onOpenChange(false);
  // "Não rodar nenhuma?" asked in place takes the whole footer.
  const [asking, setAsking] = useState(false);
  const title = queue ? usageQueueTitle(t, i18n.language, agent, queue, new Date(now)) : agent;
  const shared = queue
    ? usageQueueShared(
        t,
        queue.plan,
        queue.sharedWith.flatMap((id) => dir.agentById.get(id)?.name ?? []),
      )
    : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        shared ? (
          <span className="ac-hintline">
            {title}
            <InfoHint name={t("usageQueue.about")}>{shared}</InfoHint>
          </span>
        ) : (
          title
        )
      }
      // Asleep while it waits on the limit, awake (its live state) once it picks up.
      leading={
        <OpensAgent agentId={agentId} onOpen={leave}>
          <AgentAvatar
            agentId={agentId}
            name={agent}
            size="sm"
            state={queue?.reason && !usageQueueResuming(queue) ? "sleeping" : undefined}
          />
        </OpensAgent>
      }
      closeLabel={t("common.close")}
      width={440}
      className="cq-dialog uq-dialog"
    >
      <DialogBody>
        {queue ? (
          <div className="uq">
            {waiting > 0 && skipped > 0 && (
              <Segmented
                block
                size="sm"
                label={t("usageQueue.lists")}
                value={tab}
                onValueChange={setChosen}
                options={[
                  { value: "queued", label: t("usageQueue.queuedTab"), count: waiting },
                  { value: "skipped", label: t("usageQueue.skippedTab"), count: skipped },
                ]}
              />
            )}
            {waiting === 0 && skipped === 0 ? (
              <p className="cq__empty">{t("usageQueue.empty")}</p>
            ) : tab === "queued" ? (
              <WaitingRows queue={queue} agentId={agentId} now={now} onLeave={leave} />
            ) : (
              <SkippedRows rows={queue.closed} agentId={agentId} now={now} onLeave={leave} />
            )}
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingList count={3} />
        )}
      </DialogBody>
      {queue?.mayStopAll && tab === "queued" && waiting > 0 && (
        <DialogFooter
          bar
          note={
            asking ? undefined : (
              <Link
                className="cq-link"
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId }}
                search={{ tab: "settings", sec: "brain" }}
                onClick={leave}
              >
                {t("usageQueue.switchAi", agentGrammar(agent))}
              </Link>
            )
          }
        >
          {usageQueueStoppable(queue) > 0 && (
            <StopAll
              agentId={agentId}
              agent={agent}
              count={usageQueueStoppable(queue)}
              asking={asking}
              onAsk={setAsking}
            />
          )}
        </DialogFooter>
      )}
    </Dialog>
  );
}

/** A row opens its conversation at the message, with the dialog closed. */
function useOpenConversation(onLeave: () => void) {
  const { org } = useOrg();
  const navigate = useNavigate();
  return (row: { channelId: string; threadId: string | null; messageId: string }) => {
    onLeave();
    void (row.threadId
      ? navigate({
          to: "/org/$orgId/threads/$threadId",
          params: { orgId: org.id, threadId: row.threadId },
          search: { m: row.messageId },
        })
      : navigate({
          to: "/org/$orgId/c/$channelId",
          params: { orgId: org.id, channelId: row.channelId },
          search: { m: row.messageId },
        }));
  };
}

/**
 * In the order it picks them up, one line each: "1 #suporte · Ana e Bruno · há 40 min", with "Não rodar" only where the
 * viewer may use it and "Respondendo" on the one it answers now. The whole row opens the conversation.
 */
function WaitingRows({
  queue,
  agentId,
  now,
  onLeave,
}: {
  queue: UsageQueue;
  agentId: string;
  now: number;
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const openConversation = useOpenConversation(onLeave);
  const person = (id: string) =>
    id === me.user.id ? t("common.you") : (dir.memberById.get(id)?.name ?? t("channel.unknownPerson"));
  return (
    <>
      {queue.rows.length > 0 && (
        <ol className="uq__rows">
          {queue.rows.map((row, i) => (
            <li
              key={row.runId}
              className="uq__row"
              title={usageQueueMeta(t, i18n.language, row, person, new Date(now))}
            >
              <button type="button" className="uq__open" onClick={() => openConversation(row)}>
                <span className="uq__n">{i + 1}</span>
                <span className="uq__what">
                  <b>{usageQueueWhere(t, row, me.user.id, person)}</b>
                  <span className="uq__meta">{` · ${usageQueueWho(t, i18n.language, row, person, new Date(now))}`}</span>
                </span>
              </button>
              <span className="uq__act">
                {row.state === "answering" ? (
                  <span className="uq__now">
                    <AgentSpinner agentId={agentId} />
                    {t("usageQueue.answering")}
                  </span>
                ) : row.mayStop ? (
                  <DontRunButton runId={row.runId} may />
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      {queue.hidden > 0 && <p className="uq__hidden">{t("usageQueue.hidden", { count: queue.hidden })}</p>}
    </>
  );
}

/**
 * What it skipped in the last day as already handled (ADR 0136): where and when over why, and "Responder mesmo assim"
 * for who may. A wrong skip is one look and one click away.
 */
function SkippedRows({
  rows,
  agentId,
  now,
  onLeave,
}: {
  rows: UsageQueueClosedRow[];
  agentId: string;
  now: number;
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const openConversation = useOpenConversation(onLeave);
  return (
    <ol className="uq__rows">
      {rows.map((row) => (
        <li key={row.runId} className="uq__row" data-two="">
          <button type="button" className="uq__open" onClick={() => openConversation(row)}>
            <span className="uq__what">
              <b>{usageQueueSkippedWhere(t, row)}</b>
              <span className="uq__meta">{` · ${relativeTime(t, i18n.language, row.closed.at, new Date(now))}`}</span>
              <span className="uq__why">{usageQueueSkipReason(t, row.closed)}</span>
            </span>
          </button>
          <span className="uq__act">
            {row.continuedRunId ? (
              <span className="uq__done">{t("usageQueue.answeredAnyway")}</span>
            ) : row.mayAnswer ? (
              <AnswerAnywayButton runId={row.runId} agentId={agentId} closed={row.closed} />
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "Don't run any", asked once in place: "Don't run these 7?" with "Yes, don't run" and "Keep". */
function StopAll({
  agentId,
  agent,
  count,
  asking,
  onAsk: setAsking,
}: {
  agentId: string;
  agent: string;
  count: number;
  asking: boolean;
  onAsk: (asking: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const stop = useCancelUsageQueue(org.id, agentId);
  if (!asking) return <Button onClick={() => setAsking(true)}>{t("usageQueue.dontRunAll")}</Button>;
  return (
    <fieldset className="cq-confirm" aria-label={t("usageQueue.confirmAll", { count })}>
      <span className="cq-confirm__ask">{t("usageQueue.confirmAll", { count })}</span>
      <Button variant="ghost" onClick={() => setAsking(false)}>
        {t("usageQueue.keep")}
      </Button>
      <Button
        variant="danger"
        loading={stop.isPending}
        onClick={() =>
          stop.mutate(undefined, {
            onSuccess: (r) => {
              setAsking(false);
              toast.show(t("usageQueue.canceledAll", { count: r.canceled, agent }));
            },
            onError: (error) => toast.show(errorText(t, error), "error"),
          })
        }
      >
        {t("usageQueue.yesDontRun")}
      </Button>
    </fieldset>
  );
}
