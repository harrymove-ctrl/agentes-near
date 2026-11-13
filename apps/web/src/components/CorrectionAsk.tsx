import type { Message } from "@agenteschat/client";
import { Button, Input } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelActions } from "./channel-actions";

/**
 * My 👎 on an agent's reply becomes a private question under it: "Quer que
 * Theo refaça ou explique o que faltou?". Only on this client (the person who
 * reacted), kept in the query cache (one per session); once answered or
 * dismissed it never comes back for that message (localStorage).
 */
const askKey = (messageId: string) => ["correction-ask", messageId] as const;
const storageKey = (messageId: string) => `agentes:correction-ask:${messageId}`;

function wasDismissed(messageId: string) {
  try {
    return window.localStorage.getItem(storageKey(messageId)) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(messageId: string) {
  try {
    window.localStorage.setItem(storageKey(messageId), "1");
  } catch {
    // Private window or blocked storage: it only stays hidden until reload.
  }
}

/** `open`: my 👎 was just added (ask, unless already answered or dismissed); `clear`: taken back or turned into 👍. */
export function useCorrectionAsk() {
  const qc = useQueryClient();
  return {
    open: (messageId: string) => {
      if (!wasDismissed(messageId)) qc.setQueryData(askKey(messageId), true);
    },
    clear: (messageId: string) => {
      if (qc.getQueryData(askKey(messageId))) qc.setQueryData(askKey(messageId), false);
    },
  };
}

/** The card under the agent's reply, shown only while asked. */
export function CorrectionAsk({ message, agentName }: { message: Message; agentName: string }) {
  const { t } = useTranslation();
  const actions = useChannelActions();
  const qc = useQueryClient();
  const { data: open } = useQuery({
    queryKey: askKey(message.id),
    queryFn: () => false,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [text, setText] = useState("");
  const dismiss = () => {
    rememberDismissed(message.id);
    qc.setQueryData(askKey(message.id), false);
  };
  if (!open || !actions?.requestCorrection) return null;
  const titleId = `correction-ask-${message.id}`;
  return (
    <form
      className="correction-ask"
      aria-labelledby={titleId}
      onSubmit={(e) => {
        e.preventDefault();
        actions.requestCorrection?.(message, text.trim() || t("correctionAsk.defaultText"));
        setText("");
        dismiss();
      }}
    >
      <p className="correction-ask__title" id={titleId}>
        {t("correctionAsk.title", { name: agentName })}
      </p>
      <div className="correction-ask__row">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("correctionAsk.placeholder")}
          aria-label={t("correctionAsk.label")}
          maxLength={2000}
        />
        {/* The field's height (40px): a field and its buttons are one row of the ruler. */}
        <Button type="submit" variant="primary">
          {t("correctionAsk.send")}
        </Button>
        <Button variant="ghost" onClick={dismiss}>
          {t("correctionAsk.notNow")}
        </Button>
      </div>
    </form>
  );
}
