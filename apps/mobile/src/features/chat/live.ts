import {
  type AgentQuestion,
  ApiError,
  applyBrowserHandoff,
  applyChannelEvent,
  applyConsultEvent,
  applyConversationEvent,
  applyMembershipEvent,
  applyReceiptEvent,
  applyTyping,
  type BlockState,
  type ChannelEvent,
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
  cacheTeamCard,
  catchUpChannel,
  consultSeeds,
  consultsIn,
  dismissRun,
  dropProvisional,
  emptyStreams,
  expectReply,
  expireTyping,
  guessedFrom,
  guessReceipt,
  keys,
  type LiveConsult,
  type LiveRun,
  type Message,
  markStopping,
  type OpenConsult,
  openConversation,
  type ReactionCount,
  type ReceiptsState,
  reconcileConsults,
  reconcileRuns,
  refreshRepliedThread,
  repliedThread,
  runsInChannel,
  type SecretRequest,
  type StreamsState,
  seedReceipt,
  seedReceipts,
  staleProvisional,
  startThreadCache,
  stopTyping,
  type TypingState,
  typingThrottle,
  unmarkStopping,
  useApi,
} from "@agenteschat/client";
import { type AgentUnavailableEvent, isAgentUnavailable } from "@agenteschat/client/lib/audience";
import { newerBlockState } from "@agenteschat/client/lib/blocks";
import { deviceWaitEventOf } from "@agenteschat/client/lib/devices";
import { playSound } from "@agenteschat/client/lib/sounds";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useConnection, useMeId } from "../shared/hooks";
import { withContinued } from "./turn";

/**
 * A conversation, live: subscribes to its channel while the screen is open,
 * keeps the message caches current (new messages, reactions, approvals,
 * agents' questions and secret requests, threads, missions) and holds the runs in progress (streaming text, who is
 * working, agents asking agents), who is typing, and the agents' receipts on people's messages (who saw it,
 * who answers; `receipts.ts`, as on the web). The database stays the truth: on open and after a reconnect the
 * active runs come from the server, and the lists' receipts seed the rest.
 */

interface LiveState {
  streams: StreamsState;
  consults: ConsultsState;
  receipts: ReceiptsState;
  /** Who is typing (`user.typing`), only while it lasts: what ran out is swept on time. */
  typing: TypingState;
  /** Agents I named here that won't answer me (`agent.unavailable`): only for me, never stored. */
  notices: AgentUnavailableEvent[];
}

type Action =
  | { type: "event"; event: ChannelEvent; at: number }
  | { type: "reconcile"; channelId: string; active: Parameters<typeof reconcileRuns>[2]; at: number; askedAt: number }
  | { type: "consults"; channelId: string; open: OpenConsult[]; at: number; askedAt: number }
  | { type: "expect"; channelId: string; threadId: string; messageId: string; agentIds: string[]; at: number }
  /** `before`: the receipts when the read was asked for; one that hasn't changed since takes the read as it is. */
  | { type: "seed"; messages: readonly Message[]; before?: ReceiptsState }
  | { type: "stopping"; runId: string; byUserId: string }
  | { type: "unstopping"; runId: string }
  | { type: "dismiss"; runId: string }
  | { type: "sweep"; at: number }
  | { type: "typed"; at: number }
  | { type: "unavailable"; event: AgentUnavailableEvent };

/** A "pensando…" the server never confirmed is dropped after this long (the web's `PROVISIONAL_TTL_MS`). */
export const PROVISIONAL_TTL_MS = 20_000;

