import { dayLabel } from "@agenteschat/client/lib/format";
import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DATE_PILL_IDLE_MS, dayAtTop } from "@/lib/date-pill";

export interface DatePillHandle {
  /** The person scrolled: show the day at the top, and hide it a moment after the last call. */
  poke: () => void;
}

/**
 * The day of the messages at the top of the list, floating at its top centre while the person scrolls (as WhatsApp
 * does): "Hoje", "Ontem", a weekday this week, else a date in the person's locale. Hidden from screen readers: the
 * day dividers in the list say it.
 */
export function DatePill({ scroller, ref }: { scroller: RefObject<HTMLElement | null>; ref: Ref<DatePillHandle> }) {
  const { t, i18n } = useTranslation();
  const [day, setDay] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useImperativeHandle(
    ref,
    () => ({
      poke() {
        const list = scroller.current;
        const top = list ? dayAtTop(list) : null;
        clearTimeout(timer.current);
        // Scrolled up past the first day, onto the conversation's start: it goes at once, never left over a card.
        if (!top) return setShown(false);
        setDay(top);
        setShown(true);
        timer.current = setTimeout(() => setShown(false), DATE_PILL_IDLE_MS);
      },
    }),
    [scroller],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!day) return null;
  return (
    <div className="channel__date" data-shown={shown || undefined} aria-hidden="true">
      <span className="channel__date-pill">{dayLabel(t, i18n.language, day)}</span>
    </div>
  );
}
