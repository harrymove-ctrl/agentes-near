import { and, type Executor, eq, schema, sql } from "@agenteschat/db";

const { organizationMembers } = schema;

/** How a conversation's rows are drawn. Mirrored in packages/client/src/lib/chat-look.ts, which also holds the defaults. */
export const CHAT_STYLES = ["comfortable", "left", "bubbles", "compact"] as const;
export type ChatStyle = (typeof CHAT_STYLES)[number];
/** My bubbles in the Bolhas style: a light tint or the solid color. */
export const CHAT_TONES = ["light", "strong"] as const;
export type ChatTone = (typeof CHAT_TONES)[number];
/** Where a conversation opens: at its newest message, or where the person stopped reading. */
export const CHAT_OPEN_AT = ["latest", "read"] as const;
export type ChatOpenAt = (typeof CHAT_OPEN_AT)[number];
/** Tamanho do texto of the messages, smallest first. */
export const CHAT_TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];

/** Only what the person chose: a key not here keeps the app's default. */
export interface ChatPrefs {
  channelStyle?: ChatStyle;
  dmStyle?: ChatStyle;
  channelTone?: ChatTone;
  dmTone?: ChatTone;
  openAt?: ChatOpenAt;
  textSize?: ChatTextSize;
  /**
   * "Always send" (ADR 0160 §12): a report an agent offers about the app goes with its reply, without asking. Kept
   * here because it is theirs alone, per workspace, on every device.
   */
  feedbackAuto?: boolean;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown) => (list.includes(v as T) ? (v as T) : undefined);

/** The stored value, keeping only what this build knows. */
export function chatPrefsOf(stored: unknown): ChatPrefs {
  const o = (stored ?? {}) as Record<string, unknown>;
  const picks = {
    channelStyle: oneOf(CHAT_STYLES, o.channelStyle),
    dmStyle: oneOf(CHAT_STYLES, o.dmStyle),
    channelTone: oneOf(CHAT_TONES, o.channelTone),
    dmTone: oneOf(CHAT_TONES, o.dmTone),
    openAt: oneOf(CHAT_OPEN_AT, o.openAt),
    textSize: oneOf(CHAT_TEXT_SIZES, o.textSize),
    feedbackAuto: typeof o.feedbackAuto === "boolean" ? o.feedbackAuto : undefined,
  };
  return Object.fromEntries(Object.entries(picks).filter(([, v]) => v !== undefined));
}

/** Merged in the database, so a choice made on another device in the meantime stays. Null: not a member here. */
export async function saveChatPrefs(db: Executor, orgId: string, userId: string, patch: ChatPrefs) {
  const rows = await db
    .update(organizationMembers)
    .set({ chatPrefs: sql`${organizationMembers.chatPrefs} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ chatPrefs: organizationMembers.chatPrefs });
  return rows[0] ? chatPrefsOf(rows[0].chatPrefs) : null;
}