function reduce(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "event": {
      const { event } = action;
      const streams = applyChannelEvent(state.streams, event, action.at);
      const consults = applyConsultEvent(state.consults, event, action.at);
      // A person's new message starts its receipt before the event itself lands on it (as on the web).
      const seeded =
        event.type === "message.created" && event.message ? seedReceipt(state.receipts, event.message) : state.receipts;
      const receipts = applyReceiptEvent(seeded, event);
      const typing =
        event.type === "user.typing"
          ? applyTyping(state.typing, event.channelId, event.userId, action.at, event.ttlMs, event.threadId)
          : event.type === "message.created" && event.message?.author?.type === "person" && event.message.author.id
            ? stopTyping(state.typing, event.channelId, event.message.author.id)
            : state.typing;
      // An event that changes none of them doesn't re-render.
      return streams === state.streams &&
        consults === state.consults &&
        receipts === state.receipts &&
        typing === state.typing
        ? state
        : { ...state, streams, consults, receipts, typing };
    }
    // The agent won't answer me: its "pensando…" on that message goes, and the line says why, once per agent.
    case "unavailable": {
      const e = action.event;
      const notices = [...state.notices.filter((n) => n.agentId !== e.agentId), e];
      return {
        ...state,
        notices,
        streams: dismissRun(state.streams, `pending:${e.agentId}:${e.threadId ?? e.messageId}`),
      };
    }
    case "typed": {
      const typing = expireTyping(state.typing, action.at);
      return typing === state.typing ? state : { ...state, typing };
    }
    case "seed": {
      const receipts = seedReceipts(state.receipts, action.messages, action.before);
      return receipts === state.receipts ? state : { ...state, receipts };
    }
    case "reconcile":
      return {
        ...state,
        streams: reconcileRuns(state.streams, action.channelId, action.active, action.at, action.askedAt),
      };
    case "consults":
      return {
        ...state,
        consults: reconcileConsults(state.consults, action.channelId, action.open, action.askedAt, action.at),
      };
    case "expect": {
      let streams = state.streams;
      for (const agentId of action.agentIds)
        streams = expectReply(
          streams,
          { channelId: action.channelId, threadId: action.threadId, agentId, messageId: action.messageId },
          action.at,
        );
      // The message's receipt guesses the same agents until the server says (unconfirmed; the sweep drops it).
      return { ...state, streams, receipts: guessReceipt(state.receipts, action.messageId, action.agentIds) };
    }
    case "stopping":
      return { ...state, streams: markStopping(state.streams, action.runId, action.byUserId) };
    case "unstopping":
      return { ...state, streams: unmarkStopping(state.streams, action.runId) };
    case "dismiss":
      return { ...state, streams: dismissRun(state.streams, action.runId) };
    case "sweep": {
      const stale = staleProvisional(state.streams, action.at, PROVISIONAL_TTL_MS);
      if (stale.length === 0) return state;
      const asked = new Set(stale.map(guessedFrom));
      // A guess the server never confirmed goes with its "pensando…" (the conversation resyncs right after).
      const receipts = Object.fromEntries(
        Object.entries(state.receipts).filter(([id, r]) => !(asked.has(id) && !r.confirmed)),
      );
      return { ...state, streams: dropProvisional(state.streams, new Set(stale.map((r) => r.threadId))), receipts };
    }
  }
}

/** Reactions changed for everyone: the message's pills in every loaded list, and the reactions cache. */
function cacheReactions(
  qc: QueryClient,
  orgId: string,
  channelId: string,
  messageId: string,
  reactions: ReactionCount[],
) {
  qc.setQueryData(keys.reactions(orgId, messageId), reactions);
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, reactions } : m));
  });
}

/**
 * A stopped reply was continued (my own "Continuar"; others' arrive as `run.continued`, `useContinuedRun`):
 * its "Continuar" goes away in every loaded list of the channel (`meta.canceled.continuedRunId`).
 */
export function cacheContinued(qc: QueryClient, orgId: string, channelId: string, messageId: string, newRunId: string) {
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === messageId)) return data;
    return list.map((m) => (m.id === messageId ? { ...m, meta: withContinued(m.meta, newRunId) } : m));
  });
}

/** A question was asked or answered: its card (`meta.question`) in every loaded list of the channel. */
function cacheQuestion(qc: QueryClient, orgId: string, channelId: string, question: AgentQuestion) {
  if (!question.messageId) return;
  qc.setQueriesData({ queryKey: ["org", orgId, "channel", channelId] }, (data: unknown) => {
    if (!Array.isArray(data)) return data;
    const list = data as Message[];
    if (!list.some((m) => m && m.id === question.messageId)) return data;
    return list.map((m) => (m.id === question.messageId ? { ...m, meta: { ...m.meta, question } } : m));
  });
}

/**
 * A secret was asked for, or the request closed (delivered, declined, expired, canceled; ADR 0027): its card
 * (`meta.secretRequest`) in every loaded list of the channel, threads included, so the card and the line above the
 * composer follow an answer given elsewhere.
 */
function cacheSecret(qc: QueryClient, orgId: string, channelId: string, secretRequest: SecretRequest) {
  if (!secretRequest.messageId) return;
  cacheMessageMeta(qc, orgId, channelId, secretRequest.messageId, () => ({ secretRequest }));
}

