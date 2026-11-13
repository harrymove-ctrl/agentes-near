import {
  type BrowserTrailStep,
  browserTrailHosts,
  browserTrailHref,
  browserTrailKind,
  browserTrailLines,
  browserTrailPages,
  browserTrailSpanMs,
  type ScreenKind,
  trailProfile,
} from "@agenteschat/client";
import { formatTime, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatDuration } from "@agenteschat/client/lib/work";
import { agentGradient, BrowserMark, BrowserStrip, Chip, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { stepText, useHeldTakeover } from "./BrowserCard";
import { SiteIcon } from "./SiteIcon";
import { screenIcon, screenT } from "./screen";
import "./browser.css";

/** A step in the person's words, from the saved trail. */
const said = (t: TFunction, s: BrowserTrailStep, screen: ScreenKind) =>
  stepText(t, { id: "", tool: s.tool, detail: s.detail, running: false }, screen);

/**
 * Where the agent browsed, on its message after the run: the closed card stays, still, with a drawn
 * page (never a picture of the real one, ADR 0040 §7), where it browsed, its steps as pixel columns
 * in the agent's tones (as a routine's runs) and how long. Opening it lists the steps by page,
 * repeats folded into one line, each site openable in the person's own browser. On the desktop
 * (`screen`, ADR 0062) the same card tells the apps it opened instead of the sites.
 */
export function BrowserTrailCard({
  agentId,
  runId,
  name,
  steps,
  stopped,
  recent = false,
  screen = "browser",
}: {
  agentId: string;
  /** Its run: while a take over still holds the browser, the live card stands here instead. */
  runId: string | null;
  name: string;
  /** `meta.browser.steps` (`browserTrailOf`), or the desktop's (`desktopTrailOf`). */
  steps: BrowserTrailStep[];
  /** The run was stopped (`meta.canceled`): who pressed Parar, when known. */
  stopped?: { byUserId: string | null } | null;
  /** A recent message: ask the server about a take over (otherwise only what the realtime events said). */
  recent?: boolean;
  screen?: ScreenKind;
}) {
  const { t, i18n } = useTranslation();
  const tt = screenT(t, screen);
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  // A take over that holds the browser has its live card on the chat; the desktop's has its panel.
  const held = useHeldTakeover(agentId, runId ?? "", recent && runId !== null && screen === "browser");
  const g = agentGrammar(name);
  const color = colorOf(dir.agentById.get(agentId));
  const last = steps.at(-1);
  if (!last || held) return null;
  const time = formatTime(i18n.language, last.at);
  const by = stopped?.byUserId ?? null;
  // Done needs no line (the message has its time); stopped says who and when.
  const ended = !stopped
    ? null
    : by === me.user.id
      ? tt("after.stoppedByYou", { time })
      : by && dir.memberById.get(by)
        ? tt("after.stoppedBy", { person: dir.memberById.get(by)?.name, time })
        : tt("after.stoppedAt", { time });
  const hosts = browserTrailHosts(steps);
  // A shared profile (ADR 0110): its name then, before the site; the agent's own browser has none.
  const profile = screen === "browser" ? trailProfile(steps) : null;
  // The site alone, short ("web.whatsapp.com" → "whatsapp.com"): the drawn page already says it browsed.
  const site = screen === "browser" ? hosts[0]?.replace(/^(www|web|m)\./, "") : hosts[0];
  const title = !site
    ? tt("after.titleNoSite")
    : hosts.length > 1
      ? tt("after.titleMore", { site, count: hosts.length - 1 })
      : site;
  const count = t("chat.work.steps", { count: steps.length });
  const duration = formatDuration(t, browserTrailSpanMs(steps));
  const summary = tt("after.summaryNoSite", { steps: count, duration });
  const group = tt("inCard.group", g);
  const toggle = open ? tt("after.hideSteps") : tt("after.showSteps");
  const [top, bottom] = agentGradient(color);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div
      className={open ? "brw-ac brw-trail brw-mf-end is-open" : "brw-ac brw-trail brw-mf-end"}
      role="group"
      aria-label={group}
      style={{ "--mf-a": top, "--mf-b": bottom } as CSSProperties}
    >
      {/* The frame it worked in, closed into its top: where, its steps as pixel columns, how long. */}
      <button
        type="button"
        className="brw-mf-end__row"
        aria-expanded={open}
        title={toggle}
        onClick={() => setOpen((o) => !o)}
      >
        {profile && <Chip>{profile}</Chip>}
        {hosts[0] ? (
          <SiteIcon host={hosts[0]} letterOnly={screen !== "browser"} />
        ) : (
          <Icon name={screenIcon(screen)} size={14} />
        )}
        <b>{title}</b>
        <span className="brw-grow" />
        <BrowserStrip kinds={steps.map(browserTrailKind)} color={color} rows={7} />
        <span className="brw-mf-end__sum">{summary}</span>
        <Icon name="chevronDown" size={14} className="brw-mf-end__chev" />
      </button>
      {ended && (
        <span className="brw-ac__hint brw-mf-end__hint">
          <Icon name="stop" size={14} />
          {ended}
        </span>
      )}
      {open && (
        <ol className="brw-log brw-trail__log brw-mf-end__log">
          {browserTrailPages(steps).map((p, i) => {
            const href = p.link ? browserTrailHref(p.site) : null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed list from the message
              <li key={i} className="brw-trail__page">
                <span className="brw-trail__site">
                  <Icon name={screenIcon(screen)} size={14} />
                  <span>
                    {p.host ?? tt("after.noSite")}
                    {p.path && <span className="brw-ac__path">{p.path}</span>}
                  </span>
                  {p.steps[0] && <small>{formatTime(i18n.language, p.steps[0].at)}</small>}
                  {href && (
                    <a
                      className="brw-trail__ext"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={tt("after.openSite", { site: p.site })}
                      title={tt("after.openSite", { site: p.site })}
                    >
                      <Icon name="external" size={14} />
                    </a>
                  )}
                </span>
                <ol>
                  {browserTrailLines(p.steps).map((line, j) => {
                    const [a, b] = line.steps;
                    if (!a) return null;
                    const text = b
                      ? tt("after.pair", { a: said(t, a, screen), b: lowerFirst(said(t, b, screen), i18n.language) })
                      : a.failed
                        ? tt("after.failed", { step: said(t, a, screen) })
                        : said(t, a, screen);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed list from the message
                      <li key={j} className={a.failed ? "is-failed" : undefined}>
                        <BrowserMark kind={browserTrailKind(a)} color={color} className="brw-trail__mark" />
                        <span>{text}</span>
                        {line.times > 1 && (
                          <b className="brw-trail__times">{tt("after.times", { count: line.times })}</b>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
