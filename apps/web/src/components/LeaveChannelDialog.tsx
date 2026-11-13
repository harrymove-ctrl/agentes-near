import { type Channel, keys, useApi, useLeaveChannel, useRoster } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogFooter } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";

type Leaving = Pick<Channel, "id" | "name" | "visibility">;

const EVENT = "agentes:channel-leave";

/** Out of the channel, and off its page when it was open. */
function useLeave() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const leave = useLeaveChannel(org.id);
  const run = (channel: Leaving, then?: () => void, undo?: { label: string; run: () => void }) =>
    leave.mutate(channel.id, {
      onSuccess: () => {
        then?.();
        if (router.state.location.pathname.includes(`/c/${channel.id}`))
          void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
        toast.show(t("channel.left", { channel: channel.name }), "info", undo);
      },
      onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
    });
  return { run, pending: leave.isPending };
}

/**
 * "Sair do canal": a public channel goes at once, with Desfazer in its toast, since anyone can join it again. A
 * private one asks first (`LeaveChannelDialog`): only someone in it can bring the person back.
 */
export function useLeaveChannelWithUndo() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { run, pending } = useLeave();
  const ask = (channel: Leaving, onDone?: () => void) => {
    if (channel.visibility === "private") {
      onDone?.();
      window.dispatchEvent(new CustomEvent<Leaving>(EVENT, { detail: channel }));
      return;
    }
    run(channel, onDone, {
      label: t("channelCategories.undo"),
      run: () =>
        void api.chat
          .join(org.id, channel.id)
          .then(async () => {
            await qc.invalidateQueries({ queryKey: keys.channels(org.id) });
            await navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: channel.id } });
          })
          .catch((e: unknown) => toast.show(errorText(t, e, i18n.language), "error")),
    });
  };
  return { run: ask, pending };
}

/** The question before leaving a private channel, once for the whole app; the last person out archives it. */
export function LeaveChannelDialog() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [channel, setChannel] = useState<Leaving | null>(null);
  const { run, pending } = useLeave();
  const roster = useRoster(org.id, channel?.id ?? "", channel !== null);
  // The channel asked about stays drawn while the dialog closes.
  const last = useRef<Leaving | null>(channel);
  if (channel) last.current = channel;
  useEffect(() => {
    const onAsk = (e: Event) => setChannel((e as CustomEvent<Leaving>).detail);
    window.addEventListener(EVENT, onAsk);
    return () => window.removeEventListener(EVENT, onAsk);
  }, []);
  const alone = (roster.data ?? []).filter((m) => m.type !== "agent").length === 1;
  const shown = last.current;
  return (
    <Dialog
      open={channel !== null}
      onOpenChange={(o) => !o && !pending && setChannel(null)}
      title={t("channel.leaveTitle", { channel: shown?.name ?? "" })}
      description={t(alone ? "channel.leaveLast" : "channel.leavePrivate")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button variant="ghost" onClick={() => setChannel(null)} disabled={pending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={pending}
          disabled={roster.isLoading}
          onClick={() => shown && run(shown, () => setChannel(null))}
        >
          {t(alone ? "channel.leaveLastConfirm" : "channel.leaveConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