/** What each event changes in the caches (the run rows are the reducer's). */
function applyToCache(qc: QueryClient, orgId: string, channelId: string, event: ChannelEvent) {
  switch (event.type) {
    // A question to another agent went out, came back or waits on a person: the reply that asked redraws it.
    case "agent.consulting":
    case "agent.consulted":
    case "agent.consultation":
      void qc.invalidateQueries({ queryKey: keys.consultations(orgId, channelId) });
      break;
    case "message.created": {
      if (event.message) cacheMessage(qc, orgId, event.message);
      else void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
      // A new top-level message may get agent replies in its thread: start that list.
      if (event.message) startThreadCache(qc, orgId, event.message);
      // A reply: its root's "2 respostas" link and the thread's header.
      const threadId = repliedThread(event);
      if (threadId) refreshRepliedThread(qc, orgId, threadId);
      // The conversation list's last line and unread.
      void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
      void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
      break;
    }
    // A DM between people: the other one read it ("Visto" moves).
    case "channel.read":
      cacheDmRead(qc, orgId, event);
      break;
    case "message.pinned":
    case "message.unpinned":
      cachePinned(qc, orgId, channelId, event.messageId, event.type === "message.pinned");
      void qc.invalidateQueries({ queryKey: keys.pins(orgId, channelId) });
      break;
    case "agent.run":
    case "run.finished":
      // "Trabalhando agora" on Início, and the task manager (an agent's DM header counts its tasks here too).
      void qc.invalidateQueries({ queryKey: keys.working(orgId) });
      void qc.invalidateQueries({ queryKey: keys.taskManager(orgId) });
      break;
    case "message.reactions":
      cacheReactions(qc, orgId, channelId, event.messageId, event.reactions);
      break;
    case "poll.updated":
      qc.setQueryData(keys.poll(orgId, event.poll.id), event.poll);
      break;
    case "block.state":
      qc.setQueryData<BlockState>(keys.blockState(orgId, event.block.id, event.block.version), (old) =>
        newerBlockState(old, event.block),
      );
      break;
    case "choices.updated":
      qc.setQueryData(keys.choices(orgId, event.choices.id), event.choices);
      break;
    case "message.actions":
      // An agent's receipts changed (undone, redone, a new one): replace the list.
      cacheMessageActions(qc, orgId, channelId, event.messageId, event.actions);
      break;
    case "agent.work":
      // A long work moved, updated or ended (ADR 0121): its anchor's line redraws.
      cacheMessageWork(qc, orgId, channelId, event.work);
      break;
    case "approval.created":
    case "approval.decided":
      cacheApproval(qc, orgId, event.approval);
      break;
    case "thread.updated":
      void qc.invalidateQueries({ queryKey: keys.threads(orgId) });
      if (["created", "context", "moved", "returned", "deleted"].includes(event.change))
        void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", event.channelId] });
      break;
    case "mission.updated":
      void qc.invalidateQueries({ queryKey: keys.missions(orgId) });
      if (event.change === "suggestion" || event.change === "closed" || event.change === "done")
        void qc.invalidateQueries({ queryKey: keys.thread(orgId, event.channelId, event.threadId) });
      break;
    case "question.asked":
    case "question.answered":
      cacheQuestion(qc, orgId, channelId, event.question);
      break;
    case "secret.requested":
    case "secret.updated":
      cacheSecret(qc, orgId, channelId, event.secretRequest);
      break;
    case "card.delegate":
      cacheCardDelegate(qc, orgId, event, event.delegate);
      break;
    case "agent.proposal.updated":
      // An agent's proposal of a new agent was created or denied (by anyone): its card.
      cacheAgentProposal(qc, orgId, event, event);
      break;
    case "team.proposal.updated":
      // The right hand's team card changed (created, failed, adjusted, dismissed, undone): the whole card.
      cacheTeamCard(qc, orgId, event, event.card);
      break;
    case "calendar.proposal.updated":
      // An agent's event proposal was confirmed or dismissed: its card says so.
      cacheMessageMeta(qc, orgId, channelId, event.messageId, () => ({ calendarProposal: event.proposal }));
      break;
    case "feedback_offer.updated":
      // A report an agent offered was sent or put away (on another device of the person's): its row follows.
      cacheMessageMeta(qc, orgId, channelId, event.messageId, () => ({ feedbackOffer: event.offer }));
      break;
    case "action_card.updated":
      // A right hand's card of a workspace change was applied, dismissed or sent on: the whole card.
      cacheActionCard(qc, orgId, event, event.card);
      break;
    case "browser.handoff.updated": {
      const { handoff } = event;
      // An agent's browser request changed (ADR 0040): its card, the live view, the agent's open request.
      applyBrowserHandoff(qc, orgId, handoff, { channelId: event.channelId, threadId: event.threadId });
      // The card's own copy too (`meta.browserHandoff`, as the server keeps it): one that ended is no longer asked
      // about. Its message has the request's id; a take over has no card.
      if (handoff.kind === "ask")
        cacheMessageMeta(qc, orgId, channelId, handoff.id, () => ({ browserHandoff: handoff }));
      break;
    }
    case "machine.task":
      if (event.task.threadId) void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, event.task.threadId) });
      if (event.task.missionId) void qc.invalidateQueries({ queryKey: keys.mission(orgId, event.task.missionId) });
      break;
    default: {
      // An agent's wait for a device ended (or changed): its card says how, without a reload.
      const wait = deviceWaitEventOf(event);
      if (wait) {
        cacheMessageMeta(qc, orgId, wait.channelId, wait.messageId, () => ({ deviceWait: wait.deviceWait }));
        if (wait.threadId) void qc.invalidateQueries({ queryKey: keys.thread(orgId, wait.channelId, wait.threadId) });
      }
      break;
    }
  }
}

