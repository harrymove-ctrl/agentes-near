import { Button, isApple, Locked, onScreenKeyboard, Textarea } from "@agenteschat/ui";
import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { aimsAtScreen } from "@/lib/keys";
import { useDialogHead } from "./head";

/** What the stage takes while watching (`useAskControl`): none of it otherwise, but its ref. */
export interface AskStage {
  ref: (el: HTMLElement | null) => void;
  tabIndex?: number;
  onPointerDownCapture?: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
}

/** A finger that moves farther than this between down and up scrolled, it didn't tap. */
const TAP_SLOP_PX = 12;

/** What on the stage keeps its own clicks: the question's buttons, a field. */
const OWN_INPUT = 'button,a,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"]';
/** Where keys and pastes are the person's own words. */
const TEXT_FIELD = 'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]';
/** A control that keeps Enter, Space and arrows; a letter typed on it still asks. */
const CONTROL =
  'button,a,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="radio"],[role="checkbox"],[role="switch"],[role="slider"]';

/**
 * Watching the agent's screen or page in the computer dialog: a click, a tap, a key or a paste asks "Quer assumir o
 * controle?" and sends nothing there. The question stays through more clicks and keys, so the person knows they aren't
 * in control; only Cancelar, Esc or taking control close it, and the next try asks again. Keys and pastes count with
 * the focus anywhere in the stage's dialog but a field (a control keeps its Enter, Space and arrows), and shortcuts
 * stay the browser's (`aimsAtScreen`). `offer`: watching, live, and nothing else in the way.
 */
export function useAskControl(offer: boolean) {
  const head = useDialogHead();
  const [asking, setAsking] = useState(false);
  const tapAt = useRef<{ x: number; y: number } | null>(null);
  const stageEl = useRef<HTMLElement | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    stageEl.current = el;
  }, []);
  // Cancelar goes with the question: the keys stay where they were, on the stage.
  const cancel = useCallback(() => {
    setAsking(false);
    stageEl.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!offer) setAsking(false);
  }, [offer]);
  const open = asking && offer;
  const setAsk = head?.setAsk;
  useEffect(() => {
    if (!open) return;
    setAsk?.(cancel);
    return () => setAsk?.(null);
  }, [open, setAsk, cancel]);
  useEffect(() => {
    if (!offer) return;
    // The stage's dialog, or the page with nothing over it; a menu or a dialog over it keeps its keys.
    const near = (target: EventTarget | null) => {
      const room = stageEl.current?.closest('[role="dialog"]') ?? document.body;
      if (!(target instanceof Element) || !stageEl.current) return false;
      return target === document.body || room.contains(target);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !near(e.target) || !aimsAtScreen(e, isApple())) return;
      const target = e.target as Element;
      if (target.closest(TEXT_FIELD)) return;
      if (target !== stageEl.current && target.closest(CONTROL) && (e.key.length !== 1 || e.key === " ")) return;
      e.preventDefault();
      setAsking(true);
    };
    const paste = (e: globalThis.ClipboardEvent) => {
      if (e.defaultPrevented || !near(e.target) || (e.target as Element).closest(TEXT_FIELD)) return;
      e.preventDefault();
      setAsking(true);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("paste", paste);
    };
  }, [offer]);
  const own = (target: EventTarget) => target instanceof Element && target.closest(OWN_INPUT) !== null;
  const stage: AskStage = offer
    ? {
        ref,
        tabIndex: 0,
        onPointerDownCapture: (e: PointerEvent<HTMLElement>) => {
          if (own(e.target)) return;
          if (e.pointerType === "touch") {
            tapAt.current = { x: e.clientX, y: e.clientY };
            return;
          }
          if (e.button !== 0) return;
          e.currentTarget.focus({ preventScroll: true });
          setAsking(true);
        },
        onPointerUp: (e: PointerEvent<HTMLElement>) => {
          const at = tapAt.current;
          tapAt.current = null;
          if (e.pointerType === "touch" && at && Math.hypot(e.clientX - at.x, e.clientY - at.y) < TAP_SLOP_PX)
            setAsking(true);
        },
        onPointerCancel: () => {
          tapAt.current = null;
        },
      }
    : { ref };
  return { asking: open, cancel, stage };
}

/** The question's buttons: take control (when this person may), and Cancelar under it (Fechar when it only says so). */
export function AskActions({ take, onCancel }: { take?: ReactNode; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="brw-dim__acts">
      {take}
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {take ? t("common.cancel") : t("common.close")}
      </Button>
    </span>
  );
}

/**
 * Pronto or Devolver, under the screen or the page for as long as the person is in control: one click hands back.
 * "Deixar um recado" opens a word to the agent, which it reads as the person's own, in the title's place. Where the
 * request asked the person something (`handoffWantsWords`) it is open from the start. Only that link and a click in the
 * note take the keys: a press anywhere else in the bar leaves them on the screen or the page, where Enter stays the
 * page's. Open, it is one line that grows as it wraps (`.brw-ac__note`). Enter hands back as in the chat, while
 * Shift+Enter, an input method's Enter and a phone's return key add a line, and Esc closes it empty, the keys back
 * where they were.
 */
export function HandBackFoot({
  title,
  label,
  grammar,
  note,
  onNote,
  noteFirst,
  pending,
  locked = false,
  onBack,
  other,
}: {
  title: string;
  label: string;
  grammar: { name: string; context?: string };
  /** Absent: no note (a shared profile goes back to its agents, not to one). */
  note?: string;
  onNote?: (note: string) => void;
  /** The note open from the start. */
  noteFirst: boolean;
  pending: boolean;
  /** The other way out is on its way: the whole bar waits, its button with no spinner of its own. */
  locked?: boolean;
  onBack: () => void;
  /** The other way out (a request's Desistir), before the main one. */
  other?: ReactNode;
}) {
  const { t } = useTranslation();
  // A note written before "Não consegui" opens again with it: nothing goes to the agent out of sight.
  const [writing, setWriting] = useState(noteFirst || Boolean(note?.trim()));
  const keysWere = useRef<HTMLElement | null>(null);
  const noted = writing && note !== undefined;
  const back = () => {
    if (!pending) onBack();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a press on the bar keeps the keys where they are
    <div
      className="brw-ac__foot brw-ac__fail brw-ac__back"
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      }}
    >
      <Locked when={pending || locked}>
        <div className="brw-ac__row">
          {noted ? (
            <Textarea
              rows={1}
              autoGrow
              className="brw-ac__note"
              autoFocus={keysWere.current !== null}
              value={note}
              onChange={(e) => onNote?.(e.target.value)}
              placeholder={t("browser.inCard.backPlaceholder", grammar)}
              aria-label={t("browser.inCard.backLabel", grammar)}
              maxLength={1000}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !noteFirst && !note.trim()) {
                  setWriting(false);
                  keysWere.current?.focus({ preventScroll: true });
                }
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || onScreenKeyboard()) return;
                e.preventDefault();
                back();
              }}
            />
          ) : (
            <>
              <b>{title}</b>
              {note !== undefined && (
                <button
                  type="button"
                  className="ac-link ac-link--muted brw-ac__add"
                  onClick={() => {
                    keysWere.current = document.activeElement as HTMLElement | null;
                    setWriting(true);
                  }}
                >
                  {t("browser.inCard.addNote")}
                </button>
              )}
            </>
          )}
          <span className="brw-ac__ways">
            {other}
            <Button size="sm" variant="primary" icon="check" loading={pending} onClick={back}>
              {label}
            </Button>
          </span>
        </div>
      </Locked>
    </div>
  );
}
