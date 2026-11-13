import type { Message } from "@agenteschat/client";
import { isMediaAfterReply } from "@agenteschat/client/lib/media";
import { type StoppedNotice, stoppedNoticeOf } from "@agenteschat/client/lib/notices";
import { createContext, useContext } from "react";
import { stoppedOf } from "./turn";

/** A task's stop as its notice tells it (ADR 0128): who stopped it, the reason, and the notice's own message. */
export interface StoppedRun {
  notice: StoppedNotice;
  /** The `run_stopped` notice's message (its time, its agent). */
  message: Message;
}

/**
 * One stop is one object in the conversation: the stopped reply's pill under its text. When that reply is here, the
 * run's `run_stopped` notice draws nothing and the reply's pill takes its words (who stopped it, the reason, "Add a
 * reason"); a run stopped before it wrote anything (still queued) keeps the notice's own pill. By run id, only the
 * runs whose stopped reply (`meta.canceled`, not media posted after it) is among `messages`.
 */
export function stoppedRunsOf(messages: readonly Message[]): ReadonlyMap<string, StoppedRun> {
  const notices = new Map<string, StoppedRun>();
  for (const message of messages) {
    const notice = stoppedNoticeOf(message.meta);
    if (notice) notices.set(notice.runId, { notice, message });
  }
  const runs = new Map<string, StoppedRun>();
  if (notices.size === 0) return runs;
  for (const m of messages) {
    if (m.author.type !== "agent" || !m.agentRunId || isMediaAfterReply(m.meta) || !stoppedOf(m.meta)) continue;
    const stop = notices.get(m.agentRunId);
    if (stop) runs.set(m.agentRunId, stop);
  }
  return runs;
}

/** What redraws the rows that read the stops: a reason said, a reply arriving, never every new message. */
export const stoppedRunsKey = (runs: ReadonlyMap<string, StoppedRun>) =>
  [...runs].map(([runId, s]) => `${runId}:${s.message.id}:${s.notice.reason ?? ""}`).join(" ");

const NONE: ReadonlyMap<string, StoppedRun> = new Map();

/** The conversation's stops by run (`stoppedRunsOf`); none outside a conversation's list. */
export const StoppedRunsContext = createContext<ReadonlyMap<string, StoppedRun>>(NONE);

/** The stop of a run whose reply is in this conversation, or null. */
export function useStoppedRun(runId: string | null | undefined): StoppedRun | null {
  const runs = useContext(StoppedRunsContext);
  return (runId && runs.get(runId)) || null;
}
