import type { CalItem } from "@agenteschat/client/lib/calendar";
import { Popover, RunLane } from "@agenteschat/ui";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { lookOf } from "@/lib/look";
import { useCadence } from "./EventChip";

/**
 * A routine that runs often, as its lane on the Rotinas horizon: the name
 * and cadence on top in a quiet line (the agent is the sprite on the lane), then the dotted line over its days, past runs as
 * pixel columns, future runs as pixels and the next one as the agent's
 * sprite. A click opens its details.
 */
export function RoutineBand({
  item,
  now,
  track,
  style,
  open,
  onOpenChange,
  details,
}: {
  item: CalItem;
  /** The view's wall clock. */
  now: Date;
  /** Where its line sits in the row: first day column, days covered, columns in the view. */
  track: { from: number; span: number; cols: number };
  style?: CSSProperties;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: ReactNode;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const cadence = useCadence()(item);
  const look = lookOf(actors.dir.agentById.get(item.agentId ?? ""));
  const past = (item.pastRuns ?? []).filter((r) => r.at >= item.start && r.at <= now);
  const future = (item.runs ?? []).filter((r) => r > now);
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={item.title}
      side="bottom"
      align="start"
      className="cal-pop"
      trigger={
        <button
          type="button"
          className="cal-band"
          style={style}
          aria-label={t("calendar.eventAria", { title: item.title, time: cadence })}
          aria-pressed={open}
        >
          <span className="cal-band__label">
            <b>{item.title}</b>
            <span className="cal-band__cadence">{cadence}</span>
          </span>
          <span
            className="cal-band__track"
            aria-hidden="true"
            style={{
              marginLeft: `${(track.from / track.cols) * 100}%`,
              width: `${(track.span / track.cols) * 100}%`,
            }}
          >
            <RunLane
              from={item.start}
              to={item.end}
              now={now}
              past={past}
              future={future}
              color={look?.color ?? "sky"}
              eyes={look?.eyes ?? "round"}
              running={item.running}
            />
          </span>
        </button>
      }
    >
      {details}
    </Popover>
  );
}
