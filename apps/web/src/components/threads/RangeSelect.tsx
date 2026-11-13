import type { Message, ThreadInfo } from "@agenteschat/client";
import { useThreadMutation } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { formatTime, joinNames } from "@agenteschat/client/lib/format";
import {
  excludedRuns,
  moveEdge,
  pickRow,
  type RangeSelection,
  selectionInfo,
  selectionOf,
  stepEdge,
  threadTitle,
  timeSpan,
} from "@agenteschat/client/lib/threads";
import { Button, Checkbox, Chip, cx, Icon, Locked } from "@agenteschat/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useThreadFlows } from "./ThreadBits";
import "./threads.css";

/**
 * "Ajustar trecho": the selection in place on
 * the channel. The range is one continuous band; a thin rail in the gutter
 * joins it, with small start/end caps showing the time (drag them, or focus
 * one and use the arrow keys). Every row has a small outline checkbox; rows
 * left out collapse to one line ("Rafa · deixada de fora · Incluir"). The bar
 * at the bottom says how many and when, with Cancelar / Salvar.
 */

/** Pixels from the list's edge where dragging a cap scrolls it. */
const EDGE_SCROLL = 40;

export function useRangeAdjust({
  thread,
  list,
  channelName,
  onDone,
}: {
  thread: ThreadInfo | undefined;
  /** The channel's top-level messages (and the thread's moved ones), oldest first. */
  list: Message[];
  channelName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const flows = useThreadFlows();
  const mutation = useThreadMutation(org.id);
  const [sel, setSel] = useState<RangeSelection | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [blind, setBlind] = useState<string[] | null>(null);
  // The thread's range, once its messages are in the list.
  useEffect(() => {
    if (sel || !thread) return;
    const start = selectionOf(list, thread.context);
    if (start) setSel(start);
  }, [sel, thread, list]);
  const info = sel ? selectionInfo(list, sel) : null;
  const change = (next: RangeSelection) => {
    if (mutation.isPending) return;
    setBlind(null);
    setSel(next);
  };
  const save = () => {
    if (!thread || !sel || !info?.count) return;
    mutation.mutate(
      {
        type: "update",
        thread,
        patch: { firstMessageId: sel.a, lastMessageId: sel.b, excludedMessageIds: [...sel.excluded] },
      },
      {
        onSuccess: () => {
          toast.show(t("threads.adjust.saved", { count: info.count }));
          flows.openThread(thread.id);
          onDone();
        },
        onError: (error) => {
          if (errorCode(error) === "thread.context_not_visible") {
            // Who in the thread's conversation can't read this channel, by name.
            const params = (error as { params?: { userIds?: unknown; agentIds?: unknown } }).params ?? {};
            const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
            setBlind([
              ...ids(params.userIds).map((id) => dir.memberById.get(id)?.name ?? t("threads.adjust.someone")),
              ...ids(params.agentIds).map((id) => dir.agentById.get(id)?.name ?? t("threads.adjust.someAgent")),
            ]);
            return;
          }
          toast.show(errorText(t, error), "error");
        },
      },
    );
  };
  const cancel = () => {
    if (thread) flows.openThread(thread.id);
    onDone();
  };
  return {
    thread,
    list,
    channelName,
    sel,
    info,
    open,
    blind,
    saving: mutation.isPending,
    change,
    expand: (ids: string[]) => setOpen((prev) => new Set([...prev, ...ids])),
    save,
    cancel,
  };
}

export type RangeAdjust = ReturnType<typeof useRangeAdjust>;

/** The rows of the channel during "Ajustar trecho" (in place of the timeline). */
export function RangeRows({
  adjust,
  scroller,
  renderMessage,
}: {
  adjust: RangeAdjust;
  scroller: RefObject<HTMLElement | null>;
  /** The message as the channel draws it (inert here: the row is what you tap). */
  renderMessage: (message: Message) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const { list, sel, info, open } = adjust;
  const selRef = useRef(sel);
  selRef.current = sel;
  const runs = useMemo(() => (sel ? excludedRuns(list, sel, open) : null), [list, sel, open]);
  const [dragging, setDragging] = useState<"a" | "b" | null>(null);
  // Brings the start cap into view once the selection is there.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!sel || scrolled.current) return;
    scrolled.current = true;
    scroller.current?.querySelector(`[data-sid="${sel.a}"]`)?.scrollIntoView?.({ block: "start" });
  }, [sel, scroller]);
  // A cap being dragged: follows the pointer over the rows and scrolls near the edges.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: globalThis.PointerEvent) => {
      const el = scroller.current;
      const current = selRef.current;
      if (!el || !current) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (e.clientY < box.top + EDGE_SCROLL) el.scrollTop -= 14;
      else if (e.clientY > box.bottom - EDGE_SCROLL) el.scrollTop += 14;
      let best: HTMLElement | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const row of Array.from(el.querySelectorAll<HTMLElement>("[data-sid]"))) {
        const r = row.getBoundingClientRect();
        if (!r.height) continue;
        if (e.clientY >= r.top && e.clientY < r.bottom) {
          best = row;
          break;
        }
        const d = Math.min(Math.abs(e.clientY - r.top), Math.abs(e.clientY - r.bottom));
        if (d < distance) {
          distance = d;
          best = row;
        }
      }
      const id = best?.dataset.sid;
      if (id) adjust.change(moveEdge(list, current, dragging, id));
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, list, scroller, adjust]);

  if (!sel || !info || !runs) {
    return (
      <p className="channel__notice ac-iconline" role="status">
        <Icon name="spinner" size={16} />
        {t("threads.adjust.loading")}
      </p>
    );
  }
  /** "Incluir" on a collapsed run: all of it goes back in. */
  const toggleRun = (run: Message[]) => () => {
    const current = selRef.current;
    if (!current) return;
    const excluded = new Set(current.excluded);
    for (const m of run) excluded.delete(m.id);
    adjust.change({ ...current, excluded });
  };
  // The end cap sits on the last row you can see (a collapsed run may hide the real last one).
  const lastVisible = (() => {
    const b = list[info.ib];
    if (!b || !runs.hidden.has(b.id)) return b?.id;
    for (const [head, run] of runs.heads) if (run.some((m) => m.id === b.id)) return head;
    return b.id;
  })();
  const cap = (edge: "a" | "b") => {
    const row = list[edge === "a" ? info.ia : info.ib];
    if (!row) return null;
    const time = formatTime(i18n.language, row.createdAt);
    return (
      <div className={cx("thsel-cap", `thsel-cap--${edge}`, dragging === edge && "is-dragging")}>
        <button
          type="button"
          className="thsel-cap__handle"
          aria-label={t(edge === "a" ? "threads.adjust.start" : "threads.adjust.end", { time })}
          onPointerDown={(e: PointerEvent) => {
            e.preventDefault();
            setDragging(edge);
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            adjust.change(stepEdge(list, sel, edge, e.key === "ArrowUp" ? -1 : 1));
          }}
        >
          <Icon name="grip" size={14} />
          <span>{time}</span>
        </button>
      </div>
    );
  };
  return (
    <Locked when={adjust.saving}>
      <section className="thsel" aria-label={t("threads.adjust.rows")}>
        {list.map((m, j) => {
          if (runs.hidden.has(m.id)) return null;
          const inRange = j >= info.ia && j <= info.ib;
          const left = inRange && sel.excluded.has(m.id);
          const run = runs.heads.get(m.id);
          const name = dir.authorName(m.author);
          const time = formatTime(i18n.language, m.createdAt);
          const toggle = () => adjust.change(pickRow(list, sel, m.id));
          return (
            // biome-ignore lint/a11y: the checkbox (and the caps) are the keyboard way; a tap anywhere on the row does the same
            <div
              key={m.id}
              data-sid={m.id}
              className={cx(
                "thsel-row",
                !inRange && "is-out",
                inRange && "is-in",
                left && "is-left",
                j === info.ia && "is-first",
                m.id === lastVisible && "is-last",
                run && "is-collapsed",
              )}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button, a, [role=checkbox]")) return;
                toggle();
              }}
            >
              {run ? (
                <ExcludedLine run={run} onOpen={() => adjust.expand(run.map((x) => x.id))} onInclude={toggleRun(run)} />
              ) : (
                <>
                  <Checkbox
                    className="thsel-row__check"
                    checked={inRange && !left}
                    onCheckedChange={toggle}
                    aria-label={t("threads.adjust.include", { name, time })}
                  />
                  <div className="thsel-row__msg" inert>
                    {renderMessage(m)}
                  </div>
                </>
              )}
              {j === info.ia && cap("a")}
              {m.id === lastVisible && cap("b")}
            </div>
          );
        })}
      </section>
    </Locked>
  );
}

