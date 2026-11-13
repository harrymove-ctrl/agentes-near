import type { AgentStatus, Availability, MemberPresence, MemberStatus, StatusInput } from "@agenteschat/client";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { clearsText, type UntilChoice, untilFor } from "@agenteschat/client/lib/presence";
import type { TFunction } from "i18next";

/**
 * The phone's Status screen and the lines that show a status (ADR 0084), pure: the draft the screen edits, what
 * it saves, and how a person's or an agent's line reads in a row, a pill and a profile.
 */

/** What you picked, read back from how you appear to yourself (connected or not, "auto" is online). */
export function availabilityOf(presence: MemberPresence | undefined): Availability {
  return presence === "away" || presence === "busy" || presence === "out" || presence === "hidden" ? presence : "auto";
}

/** When the line clears: a choice made now, or the end the saved status already has (null: never). */
export type UntilPick = { choice: UntilChoice } | { at: string | null };

export interface StatusDraft {
  availability: Availability;
  emoji: string | null;
  text: string;
  until: UntilPick;
}

/** The screen starts from your saved availability (the server's, on your own row) and line. */
export function draftOf(
  me: { presence: MemberPresence; status: MemberStatus | null; availability?: Availability } | undefined,
): StatusDraft {
  return {
    availability: me?.availability ?? availabilityOf(me?.presence),
    emoji: me?.status?.emoji ?? null,
    text: me?.status?.text ?? "",
    until: { at: me?.status?.until ?? null },
  };
}

/** The end to save (ISO), or null. */
export const untilOf = (pick: UntilPick, now = new Date()): string | null =>
  "choice" in pick ? untilFor(pick.choice, now) : pick.at;

/** "Salvar": the availability and the line; an empty line clears it. */
export function inputOf(draft: StatusDraft, now = new Date()): StatusInput {
  const text = draft.text.trim();
  return {
    availability: draft.availability,
    status: text ? { text, emoji: draft.emoji, until: untilOf(draft.until, now) } : null,
  };
}

/** Whether the draft holds a suggestion as it was picked (its chip shows chosen). */
export const isSuggestion = (draft: StatusDraft, text: string, emoji: string) =>
  draft.text.trim() === text && draft.emoji === emoji;

/** The emojis offered for a line (the field's key): the suggestions' first, then common ones. */
export const STATUS_EMOJIS: readonly string[] = "💬 📅 🎧 🍽️ 🤒 🏖️ ☕ 🚗 ✈️ 🏠 💻 🛠️ 📚 🧘 🏃 🎉 👶 💤".split(" ");

/** A person's line in one string: "📅 Em reunião" (the emoji first, when there is one). */
export const lineText = (s: { emoji: string | null; text: string }) => (s.emoji ? `${s.emoji} ${s.text}` : s.text);

/** A person's line with when it clears: "📅 Em reunião · some às 15:00" (nothing said without an end). */
export function personLine(t: TFunction, language: string, s: MemberStatus, now = new Date()): string {
  return s.until ? `${lineText(s)} · ${lowerFirst(clearsText(t, language, s.until, now), language)}` : lineText(s);
}

/** What an agent's presence is from (`presence.agentWhy.*`): active, on heavy work, idle since, held, no AI. */
export function agentWhyKey(
  presence: AgentStatus["presence"],
  activeAt: string | null | undefined,
  noAi: boolean,
): "online" | "busy" | "away" | "awayNever" | "out" | "offline" | "noAi" {
  if (noAi) return "noAi";
  if (presence === "away") return activeAt ? "away" : "awayNever";
  return presence;
}
