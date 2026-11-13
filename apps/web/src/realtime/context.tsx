import type {
  ActiveRun,
  Agent,
  AgentQuestion,
  ApiClient,
  BlockState,
  BudgetEvent,
  ChannelEvent,
  IssueColumn,
  MachineTask,
  MemoryUpdate,
  Message,
  SecretRequest,
  ThreadInfo,
  VoiceDroppedEvent,
} from "@agenteschat/client";
import {
  ApiError,
  applyBrowserHandoff,
  applyChannelEvent,
  applyComputerEvent,
  applyConsultEvent,
  applyConversationEvent,
  applyDashboardEvent,
  applyIssueEvent,
  applyMachineEvent,
  applyMembershipEvent,
  applyNotificationEvent,
  applyReactions,
  applyReceiptEvent,
  applyTyping,
  applyUnreadEvent,
  applyWorkspaceEvent,
  type BrowserFrame,
  type BrowserInputEvent,
  type BrowserLiveStatus,
  type BrowserLiveUnavailable,
  type ConnectionStatus,
  type ConsultsState,
  cacheActionCard,
  cacheAgentProposal,
  cacheApproval,
  cacheCardDelegate,
  cacheDmRead,
  cacheMessage,
  cacheMessageActions,
  cacheMessageMeta,
  cacheMessageWork,
  cachePinned,
  cacheReceipts,
  cacheTask,
  cacheTeamCard,
  catchUpChannel,
  consultSeeds,
  createBrowserLiveConnection,
  dismissRun,
  dropLocalVoice,
  dropProvisional,
  emptyStreams,
  expectReply,
  guessedFrom,
  guessReceipt,
  isActiveStatus,
  isNotificationEvent,
  keys,
  markStopping,
  type OpenConsult,
  openConversation,
  RealtimeConnection,
  type ReceiptsState,
  realtimeUrl,
  reconcileConsults,
  reconcileRuns,
  refreshMission,
  refreshProposals,
  refreshRepliedThread,
  repliedThread,
  retargetProvisional,
  runsInChannel,
  type SocketFactory,
  type StreamsState,
  seedReceipt,
  staleProvisional,
  startThreadCache,
  stopTyping,
  type TypingState,
  touchRun,
  typingThrottle,
  unmarkStopping,
  useIssueLive,
  useSendWaiting,
} from "@agenteschat/client";
import { type AgentUnavailableEvent, isAgentUnavailable } from "@agenteschat/client/lib/audience";
import { newerBlockState } from "@agenteschat/client/lib/blocks";
import { deviceWaitEventOf } from "@agenteschat/client/lib/devices";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { formatPercent } from "@agenteschat/client/lib/format";
import { nextMonthIso, usageWhen } from "@agenteschat/client/lib/plan-usage";
import { playSound, soundForNotification } from "@agenteschat/client/lib/sounds";
import { playAgentReaction } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { checkAppVersion } from "@/lib/app-version";
import { desktopNotice, inDesktopApp, thisMac } from "@/lib/desktop";
import { feedIsland, island } from "@/lib/island";
import { notificationAudience } from "@/lib/sounds";
import { useToast } from "@/lib/toast";
import { settleShownPushes } from "@/lib/web-push";

/** Live state shared by the channel and the sidebar: runs, receipts and who is typing. */
export interface LiveState {
  streams: StreamsState;
  receipts: ReceiptsState;
  typing: TypingState;
  /** Latest state of agent questions (answered elsewhere, or by us). */
  questions: Record<string, AgentQuestion>;
  /** Latest state of secret requests (answered here or elsewhere; ADR 0027). */
  secrets: Record<string, SecretRequest>;
  /** `memory.updated` cards per channel (live; they aren't in the message list). */
  memory: Record<string, LiveMemoryCard[]>;
  /** "O Theo só responde a Walter." per channel: only for me, never stored. */
  notices: Record<string, LiveNotice[]>;
  /** Stopped runs someone continued (`run.continued`, or our own "Continuar"): run id → the new run's id. */
  continued: Record<string, string | null>;
  /** Agents asking other agents right now (`agent.consulting` / `agent.consulted`), by the asking run. */
  consults: ConsultsState;
}

/** `run.continued`: someone pressed "Continuar" on a stopped answer. */
interface RunContinuedEvent {
  type: "run.continued";
  channelId: string;
  threadId: string | null;
  runId: string;
  newRunId: string;
  messageId: string;
}

export interface LiveNotice {
  key: string;
  agentId: string;
  threadId: string | null;
  messageId: string;
  /** `channel.agents_denied` (this channel's exceptions, ADR 0134) or the agent's audience, with what words it. */
  code?: string;
  params?: Record<string, unknown>;
}

export interface LiveMemoryCard {
  key: string;
  agentId: string;
  threadId: string;
  update: MemoryUpdate;
}

/** A small external store; components subscribe to slices of it (`useLive`). */
export const PROVISIONAL_TTL_MS = 20_000;

/**
 * The agent's message carries its memory cards (`meta.memoryUpdates`): drop the live ones it shows. From the event
 * when it carries the message, else from the HTTP read that follows (a big message's event comes without it).
 * The same object when nothing was dropped.
 */
