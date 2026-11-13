import type { ApiClient } from "../api/client";
import { ApiError } from "../api/http";
import type { Message } from "../api/types";
import { errorCode } from "./errors";
import { voiceOf } from "./voice";

/** Retries on their way, by message: a second tap while one is asks nothing, and settles when that one does. */
const inFlight = new Map<string, Promise<void>>();

/**
 * "Tentar de novo" under my message an agent couldn't answer: the agent answers the same message again, so it never
 * shows twice. Only when that can't be (it went into a task already at work, the failed run was long work, or it had
 * done things that starting over would repeat) do its words go again (`resend`). A voice message's words never go
 * again as text: it is recorded again, and the error says so (`run.not_restartable_voice`). A second tap's promise
 * never rejects: the first one's caller says what went wrong, once.
 */
export function retryAnswer(api: ApiClient, orgId: string, message: Message, resend: () => void): Promise<void> {
  const going = inFlight.get(message.id);
  if (going) return going.catch(() => {});
  const again = () => {
    if (voiceOf(message.meta)) throw new ApiError(409, "run.not_restartable_voice", "Record the message again");
    resend();
  };
  const retry = (async () => {
    try {
      const { runs } = await api.chat.answerNow(orgId, message.id);
      if (runs.length === 0) again();
    } catch (error) {
      if (errorCode(error) !== "run.not_restartable") throw error;
      again();
    }
  })().finally(() => inFlight.delete(message.id));
  inFlight.set(message.id, retry);
  return retry;
}