/** Rows left out of the range: one quiet line ("Rafa · deixada de fora"), with Incluir. */
function ExcludedLine({ run, onOpen, onInclude }: { run: Message[]; onOpen: () => void; onInclude: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const names = [...new Set(run.map((m) => dir.authorName(m.author)))];
  const label =
    run.length === 1
      ? t("threads.adjust.leftOne", { name: names[0] ?? "" })
      : t("threads.adjust.leftMany", { count: run.length, names: joinNames(names, t) });
  return (
    <div className="thsel-left">
      <Checkbox
        className="thsel-row__check"
        checked={false}
        onCheckedChange={onInclude}
        aria-label={t("threads.adjust.includeLeft", { label })}
      />
      <button type="button" className="thsel-left__label" onClick={onOpen} aria-label={t("threads.adjust.show")}>
        <span>{label}</span>
        <Icon name="chevronRight" size={14} />
      </button>
      <Button size="sm" variant="ghost" onClick={onInclude}>
        {t("threads.adjust.includeButton")}
      </Button>
    </div>
  );
}

/** The bar in place of the composer: what is selected, Cancelar / Salvar, and why it can't be saved. */
export function RangeBar({ adjust }: { adjust: RangeAdjust }) {
  const { t, i18n } = useTranslation();
  const { thread, info, blind, channelName } = adjust;
  const left = info?.left.length ?? 0;
  return (
    <>
      {blind && (
        <div className="thread-blocked" role="alert">
          <span className="thread-blocked__icon" aria-hidden="true">
            <Icon name="lock" size={16} />
          </span>
          <div>
            <b>{t("threads.adjust.blockedTitle")}</b>
            <p>
              {t("threads.adjust.blockedText", {
                count: blind.length,
                names: joinNames(blind, t),
                channel: channelName,
              })}
            </p>
          </div>
        </div>
      )}
      <section className="thsel-bar" aria-label={t("threads.adjust.region")}>
        <div className="thsel-bar__text">
          {thread && <span className="thsel-bar__what">{t("threads.adjust.of", { title: threadTitle(thread) })}</span>}
          <b>{t("threads.messages", { count: info?.count ?? 0 })}</b>
          {info?.from && info.to && (
            <span className="thsel-bar__span">{timeSpan(i18n.language, info.from, info.to)}</span>
          )}
          {left > 0 && <Chip icon="close">{t("threads.adjust.leftChip", { count: left })}</Chip>}
        </div>
        <div className="thsel-bar__actions">
          <Locked when={adjust.saving}>
            <Button size="sm" variant="ghost" onClick={adjust.cancel}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={!info?.count || Boolean(blind)}
              loading={adjust.saving}
              onClick={adjust.save}
            >
              {t("common.save")}
            </Button>
          </Locked>
        </div>
      </section>
    </>
  );
}