function dropMemoryCards(
  memory: LiveState["memory"],
  channelId: string,
  message: Pick<Message, "agentRunId" | "meta">,
): LiveState["memory"] {
  const list = memory[channelId];
  const updates = message.meta?.memoryUpdates;
  if (!list || !message.agentRunId || !Array.isArray(updates)) return memory;
  const shown = new Set(updates.map((u) => `${message.agentRunId}:${(u as { itemId?: unknown }).itemId}`));
  const kept = list.filter((c) => !shown.has(c.key));
  return kept.length === list.length ? memory : { ...memory, [channelId]: kept };
}

export function createStreamsStore(
  initial: StreamsState = emptyStreams,
  now: () => number = () => Date.now(),
  provisionalTtlMs = PROVISIONAL_TTL_MS,
) {
  let state: LiveState = {
    streams: initial,
    receipts: {},
    typing: {},
    memory: {},
    questions: {},
    secrets: {},
    notices: {},
    continued: {},
    consults: {},
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  // Streaming deltas arrive many times a frame: their notifications wait for the next frame (one render
  // per frame, `get()` is always current). Anything else notifies at once, with whatever was waiting.
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = null;
    notify();
  };
  const set = (next: LiveState, batched = false) => {
    if (
      next.streams === state.streams &&
      next.receipts === state.receipts &&
      next.typing === state.typing &&
      next.memory === state.memory &&
      next.questions === state.questions &&
      next.secrets === state.secrets &&
      next.notices === state.notices &&
      next.continued === state.continued &&
      next.consults === state.consults
    )
      return;
    state = next;
    if (batched && batchFrames()) {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        notify();
      });
      return;
    }
    flush();
  };
  return {
    get: () => state,
    apply: (event: ChannelEvent) => {
      let typing = state.typing;
      if (event.type === "user.typing")
        typing = applyTyping(typing, event.channelId, event.userId, now(), event.ttlMs, event.threadId);
      const memory =
        event.type === "memory.updated"
          ? {
              ...state.memory,
              [event.channelId]: [
                ...(state.memory[event.channelId] ?? []).filter(
                  (m) => m.key !== `${event.runId}:${event.update.itemId}`,
                ),
                {
                  key: `${event.runId}:${event.update.itemId}`,
                  agentId: event.agentId,
                  threadId: event.threadId,
                  update: event.update,
                },
              ],
            }
          : event.type === "message.created" && event.message
            ? dropMemoryCards(state.memory, event.channelId, event.message)
            : state.memory;
      if (event.type === "message.created" && event.message?.author?.type === "person" && event.message.author.id) {
        typing = stopTyping(typing, event.channelId, event.message.author.id);
      }
      const questions =
        event.type === "question.asked" || event.type === "question.answered"
          ? { ...state.questions, [event.question.id]: event.question }
          : state.questions;
      const secrets =
        event.type === "secret.requested" || event.type === "secret.updated"
          ? { ...state.secrets, [event.secretRequest.id]: event.secretRequest }
          : state.secrets;
      const continued =
        event.type === ("run.continued" as string)
          ? {
              ...state.continued,
              [(event as unknown as RunContinuedEvent).runId]: (event as unknown as RunContinuedEvent).newRunId,
            }
          : state.continued;
      const streaming = event.type === "agent.delta" || event.type === ("agent.tool.output" as string);
      let streams = applyChannelEvent(state.streams, event, now());
      // Tentar de novo: a new run took a message whose run failed (the server deleted that one), so its failed row goes
      // and only the new run's shows.
      if (event.type === "message.claimed" || event.type === ("agent.run.steered" as string)) {
        const taken = event as { messageId: string; agentId?: string; runId?: string };
        const before = taken.agentId ? state.receipts[taken.messageId]?.runOf?.[taken.agentId] : undefined;
        if (before && before !== taken.runId && streams.runs[before]?.status === "failed")
          streams = dismissRun(streams, before);
      }
      set(
        {
          ...state,
          continued,
          questions,
          secrets,
          memory,
          streams,
          consults: applyConsultEvent(state.consults, event, now()),
          receipts: applyReceiptEvent(
            event.type === "message.created" && event.message
              ? seedReceipt(state.receipts, event.message)
              : state.receipts,
            event,
          ),
          typing,
        },
        streaming,
      );
    },
    /**
     * Messages loaded over HTTP: start the person messages' receipts, and drop the live memory cards an agent's
     * message now shows. `before`: the receipts when the read was asked for; one that hasn't changed since takes the
     * read as it is.
     */
    seed: (messages: Message[], before?: ReceiptsState) => {
      let receipts = state.receipts;
      let memory = state.memory;
      for (const m of messages) {
        receipts = seedReceipt(receipts, m, before !== undefined && receipts[m.id] === before[m.id]);
        memory = dropMemoryCards(memory, m.channelId, m);
      }
      set({ ...state, receipts, memory });
    },
    /** Right after sending: provisional "pensando…" rows and receipts for the agents we mentioned. */
    expect: (channelId: string, messageId: string, agentIds: string[], threadId = messageId) => {
      let streams = state.streams;
      let receipts = state.receipts;
      for (const agentId of agentIds)
        streams = expectReply(streams, { channelId, threadId, agentId, messageId }, now());
      receipts = guessReceipt(receipts, messageId, agentIds);
      set({ ...state, streams, receipts });
    },
    /** The optimistic message got its server id: move its "pensando…" rows and receipts there. */
    retarget: (fromId: string, toId: string) => {
      const { [fromId]: moving, ...receipts } = state.receipts;
      set({
        ...state,
        streams: retargetProvisional(state.streams, fromId, toId),
        receipts: moving && !receipts[toId] ? { ...receipts, [toId]: moving } : receipts,
      });
    },
    /**
     * Safety net: a "pensando…" the server never confirmed (no event for
     * `PROVISIONAL_TTL_MS`) is dropped, with its unconfirmed receipt. Returns
     * the channels to resync over HTTP.
     */
    sweep: (at = now()): string[] => {
      const stale = staleProvisional(state.streams, at, provisionalTtlMs);
      if (stale.length === 0) return [];
      const asked = new Set(stale.map(guessedFrom));
      const receipts = Object.fromEntries(
        Object.entries(state.receipts).filter(([id, r]) => !(asked.has(id) && !r.confirmed)),
      );
      set({ ...state, streams: dropProvisional(state.streams, new Set(stale.map((r) => r.threadId))), receipts });
      return [...new Set(stale.map((r) => r.channelId))];
    },
    /** The agent won't answer me: show the notice and drop its "pensando…" on that message. */
    unavailable: (e: AgentUnavailableEvent) => {
      const key = `${e.messageId}:${e.agentId}`;
      const list = (state.notices[e.channelId] ?? []).filter((n) => n.key !== key);
      const notice = {
        key,
        agentId: e.agentId,
        threadId: e.threadId,
        messageId: e.messageId,
        code: e.code,
        params: e.params,
      };
      set({
        ...state,
        streams: dismissRun(state.streams, `pending:${e.agentId}:${e.threadId ?? e.messageId}`),
        notices: { ...state.notices, [e.channelId]: [...list, notice] },
      });
    },
    /** Our own answer, before (or instead of) the server's event. */
    answered: (question: AgentQuestion) =>
      set({ ...state, questions: { ...state.questions, [question.id]: question } }),
    /** Our own delivery or refusal of a secret request, before the server's event. */
    secretAnswered: (request: SecretRequest) => set({ ...state, secrets: { ...state.secrets, [request.id]: request } }),
    dismiss: (runId: string) => set({ ...state, streams: dismissRun(state.streams, runId) }),
    /** "Parar" pressed (optimistic) / the cancel failed. */
    stopping: (runId: string, byUserId: string) =>
      set({ ...state, streams: markStopping(state.streams, runId, byUserId) }),
    unstopping: (runId: string) => set({ ...state, streams: unmarkStopping(state.streams, runId) }),
    /** The server's active runs for a channel (load, reconnect): stale rows go away. */
    reconcile: (channelId: string, active: ActiveRun[], askedAt = now()) =>
      set({ ...state, streams: reconcileRuns(state.streams, channelId, active, now(), askedAt) }),
    /** The server's questions still out in a channel (load, reconnect): the "asking…" line. */
    reconcileConsults: (channelId: string, open: OpenConsult[], askedAt = now()) =>
      set({ ...state, consults: reconcileConsults(state.consults, channelId, open, askedAt, now()) }),
    /** "Continuar" went through (or there is nothing left to continue: `newRunId` null). */
    continued: (runId: string, newRunId: string | null) =>
      set({ ...state, continued: { ...state.continued, [runId]: newRunId } }),
    /** "Atualizar" found the run still active. */
    touch: (runId: string) => set({ ...state, streams: touchRun(state.streams, runId, now()) }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type StreamsStore = ReturnType<typeof createStreamsStore>;

/** Frames to batch on (a browser); React's act() environment (tests) and SSR notify at once. */
const batchFrames = () =>
  typeof requestAnimationFrame === "function" &&
  !(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

interface RealtimeValue {
  connection: RealtimeConnection | null;
  streams: StreamsStore;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const browserSocket: SocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<SocketFactory>;

/** Which WebSocket to open (tests provide a fake; the app uses the browser's). */
export const SocketFactoryContext = createContext<SocketFactory>(browserSocket);

/** One WebSocket per organization, opened while the org shell is mounted. */
/** Text of a budget alert for the agent's owner: a percentage, never money. */
export function budgetAlert(t: TFunction, locale: string, event: BudgetEvent, agentName: string) {
  return event.type === "budget.exhausted"
    ? t("budget.exhausted", { name: agentName, when: usageWhen(t, locale, nextMonthIso()) })
    : t("budget.warning", { name: agentName, percent: formatPercent(locale, event.percent) });
}

export function RealtimeProvider({
  orgId,
  createSocket: explicit,
  children,
}: {
  orgId: string;
  createSocket?: SocketFactory;
  children: ReactNode;
}) {
  const fromContext = useContext(SocketFactoryContext);
  const createSocket = explicit ?? fromContext;
  const qc = useQueryClient();
  const toast = useToast();
  const { t, i18n } = useTranslation();
  const streams = useMemo(() => createStreamsStore(), []);
  // Questions agents asked that are still out, as the server lists them with the active runs.
  useEffect(() => consultSeeds.subscribe(streams.reconcileConsults), [streams]);
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  // Latest `t` without reconnecting when the language changes.
  const tRef = useRef(t);
  tRef.current = t;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one socket per org; toast and language are read live
  useEffect(() => {
    const conn = new RealtimeConnection({ url: realtimeUrl(window.location, orgId), createSocket });
    // Catch up over HTTP after a reconnect: events sent while offline are gone.
    const offReconnect = conn.onReconnect(() => {
      // A reconnect is often a deploy: is this tab still on the app the server serves?
      void checkAppVersion();
      // Reactions heard live may be stale now: the refetched message lists carry them again.
      qc.removeQueries({ queryKey: ["org", orgId, "reactions"] });
      // Nothing sent while the socket was down reached this tab, so everything the workspace holds may be old: what
      // is on screen reads again now, the rest when it is shown.
      void qc.invalidateQueries({ queryKey: keys.org(orgId) });
      void qc.invalidateQueries({ queryKey: keys.me });
    });
    // The first open too, for what a return from the billing service changes: a new plan's limits, standing and
    // computer can land in core between this page's first reads and the socket's open, and that event reaches no one.
    let opened = false;
    const offOpen = conn.onStatus((status) => {
      if (status !== "open" || opened) return;
      opened = true;
      void qc.invalidateQueries({ queryKey: keys.limits(orgId) });
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.computerSetup(orgId) });
    });
    // Approvals I can decide arrive here even when I'm not in that channel (sidebar badge, Aprovações).
    const offUser = conn.onUserEvent((event) => {
      if ((event.type === "approval.created" || event.type === "approval.decided") && "approval" in event) {
        cacheApproval(qc, orgId, event.approval);
        void qc.invalidateQueries({ queryKey: keys.approvals(orgId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
      if (isAgentUnavailable(event)) streams.unavailable(event);
      // A change I asked the right hand for was decided by someone else (ADR 0137): "Aplicado por …" on my card.
      if (event.type === "proposal.decided") {
        void refreshProposals(qc, orgId);
        void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      }
      // A proposal I may decide: the sidebar's count and Aprovações' tab.
      if (event.type === "proposal.created") void refreshProposals(qc, orgId);
      // Unread marks: a message where I am, and my reads and mutes from any device.
      applyUnreadEvent(qc, orgId, event);
      // My inbox: new or merged items, auto-resolved ones, and the badge's numbers.
      if (isNotificationEvent(event)) applyNotificationEvent(qc, orgId, event);
      // The island at the top (ADR 0071 §9): what reaches me while I'm here, and what I settled elsewhere leaves.
      if (isNotificationEvent(event)) feedIsland(event);
      // Its sound (ADR 0070): in one tab only, and in the background only what matters.
      if (isNotificationEvent(event) && event.type === "notification.upserted") {
        const { mine, background } = notificationAudience();
        const sound = mine ? soundForNotification(event.notification, background) : null;
        if (sound) playSound(sound);
      }
      // Notifications in this browser (ADR 0071): what was read, done or snoozed closes there too; a drop in
      // the badge ("Marcar tudo como lido") has one tab ask the server which shown ones went stale.
      if (isNotificationEvent(event)) settleShownPushes(orgId, event, notificationAudience().mine);
      // In the desktop app: what a phone would get pushed, shown by the app while its window is in the background,
      // unless the person turned that kind off (`alert`, ADR 0071 §8).
      if (
        isNotificationEvent(event) &&
        event.type === "notification.upserted" &&
        event.alert !== false &&
        inDesktopApp()
      ) {
        const agentName = (id: string) => qc.getQueryData<Agent[]>(keys.agents(orgId))?.find((a) => a.id === id)?.name;
        const notice = desktopNotice(tRef.current, orgId, event.notification, agentName);
        if (notice)
          void thisMac
            .notify(
              notice.title,
              notice.body,
              notice.path,
              notice.phoneId ? { orgId, phoneId: notice.phoneId } : undefined,
            )
            .catch(() => {});
      }
      // A mission waits for me (a decision, a review, an approval): the lists and the sidebar's count.
      if (event.type.startsWith("mission.") && "missionId" in event && typeof event.missionId === "string") {
        refreshMission(qc, orgId, event.missionId);
      }
      // Someone arranged the sidebar's channel categories (ADR 0080): channels and categories refetch.
      if (event.type === "channels.layout") {
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
        void qc.invalidateQueries({ queryKey: keys.channelCategories(orgId) });
      }
      // A channel's exceptions changed (ADR 0134): what I may do there (`can`) and its open permissions page.
      if (event.type === "channel.permissions" && "channelId" in event && typeof event.channelId === "string") {
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
        void qc.invalidateQueries({ queryKey: keys.channelPermissions(orgId, event.channelId) });
      }
      // The Vault changed (ADR 0144, org broadcast): what this person may see of it refetches. Never a value.
      if (event.type === "vault.changed") void qc.invalidateQueries({ queryKey: keys.vault(orgId) });
      // The board's columns changed (org broadcast): set them; a deleted column moved its tasks.
      if (event.type === "issue.columns" && "columns" in event && Array.isArray(event.columns)) {
        qc.setQueryData(keys.issueColumns(orgId), event.columns as IssueColumn[]);
        void qc.invalidateQueries({ queryKey: keys.issues(orgId), predicate: (q) => q.queryKey[3] === "list" });
      }
      applyIssueEvent(qc, orgId, event);
      // An agent switched computers, or its computer was removed: the cached view takes the new target.
      applyComputerEvent(qc, orgId, event);
      // Connected computers: online/offline, paired, renamed, removed.
      applyMachineEvent(qc, orgId, event);
      // The workspace's own computer on its way, its standing (the hold banner, the suspended screen), the groups of
      // agents (the sidebar's sections), and the lists anyone may have open (Drive, Wiki, calendar, routines, memory).
      applyWorkspaceEvent(qc, orgId, event);
      // Boards and widgets (ADR 0135): only ids come; the boards on screen refetch.
      applyDashboardEvent(qc, orgId, event);
      // A recording that won't become a message: its bubble goes, and the person hears why (ADR 0100).
      if (event.type === "voice.dropped" && "clientId" in event) {
        const dropped = event as VoiceDroppedEvent;
        dropLocalVoice(qc, orgId, dropped.channelId, dropped.clientId);
        toast.show(tRef.current(dropped.reason === "silent" ? "voice.notUnderstood" : "voice.refused"), "error");
      }
      if ((event.type === "budget.warning" || event.type === "budget.exhausted") && "agentId" in event) {
        const budgetEvent = event as BudgetEvent;
        const agent = qc.getQueryData<Agent[]>(keys.agents(orgId))?.find((a) => a.id === budgetEvent.agentId);
        toast.show(budgetAlert(tRef.current, i18n.language, budgetEvent, agent?.name ?? ""), "error");
        void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, budgetEvent.agentId) });
        void qc.invalidateQueries({ queryKey: keys.overview(orgId) });
      }
    });
    // Taken out of the workspace: `me` without it shows "Você não faz mais parte" (routes/org.$orgId.tsx) at once.
    const offError = conn.onError((code) => {
      if (code === "membership_revoked") void qc.invalidateQueries({ queryKey: keys.me });
    });
    conn.start();
    setConnection(conn);
    // Back from a sleep or a network change, the socket may be dead while it still says open: check it now.
    const wake = () => {
      if (document.visibilityState === "visible") conn.checkAlive();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      // Another workspace (or none): its notices go with it.
      island.clear();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      offReconnect();
      offOpen();
      offUser();
      offError();
      conn.stop();
      setConnection(null);
    };
  }, [orgId, createSocket, qc]);

  // Resync what the server never confirmed instead of spinning forever.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const channelId of streams.sweep()) {
        void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [streams, qc, orgId]);

  // What I sent while the connection was down (or the server restarting) goes out once it's back, whatever page
  // is open. One the server then refuses is said here, since its conversation may not be on screen.
  useSendWaiting(orgId, connection, (error) =>
    toast.show(knownErrorText(tRef.current, error) ?? tRef.current("channel.sendFailed"), "error"),
  );

  // Stable across the layout's re-renders (every navigation): only a new socket changes it.
  const value = useMemo(() => ({ connection, streams }), [connection, streams]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function useRealtime() {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside RealtimeProvider");
  return value;
}

/**
 * Brings the live rows of a channel in line with the server: the active-runs
 * list when the server has it, else each live run's detail. Rows of runs that
 * ended while we weren't listening go away (their message, if any, refetches).
 * `runIds` limits the check to those runs ("Atualizar" on one row).
 */
export async function reconcileChannelRuns(
  api: ApiClient,
  store: StreamsStore,
  orgId: string,
  channelId: string,
  runIds?: string[],
): Promise<boolean> {
  const live = runsInChannel(store.get().streams, channelId).filter(
    (r) => !r.provisional && r.status !== "failed" && (!runIds || runIds.includes(r.runId)),
  );
  const askedAt = Date.now();
  const active = await api.agents.activeRuns(orgId, channelId).catch(() => undefined);
  if (active === undefined) return false;
  if (active) {
    if (runIds) {
      const known = new Set(active.map((a) => a.runId));
      for (const r of live) if (!known.has(r.runId)) store.dismiss(r.runId);
      for (const r of live) if (known.has(r.runId)) store.touch(r.runId);
    } else store.reconcile(channelId, active, askedAt);
    return live.some((r) => !active.some((a) => a.runId === r.runId));
  }
  // No endpoint yet: ask about each live run.
  let dropped = false;
  await Promise.all(
    live.map(async (r) => {
      try {
        const { run } = await api.agents.run(orgId, r.runId);
        if (isActiveStatus(run.status)) store.touch(r.runId);
        else {
          store.dismiss(r.runId);
          dropped = true;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          store.dismiss(r.runId);
          dropped = true;
        }
      }
    }),
  );
  return dropped;
}

let quiet: StreamsStore | null = null;
const quietStore = () => {
  quiet ??= createStreamsStore();
  return quiet;
};

/**
 * `thread.updated` (ADR 0029): the thread's view (keeping my own `canManage`,
 * which the event never carries), every thread list, and the conversation
 * when messages left it or came back (moved, returned, a new marker, undo).
 */
export function applyThreadEvent(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  event: Extract<ChannelEvent, { type: "thread.updated" }>,
) {
  const one = keys.threadInfo(orgId, event.threadId);
  if (event.change === "deleted") qc.removeQueries({ queryKey: one });
  else if (event.thread) {
    const fresh = event.thread;
    // The event leaves out what is only mine: my `canManage`, following it and its unread for me stay.
    qc.setQueryData<ThreadInfo>(one, (old) =>
      old ? { ...fresh, canManage: old.canManage, following: old.following, unread: old.unread } : undefined,
    );
    if (!qc.getQueryData(one)) void qc.invalidateQueries({ queryKey: one });
  } else void qc.invalidateQueries({ queryKey: one });
  void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
  if (["created", "context", "moved", "returned", "deleted"].includes(event.change)) {
    void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", event.channelId] });
  }
}

/**
 * `mission.updated`: the mission and the reads its `change` touches (a
 * decision, a review, the plan, the files, who takes part). Messages it posts
 * arrive on their own (`message.created`).
 */
export function applyMissionEvent(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  event: Extract<ChannelEvent, { type: "mission.updated" }>,
) {
  const parts: Record<string, string[]> = {
    decision: ["decisions", "files"],
    review: ["reviews"],
    plan: ["plan", "files"],
    file_edited: ["files"],
    files: ["files"],
    participants: ["participants", "joinRequests"],
    owner: ["participants"],
    join_requests: ["joinRequests"],
    suggestion: [],
    task: [],
    command: ["commands"],
    delivery: ["deliveries"],
    status: ["deliveries"],
  };
  refreshMission(qc, orgId, event.missionId, parts[event.change] ?? undefined);
  void qc.invalidateQueries({ queryKey: keys.threadMission(orgId, event.threadId) });
  if (event.change === "suggestion" || event.change === "closed" || event.change === "done") {
    void qc.invalidateQueries({ queryKey: keys.thread(orgId, event.channelId, event.threadId) });
  }
}

/** `machine.task`: the thread's session rows; a mission's counts (running tasks) follow. */
export function applyTaskEvent(qc: ReturnType<typeof useQueryClient>, orgId: string, task: MachineTask) {
  cacheTask(qc, orgId, task);
  if (task.missionId) {
    void qc.invalidateQueries({ queryKey: keys.mission(orgId, task.missionId) });
    if (task.threadId) void qc.invalidateQueries({ queryKey: keys.threadMission(orgId, task.threadId) });
  }
}

/** A tab away at least this long reads its open conversation again when it comes back (a quick switch doesn't). */
export const RESYNC_AFTER_HIDDEN_MS = 10_000;

/**
 * Events already applied. A thread open beside its channel is a second view of that channel, and every listener gets
 * the same event object: applied twice, a tool call shows twice and its output doubles.
 */
const handledEvents = new WeakSet<ChannelEvent>();

/** Subscribes to a channel while mounted: live runs + message cache updates. */
export function useChannelRealtime(orgId: string, channelId: string, enabled: boolean) {
  const { connection, streams } = useRealtime();
  const qc = useQueryClient();
  const api = useApi();
  // On load: drop live rows the server no longer runs. The channel's events reach us only once the server confirms
  // its subscription (the first, and again after every reconnect): then the live rows are checked again, and what
  // happened before, after the page read the channel (an answer posted while the socket opened, right after a page
  // change), is read and added.
  useEffect(() => {
    if (!connection || !enabled) return;
    void reconcileChannelRuns(api, streams, orgId, channelId).then((dropped) => {
      if (dropped) void qc.invalidateQueries({ queryKey: keys.messages(orgId, channelId) });
    });
    const resync = () => {
      void reconcileChannelRuns(api, streams, orgId, channelId);
      catchUpLists(api, qc, streams, orgId, channelId);
      // The lines of its computers too: a `computer.queue` it missed leaves a wait's place unsaid.
      void qc.invalidateQueries({ queryKey: [...keys.machines(orgId), "queue"] });
    };
    const offSubscribed = connection.onSubscribed((id) => {
      if (id === channelId) resync();
    });
    // Back to the tab after a while: read it again at once. The socket may have died in the meantime (its check takes
    // seconds), or stayed up while events never reached it (a sleeping tab, the server's pub/sub reconnecting).
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt ??= Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away < RESYNC_AFTER_HIDDEN_MS) return;
      resync();
      void qc.invalidateQueries({ queryKey: keys.threads(orgId) });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      offSubscribed();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connection, enabled, orgId, channelId, qc, streams, api]);
  useEffect(() => {
    if (!connection || !enabled) return;
    const close = openConversation(qc, orgId, channelId);
    const off = connection.subscribe(channelId, (event) => {
      if (handledEvents.has(event)) return;
      handledEvents.add(event);
      streams.apply(event);
      applyMembershipEvent(qc, orgId, event);
      if (event.type === "approval.created" || event.type === "approval.decided") {
        cacheApproval(qc, orgId, event.approval);
      }
      // A file's cards and viewer, an agent's memory list.
      applyConversationEvent(qc, orgId, event);
      if (event.type === "poll.updated") qc.setQueryData(keys.poll(orgId, event.poll.id), event.poll);
      if (event.type === "block.state") {
        const { block } = event;
        qc.setQueryData<BlockState>(keys.blockState(orgId, block.id, block.version), (old) =>
          newerBlockState(old, block),
        );
      }
      if (event.type === "choices.updated") qc.setQueryData(keys.choices(orgId, event.choices.id), event.choices);
      if (event.type === "thread.updated") applyThreadEvent(qc, orgId, event);
      // An agent's browser request changed (ADR 0040): its card, the live view, the agent's open request.
      if (event.type === "browser.handoff.updated")
        applyBrowserHandoff(qc, orgId, event.handoff, { channelId: event.channelId, threadId: event.threadId });
      // Missions (ADR 0029): the pinned card, the cards in the thread, the lists; a task's row.
      if (event.type === "mission.updated") applyMissionEvent(qc, orgId, event);
      if (event.type === "machine.task") applyTaskEvent(qc, orgId, event.task);
      // An agent's proposal of a new agent was created or denied (by anyone): its card.
      if (event.type === "agent.proposal.updated") cacheAgentProposal(qc, orgId, event, event);
      // The right hand's team card changed (created, failed, adjusted, dismissed, undone): the whole card.
      if (event.type === "team.proposal.updated") cacheTeamCard(qc, orgId, event, event.card);
      // An agent's event proposal was confirmed or dismissed: its card says so.
      if (event.type === "calendar.proposal.updated")
        cacheMessageMeta(qc, orgId, event.channelId, event.messageId, () => ({ calendarProposal: event.proposal }));
      if (event.type === "card.delegate") cacheCardDelegate(qc, orgId, event, event.delegate);
      // A right hand's card of a workspace change was applied, dismissed or sent on: the whole card.
      if (event.type === "action_card.updated") cacheActionCard(qc, orgId, event, event.card);
      // A report an agent offered was sent or put away (on another device of the person's): its row follows.
      if (event.type === "feedback_offer.updated") {
        cacheMessageMeta(qc, orgId, event.channelId, event.messageId, () => ({ feedbackOffer: event.offer }));
        if (event.threadId)
          void qc.invalidateQueries({ queryKey: keys.thread(orgId, event.channelId, event.threadId) });
      }
      // An agent's wait for a device ended (or changed): its card flips to how it ended, without a reload.
      const deviceWait = deviceWaitEventOf(event);
      if (deviceWait) {
        cacheMessageMeta(qc, orgId, deviceWait.channelId, deviceWait.messageId, () => ({
          deviceWait: deviceWait.deviceWait,
        }));
        if (deviceWait.threadId)
          void qc.invalidateQueries({ queryKey: keys.thread(orgId, deviceWait.channelId, deviceWait.threadId) });
      }
      // A DM between people: the other one read it ("Visto" moves).
      if (event.type === "channel.read") cacheDmRead(qc, orgId, event);
      // Someone reacted: the pills under that message change for everyone.
      if (event.type === "message.reactions")
        applyReactions(qc, orgId, event.messageId, event.reactions, playAgentReaction);
      // Someone pinned or unpinned a message: its "Fixar" / "Desafixar" and the pins list follow.
      if (event.type === "message.pinned" || event.type === "message.unpinned") {
        cachePinned(qc, orgId, channelId, event.messageId, event.type === "message.pinned");
        void qc.invalidateQueries({ queryKey: keys.pins(orgId, channelId) });
      }
      // Act with undo: an agent message's receipts changed (made, undone, redone): replace the list.
      // A long work moved, updated or ended (ADR 0121): its anchor's line redraws; its card on the board too.
      if (event.type === "agent.work") {
        cacheMessageWork(qc, orgId, event.channelId, event.work);
        if (event.work.issue) void qc.invalidateQueries({ queryKey: keys.issues(orgId) });
      }
      if (event.type === "message.actions") {
        cacheMessageActions(qc, orgId, event.channelId, event.messageId, event.actions);
        // A channel an agent created (or its undo archived): the sidebar lists it now, not at the next refetch.
        if (event.actions.some((a) => a.kind === "channel.created"))
          void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      }
      if (event.type === "message.created") {
        if (event.message) cacheMessage(qc, orgId, event.message);
        else {
          // Too big for its event: the open lists read it (its live block holds until it lands); a closed one, when
          // it opens again.
          void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId], refetchType: "none" });
          catchUpLists(api, qc, streams, orgId, channelId);
        }
        // A new top-level message may get agent replies in its thread: start watching it.
        if (event.message) startThreadCache(qc, orgId, event.message);
        const threadId = repliedThread(event);
        if (threadId) refreshRepliedThread(qc, orgId, threadId);
      }
    });
    return () => {
      off();
      close();
    };
  }, [connection, enabled, orgId, channelId, qc, streams, api]);
}

