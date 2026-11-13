import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useToast } from "@/ui";
import { useConnection, useOrgId } from "../shared/hooks";
import { flushVoice, removeBubble, restoreVoice } from "./outbox";

/**
 * Recordings that still have to go, whatever screen is open: sent again when the app comes back or the connection
 * does, and a sender told when what they recorded won't arrive.
 */
export function useVoiceOutbox() {
  const qc = useQueryClient();
  const orgId = useOrgId();
  const connection = useConnection();
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(() => {
    const refused = (reason: "limit" | "refused") =>
      toast({ title: t(reason === "limit" ? "voice.limit" : "voice.notSent"), icon: "x" });
    restoreVoice(qc, orgId);
    void flushVoice(qc, refused);
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void flushVoice(qc, refused);
    });
    const offReconnect = connection?.onReconnect(() => void flushVoice(qc, refused));
    const offUser = connection?.onUserEvent((event) => {
      if (event.type !== "voice.dropped") return;
      const { clientId, channelId, reason } = event as unknown as {
        clientId: string;
        channelId: string;
        reason?: string;
      };
      removeBubble(qc, { orgId, channelId, clientId, threadId: null });
      toast({ title: t(reason === "silent" ? "voice.silent" : "voice.notSent"), icon: "mic" });
    });
    return () => {
      app.remove();
      offReconnect?.();
      offUser?.();
    };
  }, [connection, orgId, qc, t, toast]);
}
