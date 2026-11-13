import type { Message } from "@agenteschat/client";
import { useApprovals, useWebPushKey } from "@agenteschat/client";
import { billingHoldOf } from "@agenteschat/client/lib/billing";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  MAX_PUSH_OFFERS,
  type PushPermissionLike,
  pushAskAt,
  pushOffersFrom,
} from "@agenteschat/client/lib/push-offer";
import { Button, Icon } from "@agenteschat/ui";
import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import {
  canOfferWebPush,
  disableWebPush,
  enableWebPush,
  readPushEnvironment,
  readWebPushState,
  refreshWebPush,
  setStalePushSweeper,
  sweepStalePushes,
  type WebPushState,
} from "@/lib/web-push";

/** Who the server last heard this browser's subscription for, in which language (`useWebPushRefresh`). */
let refreshedFor: string | null = null;
/** Read each time, never kept here: these modules outlive the browser they first read (tests open many apps). */
const offered = () => canOfferWebPush(readPushEnvironment());

/**
 * "Avisos neste navegador" (ADR 0071): this browser's state and its switch, in Configurações › Notificações. `shown`
 * only where this browser can take notifications and the server sends them. Nothing asks for permission until the
 * person flips it.
 */
export function useBrowserNotices() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const here = offered();
  const publicKey = useWebPushKey(here).data;
  const [state, setState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!here || publicKey === undefined) return;
    let live = true;
    void readWebPushState(publicKey).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [here, publicKey]);

  const change = (on: boolean) => {
    if (busy || !publicKey) return;
    setBusy(true);
    // The person chose here: the dialog never asks again in this browser.
    storage.set(STORAGE_KEYS.pushOffers, String(MAX_PUSH_OFFERS));
    // Straight from the click: the browser shows its permission prompt only during the person's gesture.
    const run = on ? enableWebPush(api, publicKey, i18n.language) : disableWebPush(api);
    run
      .then((next) => {
        // Chrome's quieter prompts may keep the request as a crossed-out bell in the address bar, with no answer:
        // without a word here the switch would just go back off.
        if (on && next === "default") toast.show(t("shell.browserNoticesUnanswered"));
        setState(next);
      })
      .catch(() => {
        toast.show(t("shell.browserNoticesFailed"), "error");
        return readWebPushState(publicKey).then(setState);
      })
      .finally(() => setBusy(false));
  };

  const shown = here && Boolean(publicKey) && state !== null && state !== "unsupported" && state !== "off-by-server";
  return { shown, on: state === "subscribed", blocked: state === "denied", busy, change };
}

/**
 * On opening a workspace: a browser already on tells the server again, quietly (it keeps it, and it moves
 * to whoever is signed in now). Asks the person nothing.
 */
export function useWebPushRefresh(userId: string) {
  const api = useApi();
  const { i18n } = useTranslation();
  const locale = i18n.language;
  useEffect(() => {
    // Once per page load for each person and language: the route is rate limited.
    const what = `${userId}:${locale}`;
    if (!userId || !offered() || refreshedFor === what) return;
    refreshedFor = what;
    void refreshWebPush(api, locale);
  }, [api, userId, locale]);
}

/**
 * Clear on read (ADR 0071): the notifications this browser still shows for what the person already read,
 * finished or snoozed elsewhere close on opening the app, whenever the tab comes back into view, and after the
 * badge drops (the realtime handler asks for it, `requestStalePushSweep`). Quiet, and nothing at all where
 * notifications aren't on in this browser.
 */
export function useWebPushClear() {
  const api = useApi();
  useEffect(() => {
    if (!offered()) return;
    const sweep = () => sweepStalePushes(api);
    setStalePushSweeper(sweep);
    void sweep();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      setStalePushSweeper(null);
    };
  }, [api]);
}

const promptState = (): PushPermissionLike => {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission === "default" ? "undetermined" : Notification.permission;
};

/** The message the ask shows under, kept for the tab until it is answered: it counts as an offer once, when shown. */
const SHOWN_AT = `${STORAGE_KEYS.pushOffers}.at`;

/**
 * Where our notifications ask shows in this conversation (ADR 0071, `pushAskAt`), under the message it follows: the
 * first answer from an agent to the person, then the first request waiting on them. Never on a billing hold, never
 * where this browser can't take notifications. Shown once it counts as an offer, and stays there until answered.
 */
