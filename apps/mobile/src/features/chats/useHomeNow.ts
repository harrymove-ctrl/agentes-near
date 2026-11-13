import { useNotifications } from "@agenteschat/client";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { WorkItem } from "../agents/logic";
import { useNow, useOrgId } from "../shared/hooks";
import type { ConversationRow } from "./logic";
import {
  type AgentRowState,
  agentRowState,
  confirmFinished,
  endedWork,
  type FinishedItem,
  finishedFromInbox,
  keepFinished,
  latestFinished,
} from "./now";
import type { WaitingItem } from "./waiting";

/** How long an ended item waits for its answer to show in the list (the message may arrive after). */
const PENDING_MS = 5 * 60_000;

/**
 * What finished, kept for the app's session (outside React, so it survives the tab's remounts): the work
 * seen in progress last time, ended items waiting for their answer, what finished, and what was tapped.
 */
const store = {
  orgId: "",
  prev: null as WorkItem[] | null,
  pending: [] as { item: WorkItem; endedAt: number }[],
  kept: [] as FinishedItem[],
  dismissed: new Set<string>(),
};

/**
 * The newest thing an agent finished, for the greeting: runs seen working that ended with the agent's
 * answer (watched while the app is open), and unread "mission/routine finished" from the inbox. Tapping it
 * (`dismiss`) takes it off.
 */
export function useFinished(work: WorkItem[], rows: ConversationRow[]) {
  const orgId = useOrgId();
  const inbox = useNotifications(orgId, "all");
  const now = useNow(60_000);
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  if (store.orgId !== orgId) {
    store.orgId = orgId;
    store.prev = null;
    store.pending = [];
    store.kept = [];
    store.dismissed = new Set();
  }

  useEffect(() => {
    const at = Date.now();
    if (store.prev) {
      for (const item of endedWork(store.prev, work)) store.pending.push({ item, endedAt: at });
    }
    store.prev = work;
    if (store.pending.length === 0) return;
    const found = confirmFinished(
      store.pending.map((p) => p.item),
      rows,
    );
    const done = new Set(found.map((f) => f.key));
    store.pending = store.pending.filter((p) => !done.has(p.item.key) && at - p.endedAt < PENDING_MS);
    if (found.length > 0) {
      store.kept = keepFinished(store.kept, found);
      bump();
    }
  }, [work, rows]);

  const fromInbox = useMemo(() => finishedFromInbox(inbox.data?.pages[0]?.items ?? []), [inbox.data]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for the store's changes
  const finished = useMemo(
    () => latestFinished([...store.kept, ...fromInbox], store.dismissed, now),
    [fromInbox, now, version],
  );
  const dismiss = useCallback((key: string) => {
    store.dismissed.add(key);
    bump();
  }, []);
  return { finished, dismiss };
}

/**
 * What each agent DM says instead of its last message (it waits on you, waits for its offline computer, or
 * what the agent is doing), by row key.
 */
export function useAgentRowStates(
  rows: ConversationRow[],
  work: WorkItem[],
  waiting: WaitingItem[],
  offline?: ReadonlyMap<string, { name: string }>,
) {
  return useMemo(() => {
    const out = new Map<string, AgentRowState>();
    for (const r of rows) {
      if (r.kind === "dm" && r.with.type === "agent")
        out.set(r.key, agentRowState(r.with.id, r.channelId, work, waiting, offline));
    }
    return out;
  }, [rows, work, waiting, offline]);
}