export interface ChatLive {
  /** Runs in this channel, oldest first. */
  runs: LiveRun[];
  /** Agents asking agents right now. */
  consults: LiveConsult[];
  /** Agents' receipts on people's messages, by message id (`receiptView` reads one). */
  receipts: ReceiptsState;
  /** Right after sending: "pensando…" for the agents that will answer (an agent DM), on `messageId`'s receipt too. */
  expect: (threadId: string, agentIds: string[], messageId?: string) => void;
  /** Messages loaded over HTTP: their receipts (`message.receipts`) start or catch up. */
  seed: (messages: readonly Message[]) => void;
  /** My message just sent where agents may pick it up: the clock until the router decides. */
  picking: (messageId: string) => void;
  /** "Parar" (as on the web): "Parando…" until the run's event; a run that already ended just leaves. */
  stop: (runId: string, byUserId: string) => void;
  /** Who is typing now (`typingIn` reads it for the conversation or one of its threads). */
  typing: TypingState;
  /** "I'm typing" here or in a thread, throttled (at most one frame every 3 s). */
  sendTyping: (threadId: string | null, text?: string) => void;
  /** Agents I named here that won't answer me, newest last (`agent.unavailable`). */
  notices: AgentUnavailableEvent[];
}

export function useChatLive(orgId: string, channelId: string, enabled: boolean): ChatLive {
  const connection = useConnection();
  const qc = useQueryClient();
  const api = useApi();
  const [state, dispatch] = useReducer(reduce, {
    streams: emptyStreams,
    consults: {},
    receipts: {},
    typing: {},
    notices: [],
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const meId = useMeId();
  const meRef = useRef(meId);
  meRef.current = meId;

  // Questions agents asked from here still out (the "asking…" line), listed with the active runs.
  useEffect(
    () =>
      consultSeeds.subscribe((id, open, askedAt) => {
        if (id === channelId) dispatch({ type: "consults", channelId, open, at: Date.now(), askedAt });
      }),
    [channelId],
  );

  // On open and after every reconnect: the server's active runs replace what we guessed. The channel's events reach
  // us only once the server confirms its subscription (the first, and after every reconnect): then the runs are
  // checked again and what the lists missed before then (an answer posted while the conversation opened) is added.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () => {
      const askedAt = Date.now();
      api.agents
        .activeRuns(orgId, channelId)
        .then((active) => {
          if (alive && active) dispatch({ type: "reconcile", channelId, active, at: Date.now(), askedAt });
        })
        .catch(() => {});
    };
    check();
    const off = connection?.onReconnect(() => {
      check();
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    });
    const offSubscribed = connection?.onSubscribed((id) => {
      if (id !== channelId) return;
      check();
      const before = stateRef.current.receipts;
      void catchUpChannel(api, qc, orgId, channelId).then((read) => {
        if (!alive) return;
        dispatch({ type: "seed", messages: read, before });
        cacheReceipts(qc, orgId, channelId, read);
      });
      // The lines of its computers too: a `computer.queue` it missed leaves a wait's place unsaid.
      void qc.invalidateQueries({ queryKey: [...keys.machines(orgId), "queue"] });
    });
    return () => {
      alive = false;
      off?.();
      offSubscribed?.();
    };
  }, [api, connection, enabled, orgId, channelId, qc]);

  // On my own topic, as on the web: an agent my message here named won't answer me.
  useEffect(() => {
    if (!connection || !enabled) return;
    return connection.onUserEvent((event) => {
      if (isAgentUnavailable(event) && event.channelId === channelId) dispatch({ type: "unavailable", event });
    });
  }, [connection, enabled, channelId]);

  useEffect(() => {
    if (!connection || !enabled) return;
    const close = openConversation(qc, orgId, channelId);
    const off = connection.subscribe(channelId, (event) => {
      // The server sends my own typing back to me too: never shown, so it never redraws.
      if (event.type === "user.typing" && event.userId === meRef.current) return;
      dispatch({ type: "event", event, at: Date.now() });
      applyToCache(qc, orgId, channelId, event);
      applyMembershipEvent(qc, orgId, event);
      // A file's cards (a deleted one says so) and an agent's memory list, as on the web.
      applyConversationEvent(qc, orgId, event);
    });
    // Left, or the app went to the background: shown again, it reads what it missed, as on the web.
    return () => {
      off();
      close();
    };
  }, [connection, enabled, orgId, channelId, qc]);

  // Safety net, as on the web: a "pensando…" the server never confirmed doesn't spin forever; the
  // conversation resyncs instead (checked every 5 s while there is one).
  const hasProvisional = Object.values(state.streams.runs).some((r) => r.provisional && r.channelId === channelId);
  useEffect(() => {
    if (!hasProvisional) return;
    const timer = setInterval(() => {
      const at = Date.now();
      if (staleProvisional(stateRef.current.streams, at, PROVISIONAL_TTL_MS).length === 0) return;
      dispatch({ type: "sweep", at });
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    }, 5000);
    return () => clearInterval(timer);
  }, [hasProvisional, qc, orgId, channelId]);

  // Someone who stops typing without sending leaves the line when their last frame runs out.
  const typingEnds = Math.min(...Object.values(state.typing[channelId] ?? {}).map((x) => x.until));
  useEffect(() => {
    if (!Number.isFinite(typingEnds)) return;
    // A beat past the end, so the sweep never runs a hair early and finds it still on.
    const timer = setTimeout(
      () => dispatch({ type: "typed", at: Date.now() }),
      Math.max(0, typingEnds - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [typingEnds]);
  const throttle = useMemo(() => typingThrottle(), []);
  const sendTyping = useCallback(
    (threadId: string | null, text?: string) => {
      if (connection && throttle(Date.now(), text)) connection.sendTyping(channelId, threadId);
    },
    [connection, channelId, throttle],
  );

  const expect = useCallback(
    (threadId: string, agentIds: string[], messageId: string = threadId) => {
      if (agentIds.length > 0) dispatch({ type: "expect", channelId, threadId, messageId, agentIds, at: Date.now() });
    },
    [channelId],
  );
  const seed = useCallback((messages: readonly Message[]) => dispatch({ type: "seed", messages }), []);
  // My message just sent where agents may pick it up: the clock at once, as the router's own `message.routing` says.
  const picking = useCallback(
    (messageId: string) =>
      dispatch({
        type: "event",
        event: { type: "message.routing", channelId, messageId, step: "plan" },
        at: Date.now(),
      }),
    [channelId],
  );

  const stop = useCallback(
    (runId: string, byUserId: string) => {
      dispatch({ type: "stopping", runId, byUserId });
      playSound("stop");
      api.agents.cancelRun(orgId, runId).catch((err: unknown) => {
        // 409 `run_finished`: it ended on its own meanwhile; its message is on the way (or already here).
        if (err instanceof ApiError && err.status === 409) {
          dispatch({ type: "dismiss", runId });
          void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
        } else dispatch({ type: "unstopping", runId });
      });
    },
    [api, orgId, channelId, qc],
  );

  // Each list keeps its identity until its own part changes: someone typing redraws the line, not the timeline.
  const runs = useMemo(() => runsInChannel(state.streams, channelId), [state.streams, channelId]);
  const consults = useMemo(() => consultsIn(state.consults, channelId), [state.consults, channelId]);
  return useMemo(
    () => ({
      runs,
      consults,
      receipts: state.receipts,
      expect,
      seed,
      picking,
      stop,
      typing: state.typing,
      sendTyping,
      notices: state.notices,
    }),
    [runs, consults, state.receipts, state.typing, expect, seed, picking, stop, sendTyping, state.notices],
  );
}
