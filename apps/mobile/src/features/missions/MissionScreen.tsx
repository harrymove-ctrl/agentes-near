import { useMission, useMissionDecisions, useMissionReviews, useThreadInfo, useThreadTasks } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComputerIcon, ComputerPortrait, useComputerKind } from "@/computer/ComputerPortrait";
import {
  Button,
  CARD_PAD,
  Card,
  Chip,
  Count,
  Icon,
  IconButton,
  LineIcon,
  PixelOrbit,
  PlanTrack,
  SCREEN_X,
  Section,
  Text,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { ThreadOptions } from "../chat/sheets";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useEdition, useNamesComputers, useNow, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { MONO, PushedHeader, Tile } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { DecisionCardView, ReviewCardView, SetupFailedCard } from "./cards";
import {
  hoursSince,
  liveSessions,
  missionComputerText,
  missionTrack,
  planProgress,
  planRows,
  sessionMinutes,
  takenDecisions,
  waitingCards,
} from "./logic";

/**
 * A mission (ADR 0029): what it is for, how far it got (the plan as pixel
 * cells), its conversation, what waits on you, who works on the computer
 * now, the plan and the decisions taken.
 */
export function MissionScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <Mission id={id} />
    </SheetHostProvider>
  );
}

function Mission({ id }: { id: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const sheet = useSheet();
  const when = useWhen();
  const now = useNow(60_000);
  const insets = useSafeAreaInsets();
  const mission = useMission(orgId, id);
  const m = mission.data;
  const thread = useThreadInfo(orgId, m?.threadId);
  const tasks = useThreadTasks(orgId, m?.threadId);
  const reviews = useMissionReviews(orgId, id);
  const decisions = useMissionDecisions(orgId, id);
  const computer = useComputerKind(orgId, m?.machine?.id);
  const cloud = useEdition() === "cloud";
  const names = useNamesComputers();
  // What waits on you leaves as it is decided, a step's mark changes as it moves on, and the sections under them
  // slide into place; nothing moves with reduced motion.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);

  if (!m) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title="" solid={false} />
        <View style={styles.center}>
          {mission.isError ? (
            <Text tone="muted">{t("mobile.mission.notFound")}</Text>
          ) : (
            <ActivityIndicator color={c.muted} />
          )}
        </View>
      </View>
    );
  }

  const agent = dir.agentById.get(m.agentId);
  const color = agentLook(agent).color;
  const { done, total } = planProgress(m);
  const hours = hoursSince(m.startedAt, now);
  const sessions = liveSessions(tasks.data, m.id);
  const waiting = m.canAct ? waitingCards(reviews.data, decisions.data) : { reviews: [], decisions: [] };
  const waitingN = waiting.reviews.length + waiting.decisions.length;
  const rows = planRows(m.plan.items);
  const taken = takenDecisions(decisions.data);
  const channelName = thread.data?.channelName ?? "";
  // ADR 0044: the mission's own copy of the project is prepared first.
  const live = m.status !== "done" && m.status !== "canceled";
  const preparing = live && m.worktreeState === "preparing";
  const setupFailed = live && m.worktreeState === "failed";
  const where = m.machine ? missionComputerText(t, m.machine, { cloud, names }) : null;

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={m.title}
        solid={false}
        right={
          thread.data ? (
            <IconButton
              icon="more"
              label={t("mobile.chat.options")}
              onPress={() => {
                const info = thread.data;
                if (info) sheet.open(<ThreadOptions thread={info} mission={m} />);
              }}
            />
          ) : null
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
      >
        <View style={styles.head}>
          <View style={styles.row}>
            <Icon name="target" size={15} color={c.muted} />
            <Text variant="small" tone="muted" style={[styles.bold, styles.shrink]}>
              {channelName ? t("mobile.mission.in", { channel: channelName }) : t("mobile.mission.kind")}
            </Text>
          </View>
          <Text variant="display" style={styles.title}>
            {m.title}
          </Text>
          <Text variant="body" tone="muted">
            {[
              agent ? t("mobile.mission.owner", { name: agent.name }) : null,
              m.startedAt ? t("mobile.mission.since", { when: when.short(m.startedAt) }) : null,
              hours !== null && hours > 0 ? t("mobile.mission.hours", { count: hours }) : null,
              m.status !== "active" ? t(`mobile.mission.status.${m.status}`) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {m.branch ? (
            <View style={[styles.row, styles.baseline]}>
              <Text style={[styles.mono, styles.shrink, { color: c.muted }]} numberOfLines={1}>
                {m.branch}
              </Text>
              {m.baseBranch ? (
                <Text variant="small" tone="muted">
                  {t("mobile.mission.base", { base: m.baseBranch })}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        <Card style={styles.progCard}>
          <View style={styles.prog}>
            <View style={styles.progHead}>
              <Count value={done} size={22} />
              <Text variant="small" tone="muted" style={styles.grow}>
                {t("mobile.mission.itemsDone", { total })}
              </Text>
              <AgentFace agentId={m.agentId} size={30} mode={m.status === "active" ? "run" : "idle"} />
            </View>
            <PlanTrack color={color} items={missionTrack(m)} />
            {where || preparing || setupFailed || m.runningTasks > 0 ? (
              <View style={styles.chips}>
                {where ? (
                  <Chip leading={<ComputerIcon kind={computer} size={13} color={c.muted} />} label={where} />
                ) : null}
                {preparing ? (
                  <Chip leading={<PixelOrbit color={color} size={10} />} label={t("mobile.mission.setup.preparing")} />
                ) : null}
                {setupFailed ? <Chip icon="flag" label={t("mobile.mission.setup.failedShort")} /> : null}
                {!preparing && m.runningTasks > 0 ? (
                  <Chip
                    leading={<PixelOrbit color={color} size={10} />}
                    label={t("mobile.mission.running", { count: m.runningTasks })}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </Card>

        <View style={styles.btn}>
          <Button
            variant="primary"
            wide
            icon="chat"
            label={t("mobile.mission.conversation")}
            onPress={() => router.push(chatHref(m.channelId, m.threadId))}
          />
        </View>

        {setupFailed ? (
          <View style={styles.setup}>
            <SetupFailedCard
              missionId={m.id}
              error={m.worktreeError ?? ""}
              {...(m.worktreeFailReason === "branch_missing" ? { lostBranch: m.branch ?? null } : {})}
            />
          </View>
        ) : null}

        <LayoutAnimationConfig skipEntering>
          {waitingN > 0 ? (
            <Animated.View {...fade} layout={layout}>
              <Section title={t("mobile.home.waiting")} count={waitingN}>
                <View style={styles.stack}>
                  {waiting.reviews.map((r) => (
                    <Animated.View key={r.id} {...fade} layout={layout}>
                      <ReviewCardView review={r} mission={m} />
                    </Animated.View>
                  ))}
                  {waiting.decisions.map((d) => (
                    <Animated.View key={d.id} {...fade} layout={layout}>
                      <DecisionCardView decision={d} mission={m} />
                    </Animated.View>
                  ))}
                </View>
              </Section>
            </Animated.View>
          ) : null}
        </LayoutAnimationConfig>

        {sessions.length > 0 ? (
          <Section title={t("mobile.mission.onComputer")}>
            <Card>
              {sessions.map((s, i) => (
                <View
                  key={s.id}
                  style={[styles.sess, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}
                >
                  <View style={styles.portrait}>
                    <ComputerPortrait kind={computer} state={m.machine?.online === false ? "offline" : "online"} />
                  </View>
                  <View style={styles.grow}>
                    <Text variant="body" style={styles.bold} numberOfLines={2}>
                      {s.mode === "setup" ? t("mobile.mission.setupTitle") : s.title}
                      {s.mode === "read" ? (
                        <Text variant="small" tone="faint">
                          {` · ${t("mobile.mission.readOnly")}`}
                        </Text>
                      ) : null}
                    </Text>
                    {s.lastLine ? (
                      <View style={styles.row}>
                        <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
                          {s.lastLine}
                        </Text>
                        <View style={[styles.caret, { backgroundColor: c.agent }]} />
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.meta}>
                    <Text variant="caption" tone="faint">
                      {s.status === "queued"
                        ? t("mobile.mission.queued")
                        : t("mobile.mission.minutes", { count: sessionMinutes(s, now) })}
                    </Text>
                    {s.branch ? (
                      <Text style={[styles.mono, { color: c.faint }]} numberOfLines={1}>
                        {s.branch}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </Card>
          </Section>
        ) : null}

        {rows.length > 0 ? (
          <Section title={t("mobile.mission.plan.section")} count={rows.length}>
            <Card>
              {/* The marks there when the plan shows don't fade in; only a step that moves on does. */}
              <LayoutAnimationConfig skipEntering>
                {rows.map((it, i) => (
                  <View
                    key={it.id}
                    style={[
                      styles.planRow,
                      i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
                    ]}
                  >
                    {/* On the item's first line, however many lines it takes. */}
                    <LineIcon variant="body" size={18}>
                      {/* Keyed by the step's state: a step moving on cross-fades its mark. */}
                      <Animated.View key={it.status} {...fade} style={styles.st}>
                        {it.status === "done" ? (
                          <Icon name="check" size={18} color={c.ok} />
                        ) : it.status === "doing" ? (
                          <PixelOrbit color={color} size={14} />
                        ) : it.status === "waiting_you" ? (
                          <Icon name="clock" size={18} color={c.muted} />
                        ) : (
                          <Icon name="circle" size={18} color={c.faint} />
                        )}
                      </Animated.View>
                    </LineIcon>
                    <View style={styles.grow}>
                      <Text
                        variant="body"
                        tone={it.status === "done" ? "muted" : it.status === "todo" ? "ink2" : "ink"}
                        style={it.status === "doing" || it.status === "waiting_you" ? styles.bold : undefined}
                      >
                        {it.title}
                      </Text>
                      {it.status === "doing" || it.status === "waiting_you" ? (
                        <Text variant="small" tone="muted">
                          {t(it.status === "doing" ? "mobile.mission.plan.doing" : "mobile.mission.plan.waiting")}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </LayoutAnimationConfig>
            </Card>
          </Section>
        ) : null}

        {taken.length > 0 ? (
          <Section title={t("mobile.mission.decisions")} count={taken.length}>
            <Card>
              {taken.map((d, i) => (
                <View
                  key={d.id}
                  style={[styles.dec, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}
                >
                  <Tile icon="flag" />
                  <View style={styles.grow}>
                    <Text variant="body" style={styles.decText}>
                      {d.chosen}
                    </Text>
                    <Text variant="small" tone="muted">
                      {[d.question, d.chosenAt ? when.short(d.chosenAt) : null].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { paddingTop: 4 },
  head: { paddingHorizontal: SCREEN_X, gap: 4 },
  progCard: { marginHorizontal: 16, marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  // Two sizes of text on one line: they share a baseline.
  baseline: { alignItems: "baseline" },
  title: { marginTop: 4 },
  bold: { fontWeight: "600" },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
  prog: { padding: CARD_PAD, gap: 10 },
  progHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  btn: { flexDirection: "row", paddingHorizontal: 16, marginTop: 16 },
  stack: { gap: 8 },
  setup: { paddingHorizontal: 16, marginTop: 8 },
  // The time on the title's first line (its baseline), never centered beside two lines; the portrait centered.
  sess: { flexDirection: "row", alignItems: "baseline", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  portrait: { alignSelf: "center" },
  caret: { width: 2, height: 12 },
  meta: { alignItems: "flex-end", gap: 4, maxWidth: 110 },
  mono: { fontFamily: MONO, fontSize: 12 },
  planRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  st: { width: 22, height: 18, alignItems: "center", justifyContent: "center" },
  dec: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  decText: { fontWeight: "500" },
});
