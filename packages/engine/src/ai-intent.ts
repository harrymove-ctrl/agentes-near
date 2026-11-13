import { isKnownProvider, PROVIDERS } from "@agenteschat/providers";
import { cutText } from "./format";
import type { Judge, JudgeAnswer } from "./judge";

/** What a person who met "no AI" wants: a Connect dialog step, or `task` (only the Connect button). */
export type ConnectIntentKind = "claude" | "chatgpt" | "api_key" | "any" | "task";

export interface ConnectIntent {
  intent: ConnectIntentKind;
  /** With `api_key`: the catalog provider the message names. */
  provider?: string;
  /** Sure enough for the Connect dialog to open by itself (for the message's author, once). */
  autoOpen?: true;
}

/** The suggested step goes on the Connect button only this sure; below it, the button opens the first step. */
export const CONNECT_INTENT_THRESHOLD = 0.6;
/**
 * The dialog opens by itself only this sure, and never for `any`: at 0.6, a price question, a cancellation
 * and a prompt injection opened dialogs nobody asked for.
 */
export const CONNECT_AUTO_OPEN_THRESHOLD = 0.9;

const INTENTS: Record<ConnectIntentKind, string> = {
  claude:
    "Connect or use Claude: a Claude plan or subscription (Pro, Max, Ultra, Team, Enterprise), Claude Code, or Anthropic.",
  chatgpt:
    "Connect or use ChatGPT: a ChatGPT plan or subscription (Plus, Pro, Business, Enterprise), Codex, or OpenAI's subscription.",
  api_key:
    "Connect an AI with an API key, or a provider other than a Claude or ChatGPT plan (OpenAI API, Anthropic API, DeepSeek, Gemini, Kimi, GLM, MiniMax, OpenRouter...).",
  any: "Set up or connect an AI without saying which one, or ask how to make the agents work.",
  task: "Anything else: a question, a task or request for the agents, a greeting, or people talking. Mentioning a product is not asking to connect it, and neither is asking its price, cancelling it, or using it for a task.",
};

const TASK: ConnectIntent = { intent: "task" };

const probabilityOf = (answer: JudgeAnswer | undefined, option: string) => answer?.probabilities?.[option] ?? 0;

/**
 * Jev reads a message that met no AI (the organization has none, or the agent asked has none) and
 * picks the Connect dialog's step. Calibrated only: without Jev, or when it fails or is slow, the
 * intent is `task` (no guessing from keywords). It only picks a step; it never grants anything.
 */
export async function aiConnectIntent(
  judge: Judge | null | undefined,
  input: { orgId: string; agentId?: string | null; runId?: string; text: string },
): Promise<ConnectIntent> {
  const text = input.text.trim();
  if (!judge || !text) return TASK;
  const providers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, `${p.label} API`])),
    none: "No provider named",
  };
  try {
    const answers = await judge.ask({
      orgId: input.orgId,
      agentId: input.agentId ?? null,
      ...(input.runId ? { runId: input.runId } : {}),
      kind: "ai_intent",
      calibrated: true,
      state: { workspace_has_ai_connected: false, message: cutText(text, 4000) },
      questions: {
        intent: {
          type: "choice",
          instructions:
            "A person wrote `message` in a team chat where no AI model is connected yet, so the AI agents can't answer. What does the person want?",
          criteria: INTENTS,
        },
        provider: {
          type: "choice",
          instructions: "Which AI provider does `message` name, if any?",
          criteria: providers,
        },
      },
    });
    const intent = answers.intent?.choice as ConnectIntentKind | undefined;
    if (!intent || !Object.hasOwn(INTENTS, intent) || intent === "task") return TASK;
    const p = probabilityOf(answers.intent, intent);
    if (p < CONNECT_INTENT_THRESHOLD) return TASK;
    const provider = answers.provider?.choice;
    const named =
      intent === "api_key" &&
      provider &&
      isKnownProvider(provider) &&
      probabilityOf(answers.provider, provider) >= CONNECT_INTENT_THRESHOLD;
    return {
      intent,
      ...(named ? { provider } : {}),
      ...(p >= CONNECT_AUTO_OPEN_THRESHOLD && intent !== "any" ? { autoOpen: true as const } : {}),
    };
  } catch {
    return TASK;
  }
}