/**
 * Reads a conversation's open lists and adds what they lack (`catchUpChannel`). A receipt nothing changed while the
 * read was on its way takes it as it is. The lists' copies get the same receipts, so the page seeding them again (on
 * every change) changes nothing.
 */
function catchUpLists(
  api: ApiClient,
  qc: ReturnType<typeof useQueryClient>,
  streams: StreamsStore,
  orgId: string,
  channelId: string,
) {
  const before = streams.get().receipts;
  void catchUpChannel(api, qc, orgId, channelId).then((read) => {
    streams.seed(read, before);
    cacheReceipts(qc, orgId, channelId, read);
  });
}

/** An open task's activity, live: comments and events from others land in its feed (`useIssueLive`). */
export function useIssueRealtime(orgId: string, issue: { id: string; channelId: string | null }) {
  useIssueLive(orgId, useRealtime().connection, issue);
}

/** Each live event of a channel while mounted and `enabled` (the handler is read through a ref). */
export function useChannelEvents(channelId: string, enabled: boolean, onEvent: (event: ChannelEvent) => void) {
  const { connection } = useRealtime();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.subscribe(channelId, (event) => handler.current(event));
  }, [connection, enabled, channelId]);
}

/** Same items in the same order (lists), or the same keys with the same values (plain objects). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && Object.is(ra[k], rb[k]));
}

/**
 * Subscribes to a slice of the live store; re-renders only when that slice
 * changes (`isEqual`), so a streaming delta re-renders the streaming row, not
 * the whole timeline.
 */
