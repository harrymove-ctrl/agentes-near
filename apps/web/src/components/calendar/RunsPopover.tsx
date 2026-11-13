import type { CalItem, RunEntry, RunStatus } from "@agenteschat/client/lib/calendar";
import { formatTime } from "@agenteschat/client/lib/format";
import { Chip, cx, type IconName, Popover } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { DetailsLink } from "@/components/details-link";

const RESULT_ICON: Record<RunStatus, IconName> = { ok: "check", silent: "dash", failed: "close", skipped: "wallet" };

/** How a run went; `last` for a run still ahead: how the routine's last one went. */
export function RunResult({ status, last }: { status: RunStatus; last?: boolean }) {
  const { t } = useTranslation();
  const words = t(`calendar.result.${status}`);
  return (
    <Chip icon={RESULT_ICON[status]} tone={status === "ok" ? "done" : "neutral"}>
      {last ? t("calendar.lastResult", { result: words }) : words}
    </Chip>
  );
}

/**
 * "+N rotinas" under a stack of routine runs in the day/week grid: it opens the stack's runs in the calendar's
 * popover, each with its agent's face, its time, how it went and a link to the routine.
 */
export function RunsPopover({
  runs,
  more,
  open,
  onOpenChange,
}: {
  runs: RunEntry[];
  /** How many runs the stack doesn't show. */
  more: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const time = (r: RunEntry) => formatTime(i18n.language, r.at.toISOString());
  const agentName = (it: CalItem) => actors.name({ type: "agent", id: it.agentId ?? "" });
  const first = runs[0] as RunEntry;
  const title = t("calendar.runsAt", { time: time(first) });
  const label = t("calendar.moreRuns", { count: more });
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      label={title}
      side="right"
      align="start"
      className="cal-pop"
      trigger={
        <button type="button" className="cal-week__more" aria-pressed={open} aria-label={label}>
          <span className="cal-more-words">{label}</span>
          {/* Where the stack is a column of faces, the count alone. */}
          <span className="cal-more-count">+{more}</span>
        </button>
      }
    >
      <section className="cal-details" aria-label={title}>
        <span className="ac-eyebrow">{title}</span>
        <ul className="cal-runs">
          {runs.map((r) => {
            const it = r.item;
            const status = r.status ?? (r.count > 1 ? undefined : it.lastResult);
            return (
              <li key={r.key} className={cx("cal-runs__item", it.agentId && "ac-iconline")}>
                {it.agentId && <AgentAvatar agentId={it.agentId} size="xs" name="" />}
                <span className="cal-runs__text">
                  <b className="cal-runs__name">{it.title}</b>
                  <span className="small muted tabular">
                    {agentName(it)} · {time(r)}
                  </span>
                  <span className="cal-runs__foot">
                    {status && <RunResult status={status} last={!r.status} />}
                    {it.routineId && (
                      <DetailsLink item={{ kind: "routine", id: it.routineId }} className="ac-link small">
                        {t("calendar.openRoutine")}
                      </DetailsLink>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </Popover>
  );
}
