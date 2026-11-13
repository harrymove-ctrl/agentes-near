import { type Routine, useCalendar } from "@agenteschat/client";
import { clockHour, whenAt } from "@agenteschat/client/lib/format";
import { runPixels } from "@agenteschat/client/lib/routine-view";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/ui";
import { router } from "@/ui/navigation";
import { CellCanvas } from "../browser/TrailPixels";
import { routineHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { useSurface } from "../shared/parts";
import {
  futureRuns,
  HORIZON_AHEAD,
  HORIZON_BACK,
  horizonLanes,
  horizonPos,
  horizonRange,
  horizonTicks,
  isRunning,
  laneTag,
  routineTitle,
} from "./logic";
import { LaneTrack } from "./RunPixels";
import { LANE_ROWS, RUN_CELL } from "./run-pixels";

/** The lanes' label column: the agent's face alone on the phone (the web's narrow layout). */
const LABEL = 40;
const LANE_H = LANE_ROWS * RUN_CELL;
const LANE_GAP = 2;
const SCALE_H = 18;
/** A tick's box on the scale, centered on its time. */
const TICK = 56;
/** Room under the lanes for the "agora" tag. */
const BOTTOM = 30;

/**
 * "Próximas 20 horas", the web's horizon on the phone: one lane per routine on the clock, its last runs in
 * pixels, its coming runs as pixels and the agent itself on the next one (with its time, or "em 10 min"),
 * "agora" as a dotted pixel line. The coming runs come from the calendar (the server's schedule math). A lane
 * opens its routine.
 */
export function RoutineHorizon({ routines, now }: { routines: readonly Routine[]; now: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const surface = useSurface();
  const [width, setWidth] = useState(0);
  // The window moves with the minute; the coming runs are asked once an hour (the calendar caches by start).
  const hour = Math.floor(now / 3_600_000);
  const range = useMemo(() => horizonRange(new Date(hour * 3_600_000)), [hour]);
  const slots = useCalendar(orgId, range.from, range.to);
  const lanes = horizonLanes(routines);
  if (lanes.length === 0) return null;
  const at = new Date(now);
  const from = new Date(now - HORIZON_BACK);
  const to = new Date(now + HORIZON_AHEAD);
  const track = Math.max(0, width - LABEL);
  const nowX = track * horizonPos(at, from, to);
  const futureOf = (r: Routine) => futureRuns(r, slots.data?.routines ?? [], at, to);
  const later = lanes.filter((r) => futureOf(r).length === 0).length;
  const time = (iso: string | Date) =>
    new Intl.DateTimeFormat(i18n.language, { hour: clockHour(i18n.language), minute: "2-digit" }).format(new Date(iso));
  const weekday = (d: Date) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\./g, "");
  const sub = [
    t("routines.horizon.lanes", { count: lanes.length }),
    later > 0 ? t("routines.horizon.later", { count: later }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.card, surface]}>
      <View style={styles.head}>
        <Text variant="footnote" tone="ink2" style={styles.bold} accessibilityRole="header">
          {t("routines.horizon.title", { count: HORIZON_AHEAD / 3_600_000 })}
        </Text>
        <Text variant="caption" tone="faint">
          {sub}
        </Text>
      </View>
      <View style={styles.body} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
        {track > 0 ? (
          <>
            <View style={styles.scale} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {horizonTicks(from, to, at).map((k) => (
                <Text
                  key={k.at.getTime()}
                  variant="caption"
                  tone={k.day ? "ink2" : "faint"}
                  numberOfLines={1}
                  style={[styles.tick, k.day ? styles.bold : null, { left: LABEL + track * k.pos - TICK / 2 }]}
                >
                  {k.day ? weekday(k.at) : time(k.at)}
                </Text>
              ))}
            </View>
            {lanes.map((r) => {
              const future = futureOf(r);
              const tag = laneTag(r, future, at);
              const title = routineTitle(r);
              const past = runPixels(r.recentRuns).filter((x) => new Date(x.at) >= from && new Date(x.at) <= at);
              const first = future[0];
              return (
                <Pressable
                  key={r.id}
                  onPress={() => router.push(routineHref(r.id))}
                  accessibilityRole="button"
                  accessibilityLabel={
                    first
                      ? t("routines.horizon.lane", { name: title, when: whenAt(t, i18n.language, first) })
                      : t("routines.horizon.laneNone", { name: title })
                  }
                  style={({ pressed }) => [styles.lane, pressed && { backgroundColor: c.sunken }]}
                >
                  <View style={styles.label}>
                    <AgentFace agentId={r.agentId} size={24} live={false} />
                  </View>
                  <View style={[styles.track, { width: track }]}>
                    <LaneTrack
                      width={track}
                      from={from.getTime()}
                      to={to.getTime()}
                      now={now}
                      past={past}
                      future={future}
                      look={agentLook(dir.agentById.get(r.agentId))}
                      running={isRunning(r)}
                    />
                    {tag ? (
                      <Text
                        variant="caption"
                        tone="ink2"
                        numberOfLines={1}
                        style={[
                          styles.tag,
                          { left: Math.max(track * horizonPos(tag.at, from, to), nowX + 12) + 20 },
                          tag.kind === "soon" ? { color: c.ink } : null,
                        ]}
                      >
                        {tag.kind === "soon" ? t("format.inMinutes", { count: tag.minutes }) : time(tag.at)}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
            <NowLine
              left={LABEL + nowX}
              height={lanes.length * (LANE_H + LANE_GAP)}
              label={t("routines.horizon.now")}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}

/** "agora": a pixel line (2 points on, 2 off) down the lanes, with its tag under them. */
function NowLine({ left, height, label }: { left: number; height: number; label: string }) {
  const c = useColors();
  const n = Math.max(1, Math.floor(height / 4));
  const runs = useMemo(
    () => [{ color: c.ink, cells: Array.from({ length: n }, (_, i) => [0, i * 2]).flat() }],
    [c.ink, n],
  );
  return (
    <View
      pointerEvents="none"
      style={[styles.now, { left: left - 1 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <CellCanvas runs={runs} width={2} height={n * 4} cx={2} cy={2} />
      <View style={[styles.nowTag, { top: n * 4 + 4 }]}>
        <View style={[styles.nowPill, { backgroundColor: c.ink }]}>
          <Text variant="caption" style={[styles.bold, { color: c.bg }]}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    paddingTop: 12,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  head: { gap: 2, marginBottom: 6 },
  bold: { fontWeight: "600" },
  body: { paddingBottom: BOTTOM },
  scale: { height: SCALE_H },
  tick: { position: "absolute", top: 0, width: TICK, textAlign: "center" },
  lane: { flexDirection: "row", alignItems: "center", height: LANE_H, marginBottom: LANE_GAP, borderRadius: 6 },
  label: { width: LABEL, alignItems: "flex-start", justifyContent: "center" },
  track: { height: LANE_H, overflow: "hidden" },
  tag: { position: "absolute", top: (LANE_H - 16) / 2, fontWeight: "600" },
  now: { position: "absolute", top: SCALE_H },
  nowTag: { position: "absolute", left: -29, width: 60, alignItems: "center" },
  nowPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
});
