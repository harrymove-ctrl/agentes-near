import type { BrainTurn } from "./types";

/**
 * A turn as a computer brain gets it: `thisTurn` is the "# This turn" block (ADR 0053 §10), what is true
 * for this turn only (the time, why it was called, where it is, memory and wiki found for the trigger,
 * a routine's time line); `thisTurnFound` is its end, what was found for the trigger (memory, wiki, recent actions).
 * Its system prompt holds only what doesn't change during its session.
 */
export type ComputerTurn = BrainTurn & { thisTurn?: string; thisTurnFound?: string };

/**
 * What a computer brain (Claude Code, Codex) reads this turn. Every turn starts
 * with "# This turn", so a live process or a resumed session never acts on the
 * time or the place it was started with. Then a new session gets the
 * conversation so far (the system text goes separately) and the trigger; a
 * resumed session already has everything up to its own last reply, so it gets
 * only what people said after it. `start`: where the turn starts ("You start in …", `prepareAgentCode`), read
 * with "# This turn" so the system text doesn't change with it: with the turn's facts, before what was found
 * (memory items are hints, and the line would read as one of them).
 */
export function computerPrompt(turn: ComputerTurn, start = ""): string {
  const all = turn.thisTurn?.trim() ?? "";
  const found = turn.thisTurnFound?.trim() ?? "";
  const head = found && all.endsWith(found) ? all.slice(0, -found.length).trim() : all;
  const now = [head, start.trim(), head === all ? "" : found].filter(Boolean).join("\n\n");
  const body = conversationPrompt(turn);
  return now ? `${now}\n\n${body}` : body;
}

function conversationPrompt(turn: BrainTurn): string {
  const { before, trigger } = withoutTrigger(turn.messages, turn.trigger.trim());
  const render = (m: { role: string; content: string }) => `${m.role === "user" ? "User" : "You"}: ${m.content}`;
  if (turn.session?.resume) {
    let i = before.length;
    while (i > 0 && before[i - 1]?.role === "user") i--;
    const fresh = before.slice(i);
    if (!fresh.length) return trigger;
    return `New messages since your last reply:\n\n${fresh.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
  }
  if (!before.length) return trigger;
  return `The conversation so far:\n\n${before.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
}

/**
 * The conversation without the trigger, which "Now answer this" gives once: the last user message is the trigger
 * itself, or holds it in its author's part (`[Ana]: …`, marked `(current message)` after others; a quote line,
 * attached files, a "sent through" line or notes may surround the text). That part and what follows it in the
 * message is then what "Now answer this" shows, its author kept.
 */
function withoutTrigger(
  messages: BrainTurn["messages"],
  trigger: string,
): { before: BrainTurn["messages"]; trigger: string } {
  const last = messages.at(-1);
  const same = { before: messages, trigger };
  if (last?.role !== "user" || !trigger) return same;
  const content = last.content.trimEnd();
  if (content.trim() === trigger) return { before: messages.slice(0, -1), trigger };
  const at = content.lastIndexOf(trigger);
  if (at === -1) return same;
  // The trigger's part starts at its author's label, after the parts before it (joined by a blank line).
  const head = content.slice(0, at);
  let from = -1;
  for (const m of head.matchAll(/(^|\n\n)(?:\(current message\) )?\[[^\]\n]*\]: /g)) {
    from = m.index + (m[1]?.length ?? 0);
  }
  if (from === -1) return same;
  const rest = content.slice(0, from).trimEnd();
  return {
    before: rest ? [...messages.slice(0, -1), { ...last, content: rest }] : messages.slice(0, -1),
    trigger: content.slice(from).replace(/^\(current message\) /, ""),
  };
}

/** The system text with the conversation's part after it (and `extra`), for a brain or runner that takes no `conversation`. */
export const systemWithConversation = (turn: Pick<BrainTurn, "system" | "conversation">, extra?: string) =>
  [turn.system, turn.conversation, extra].filter(Boolean).join("\n\n");
