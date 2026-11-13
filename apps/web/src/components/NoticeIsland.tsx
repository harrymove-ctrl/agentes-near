import type { AppNotification } from "@agenteschat/client";
import { useApprovals, useChannels, useNotificationAction, useNotificationReply } from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { type IslandItem, islandLead, noticeLine } from "@agenteschat/client/lib/island";
import { mediaWord } from "@agenteschat/client/lib/media";
import {
  opensConnectAi,
  opensOnComputer,
  openTarget,
  quickReply,
  waitingCardOf,
} from "@agenteschat/client/lib/notifications";
import { Button, CountBadge, cx, Icon, Kbd, Locked, prefersReducedMotion } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { OpenDetailsContext } from "@/components/details-link";
import { useNotificationOpener } from "@/components/NotificationOpen";
import { type Dir, Face, Headline, SystemFace } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { island } from "@/lib/island";
import "./notice-island.css";

/** How often the island counts its notices' time down. */
const TICK_MS = 250;
/** The pointer rests this long on the closed island before it opens (a pass over it doesn't). */
const OPEN_DELAY_MS = 140;
/** And leaves it this long before it closes. */
const CLOSE_DELAY_MS = 280;
/** "Enviado" stays this long before the notice leaves. */
const SENT_MS = 1400;
/** Notices the open island lists; the rest are in Atividade. */
const OPEN_MAX = 4;
/** The closing island folds back into itself. */
const LEAVE_MS = 340;
/** The key's cap, as the keyboard prints it (not words to translate). */
const ESC = "Esc";

/**
 * The island (ADR 0071 §9): a dark pill at the top of the window, centered on it, with what reached me while I'm
 * here, the face of whoever called, and "Ver" (where it happened). Resting the pointer on it (or a click, or the keyboard) opens it with the whole text and the
 * answer right there; a notice leaves after a few seconds, and one waiting on me shrinks and stays until I decide.
 */
