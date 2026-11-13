import {
  type BrowserTrailStep,
  browserTrailHosts,
  browserTrailHref,
  browserTrailKind,
  browserTrailLines,
  browserTrailPages,
  browserTrailSpanMs,
  HELD_STALE_MS,
  isHeldTakeover,
  type ScreenKind,
  useAgentBrowserHandoff,
} from "@agenteschat/client";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useCardTop } from "../chat/look";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { stepText } from "./logic";
import { TrailMark, TrailPage, TrailSky, TrailStrip } from "./TrailPixels";

/** The thumbnail: the live card's size, a browser bar on top of the drawn page. */
const THUMB = { width: 96, height: 60 };
const BAR = 13;

/** The web's words for a screen: the desktop's own where it has them, the browser's otherwise. */
function screenT(t: TFunction, screen: ScreenKind) {
  const loose = t as unknown as (keys: string[], options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) =>
    screen === "browser" ? loose([`browser.${key}`], options) : loose([`${screen}.${key}`, `browser.${key}`], options);
}

/** A step in the person's words, from the saved trail. */
const said = (t: TFunction, s: BrowserTrailStep, screen: ScreenKind) => stepText(t, s, screen);

/**
 * Where the agent browsed, on its message after the run, as on the web (`BrowserTrailCard`): the closed card
 * stays, still, with a drawn page (never a picture of the real one, ADR 0040 §7), where it browsed, its steps
 * as pixel columns in the agent's tones and how long. Opening it lists the steps by page, repeats folded into
 * one line, each site openable in the person's own browser. On the desktop (`screen`, ADR 0062) the same card
 * tells the apps it opened instead of the sites.
 */
export function TrailCard({
  agentId,
  runId,
  steps,
  stopped,
  recent = false,
  screen = "browser",
}: {
  agentId: string;
  /** Its run: while a take over still holds the browser, the live card stands in the conversation instead. */
  runId: string | null;
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
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const cardTop = useCardTop();
  const when = useWhen();
  const surface = useSurface("e2");
  const [open, setOpen] = useState(false);
  const asks = recent && runId !== null && screen === "browser";
  const handoff = useAgentBrowserHandoff(orgId, agentId, asks, HELD_STALE_MS);
  const agent = dir.agentById.get(agentId);
  const color = agentLook(agent).color;
  const last = steps.at(-1);
  if (!last || (asks && isHeldTakeover(handoff.data, runId))) return null;

  const time = when.time(last.at);
  const by = stopped?.byUserId ?? null;
  // Done needs no line (the message has its time); stopped says who and when.
  const ended = !stopped
    ? null
    : by && by === meId
      ? tt("after.stoppedByYou", { time })
      : by && dir.memberById.get(by)
        ? tt("after.stoppedBy", { person: dir.memberById.get(by)?.name, time })
        : tt("after.stoppedAt", { time });
  const hosts = browserTrailHosts(steps);
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
  const toggle = () => {
    tapHaptic();
    setOpen((o) => !o);
  };

  return (
    <View
      style={[styles.card, surface, cardTop]}
      accessibilityLabel={tt("inCard.group", agentGrammar(agent?.name ?? ""))}
    >
      <TrailSky color={color} />
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[title, summary, ended].filter(Boolean).join(". ")}
        accessibilityHint={open ? tt("after.hideSteps") : tt("after.showSteps")}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <View style={[styles.thumb, { backgroundColor: c.sunken, borderColor: c.line }]}>
          <View style={[styles.bar, { borderBottomColor: c.line }]}>
            <View style={[styles.dot, { backgroundColor: c.line2 }]} />
            <View style={[styles.dot, { backgroundColor: c.line2 }]} />
            <View style={[styles.dot, { backgroundColor: c.line2 }]} />
            <View style={[styles.address, { backgroundColor: c.plate }]} />
          </View>
          <TrailPage color={color} width={THUMB.width} height={THUMB.height - BAR} />
        </View>
        <View style={styles.grow}>
          <Text variant="footnote" tone="ink" numberOfLines={1} style={styles.semibold}>
            {title}
          </Text>
          <View style={styles.sum}>
            <TrailStrip kinds={steps.map(browserTrailKind)} color={color} />
            <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
              {summary}
            </Text>
          </View>
          {ended ? (
            <View style={styles.ended}>
              <Icon name="stop" size={12} color={c.faint} />
              <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
                {ended}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <View style={[styles.log, { borderTopColor: c.line }]}>
          {browserTrailPages(steps).map((p, i) => {
            const href = p.link ? browserTrailHref(p.site) : null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed list from the message
              <View key={i} style={styles.page}>
                <View style={styles.site}>
                  <Icon name={screen === "desktop" ? "laptop" : "globe"} size={SITE_ICON} color={c.muted} />
                  <Text variant="footnote" tone="ink2" numberOfLines={1} style={[styles.grow, styles.semibold]}>
                    {p.host ?? tt("after.noSite")}
                    {p.path ? (
                      <Text variant="footnote" tone="faint" style={styles.medium}>
                        {p.path}
                      </Text>
                    ) : null}
                  </Text>
                  {p.steps[0] ? (
                    <Text variant="caption" tone="faint">
                      {when.time(p.steps[0].at)}
                    </Text>
                  ) : null}
                  {href ? (
                    <Pressable
                      onPress={() => void Linking.openURL(href).catch(() => undefined)}
                      accessibilityRole="link"
                      accessibilityLabel={tt("after.openSite", { site: p.site })}
                      hitSlop={8}
                      style={({ pressed }) => [styles.ext, pressed && { backgroundColor: c.plate }]}
                    >
                      <Icon name="out" size={13} color={c.faint} />
                    </Pressable>
                  ) : null}
                </View>
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
                    <View key={j} style={styles.line}>
                      <View style={styles.mark}>
                        <TrailMark kind={browserTrailKind(a)} color={color} />
                      </View>
                      <Text
                        variant="footnote"
                        tone={a.failed ? "danger" : "muted"}
                        numberOfLines={1}
                        style={styles.grow}
                      >
                        {text}
                      </Text>
                      {line.times > 1 ? (
                        <View style={[styles.times, { backgroundColor: c.plate }]}>
                          <Text variant="caption" tone="ink2" style={styles.timesText}>
                            {tt("after.times", { count: line.times })}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** A page's site mark, beside its footnote name. */
const SITE_ICON = 13;

const styles = StyleSheet.create({
  card: { borderRadius: 20, overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10 },
  pressed: { opacity: 0.7 },
  thumb: {
    width: THUMB.width,
    height: THUMB.height,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  bar: {
    height: BAR,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 4, height: 4, borderRadius: 2 },
  address: { flex: 1, height: 7, marginLeft: 4, borderRadius: 999 },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  // Narrower than the web's card: the words go under a long strip instead of being cut.
  sum: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4, marginTop: 4 },
  ended: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  flip: { transform: [{ rotate: "180deg" }] },
  log: { paddingTop: 6, paddingHorizontal: 14, paddingBottom: 10, borderTopWidth: StyleSheet.hairlineWidth },
  page: { paddingTop: 4 },
  site: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 },
  ext: { width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  // A line's mark starts where its page's name does: past the site's mark and the gap.
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: SITE_ICON + 8 },
  mark: { width: 18, alignItems: "center" },
  times: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  timesText: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
