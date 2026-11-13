import { Icon } from "@agenteschat/ui";
import { useLayoutEffect, useRef } from "react";

export interface RailStep {
  id: string;
  name: string;
  done: boolean;
  disabled: boolean;
  /** Shows the "opcional" line under the name (until there is an answer). */
  optional?: boolean;
  /** What was answered, under a done step's name (e.g. the workspace name). */
  value?: string;
  /** Under the name whatever the step's state: how far something it waits for is. */
  note?: string;
}

/**
 * The numbered steps of a stepped flow on the rail (onboarding, "Criar
 * agente"): a line joins the markers and fills up to where you are, the
 * current one raised, done ones with a check and what was answered under the
 * name, the ones not reached yet disabled. On narrow screens the rail turns
 * into a step bar.
 */
export function StepRail({
  label,
  steps,
  current,
  onGo,
  doneLabel,
  optionalLabel,
}: {
  label: string;
  steps: RailStep[];
  current: number;
  onGo: (index: number) => void;
  /** Screen readers hear it after a done step's name. */
  doneLabel: string;
  optionalLabel?: string;
}) {
  // A step bar wider than its screen (a phone's) scrolls sideways to keep the current step in sight, as the step
  // changes and as the window narrows; the page itself never scrolls for it.
  const strip = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const ol = strip.current;
    if (!ol) return;
    const reveal = () => {
      const step = ol.children[current]?.getBoundingClientRect();
      const box = ol.getBoundingClientRect();
      if (!step) return;
      if (step.right > box.right) ol.scrollLeft += step.right - box.right;
      else if (step.left < box.left) ol.scrollLeft -= box.left - step.left;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(reveal);
    resized.observe(ol);
    return () => resized.disconnect();
  }, [current]);
  return (
    <nav aria-label={label}>
      <ol className="onb__steps" ref={strip}>
        {steps.map((s, i) => {
          const done = s.done && i !== current;
          const sub =
            s.note ?? (done && s.value ? s.value : s.optional && !s.done && optionalLabel ? optionalLabel : null);
          return (
            <li key={s.id} data-done={done || undefined}>
              <button
                type="button"
                className="onb__step"
                aria-current={i === current ? "step" : undefined}
                disabled={s.disabled}
                onClick={() => onGo(i)}
              >
                <span className="onb__n" aria-hidden="true">
                  {done ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <span className="onb__step-text">
                  <span className="onb__step-name">
                    {s.name}
                    {done && <span className="ac-visually-hidden"> {doneLabel}</span>}
                  </span>
                  {sub && <span className="onb__step-sub">{sub}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