export function NoticeIsland() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const opener = useOpenNotice();
  const channels = useChannels(org.id);
  const channelName = useCallback((id: string) => channels.data?.find((c) => c.id === id)?.name ?? "", [channels.data]);
  const snap = useSyncExternalStore(island.subscribe, island.get, island.get);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The same island folds away when the last notice leaves.
  const [leaving, setLeaving] = useState<IslandItem[] | null>(null);
  const last = useRef<IslandItem[]>([]);
  useEffect(() => {
    if (snap.items.length) {
      last.current = snap.items;
      setLeaving(null);
      return;
    }
    setOpen(false);
    // It may leave under the pointer: no leave event comes then.
    island.pause("hover", false);
    if (!last.current.length) return;
    setLeaving(last.current);
    last.current = [];
    const timer = setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [snap.items]);

  // Time runs while nobody looks: stopped open, typing, with the pointer on it or the tab hidden.
  useEffect(() => {
    const timer = setInterval(() => island.tick(TICK_MS), TICK_MS);
    const hidden = () => island.pause("hidden", document.visibilityState !== "visible");
    hidden();
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(timer);
      clearTimeout(hover.current);
      document.removeEventListener("visibilitychange", hidden);
      island.pause("hidden", false);
      island.pause("hover", false);
    };
  }, []);
  useEffect(() => island.pause("open", open), [open]);

  // A new notice on an island already showing: a short pulse, so it isn't missed.
  const seen = useRef(snap.seq);
  useEffect(() => {
    if (snap.seq === seen.current) return;
    seen.current = snap.seq;
    // Alone, it is the island arriving (its own entrance); open, the list shows it.
    if (snap.items.length < 2 || open || prefersReducedMotion()) return;
    root.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.045)" }, { transform: "scale(1)" }], {
      duration: 380,
      easing: "cubic-bezier(.3,1.4,.5,1)",
    });
  }, [snap.seq, open, snap.items.length]);

  // Open: Esc or a click outside closes it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLElement>(".ni__pill")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const items = snap.items.length ? snap.items : leaving;
  if (!items?.length) return null;
  const { lead, small, others } = islandLead(items);
  if (!lead) return null;

  const enter = () => {
    clearTimeout(hover.current);
    island.pause("hover", true);
    if (!open) hover.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const exit = () => {
    clearTimeout(hover.current);
    island.pause("hover", false);
    hover.current = setTimeout(() => {
      // An answer being typed keeps it open.
      if (root.current?.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  // In <body>, beside a side pane rather than in the page it makes inert (`useModalSheet` keeps it out of that): over a
  // thread open in the panel, "Ver" is the island's, never the panel header's under it.
  return createPortal(
    <div className="ni-wrap">
      {/* Resting the pointer on it opens it; the pill itself is the button (keyboard, a click). */}
      <div
        ref={root}
        className={cx("ni", open && "ni--open", !open && small && "ni--small", !snap.items.length && "ni--leaving")}
        data-theme="dark"
        data-esc-layer={open ? "" : undefined}
        onPointerEnter={enter}
        onPointerLeave={exit}
      >
        {open ? (
          <section aria-label={t("island.label")}>
            <ul className="ni__list">
              {items.slice(0, OPEN_MAX).map((item) => (
                <NoticeRow key={item.n.id} n={item.n} dir={dir} channelName={channelName} />
              ))}
            </ul>
            <div className="ni__foot">
              <Link to="/org/$orgId/notifications" params={{ orgId: org.id }} className="ni__all">
                {t("island.all")}
              </Link>
              <span className="ni__hint">
                <Kbd>{ESC}</Kbd>
                {t("island.closes")}
              </span>
            </div>
          </section>
        ) : (
          <div className="ni__bar">
            <button
              type="button"
              className="ni__pill"
              aria-expanded={false}
              aria-label={t("island.expand")}
              onClick={() => setOpen(true)}
              onKeyDown={(e) => {
                // Esc on the closed island puts it away: the waiting ones shrink, the rest leave.
                if (e.key === "Escape") island.putAway();
              }}
            >
              <Who n={lead.n} dir={dir} className="ni__face" />
              <span className="ni__head">
                <Headline n={lead.n} dir={dir} channelName={channelName} />
              </span>
              {!small && <Line n={lead.n} className="ni__line" />}
              {others > 0 && (
                <>
                  <span className="ni__faces" aria-hidden="true">
                    {items
                      .filter((i) => i !== lead)
                      .slice(0, 2)
                      .map((i) => (
                        <Who key={i.n.id} n={i.n} dir={dir} className="ni__mini" />
                      ))}
                  </span>
                  <CountBadge className="ni__count">+{others}</CountBadge>
                </>
              )}
            </button>
            {opener.canOpen(lead.n) && (
              <Button
                size="sm"
                className="ni__see"
                // Resting on "Ver" never opens the island under the pointer: it goes where the notice happened.
                onPointerEnter={() => clearTimeout(hover.current)}
                onClick={() => opener.open(lead.n)}
              >
                {t("island.see")}
              </Button>
            )}
          </div>
        )}
      </div>
      {/* Read aloud as it arrives: who did what, and the line. */}
      <span className="ac-visually-hidden" role="status">
        {snap.items[0] && (
          <>
            <Headline n={snap.items[0].n} dir={dir} channelName={channelName} />: <Line n={snap.items[0].n} />
          </>
        )}
      </span>
    </div>,
    document.body,
  );
}

/** Whoever called; nobody behind it (the workspace telling), what it is about, else a bell. */
function Who({ n, dir, className }: { n: AppNotification; dir: Dir; className?: string }) {
  if (n.actors[0]) return <Face actor={n.actors[0]} dir={dir} size="sm" className={className} />;
  // SystemFace is plain markup (no hooks): null for kinds it has no face for.
  return (
    SystemFace({ n, className: cx("ni__sys", className) }) ?? (
      <span className={cx("ni__sys", className)} aria-hidden="true">
        <Icon name="bell" size={16} />
      </span>
    )
  );
}

function Line({ n, className }: { n: AppNotification; className?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // A request's title in words, from the request itself (the notification keeps the tool's raw title), as the phone.
  const approvals = useApprovals(org.id);
  const request = n.kind === "approval" ? approvals.data?.find((a) => a.id === n.source.approvalId) : undefined;
  const line = request ? approvalTitle(t, request) : noticeLine(n, (kind) => mediaWord(t, kind));
  return line ? <span className={className}>{line}</span> : null;
}

/** Where a notice happened: whether it has a place to open, and opening it there (read, and off the island). */
function useOpenNotice() {
  const { org } = useOrg();
  const act = useNotificationAction(org.id);
  const openNotification = useNotificationOpener();
  const openDetails = useContext(OpenDetailsContext);
  const canOpen = (n: AppNotification) => Boolean(openTarget(n) || opensOnComputer(n) || opensConnectAi(n, undefined));
  const open = (n: AppNotification) => {
    if (!n.readAt) act.mutate({ type: "read", item: n, read: true });
    island.settle(n.id);
    // An approval opens in its dialog over the page I'm on (approve or refuse there); the rest, where it happened.
    if (n.kind === "approval" && n.source.approvalId && openDetails) {
      openDetails({ kind: "approval", id: n.source.approvalId });
      return;
    }
    openNotification(n, org.id);
  };
  return { canOpen, open };
}

/** One notice on the open island: who and what, the whole line, and the answer right there. */
function NoticeRow({ n, dir, channelName }: { n: AppNotification; dir: Dir; channelName: (id: string) => string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const act = useNotificationAction(org.id);
  const reply = useNotificationReply(org.id);
  const opener = useOpenNotice();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    island.pause(`typing:${n.id}`, typing);
    return () => island.pause(`typing:${n.id}`, false);
  }, [typing, n.id]);
  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);

  const { target, suggestions, readOnly } = quickReply(n, Boolean(org.deletion));
  const waiting = n.waiting ? waitingCardOf(n) : null;
  const canOpen = opener.canOpen(n);
  // Revisar or Abrir as the main button, for a request that is opened rather than answered here.
  const opens = Boolean(waiting && waiting.action !== "answer" && canOpen);

  const read = () => {
    if (!n.readAt) act.mutate({ type: "read", item: n, read: true });
  };
  const open = () => opener.open(n);
  const answer = (text: string, choice = false) => {
    if (!target || !text.trim()) return;
    setFailed(false);
    reply.mutate(
      { target, text: text.trim(), choice },
      {
        onSuccess: () => {
          read();
          setTyping(false);
          setDone(choice ? t("island.answered", { choice: text.trim() }) : t("island.sent"));
          setTimeout(() => island.settle(n.id), SENT_MS);
        },
        onError: () => setFailed(true),
      },
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    answer(draft);
  };

  const buttons = [
    opens && (
      <Button key="main" variant="primary" size="sm" onClick={open}>
        {waiting?.action === "review" ? t("island.review") : t("island.open")}
      </Button>
    ),
    target && (
      <Button key="reply" size="sm" icon="reply" onClick={() => setTyping(true)}>
        {suggestions.length ? t("island.otherAnswer") : t("island.reply")}
      </Button>
    ),
    !opens && canOpen && (
      <Button key="open" size="sm" onClick={open}>
        {t("island.open")}
      </Button>
    ),
  ];

  return (
    <li className="ni__item ac-mediarow">
      <span className="ac-mediarow__face">
        <Who n={n} dir={dir} className="ni__face" />
      </span>
      <span className="ac-mediarow__head ni__title">
        <span>
          <Headline n={n} dir={dir} channelName={channelName} />
        </span>
      </span>
      <div className="ac-mediarow__body">
        <Line n={n} className="ni__text" />
        {done ? (
          <p className="ni__done" role="status">
            <Icon name="check" size={16} />
            {done}
          </p>
        ) : (
          <>
            {readOnly && (
              <p className="ni__readonly ac-iconline" role="status">
                <Icon name="lock" size={16} />
                <span>{t("deleting.composer")}</span>
              </p>
            )}
            {typing && target ? (
              <form className="ni__reply" onSubmit={submit}>
                <Locked when={reply.isPending}>
                  <input
                    ref={input}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setTyping(false);
                      }
                    }}
                    placeholder={t("island.placeholder")}
                    aria-label={t("island.reply")}
                  />
                </Locked>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon="send"
                  iconOnly
                  aria-label={t("island.send")}
                  loading={reply.isPending}
                  disabled={!draft.trim()}
                />
              </form>
            ) : (
              <Locked when={reply.isPending}>
                <div className="ni__acts">
                  {suggestions.map((s) => (
                    <button key={s} type="button" className="ni__choice" onClick={() => answer(s, true)}>
                      {s}
                    </button>
                  ))}
                  {/* Buttons alone end at the right edge with the main one last, in the page's order too, so Tab
                      goes as the eye does. After answers to pick, Outra resposta follows them. */}
                  {suggestions.length ? buttons : buttons.reverse()}
                </div>
              </Locked>
            )}
            {failed && <p className="ni__failed">{t("island.failed")}</p>}
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon="close"
        iconOnly
        aria-label={t("island.dismiss")}
        className="ni__x"
        onClick={() => island.dismiss(n.id)}
      />
    </li>
  );
}