export function usePushAsk(messages: readonly Message[] | undefined) {
  const { org, me } = useOrg();
  const here = offered();
  const publicKey = useWebPushKey(here).data;
  const held = billingHoldOf(org.standing) !== null;
  const approvals = useApprovals(org.id).data;
  const [offers, setOffers] = useState(() => pushOffersFrom(storage.get(STORAGE_KEYS.pushOffers), false));
  const [shownAt, setShownAt] = useState(() => sessionStore.get(SHOWN_AT));
  const pending = new Set((approvals ?? []).filter((a) => a.status === "pending").map((a) => a.id));
  const found =
    here && publicKey && messages
      ? pushAskAt(messages, me.user.id, {
          held,
          offers,
          permission: promptState(),
          turnedOff: false,
          waitsOnMe: (m) => typeof m.meta?.approvalId === "string" && pending.has(m.meta.approvalId),
        })
      : null;
  const next = found?.messageId ?? null;
  useEffect(() => {
    if (!next || sessionStore.get(SHOWN_AT)) return;
    sessionStore.set(SHOWN_AT, next);
    setShownAt(next);
    storage.set(STORAGE_KEYS.pushOffers, String(offers + 1));
    setOffers(offers + 1);
  }, [next, offers]);
  const close = useCallback(() => {
    sessionStore.remove(SHOWN_AT);
    setShownAt(null);
  }, []);
  const messageId = shownAt && messages?.some((m) => m.id === shownAt) ? shownAt : null;
  // Read by every message row (memoized): it changes only when the message it shows under does.
  return useMemo(() => ({ messageId, close }), [messageId, close]);
}

/** The conversation's ask (`usePushAsk`), for its message rows. */
export const PushAskContext = createContext<ReturnType<typeof usePushAsk> | null>(null);

/**
 * The ask itself, under the agent's answer: what a notification from it looks like, that it comes with the tab
 * closed, "Ativar avisos" (the browser's prompt, from that click) and "Agora não".
 */
export function PushAskInline({
  agent,
  onClose,
}: {
  agent: { id: string; name: string } | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const publicKey = useWebPushKey(offered()).data;
  const [asking, setAsking] = useState(false);
  const name = agent?.name ?? t("webPushAsk.someone");
  const turnOn = () => {
    if (asking || !publicKey) return;
    setAsking(true);
    // Straight from the click: the browser shows its prompt only during the person's gesture.
    enableWebPush(api, publicKey, i18n.language)
      .then((state) => {
        if (state === "subscribed") toast.show(t("webPushAsk.done"));
        // Chrome's quieter prompts may keep it as a crossed-out bell by the address, with no answer.
        else if (state === "default") toast.show(t("shell.browserNoticesUnanswered"));
      })
      .catch(() => toast.show(t("webPushAsk.failed"), "error"))
      .finally(() => {
        setAsking(false);
        onClose();
      });
  };
  return (
    <section className="push-ask" aria-label={t("webPushAsk.inline.title", agentGrammar(name))}>
      <p className="push-ask__title ac-iconline">
        <Icon name="bell" size={16} />
        <b>{t("webPushAsk.inline.title", agentGrammar(name))}</b>
      </p>
      <div className="web-push-ask__example ac-mediarow ac-mediarow--row" aria-hidden="true">
        <span className="ac-mediarow__face">
          <AgentAvatar agentId={agent?.id} name={name} size="sm" />
        </span>
        <span className="ac-mediarow__head">
          <b>{t("webPushAsk.finished.title", { name })}</b>
        </span>
        <span className="ac-mediarow__end ac-mediarow__meta">{t("webPushAsk.now")}</span>
        <span className="ac-mediarow__body web-push-ask__body">{t("webPushAsk.finished.body")}</span>
      </div>
      <p className="push-ask__why">{t("webPushAsk.inline.why")}</p>
      <div className="push-ask__acts">
        <Button size="sm" variant="primary" icon="bell" loading={asking} onClick={turnOn}>
          {t("webPushAsk.on")}
        </Button>
        <Button size="sm" variant="ghost" disabled={asking} onClick={onClose}>
          {t("webPushAsk.later")}
        </Button>
      </div>
    </section>
  );
}
