import type { Message, ComputerQueue as Queue, QueueWhere } from "@agenteschat/client";
import { receiptView, useChannels, useDms, useMachineQueue, useMachines } from "@agenteschat/client";
import {
  type ConversationWait,
  conversationWaits,
  durationText,
  fanChipText,
  fanOutOf,
  fanOutText,
  fanShows,
  nthText,
  type QueueNames,
  type QueuePlace,
  queueAllStartedText,
  queueButtonText,
  queuedNextText,
  queueFillText,
  queueLeftText,
  queueLiveText,
  queuePurposeText,
  queueStartText,
  queueStatusText,
  queueView,
  queueWhereText,
  waitingFor,
} from "@agenteschat/client/lib/computer-queue";
import { badgeCount } from "@agenteschat/client/lib/unread";
import {
  Button,
  Chip,
  CountChip,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Message as MessageRow,
  useNow,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { StopTaskButton, useTaskStop } from "@/components/tasks/TaskBits";
import { useDirectory } from "@/hooks/useDirectory";
import { useLive } from "@/realtime/context";
import "./computer-queue.css";

/**
 * A shared computer's line (ADR 0032, "Calm waits"): the dialog every member can open in place, the waiting agent's
 * turn after the message it answers, the strip under an agent's message that called several agents, and the
 * conversation header's button while anyone waits. Every time is an estimate ("~N min").
 */

/** The computer an agent runs on, from the computers list (every member reads it). */
export function useAgentMachineId(agentId: string | null | undefined) {
  const { org } = useOrg();
  const machines = useMachines(org.id, Boolean(agentId));
  return machines.data?.find((m) => m.agents.some((a) => a.id === agentId))?.id ?? null;
}

/** The computer most of these agents share (a channel's agents nearly always share one). */
export function useAgentsMachineId(agentIds: readonly string[]) {
  const { org } = useOrg();
  const machines = useMachines(org.id, agentIds.length > 0);
  // ponytail: one computer per conversation; a channel whose agents split over several shows the busiest share only.
  let best: { id: string; n: number } | null = null;
  for (const m of machines.data ?? []) {
    const n = m.agents.filter((a) => agentIds.includes(a.id)).length;
    if (n > 0 && (!best || n > best.n)) best = { id: m.id, n };
  }
  return best?.id ?? null;
}

function useQueueNames(): QueueNames & { place: (w: QueueWhere) => QueuePlace } {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  return {
    viewerId: me.user.id,
    agent: (id) => dir.agentById.get(id)?.name,
    person: (id) => dir.memberById.get(id)?.name,
    place: (w) => {
      if (w.agents) return { kind: "agents" };
      const channel = channels.data?.find((c) => c.id === w.channelId);
      if (channel) return { kind: "channel", name: channel.name, thread: w.threadId !== null };
      if (dms.data?.some((d) => d.channelId === w.channelId)) return { kind: "dm", mine: true };
      return { kind: "hidden" };
    },
  };
}

/** "See queue": a link-like button that opens the computer's line over the conversation. */
export function SeeQueue({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="cq-link" onClick={() => setOpen(true)}>
        {t("queue.see")}
      </button>
      {open && <QueueDialog machineId={machineId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** The computer's line: how full it is, what fills it, every turn working on it, and the order of the rest. */
export function QueueDialog({
  machineId,
  open,
  onOpenChange,
  onOpenComputer,
}: {
  machineId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenComputer?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const q = useMachineQueue(org.id, machineId, open);
  const names = useQueueNames();
  // Elapsed times and estimates move on while it is open.
  const now = useNow(open ? 1000 : false);
  const queue = q.data;
  const name = queue?.name ?? t("queue.buttonIdle");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          <span aria-hidden="true">{name}</span>
          <span className="ac-visually-hidden">{t("queue.label", { name })}</span>
        </>
      }
      closeLabel={t("common.close")}
      width={440}
      className="cq-dialog"
      subtitle={queue ? queueStatusText(t, queueView(queue, names.viewerId), now) : undefined}
    >
      <DialogBody>
        {queue ? (
          <QueueLists queue={queue} names={names} now={now} onLeave={() => onOpenChange(false)} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingList count={3} />
        )}
      </DialogBody>
      {onOpenComputer && (
        <DialogFooter>
          <Button icon="computer" onClick={onOpenComputer}>
            {t("queue.openComputer")}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}

/** A row's text, opening its task where the viewer sees it, then its stop. */
function QueueRowBody({
  row,
  name,
  onOpen,
  onStop,
  stopping,
  children,
}: {
  row: { canOpen?: boolean; canStop?: boolean };
  name: string;
  onOpen: () => void;
  onStop: () => void;
  stopping: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {row.canOpen ? (
        <button
          type="button"
          className="cq__text cq__open"
          aria-label={`${t("queue.openTask")}: ${name}`}
          onClick={onOpen}
        >
          {children}
        </button>
      ) : (
        <span className="cq__text">{children}</span>
      )}
      {row.canStop && (
        <StopTaskButton label={t("taskManager.actions.stop")} title={name} stopping={stopping} onClick={onStop} />
      )}
    </>
  );
}

function QueueLists({
  queue,
  names,
  now,
  onLeave,
}: {
  queue: Queue;
  names: ReturnType<typeof useQueueNames>;
  now: number;
  /** An agent's picture or a task opened elsewhere: the dialog gives way. */
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const { stop, stopping } = useTaskStop();
  const view = queueView(queue, names.viewerId);
  const allStarted = queueAllStartedText(t, view, now);
  const fill = queueFillText(t, view.working);
  const agentName = (id: string) => names.agent(id) ?? t("channel.unknownAgent");
  const open = (runId: string) => {
    onLeave();
    void navigate({ to: "/org/$orgId/task-manager", params: { orgId: org.id }, search: { task: runId } });
  };
  return (
    <div className="cq">
      <section className="cq__group">
        <h3 className="cq__title">
          <span>{t("queue.workingNow", { n: view.working.length })}</span>
        </h3>
        {fill && <p className="cq__fill">{fill}</p>}
        {view.working.length === 0 && <p className="cq__empty">{t("queue.nothingWorking")}</p>}
        <ol className="cq__rows">
          {view.working.map((w) => (
            <li key={w.runId} className="cq__row" data-mine={w.mine || undefined}>
              <OpensAgent agentId={w.agentId} onOpen={onLeave}>
                <AgentAvatar agentId={w.agentId} name={agentName(w.agentId)} size="xs" state="thinking" />
              </OpensAgent>
              <QueueRowBody
                row={w}
                name={agentName(w.agentId)}
                onOpen={() => open(w.runId)}
                onStop={() => stop([w.runId], undefined, true)}
                stopping={stopping.has(w.runId)}
              >
                <span className="cq__l1">
                  <b>{agentName(w.agentId)}</b>
                  <span className="cq__time">{queueLeftText(t, w, now)}</span>
                </span>
                <span className="cq__l2">
                  {[
                    queuePurposeText(t, w.purpose, names),
                    queueWhereText(t, names.place(w.where)),
                    durationText(t, Math.max(0, now - Date.parse(w.startedAt))),
                  ].join(" · ")}
                </span>
              </QueueRowBody>
            </li>
          ))}
        </ol>
      </section>
      {view.waiting.length > 0 && (
        <section className="cq__group">
          <h3 className="cq__title">
            <span>{t("queue.inLine", { n: view.waiting.length })}</span>
            {allStarted && <span className="cq__all">{allStarted}</span>}
          </h3>
          <ol className="cq__rows">
            {view.waiting.map((w) => (
              <li key={w.runId} className="cq__row" data-mine={w.mine || undefined}>
                <OpensAgent agentId={w.agentId} onOpen={onLeave}>
                  <AgentAvatar agentId={w.agentId} name={agentName(w.agentId)} size="xs" state="idle" />
                </OpensAgent>
                <QueueRowBody
                  row={w}
                  name={agentName(w.agentId)}
                  onOpen={() => open(w.runId)}
                  onStop={() => stop([w.runId], undefined, true)}
                  stopping={stopping.has(w.runId)}
                >
                  <span className="cq__l1">
                    <b>{agentName(w.agentId)}</b>
                    <span className="cq__nth">{nthText(t, i18n.language, w.position)}</span>
                    <span className="cq__time">{queueStartText(t, w, names.agent, now)}</span>
                  </span>
                  <span className="cq__l2">
                    {[queuePurposeText(t, w.purpose, names), queueWhereText(t, names.place(w.where))].join(" · ")}
                  </span>
                  {w.mine && w.people && <Chip className="cq-first">{t("queue.youFirst")}</Chip>}
                </QueueRowBody>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="cq__rule">{t("queue.rule")}</p>
    </div>
  );
}

/** The waiting turns of a message's agents in their computer's line, resolved as `waitingFor` finds them. */
function useQueueWaits(message: Message) {
  const { org } = useOrg();
  const receipt = useLive((s) => s.receipts[message.id]);
  const status = receiptView(receipt).status;
  const agents = status?.kind === "queued" ? status.agents : [];
  const machineId = useAgentsMachineId(agents);
  const q = useMachineQueue(org.id, machineId, agents.length > 0);
  const rows = agents.flatMap((id) => waitingFor(q.data, receipt, id, message.channelId) ?? []);
  // The fan-out strip says where each stands instead.
  const fanned = fanShows(message, fanOutOf(receipt, q.data), receipt);
  return { agents, rows: fanned ? [] : rows };
}

/**
 * The receipt of a message whose agents wait in line: "Theo is in line for the computer · next" when its one agent
 * is next, else `fallback` (the plain queued line). Once, whatever the number of agents.
 */
export function QueuedWords({ message, fallback }: { message: Message; fallback: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const { agents, rows } = useQueueWaits(message);
  const next = agents.length === 1 && rows[0]?.position === 1 ? dir.agentById.get(rows[0].agentId)?.name : undefined;
  return <span>{next ? queuedNextText(t, next) : fallback}</span>;
}

const sameWaits = (a: ConversationWait[], b: ConversationWait[]) =>
  a.length === b.length && a.every((w, i) => w.agentId === b[i]?.agentId && w.runId === b[i]?.runId);

/**
 * Where "thinking" shows, at the end of the conversation, for each run of these messages that waits in line for its
 * computer: one turn per run, whatever number of messages went into it. It lives as long as the receipts say the run
 * waits, and its computer's line only adds to it.
 */
export function QueueWaitTurns({ channelId, messages }: { channelId: string; messages: readonly Message[] }) {
  const waits = useLive((s) => conversationWaits(messages, s.receipts, (id) => id in s.streams.runs), sameWaits);
  return (
    <>
      {waits.map((w) => (
        <QueueWaitTurn key={w.runId ?? w.agentId} wait={w} channelId={channelId} />
      ))}
    </>
  );
}

/**
 * The agent's turn (its face, its name): "Waiting for the computer. Next up, in about 1 min" or "In line, 4th. After
 * Ada, Kai and Ravi", "You go first" on the viewer's own request, and "See queue"; "Waiting for the computer" until
 * the line knows the turn.
 */
function QueueWaitTurn({ wait: { agentId, runId }, channelId }: { wait: ConversationWait; channelId: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const now = useNow(30_000);
  const machineId = useAgentMachineId(agentId);
  const queue = useMachineQueue(org.id, machineId).data;
  const w = waitingFor(queue, runId ? { runOf: { [agentId]: runId } } : undefined, agentId, channelId);
  const agentName = (id: string) => dir.agentById.get(id)?.name;
  const name = agentName(agentId) ?? t("channel.unknownAgent");
  const text = w ? queueLiveText(t, i18n.language, queue, w.runId, agentName, now) : t("queue.live.waiting");
  const first = w?.people && w.purpose.kind === "person" && w.purpose.userId === me.user.id;
  return (
    <MessageRow
      agent
      stacked
      className="cq-turn"
      avatar={<AgentAvatar agentId={agentId} name={name} state="idle" />}
      author={name}
      time={null}
    >
      <p className="cq-turn__say ac-iconline" aria-live="polite">
        <Icon name="waiting" size={14} />
        <span>{text}</span>
      </p>
      <span className="cq-turn__acts">
        {first && <Chip className="cq-first">{t("queue.youFirst")}</Chip>}
        {machineId && <SeeQueue machineId={machineId} />}
      </span>
    </MessageRow>
  );
}

/**
 * Under a message that called several agents, once two or more started: "12 agents called · 2 answered · 2 working ·
 * 8 in line" and a chip per agent, live. `otherwise` (the receipt's own line) before that, and once every one is done.
 */
export function FanOutStrip({ message, otherwise = null }: { message: Message; otherwise?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const receipt = useLive((s) => s.receipts[message.id]);
  const plain = fanOutOf(receipt);
  const open = plain?.agents.filter((a) => a.state === "working" || a.state === "inLine") ?? [];
  const machineId = useAgentMachineId(open[0]?.agentId);
  const q = useMachineQueue(org.id, machineId, open.length > 0);
  const fan = fanOutOf(receipt, q.data);
  if (!fanShows(message, fan, receipt)) return otherwise;
  return (
    <section className="cq-fan" aria-label={fanOutText(t, fan)}>
      <p className="cq-fan__head">
        <span>{fanOutText(t, fan)}</span>
        {machineId && <SeeQueue machineId={machineId} />}
      </p>
      <ul className="cq-fan__chips">
        {fan.agents.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? t("channel.unknownAgent");
          return (
            <li key={a.agentId}>
              <Chip
                className="cq-fan__chip"
                data-state={a.state}
                lead={<AgentAvatar agentId={a.agentId} name={name} size="xs" state="idle" />}
              >
                {name} <small>{fanChipText(t, i18n.language, a)}</small>
              </Chip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The conversation header's computer button: "Computer · 9 waiting" while anyone waits for this computer, opening the
 * line, else `idle` (a DM's own Computer button). `onOpenComputer` gives the line "Open the computer".
 */
/** The computer's state a header button shows as a dot (`brw-dm`), and says to a screen reader. */
export type EntrySignal = { state?: "waiting" | "live"; style?: CSSProperties; line?: string };

export function QueueButton({
  machineId,
  idle = null,
  signal,
  onOpenComputer,
}: {
  machineId: string | null;
  idle?: ReactNode;
  signal?: EntrySignal;
  onOpenComputer?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const q = useMachineQueue(org.id, machineId);
  const [open, setOpen] = useState(false);
  const waiting = machineId ? (q.data?.waiting.length ?? 0) : 0;
  return (
    <>
      {waiting > 0 ? (
        <Button
          size="sm"
          icon="computer"
          className={signal ? "cq-btn brw-dm" : "cq-btn"}
          data-state={signal?.state}
          style={signal?.style}
          onClick={() => setOpen(true)}
        >
          <span className="cq-btn__label">{queueButtonText(t, q.data)}</span>
          <CountChip size="sm" className="cq-btn__count" aria-hidden="true">
            {badgeCount(waiting)}
          </CountChip>
          {signal?.line && <span className="ac-visually-hidden">{signal.line}</span>}
        </Button>
      ) : (
        idle
      )}
      {/* Stays open as the line empties: the person sees it end. */}
      {open && machineId && (
        <QueueDialog
          machineId={machineId}
          open={open}
          onOpenChange={setOpen}
          onOpenComputer={
            onOpenComputer &&
            (() => {
              setOpen(false);
              onOpenComputer();
            })
          }
        />
      )}
    </>
  );
}
