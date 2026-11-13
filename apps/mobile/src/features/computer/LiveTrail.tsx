import {
  type BrowserTrailStep,
  browserTrailKind,
  browserTrailLines,
  browserTrailPages,
  type ScreenKind,
  type ScreenStep,
} from "@agenteschat/client";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, PixelOrbit, Text } from "@/ui";
import { stepText } from "../browser/logic";
import { TrailMark, TrailStrip } from "../browser/TrailPixels";
import { useColors, useWhen } from "../shared/hooks";

/** The pages the list keeps, the latest last: older ones are on the message once the run ends. */
const PAGES = 2;
/** The strip's columns, the latest: past this it would cross the screen. */
const STRIP = 24;

/** A live step as the saved trail has it: when it started (or now) and never failed yet. */
const asTrail = (s: ScreenStep, now: number): BrowserTrailStep => ({
  tool: s.tool,
  detail: s.detail,
  at: new Date(s.since ?? now).toISOString(),
  failed: false,
});

/** The desktop's words where it has them, the browser's otherwise (as the trail card says them). */
function screenT(t: TFunction, screen: ScreenKind) {
  const loose = t as unknown as (keys: string[], options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) =>
    screen === "browser" ? loose([`browser.${key}`], options) : loose([`${screen}.${key}`, `browser.${key}`], options);
}

/**
 * Under the agent's screen while watching, "Agora": its work as the browser's trail card lists it after the run
 * (ADR 0040 §7), live. The header carries a pixel column per step in the agent's tones and "N passos · tempo". The
 * steps go by page or app, repeats folded into "×2", and the one running now carries its orbit.
 */
export function LiveTrail({ steps, color, now }: { steps: ScreenStep[]; color: AgentColorName; now: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const when = useWhen();
  if (steps.length === 0) return null;
  const screen: ScreenKind = steps.at(-1)?.screen ?? "browser";
  const tt = screenT(t, screen);
  const trail = steps.map((s) => asTrail(s, now));
  const running = new Set(steps.flatMap((s, i) => (s.running ? [trail[i]] : [])));
  const first = trail[0];
  const span = first ? Math.max(0, now - Date.parse(first.at)) : 0;
  const summary = tt("after.summaryNoSite", {
    steps: t("chat.work.steps", { count: steps.length }),
    duration: formatDuration(t, span),
  });
  return (
    <View style={styles.trail}>
      <View style={styles.head} accessibilityRole="header">
        <Text variant="small" tone="ink" style={styles.semibold}>
          {t("agentComputer.phone.now")}
        </Text>
        <TrailStrip kinds={trail.slice(-STRIP).map(browserTrailKind)} color={color} />
        <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.summary}>
          {summary}
        </Text>
      </View>
      {browserTrailPages(trail)
        .slice(-PAGES)
        .map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pages of one run, in order
          <View key={i}>
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
            </View>
            {browserTrailLines(p.steps).map((line, j) => {
              const [a, b] = line.steps;
              if (!a) return null;
              const live = line.steps.some((s) => running.has(s));
              const said = (s: BrowserTrailStep) => stepText(t, s, screen);
              const text = b ? tt("after.pair", { a: said(a), b: lowerFirst(said(b), i18n.language) }) : said(a);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one page, in order
                <View key={j} style={styles.line}>
                  <View style={styles.mark}>
                    {live ? (
                      <PixelOrbit color={color} size={12} />
                    ) : (
                      <TrailMark kind={browserTrailKind(a)} color={color} />
                    )}
                  </View>
                  <Text
                    variant="footnote"
                    tone={live ? "ink" : "muted"}
                    numberOfLines={1}
                    style={[styles.grow, live && styles.semibold]}
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
        ))}
    </View>
  );
}

/** A page's site mark, beside its footnote name. */
const SITE_ICON = 13;

const styles = StyleSheet.create({
  trail: { paddingHorizontal: 16, paddingTop: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 28 },
  summary: { marginLeft: "auto", flexShrink: 1, fontVariant: ["tabular-nums"] },
  site: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 },
  // A line's mark starts where its page's name does: past the site's mark and the gap.
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: SITE_ICON + 8 },
  mark: { width: 18, alignItems: "center" },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  times: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  timesText: { fontWeight: "600", fontVariant: ["tabular-nums"] },
});
