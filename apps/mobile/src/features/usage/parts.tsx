import type { PlanAccountInfo } from "@agenteschat/client";
import {
  accountName,
  accountOwner,
  brandOf,
  type MeterSegment,
  type MeterWindow,
  planMeterText,
} from "@agenteschat/client/lib/plan-usage";
import { planName } from "@agenteschat/client/lib/plans";
import { mixHex } from "@agenteschat/ui/agent/engine";
import {
  PLAN_ALMOST,
  PLAN_TONE,
  planLevel,
  planLine,
  planState,
  planWindows,
  renewals,
} from "@agenteschat/ui/plan-state";
import { Canvas, createPicture, Picture, Skia } from "@shopify/react-native-skia";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { type IconName, InfoHint, LineIcon, ProviderLogo, Text, useTheme } from "@/ui";
import { useColors } from "../shared/hooks";

/*
 * The usage views' pieces (ADR 0063), as the web draws them (`PlanMeter`, `UsageDays`, `PlanUsage.tsx`): a plan's
 * windows as bars, an account's head, a month day by day. The words come from the shared
 * `@agenteschat/client/lib/plan-usage`.
 */

type MeterUsage = { windows: readonly MeterWindow[]; limited?: boolean; at: string };

/**
 * The bar (`.ac-meter`): a tint track, the value, an estimated part in full tone over it, the "almost" mark. Ink unless
 * a plan's level gives it a `color` (a 6-digit hex: its part's tint adds an alpha to it). `segments`: the value split
 * from the left by agent, each in its colour (its light tone in the dark theme), a hairline of track between them.
 */
export function Meter({
  value,
  part,
  segments,
  label,
  mark,
  color,
}: {
  value: number;
  part?: number;
  segments?: readonly MeterSegment[];
  label: string;
  mark?: number;
  color?: string;
}) {
  const { colors: c, scheme } = useTheme();
  const tone = color ?? c.ink;
  const split = segments && segments.length > 0 ? segments : null;
  const parts = part !== undefined || split !== null;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}
      style={[styles.track, { backgroundColor: c.plate }]}
    >
      <View style={[styles.bar, { width: `${Math.min(100, value)}%`, backgroundColor: parts ? `${tone}4d` : tone }]} />
      {part !== undefined ? (
        <View style={[styles.bar, { width: `${Math.min(100, part)}%`, backgroundColor: tone }]} />
      ) : null}
      {split ? (
        <View style={styles.segs}>
          {split.map((g) => (
            <View
              key={g.key}
              style={{ width: `${Math.min(100, g.value)}%`, backgroundColor: scheme === "dark" ? g.light : g.deep }}
            />
          ))}
        </View>
      ) : null}
      {mark !== undefined ? <View style={[styles.mark, { left: `${mark}%`, backgroundColor: c.raised }]} /> : null}
    </View>
  );
}

/**
 * A plan's usage like the provider shows it (the web's `PlanMeter`): a bar per window, tightest first, with its
 * percentage and when it resets; "almost" from 80%, "at the limit until…" at 100%, and how old the numbers are. The
 * bars are ink until a window nears its limit (`planLevel`, `PLAN_TONE`): amber from 80%, red from 90% and at the
 * limit, each window by its own level and the words above by the plan's.
 * `compact` (an agent's month, Contas de IA, Você): one line with the tightest windows ("semana 40% · 5h 12%",
 * after `label`), one bar for the fullest, only near the limit when it renews, then how old the numbers are from 10
 * minutes (out of date past 6 hours); nothing while no window is known, unless the plan already refused a request
 * ("No limite").
 */