export function useLive<T>(select: (state: LiveState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  // Outside the org shell (a lone component in a test, the gallery): a quiet, empty store.
  const store = useContext(RealtimeContext)?.streams ?? quietStore();
  const selectRef = useRef(select);
  selectRef.current = select;
  const [value, setValue] = useState(() => select(store.get()));
  const valueRef = useRef(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selector and isEqual are read through refs
  useEffect(() => {
    const check = () => {
      const next = selectRef.current(store.get());
      if (!isEqual(valueRef.current, next)) {
        valueRef.current = next;
        setValue(() => next);
      }
    };
    check();
    return store.subscribe(check);
  }, [store]);
  // The selector may read the component's own state (which runs a channel shows): a render checks again.
  // A selector that builds a new list or object each call (`runsInChannel`) would set it on every render
  // and never stop: one with the same items counts as unchanged here.
  useEffect(() => {
    const next = selectRef.current(store.get());
    if (!isEqual(valueRef.current, next) && !shallowEqual(valueRef.current, next)) {
      valueRef.current = next;
      setValue(() => next);
    }
  });
  return value;
}

export function useStreams<T>(select: (state: StreamsState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useLive((s) => select(s.streams), isEqual);
}

export function useLiveStore() {
  return useRealtime().streams;
}

/** Throttled "I'm typing" for a channel, or for one of its threads. */
export function useTypingSender(channelId: string, threadId?: string) {
  const { connection } = useRealtime();
  const throttle = useMemo(() => typingThrottle(), []);
  return (text?: string) => {
    if (connection && throttle(Date.now(), text)) connection.sendTyping(channelId, threadId);
  };
}

export function useDismissRun() {
  return useRealtime().streams.dismiss;
}

/** What the live view shows of an agent's browser (ADR 0040 §7). */
export interface BrowserLiveState {
  frame: BrowserFrame | null;
  status: BrowserLiveStatus | null;
  /** Why nothing is shown now (cleared by the next frame or status). */
  unavailable: { reason: BrowserLiveUnavailable; message?: string } | null;
  ended: boolean;
  /** How it ended (cleared with `ended`): Parar says who and when. */
  endedBy: { reason: "stopped" | "closed" | "error"; userId?: string; at?: string } | null;
  /** The last refusal (`not_in_control`, `forbidden`, …). */
  error: string | null;
  /** How many came, for what says each one: the same refusal again leaves `error` as it was. */
  errors: number;
}

const EMPTY_LIVE: BrowserLiveState = {
  frame: null,
  status: null,
  unavailable: null,
  ended: false,
  endedBy: null,
  error: null,
  errors: 0,
};

/**
 * Watches an agent's browser on the org's socket while mounted (`enabled`):
 * frames, who is in control, and why it can't be shown. Watches again when
 * the socket reconnects, and on `retry`. `sendInput` is for the person in control.
 * `maxFps`: the frames a second this view needs (`BROWSER_FPS.preview` for a small picture; none for the stream's
 * own rate), changed in place, never with a new watch (ADR 0040 §7.1).
 */
export function useBrowserLive(agentId: string, enabled = true, maxFps?: number) {
  const { connection } = useRealtime();
  const [state, setState] = useState<BrowserLiveState>(EMPTY_LIVE);
  const liveRef = useRef<ReturnType<typeof createBrowserLiveConnection> | null>(null);
  // The rate when the watch starts; a change later goes through `setMaxFps`.
  const fps = useRef(maxFps);
  fps.current = maxFps;
  useEffect(() => {
    if (!connection || !enabled) return;
    setState(EMPTY_LIVE);
    const live = createBrowserLiveConnection({
      send: (frame) => connection.sendBrowserFrame(frame),
      // Shared per socket: the card, the bar and the full view of one agent are one watch.
      watcher: connection.browserWatcher,
      agentId,
      maxFps: fps.current,
      // An answer means the watch went through: an earlier refusal (too many browsers) no longer holds.
      onFrame: (frame) =>
        setState((s) => ({ ...s, frame, unavailable: null, ended: false, endedBy: null, error: null })),
      onStatus: (status) =>
        setState((s) => ({ ...s, status, unavailable: null, ended: false, endedBy: null, error: null })),
      onUnavailable: (reason, message) =>
        setState((s) => ({ ...s, unavailable: { reason, ...(message ? { message } : {}) } })),
      onEnded: (reason, _message, by) =>
        setState((s) => ({
          ...s,
          ended: true,
          // A stop says who; a later "closed" from the same stop keeps it.
          endedBy: reason === "stopped" || s.endedBy?.reason !== "stopped" ? { reason, ...by } : s.endedBy,
        })),
      onError: (code) => setState((s) => ({ ...s, error: code, errors: s.errors + 1 })),
    });
    liveRef.current = live;
    const off = connection.onBrowserFrame((frame) => live.handleMessage(frame));
    // Watch once the socket is open, and again after every reconnect (the server forgets the watch).
    // A view that mounted before the socket opened starts here (start is a no-op once started).
    const offStatus = connection.onStatus((status) => {
      if (status === "open") {
        live.start();
        live.resume();
      }
    });
    if (connection.isOpen) live.start();
    return () => {
      off();
      offStatus();
      live.close();
      liveRef.current = null;
    };
  }, [connection, agentId, enabled]);
  useEffect(() => {
    liveRef.current?.setMaxFps(maxFps);
  }, [maxFps]);
  const sendInput = useCallback((events: BrowserInputEvent[]) => liveRef.current?.sendInput(events) ?? false, []);
  const retry = useCallback(() => liveRef.current?.retry(), []);
  return { ...state, sendInput, retry };
}

export function useConnectionStatus(): ConnectionStatus {
  const { connection } = useRealtime();
  const [status, setStatus] = useState<ConnectionStatus>(connection?.status ?? "idle");
  useEffect(() => {
    if (!connection) return;
    setStatus(connection.status);
    return connection.onStatus(setStatus);
  }, [connection]);
  return status;
}
