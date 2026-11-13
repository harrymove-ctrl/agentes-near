import type { Agent } from "@agenteschat/client";
import { askKindWords } from "@agenteschat/client/lib/approval-words";
import { EventPill, EventPillMore, ExpiryFuse, Icon, type IconName, Locked, Spinner } from "@agenteschat/ui";
import {
  createContext,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { inlineWords } from "@/lib/markdown";
import { CardSky, colorOf } from "./Sky";
import "./request-card.css";

/**
 * What an agent can ask of a person in the conversation: each says so in the card's header and in the bar.
 * "proposal": a change to the workspace's context or an agent's instructions; "agent": a new agent.
 */
export type RequestKind =
  | "approval"
  | "secret"
  | "question"
  | "browser"
  | "desktop"
  | "proposal"
  | "agent"
  | "team"
  | "firstTask";

/** A request waiting for the viewer, as its card registers it: the bar above the composer says it. */
export type PendingAsk = { id: string; kind: RequestKind; agentId: string; what: string };

/** The same request, said the same way: nothing for the bar to redraw. */
export const sameAsk = (a: PendingAsk | undefined, b: PendingAsk | undefined) =>
  a?.id === b?.id && a?.kind === b?.kind && a?.agentId === b?.agentId && a?.what === b?.what;

/**
 * The request cards waiting for the viewer in one conversation's scroller, by their root element. A card puts
 * itself here while it waits for the viewer and takes itself out after; the bar above the composer watches them
 * (`useAsksOutOfView`), so nothing has to scan the rows while an agent writes.
 */
export function createAskRegistry() {
  const cards = new Map<HTMLElement, PendingAsk>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    cards: cards as ReadonlyMap<HTMLElement, PendingAsk>,
    put(el: HTMLElement, ask: PendingAsk) {
      if (sameAsk(cards.get(el), ask)) return;
      cards.set(el, ask);
      changed();
    },
    drop(el: HTMLElement) {
      if (cards.delete(el)) changed();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type AskRegistry = ReturnType<typeof createAskRegistry>;

const AskRegistryContext = createContext<AskRegistry | null>(null);

/**
 * Around one conversation's scroller, and only it: a card anywhere else (a panel beside it, a dialog) would
 * never read as in view there. Without one, a card registers nothing.
 */
export const AskRegistryProvider = AskRegistryContext.Provider;

/** setTimeout's longest wait (about 24.8 days): a later deadline is waited for in steps. */
const LONGEST_WAIT = 2_147_483_647;

/**
 * Whether `expiresAt` has passed, drawn again the moment it does (one timer for that moment, no clock), so a
 * request stops waiting on time even when no event says it expired. None: no deadline.
 */
export function useExpired(expiresAt: string | null | undefined) {
  const end = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const passed = Date.now() >= end;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (Number.isNaN(end) || passed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => {
      const ms = end - Date.now();
      // A timer may fire a little early: it waits out the rest.
      if (ms > 0) timer = setTimeout(wait, Math.min(ms, LONGEST_WAIT));
      else redraw((n) => n + 1);
    };
    wait();
    return () => clearTimeout(timer);
  }, [end, passed]);
  return passed;
}

/**
 * One card for every request an agent makes in the conversation, so each reads the same way and its decision
 * sits in the same place: a quiet header (what kind of request, and who else it waits for), the agent's own
 * words, what will happen drawn edge to edge (its preview, as an attachment's cover), the object on a line of its own between
 * hairlines with "Ver …" under its words opening it whole, anything to fill in, and the footer strip with the decision on
 * the left and the time left on the right. One surface: nothing inside has a background of its own.
 *
 * While it waits for the viewer it registers with its conversation (`AskRegistryProvider`), so the bar above the
 * composer can say it waits while it is out of view; `data-ask-id` lets "Ver" find it and bring it back.
 */
export function RequestCard({
  id,
  kind,
  agent,
  label,
  mine,
  waitingFor,
  who,
  source,
  lead,
  preview,
  object,
  details,
  open: openProp,
  onOpenChange,
  body,
  actions,
  end,
  what,
  onSubmit,
  muted = false,
  locked = false,
}: {
  id: string;
  kind: RequestKind;
  agent: Agent | undefined;
  /** The group's accessible name. */
  label: string;
  /** The viewer can answer it: the header says it waits for you (and the bar may bring it back). */
  mine: boolean;
  /** Who it waits for when it isn't the viewer. */
  waitingFor?: string;
  /** Who asks, before the kind ("Ada · Pergunta"), where the card stands away from its conversation. */
  who?: ReactNode;
  /** Where it was asked, after the kind ("Thread · #eng"), where the card stands away from its conversation. */
  source?: ReactNode;
  /** The agent's own words: what it asks. */
  lead: ReactNode;
  /**
   * What will happen, drawn edge to edge between hairlines above the object's line (an email as it will go out, an
   * action's values): its start, fading at the foot. "Ver …" replaces it with the whole thing.
   */
  preview?: ReactNode;
  /** The thing it is about, in two lines with a logo; `more` labels the button that opens `details`. */
  object?: { logo: ReactNode; title: ReactNode; detail?: ReactNode; more?: string };
  /** What "Ver …" opens: the whole action (an email as the email), the change, where it came from. */
  details?: ReactNode;
  /** Controlled "Ver …" (otherwise the card keeps it); with no `details`, what it opens lives outside the card. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Anything to fill in before deciding (a secret's field), above the footer. */
  body?: ReactNode;
  /** The footer's decision, primary first. Without it (and without `end`) the card has no footer. */
  actions?: ReactNode;
  /** The footer's right end: the fuse and its time left. */
  end?: ReactNode;
  /** The object's short title, for the bar ("Enviar e-mail"). */
  what: string;
  /** Its field and footer are a form (a secret): Enter sends it. */
  onSubmit?: () => void;
  /** Overtaken (a newer card took its place): drawn quiet, nothing to do. */
  muted?: boolean;
  /** Its decision is on its way or can't be made any more: what is filled in and clicked turns off, "Ver …" stays. */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const registry = useContext(AskRegistryContext);
  const root = useRef<HTMLDivElement>(null);
  const agentId = agent?.id ?? "";
  // Waiting for the viewer: in the conversation's list, with what the bar says (kept current in place).
  useEffect(() => {
    const el = root.current;
    if (registry && mine && el) registry.put(el, { id, kind, agentId, what });
  }, [registry, mine, id, kind, agentId, what]);
  useEffect(() => {
    const el = root.current;
    if (!registry || !mine || !el) return;
    return () => registry.drop(el);
  }, [registry, mine]);
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOpenSelf(next);
    onOpenChange?.(next);
  };
  const foot = (actions || end) && (
    <div className="rq__foot">
      {actions}
      {end && <span className="rq__end">{end}</span>}
    </div>
  );
  const fill = (
    <Locked when={locked}>
      {body}
      {foot}
    </Locked>
  );
  const inner = (
    <>
      <CardSky color={colorOf(agent)} />
      <div className="rq__head">
        <span className="rq__kind">
          {who && (
            <>
              <span className="rq__who">{who}</span>
              {" · "}
            </>
          )}
          {askKindWords(t, kind, Boolean(mine))}
          {source && <span className="rq__source"> · {source}</span>}
        </span>
        {/* Who else it waits for; waiting for me needs no words (the buttons say it). */}
        {!mine && waitingFor && <span className="rq__state rq__state--other">{waitingFor}</span>}
      </div>
      <p className="rq__lead">{inlineWords(lead, "rq")}</p>
      {preview && !(open && details) && <div className="rq__preview">{preview}</div>}
      {object && (
        <div className="rq__well">
          <span className="rq__logo">{object.logo}</span>
          {/* "Ver …" under the words, never a column beside them that would squeeze them. */}
          <span className="rq__wt">
            <b>{object.title}</b>
            {object.detail && <small>{inlineWords(object.detail, "rq-d")}</small>}
            {object.more && (details || onOpenChange) && (
              <RequestMore open={open} onClick={toggle}>
                {object.more}
              </RequestMore>
            )}
          </span>
        </div>
      )}
      {open && details && (
        <div className="rq__details">
          <Locked when={locked}>{details}</Locked>
        </div>
      )}
      {onSubmit ? (
        // Only what is filled in and sent is the form (laid out as if it weren't there).
        <form
          className="rq__form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {fill}
        </form>
      ) : (
        fill
      )}
    </>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      ref={root}
      className={muted ? "rq rq--muted" : "rq"}
      role="group"
      aria-label={label}
      data-ask-id={id}
      data-ask-kind={kind}
      data-ask-mine={mine ? "" : undefined}
    >
      {inner}
    </div>
  );
}

/** "Ver …": opens what a request holds back; its arrow turns while it is open. */
function RequestMore({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="rq__more" aria-expanded={open} onClick={onClick}>
      {children}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * A decided request: no card, one event pill in the conversation (`EventPill`). A pixel mark (a square when it went
 * through, a short bar when it was refused, expired or not applied), its words, its time, and its actions in the
 * frame: "Ver …" opens the rest under it.
 */
export function RequestDone({
  done,
  label,
  more,
  action,
  time,
  note,
  children,
}: {
  /** It went through. */
  done: boolean;
  /** The group's accessible name. */
  label: string;
  /** What the pill leaves out, and the action that opens it. */
  more?: { label: string; content: ReactNode };
  /** Its own actions (Desfazer, Cancelar): `EventPillAction`s. */
  action?: ReactNode;
  /** When it was decided. */
  time?: string;
  /** A quiet line under the pill (when one approved ahead runs, when it ran): a long time never squeezes the words. */
  note?: ReactNode;
  /** The words: what it was and how it ended. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const actions =
    action || more ? (
      <>
        {action}
        {more && (
          <EventPillMore open={open} onClick={() => setOpen((v) => !v)}>
            {more.label}
          </EventPillMore>
        )}
      </>
    ) : undefined;
  return (
    <EventPill
      className="rq-done"
      role="group"
      aria-label={label}
      mark={
        <span className="rq-done__mark" data-done={done || undefined} aria-hidden="true">
          <span />
        </span>
      }
      time={time}
      actions={actions}
      below={
        note || (open && more) ? (
          <>
            {note && <p className="rq-done__note">{note}</p>}
            {open && more && <div className="rq__details">{more.content}</div>}
          </>
        ) : undefined
      }
    >
      <span className="rq-done__text">{children}</span>
    </EventPill>
  );
}

/**
 * A request still waiting, as the same event pill it becomes once decided (`RequestDone`): its words in ink, and
 * - waiting for the viewer (`mine`): the pulsing pixel square (`WaitMark`) and what it asks for as the `primary`
 *   `EventPillAction` ("Connect", "Continue now"), the other actions plain after it;
 * - waiting for someone else (or for something, a computer): a quiet icon and no primary action.
 * Its words stay one sentence: a why, what a proposal gives or a command go under the frame (`below`), or behind
 * "See details" (`more`). Never a card inside it.
 */
export function RequestOpen({
  mine,
  icon = "clock",
  label,
  action,
  more,
  below,
  time,
  children,
  className,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** It waits for the viewer: the pulsing mark, and its main action is `primary`. */
  mine: boolean;
  /** The quiet mark while it waits for someone else. */
  icon?: IconName;
  /** The group's accessible name (its sentence when that is plain text). */
  label?: string;
  /** Its `EventPillAction`s, the main one first. */
  action?: ReactNode;
  /** What the pill leaves out, and the action that opens it. */
  more?: { label: string; content: ReactNode };
  /** Always under the frame: the why, what it gives, who may decide. */
  below?: ReactNode;
  time?: string;
  /** The one sentence: what it asks. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const actions =
    action || more ? (
      <>
        {action}
        {more && (
          <EventPillMore open={open} onClick={() => setOpen((v) => !v)}>
            {more.label}
          </EventPillMore>
        )}
      </>
    ) : undefined;
  const under =
    below || (open && more) ? (
      <>
        {open && more && <div className="rq__details">{more.content}</div>}
        {below && <div className="rq-open__below">{below}</div>}
      </>
    ) : undefined;
  return (
    <EventPill
      waiting
      className={className ? `rq-open ${className}` : "rq-open"}
      role="group"
      aria-label={label ?? (typeof children === "string" ? children : undefined)}
      mark={mine ? <WaitMark /> : <Icon name={icon} size={14} />}
      time={time}
      actions={actions}
      below={under}
      {...rest}
    >
      {children}
    </EventPill>
  );
}

/** The keys a request's answers take: one to nine. */
const CHOICE_KEYS = 9;

/** Number keys pick an answer while the focus is in the list (never while typing elsewhere). */
function choiceKeys(pick: (index: number) => void) {
  return (list: HTMLElement | null) => {
    if (!list) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      e.preventDefault();
      pick(Number(e.key) - 1);
    };
    list.addEventListener("keydown", onKey);
    return () => list.removeEventListener("keydown", onKey);
  };
}

/**
 * The answers an agent offers, in a request card's body: a list, one a line in the full width with its number key
 * (1 to 9 pick while the focus is in the list), whole sentences wrapping in their line, and `other` ("Outra
 * resposta") its last line. Only answers: deciding (approve, accept, create) stays the footer's buttons.
 */
export function RequestChoices({
  choices,
  onPick,
  disabled = false,
  other,
}: {
  choices: readonly { label: string; busy?: boolean }[];
  onPick: (index: number) => void;
  disabled?: boolean;
  /** The last line, writing an answer of one's own; none while that field is open. */
  other?: { label: string; onClick: () => void; ref?: Ref<HTMLButtonElement> };
}) {
  return (
    <ul
      className="rq__choices"
      ref={choiceKeys((i) => {
        if (!disabled && choices[i]) onPick(i);
      })}
    >
      {choices.map((c, i) => (
        <li key={c.label}>
          <button
            type="button"
            className="rq__choice"
            data-choice=""
            disabled={disabled}
            aria-busy={c.busy || undefined}
            onClick={() => onPick(i)}
          >
            {i < CHOICE_KEYS && (
              <span className="rq__key" aria-hidden="true">
                {i + 1}
              </span>
            )}
            <span className="rq__choice-text">{c.label}</span>
            {c.busy && <Spinner size={14} />}
          </button>
        </li>
      ))}
      {other && (
        <li>
          <button
            ref={other.ref}
            type="button"
            className="rq__choice rq__choice--other"
            disabled={disabled}
            onClick={other.onClick}
          >
            <span className="rq__key" aria-hidden="true">
              <Icon name="edit" size={14} />
            </span>
            <span className="rq__choice-text">{other.label}</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** The footer's "Tecle 1–3 para responder" under a list of two or more answers. */
export function RequestKeys({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count < 2) return null;
  return <span className="rq__keys">{t("question.keysHint", { count: Math.min(count, CHOICE_KEYS) })}</span>;
}

/** Waiting for you: a small pixel square outline that pulses (also in the bar above the composer). */
export function WaitMark() {
  return (
    <span className="rq-wait" aria-hidden="true">
      <span />
    </span>
  );
}

/** The footer's right end: the fuse burning down to the expiry, and its words. */
export function RequestFuse({ left, agent, text }: { left: number; agent: Agent | undefined; text: ReactNode }) {
  return (
    <>
      <ExpiryFuse left={left} color={colorOf(agent)} />
      {text}
    </>
  );
}

/** The well's logo tile with an icon of ours (a lock, the browser, a document). */
export function RequestTile({ children }: { children: ReactNode }) {
  return <span className="rq__tile">{children}</span>;
}

/** "Ver" in the bar: the request centered on screen, lit up for a moment. */
export function showRequest(root: HTMLElement | null, id: string, smooth: boolean) {
  const card = Array.from(root?.querySelectorAll<HTMLElement>("[data-ask-id]") ?? []).find(
    (el) => el.dataset.askId === id,
  );
  if (!card) return;
  card.scrollIntoView?.({ block: "center", behavior: smooth ? "smooth" : "auto" });
  card.classList.remove("rq--flash");
  // Restarts the animation when it is asked for again.
  void card.offsetWidth;
  card.classList.add("rq--flash");
  card.addEventListener("animationend", () => card.classList.remove("rq--flash"), { once: true });
}
