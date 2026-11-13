/**
 * The app's sounds (ADR 0070): which one an event plays. The shared code only names the sound; each app plays
 * it (web: Web Audio; phone: a WAV in its cache, both synthesized by `@agenteschat/ui/sfx`), after the person's
 * choice on that device (off, or a style).
 */
import type { AppNotification, NotificationKind } from "../api/types";

/** Same names as `SOUNDS` in `@agenteschat/ui/sfx`. */
export type SoundName = "send" | "reply" | "done" | "attention" | "approved" | "error" | "stop" | "mention";

let player: ((name: SoundName) => void) | null = null;

/** Each app sets its player once; none (tests, a platform without sound) is silence. */
export function setSoundPlayer(next: ((name: SoundName) => void) | null) {
  player = next;
}

export function playSound(name: SoundName) {
  try {
    player?.(name);
  } catch {
    // A sound never breaks what played it.
  }
}

const BY_KIND: Partial<Record<NotificationKind, SoundName>> = {
  approval: "attention",
  agent_question: "attention",
  browser_handoff: "attention",
  secret_request: "attention",
  join_request: "attention",
  change_request: "attention",
  proposal_waiting: "attention",
  usage_limit: "attention",
  browser_profile_request: "attention",
  skill_update: "done",
  invitation_accepted: "done",
  approval_cover: "done",
  right_hand_decided: "done",
  right_hand_paused: "attention",
  app_created: "done",
  mention: "mention",
  dm: "reply",
  thread_reply: "reply",
  agent_reply: "reply",
  mission_finished: "done",
  routine_finished: "done",
  mission_stopped: "error",
  routine_failed: "error",
  run_failed: "error",
  routine_paused: "error",
  // Boards (ADR 0135): an alert and a request to publish wait on you; a widget that stopped is a failure.
  widget_alert: "attention",
  dashboard_proposal: "attention",
  widget_failed: "error",
};

/** In the background only what matters plays: something waits on you, someone called you, work ended. */
const FOREGROUND_ONLY = new Set<SoundName>(["reply"]);

/**
 * The sound for a notification that just arrived (`notification.upserted`): new and unread, once per group (a
 * merge into one already there plays nothing), or none.
 */
export function soundForNotification(
  n: Pick<AppNotification, "kind" | "waiting" | "count" | "readAt" | "doneAt">,
  background: boolean,
): SoundName | null {
  if (n.readAt || n.doneAt || n.count > 1) return null;
  const sound = BY_KIND[n.kind] ?? (n.waiting ? "attention" : null);
  if (!sound || (background && FOREGROUND_ONLY.has(sound))) return null;
  return sound;
}