export function PlanMeter({
  usage,
  compact = false,
  plain = false,
  label,
  children,
}: {
  usage: MeterUsage;
  compact?: boolean;
  /** No words above the bars on where the plan stands: what holds the meter already says it. */
  plain?: boolean;
  label?: string;
  /** An account's agents: between the bars and when they renew, which then shows once under them. */
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const text = planMeterText(t, i18n.language);
  const now = Date.now();
  if (compact) {
    const shown = planLine(usage, text, now);
    if (!shown) return null;
    const line = [label, shown.line, shown.age].filter(Boolean).join(" · ");
    const tone = c[PLAN_TONE[planLevel(shown.top?.used ?? 0, shown.state === "limited")]];
    return (
      <View style={styles.meterCompact}>
        {line ? (
          <Text variant="caption" tone="muted" style={styles.tabular}>
            {line}
          </Text>
        ) : null}
        {shown.top ? (
          <Meter value={shown.top.used} label={text.window(shown.top)} mark={PLAN_ALMOST} color={tone} />
        ) : null}
        {shown.alert ? (
          <Text variant="caption" style={[styles.bold, { color: tone }]}>
            {shown.alert}
          </Text>
        ) : null}
      </View>
    );
  }
  const rows = planWindows(usage, now);
  const { state, until, used } = planState(usage, now);
  const headline = plain ? null : state === "limited" ? text.limited(until) : state === "almost" ? text.almost : null;
  const passed = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= now;
  const renews = children ? renewals(rows, text, now) : null;
  return (
    <View style={styles.meter}>
      {headline ? (
        <Text variant="small" style={[styles.bold, { color: c[PLAN_TONE[planLevel(used, state === "limited")]] }]}>
          {headline}
        </Text>
      ) : null}
      {rows.map((w, i) => {
        const name = text.window(w);
        // A window that reset is empty again: its parts were the old window's.
        const fresh = !passed(w.resetsAt);
        const level = planLevel(w.used);
        const tone = c[PLAN_TONE[level]];
        return (
          <View key={`${w.kind}:${w.label ?? i}`} style={styles.window}>
            <View style={styles.windowLine}>
              <Text variant="small" tone="ink2" style={styles.grow}>
                {name}
              </Text>
              <Text variant="small" tone="muted" style={[styles.tabular, level !== "ok" && { color: tone }]}>
                {w.used}%
              </Text>
            </View>
            <Meter
              value={w.used}
              label={name}
              mark={PLAN_ALMOST}
              color={tone}
              {...(w.part !== undefined && fresh ? { part: w.part } : {})}
              {...(w.segments && fresh ? { segments: w.segments } : {})}
            />
            {w.note && fresh ? (
              <Text variant="caption" tone="muted">
                {w.note}
              </Text>
            ) : null}
            {w.resetsAt && fresh && !children ? (
              <Text variant="caption" tone="muted">
                {text.resets(w.resetsAt)}
              </Text>
            ) : null}
          </View>
        );
      })}
      {children}
      {children && renews ? (
        <Text variant="caption" tone="muted">
          {renews}
        </Text>
      ) : null}
      <Text variant="caption" tone="muted">
        {text.updated(usage.at)}
      </Text>
    </View>
  );
}

/** An account's head: the maker's mark, its name and plan, its maker and whose it is. */
export function AccountHead({ account, extra }: { account: PlanAccountInfo; extra?: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const whose = account.email ?? accountOwner(t, account);
  // The maker's logo, the account and its plan on one line, whose it is under them at the row's width.
  return (
    <View style={styles.acctBox}>
      <View style={styles.acct}>
        <ProviderLogo id={account.provider ?? account.kind} size="sm" off={account.signedOut} />
        <View style={[styles.grow, styles.acctName]}>
          <Text variant="callout" tone="ink" style={styles.bold}>
            {accountName(t, account)}
          </Text>
          {account.plan ? <Tag text={planName(account.plan)} color={c.muted} /> : null}
          {account.signedOut ? <Tag text={t("usageViews.signedOut")} color={c.warn} /> : null}
        </View>
      </View>
      <Text variant="small" tone="muted">
        {[brandOf(account), whose, extra].filter(Boolean).join(" · ")}
      </Text>
    </View>
  );
}

/** The small plate beside an account's name (its plan, "saiu da conta"). */
export function Tag({ text, color }: { text: string; color: string }) {
  const c = useColors();
  return (
    <View style={[styles.tag, { backgroundColor: c.plate }]}>
      <Text variant="caption" style={[styles.heavy, { color }]}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A card of the usage views: its icon and title (an ⓘ after it with what the card's numbers mean), then its body, then
 * an optional footer.
 */
export function UsageCard({
  icon,
  title,
  hint,
  footer,
  children,
}: {
  icon: IconName;
  title: string;
  hint?: { name: string; text: string };
  footer?: string;
  children: ReactNode;
}) {
  const { colors: c, shadows } = useTheme();
  const heading = (
    <Text variant="callout" tone="ink" accessibilityRole="header" style={[styles.grow, styles.heavy]}>
      {title}
    </Text>
  );
  return (
    // The kit's card surface (e1 and the lit top edge), as the other cards on these screens.
    <View style={[styles.card, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      <View style={styles.cardHead}>
        {/* On the title's line: a 16-point icon at the top of a 21-point line sat above its letters. */}
        <LineIcon variant="callout" name={icon} size={16} color={c.muted} />
        {hint ? (
          <View style={styles.grow}>
            <InfoHint {...hint} variant="callout">
              {heading}
            </InfoHint>
          </View>
        ) : (
          heading
        )}
      </View>
      {children}
      {footer ? (
        <View style={[styles.cardFoot, { borderTopColor: c.line }]}>
          <Text variant="caption" tone="muted">
            {footer}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One source's piece of a day: `value` is 0–100 of the column's height, in its tone. */
export interface DayPart {
  key: string;
  value: number;
  color: string;
}

const DAYS_HEIGHT = 150;
const DAY_GAP = 3;

/**
 * A month day by day (the web's `UsageDays`), drawn on one Skia canvas: a column per day, stacked by source with a
 * 1 pt gap, each piece in rows of 2 pt of its tone and 1 pt of it mixed into the card (the web's stripes); days still
 * to come a dotted stub. The day numbers under it. Decorative: `label` says it.
 */
export function UsageDays({
  days,
  label,
  marks,
}: {
  days: { key: string; parts: DayPart[]; ahead?: boolean }[];
  label: string;
  marks: number[];
}) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const n = days.length;
  const col = n > 0 ? (width - DAY_GAP * (n - 1)) / n : 0;
  const picture = useMemo(() => {
    if (!width || n === 0) return null;
    const dot = mixHex(c.lineStrong, c.raised, 0.55);
    return createPicture(
      (canvas) => {
        const paint = Skia.Paint();
        paint.setAntiAlias(false);
        days.forEach((d, i) => {
          const x = i * (col + DAY_GAP);
          if (d.ahead) {
            // Dots every 3 pt over the bottom 14 pt, as the web's radial pattern.
            paint.setColor(Skia.Color(dot));
            for (let y = DAYS_HEIGHT - 2; y > DAYS_HEIGHT - 14; y -= 3)
              for (let dx = 1; dx < col; dx += 3) canvas.drawRect(Skia.XYWHRect(x + dx, y, 1, 1), paint);
            return;
          }
          let base = DAYS_HEIGHT;
          for (const p of d.parts) {
            if (p.value <= 0) continue;
            const h = Math.max(2, (Math.min(100, p.value) / 100) * DAYS_HEIGHT);
            const top = base - h;
            const light = mixHex(p.color, c.raised, 0.4);
            for (let y = top; y < base; y += 3) {
              paint.setColor(Skia.Color(p.color));
              canvas.drawRect(Skia.XYWHRect(x, y, col, Math.min(2, base - y)), paint);
              if (y + 2 < base) {
                paint.setColor(Skia.Color(light));
                canvas.drawRect(Skia.XYWHRect(x, y + 2, col, Math.min(1, base - y - 2)), paint);
              }
            }
            base = top - 1;
          }
        });
      },
      { width, height: DAYS_HEIGHT },
    );
  }, [days, width, n, col, c.lineStrong, c.raised]);
  return (
    <View>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        style={[styles.days, { borderBottomColor: c.line }]}
      >
        {picture ? (
          <Canvas style={{ width, height: DAYS_HEIGHT }}>
            <Picture picture={picture} />
          </Canvas>
        ) : null}
      </View>
      {/* The marked days' numbers, centered under their columns (never wrapped into a narrow column). */}
      <View style={styles.axis} importantForAccessibility="no-hide-descendants">
        {width
          ? marks.map((m) => (
              <Text
                key={m}
                variant="caption"
                tone="faint"
                style={[styles.axisDay, { left: (m - 1) * (col + DAY_GAP) + col / 2 - 15 }]}
              >
                {String(m)}
              </Text>
            ))
          : null}
      </View>
    </View>
  );
}

/** A legend swatch in a source's tone. */
export function Swatch({ color }: { color: string }) {
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  heavy: { fontWeight: "700" },
  tabular: { fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  bar: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 3 },
  mark: { position: "absolute", top: 0, bottom: 0, width: 2, marginLeft: -1 },
  segs: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row", gap: 1 },
  meter: { gap: 10 },
  meterCompact: { gap: 4 },
  window: { gap: 4 },
  windowLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  acctBox: { gap: 4 },
  acct: { flexDirection: "row", alignItems: "center", gap: 12 },
  // The name wraps instead of losing its end, the plan's tag after it, on the next line when there's no room.
  acctName: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 7, rowGap: 4 },
  tag: { height: 19, paddingHorizontal: 6, borderRadius: 6, borderBottomLeftRadius: 2, justifyContent: "center" },
  card: { borderRadius: 20, padding: 16, gap: 14 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardFoot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  days: { height: DAYS_HEIGHT + 4, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  axis: { height: 18, marginTop: 4 },
  axisDay: { position: "absolute", width: 30, textAlign: "center" },
  swatch: { width: 10, height: 10, borderRadius: 2 },
});
