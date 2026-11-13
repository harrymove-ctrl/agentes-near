import {
  type Routine,
  type RoutineAhead,
  type RoutineRun,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
} from "@agenteschat/client";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { formatTokensShort, formatUsd, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  busyOnComputer,
  eventWebhook,
  healthWords,
  isRunAtWork,
  isStoppable,
  pausedFix,
  routineChannelOf,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runPixels,
  runsPerDay,
  stopWordsKey,
  usageParts,
  whereItRuns,
} from "@agenteschat/client/lib/routine-view";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  IconButton,
  type IconName,
  InfoHint,
  LineIcon,
  Text,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { approvalTitleText, useCancelAhead } from "../approvals/parts";
import { FoldedBody } from "../chat/FoldedBody";
import { chatHref, widgetHref } from "../links/logic";
import { openSwitchComputer } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { AgentFace } from "../shared/Face";
import {
  useColors,
  useDirectory,
  useEdition,
  useNamesComputers,
  useNow,
  useOrgId,
  usePullRefresh,
} from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { FocusLive, goBack, PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { EventWebhookSetup } from "./EventWebhookSetup";
import {
  editRoutineHref,
  useNextText,
  useRoutineControls,
  useRoutineMenu,
  useRunWords,
  useSay,
  useTargetLabel,
  useWhenText,
} from "./hooks";
import { hasFired, isDoneOnce, isPaused, isReminder, isRunning, mailTrouble, routineTitle, targetIcon } from "./logic";
import { FixButton, StateChip, UsagePausedNote } from "./parts";
import { RunStrip } from "./RunPixels";
import { nextLabel } from "./rule";
import { WebhookCard } from "./WebhookCard";

/** At most this many runs on the screen (the web's details show as many). */
const RUNS_SHOWN = 30;
/** A run's mark on the timeline, and the height of the outcome's line beside it. */
const NODE = 18;
const SUBHEAD_LINE = 20;

/**
 * One routine (`/routines/<id>`), the web's details on a screen of its own: the agent, the title and its state;
 * Editar, Rodar agora or Parar, Pausar or Retomar (and the one-tap fix, "Trocar computador" while its run waits
 * for an offline computer on a self-host) for whoever may change it; then the week, what it does, when, where it
 * delivers, where it runs (only where the workspace has more than one computer, by its name), what it may do on its
 * own, when it posts, and its runs, each opening the agent's message
 * (or the approval it waits for); a webhook routine's address card for who manages it. "…" in the bar: Editar,
 * Duplicar, Copiar URL do webhook, Apagar. The routine comes
 * from the list (there is no single-routine endpoint).
 */
export function RoutineScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <RoutineView id={id} />
    </SheetHostProvider>
  );
}

function RoutineView({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const routines = useRoutines(useOrgId());
  const r = routines.data?.find((x) => x.id === id);
  if (r) return <Details routine={r} refetch={routines.refetch} />;
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("routines.panel.eyebrow")} solid={false} grouped />
      <View style={styles.center}>
        {routines.isLoading ? (
          <ActivityIndicator color={c.muted} />
        ) : routines.isError && !routines.data ? (
          <>
            <Text tone="muted" style={styles.centerText}>
              {t("mobile.routines.loadFailed")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.common.retry")}
              onPress={() => void routines.refetch()}
            />
          </>
        ) : (
          <>
            <Text variant="callout" style={styles.bold}>
              {t("mobile.notFound.title")}
            </Text>
            <Text tone="muted" style={styles.centerText}>
              {t("mobile.notFound.subtitle")}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

function Details({ routine: r, refetch }: { routine: Routine; refetch: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const say = useSay();
  const controls = useRoutineControls(r);
  const menu = useRoutineMenu(r, "screen", goBack);
  const runs = useRoutineRuns(orgId, r.id);
  const targetLabel = useTargetLabel();
  const whenText = useWhenText();
  const nextText = useNextText();
  const words = useRunWords();
  const at = new Date(useNow(60_000));
  const outages = useMachineOutages();
  const pull = usePullRefresh(() => Promise.all([refetch(), runs.refetch()]));
  const agentName = dir.nameOf({ type: "agent", id: r.agentId });
  const title = routineTitle(r);
  const done = isDoneOnce(r);
  const fired = hasFired(r);
  const running = isRunning(r);
  const stoppable = isStoppable(r);
  const reminder = isReminder(r);
  const trouble = mailTrouble(r);
  const described = useRuleDescribe(
    orgId,
    r.active && r.trigger.type === "schedule" && r.trigger.rule ? r.trigger.rule : null,
  );
  const nexts = described.data?.ok ? described.data.nextRuns.slice(0, 4) : r.nextRunAt ? [r.nextRunAt] : [];
  const fix = r.canManage ? pausedFix(r) : null;
  // "Trocar computador": the outage its run waits on, for whoever can move agents, where people connect their own
  // computers (a Cloud workspace has one).
  const selfHost = useEdition() === "selfhost";
  const outage =
    selfHost && r.state === "waiting_computer" && r.waitingFor && can(org, "manage_agents")
      ? outages.outages.find((o) => o.machineId === r.waitingFor?.machineId)
      : undefined;
  const health = healthWords(r.health);
  const usage = usageParts(r.usage, can(org, "view_usage"));
  const usageText = usage
    ? [
        t("routines.usage.runs", { count: usage.runs }),
        usage.tokens !== null
          ? t("routines.usage.tokens", { tokens: formatTokensShort(t, i18n.language, usage.tokens) })
          : null,
        usage.costUsd !== null ? t("routines.usage.cost", { cost: formatUsd(i18n.language, usage.costUsd) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const namesComputer = useNamesComputers();
  const runsOn = whereItRuns(r.brain, namesComputer);
  const perDay = r.trigger.type === "schedule" ? runsPerDay(r.trigger.rule ?? null, r.trigger.cron) : 0;
  const busy = r.active ? busyOnComputer(r.brain, perDay, { selfHost, namesComputer }) : null;
  const whereHint =
    r.target.type === "conversation"
      ? r.target.threadId
        ? "thread"
        : "channel"
      : r.target.type === "dm"
        ? "dm"
        : r.target.type;
  // Where it delivers opens when it is a conversation the phone has (a channel, a thread), or its widget (ADR 0135).
  const whereChannel = routineChannelOf(r.target);
  const widget = r.target.type === "widget" ? r.target : null;
  const whereHref = widget
    ? widgetHref(widget.widgetId, widget.dashboardId)
    : whereChannel
      ? chatHref(whereChannel, r.target.type === "conversation" ? r.target.threadId : null)
      : null;
  const list = runs.data ?? r.recentRuns;
  const next = done ? "" : nextText(r, at);
  // A run that starts, or a prepared action withdrawn, while the person watches fades; the rest slide into place.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("routines.panel.eyebrow")}
        solid={false}
        grouped
        right={menu.any ? <IconButton icon="more" label={menu.label} onPress={menu.open} /> : undefined}
      />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 32 }]}
        >
          <View style={styles.head}>
            <AgentFace agentId={r.agentId} size={56} mode={running ? "run" : isPaused(r) ? "rest" : "idle"} />
            <View style={styles.grow}>
              <Text variant="title2" accessibilityRole="header">
                {title}
              </Text>
              <Text variant="subhead" tone="muted" numberOfLines={1}>
                {agentName}
              </Text>
              <View style={styles.chips}>
                {done ? <Chip icon="check" label={t("routines.panel.state.done")} /> : <StateChip routine={r} />}
                {reminder ? <Chip icon="bell" label={t("routines.reminder")} /> : null}
              </View>
            </View>
          </View>
          {r.canManage ? (
            <View style={styles.actions}>
              {fix && fix !== "resume" ? <FixButton fix={fix} controls={controls} /> : null}
              {outage ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon="laptop"
                  label={t("outage.switch")}
                  onPress={() => openSwitchComputer(outage.machineId)}
                />
              ) : null}
              {/* A widget's routine is changed from its widget. */}
              {widget ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="chart"
                  label={t("widgets.notice.openWidget")}
                  onPress={() => router.push(widgetHref(widget.widgetId, widget.dashboardId))}
                />
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="pen"
                  label={t("routines.edit")}
                  onPress={() => router.push(editRoutineHref(r.id))}
                />
              )}
              {/* Parar for a run at work (a paused routine's too); "Rodar agora" while it may run. */}
              {(stoppable || !fired) && !reminder ? (
                stoppable ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="stop"
                    label={t(stopWordsKey(r))}
                    disabled={controls.action.isPending}
                    onPress={controls.stop}
                  />
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="play"
                    label={t("routines.runNow")}
                    disabled={controls.action.isPending}
                    onPress={controls.run}
                  />
                )
              ) : null}
              {fired ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={r.active ? "pause" : "play"}
                  label={r.active ? t("routines.panel.pause") : t("routines.resume")}
                  disabled={controls.action.isPending}
                  onPress={() => controls.setActive(!r.active)}
                />
              )}
            </View>
          ) : null}

          {r.state === "usage_paused" ? <UsagePausedNote routine={r} controls={controls} /> : null}
          <Section title={t("routines.panel.week")}>
            <Block>
              <Text variant="body">{health ? health.map(say).join(" · ") : t("routines.health.none")}</Text>
              {usageText ? (
                <Text variant="footnote" tone="muted">
                  {`${t("routines.panel.usage")}: ${usageText}`}
                </Text>
              ) : null}
              <View style={styles.strip}>
                <RunStrip
                  runs={runPixels(r.recentRuns)}
                  color={agentLook(dir.agentById.get(r.agentId)).color}
                  running={running}
                  label={words.label(r)}
                />
                <Text variant="caption" tone="faint" style={styles.shrink}>
                  {words.caption(r, at)}
                </Text>
              </View>
            </Block>
          </Section>

          <Section title={t("routines.panel.what", agentGrammar(agentName))}>
            <Block>
              {r.canSeeDetails && r.prompt !== null ? (
                <Text variant="body" selectable>
                  {r.prompt}
                </Text>
              ) : (
                <Text variant="footnote" tone="muted">
                  {t("routines.detailsHidden")}
                </Text>
              )}
            </Block>
          </Section>

          <Section title={t("routines.panel.when")}>
            <Block>
              <Text variant="body">{whenText(r)}</Text>
              {trouble ? (
                <Chip
                  icon="mail"
                  label={trouble === "error" ? t("mail.routine.error") : t("mail.routine.needsReconnect")}
                />
              ) : null}
              {r.trigger.type === "email" ? (
                <Text variant="footnote" tone="muted">
                  {t("mail.routine.every")}
                </Text>
              ) : r.trigger.type === "webhook" ? (
                <Text variant="footnote" tone="muted">
                  {t("common.joinSentences", {
                    a: t("routines.webhook.every"),
                    b: t("routines.webhook.methodsLine", { methods: (r.trigger.methods ?? ["POST"]).join(", ") }),
                  })}
                </Text>
              ) : r.trigger.type === "event" ? (
                <Text variant="footnote" tone="muted">
                  {t("routines.panel.eventEvery")}
                </Text>
              ) : nexts.length > 0 && !done ? (
                <View style={styles.nexts}>
                  {nexts.map((iso) => (
                    <View key={iso} style={[styles.next, { backgroundColor: c.sunken }]}>
                      <Text variant="footnote" tone="ink2">
                        {nextLabel(i18n.language, iso)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {next ? (
                <Text variant="footnote" tone={running ? "ink2" : "muted"}>
                  {next}
                </Text>
              ) : null}
              {busy ? (
                <View style={styles.note}>
                  {/* On the note's first line, not above its letters at the row's top. */}
                  <LineIcon variant="footnote" name="laptop" size={14} color={c.muted} />
                  <Text variant="footnote" tone="muted" style={styles.shrink}>
                    {say(busy)}
                  </Text>
                </View>
              ) : null}
            </Block>
          </Section>

          {r.trigger.type === "event" && eventWebhook(r.trigger.event) && !done ? (
            <EventWebhookSetup provider={eventWebhook(r.trigger.event) ?? "github"} />
          ) : null}
          {r.trigger.type === "webhook" ? (
            r.canManage ? (
              <WebhookCard routine={r} runs={list} />
            ) : (
              <Section title={t("routines.form.kind.webhook")}>
                <Block>
                  <Text variant="footnote" tone="muted">
                    {t("routines.webhook.hidden")}
                  </Text>
                </Block>
              </Section>
            )
          ) : null}

          {r.ahead && r.ahead.length > 0 ? (
            <Section title={t("routines.panel.ahead")}>
              {r.ahead.map((a) => (
                <Animated.View key={a.id} {...fade} layout={layout}>
                  <AheadItem action={a} />
                </Animated.View>
              ))}
              <Block>
                <Text variant="footnote" tone="muted">
                  {t("routines.ahead.hint")}
                </Text>
              </Block>
            </Section>
          ) : null}

          {r.canSeeDetails ? (
            <Section title={t("routines.panel.ownActions")}>
              {(r.ownActions ?? []).map((name) => (
                <GroupedRow
                  key={name}
                  label={ownActionName(t, name)}
                  {...(r.canManage
                    ? {
                        toggle: true,
                        disabled: controls.action.isPending,
                        onPress: () =>
                          controls.action.mutate({
                            type: "update",
                            id: r.id,
                            patch: { ownActions: (r.ownActions ?? []).filter((a) => a !== name) },
                          }),
                      }
                    : {})}
                />
              ))}
              <Block>
                <Text variant="footnote" tone="muted">
                  {t(r.ownActions?.length ? "routines.ownActions.hint" : "routines.ownActions.none")}
                </Text>
              </Block>
            </Section>
          ) : null}

          <Section title={t("routines.panel.where")}>
            <GroupedRow
              icon={targetIcon(r.target)}
              label={r.widget?.title ?? targetLabel(r.target)}
              sub={t(`routines.panel.whereHint.${whereHint}`)}
              subLines={2}
              media
              chevron={Boolean(whereHref)}
              {...(whereHref ? { onPress: () => router.push(whereHref) } : {})}
            />
          </Section>

          {runsOn ? (
            <Section title={t("routines.panel.runsOn")}>
              <Block>
                <Text variant="body">{runsOn}</Text>
              </Block>
            </Section>
          ) : null}

          <Section title={t("routines.panel.report")}>
            <Block>
              <InfoHint
                name={t("common.about", { label: t("routines.panel.report") })}
                text={t("routines.report.hint")}
                variant="body"
              >
                <Text variant="body">{t(`routines.report.${r.report}`)}</Text>
              </InfoHint>
            </Block>
          </Section>

          <Section title={t("routines.panel.runs")}>
            {runs.isLoading && list.length === 0 ? (
              <Block>
                <ActivityIndicator color={c.muted} />
              </Block>
            ) : list.length > 0 ? (
              // The runs fade in over the spinner; the ones there when they load don't each fade again.
              <Animated.View {...fade} style={styles.runs}>
                <LayoutAnimationConfig skipEntering>
                  {list.slice(0, RUNS_SHOWN).map((x, i, shown) => (
                    <Animated.View key={x.id} {...fade} layout={layout}>
                      <RunItem run={x} routine={r} last={i === shown.length - 1} />
                    </Animated.View>
                  ))}
                </LayoutAnimationConfig>
              </Animated.View>
            ) : (
              <Block>
                <Text variant="footnote" tone="muted">
                  {nexts[0] && !done
                    ? t("common.joinSentences", {
                        a: t("routines.noRuns"),
                        b: t("routines.panel.firstRun", { when: nextLabel(i18n.language, nexts[0]) }),
                      })
                    : t("routines.noRuns")}
                </Text>
              </Block>
            )}
          </Section>
        </ScrollView>
      </FocusLive>
    </View>
  );
}

/** A section of the screen: its header over a grouped card. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <GroupedHeader>{title}</GroupedHeader>
      <GroupedList>{children}</GroupedList>
    </>
  );
}

/** Text inside a section's card. */
function Block({ children }: { children: ReactNode }) {
  return <View style={styles.block}>{children}</View>;
}

/**
 * An action prepared for one of its runs (`schedule_action`): what it does and when, opening its request; the
 * "x" withdraws it (it won't run) for whoever may.
 */
function AheadItem({ action: a }: { action: RoutineAhead }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const cancel = useCancelAhead();
  const title = approvalTitleText(t, { ...a, email: null });
  const sub = t(a.status === "approved" ? "routines.ahead.approved" : "routines.ahead.pending", {
    when: nextLabel(i18n.language, a.runAt),
  });
  return (
    <View style={styles.ahead}>
      <Pressable
        onPress={() => router.push(`/approval/${a.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${sub}`}
        style={({ pressed }) => [styles.aheadMain, pressed ? { opacity: 0.6 } : null]}
      >
        <LineIcon name={a.status === "approved" ? "clock" : "wait"} size={16} color={c.muted} variant="subhead" />
        <View style={styles.grow}>
          <Text variant="subhead" style={styles.bold}>
            {title}
          </Text>
          <Text variant="footnote" tone="muted">
            {sub}
          </Text>
        </View>
      </Pressable>
      {a.canCancel ? (
        <IconButton
          icon="x"
          label={`${t("approval.ahead.cancel")}: ${title}`}
          disabled={cancel.pending}
          onPress={() => cancel.cancel(a.id)}
        />
      ) : null}
    </View>
  );
}

/** A run's mark on the timeline, as the web's: done, nothing new (a dash), failed, skipped, at work. */
function useNode(run: RoutineRun): { bg: string; ink: string; icon: IconName | null } {
  const c = useColors();
  const pixel = runPixelStatus(run.status);
  if (pixel === "ok") return { bg: c.ink, ink: c.bg, icon: "check" };
  // Each fill's own ink: white stood on dark's light red, amber and blue with too little contrast.
  if (pixel === "failed") return { bg: c.danger, ink: c.bg, icon: "x" };
  if (pixel === "skipped") return { bg: c.warn, ink: c.onWarn, icon: "pause" };
  if (pixel === null && isRunAtWork(run.status)) return { bg: c.agent, ink: c.onAgent, icon: "play" };
  return { bg: c.sunken, ink: c.ink2, icon: null };
}

/**
 * One run: its outcome in plain words ("Contou o que achou", "Pulada: a anterior ainda estava rodando", "Parada
 * por Ana"), the agent's words when the viewer may read them, and where it goes: the approval it waits for, or
 * the agent's message ("Abrir na conversa").
 */
function RunItem({ run: x, routine: r, last }: { run: RoutineRun; routine: Routine; last: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const say = useSay();
  const node = useNode(x);
  const outcome = say(runOutcome(x, (id) => dir.memberById.get(id)?.name ?? null));
  const link = runMessageLink(x);
  const words = r.canSeeDetails && (x.status === "reported" || x.status === "silent") ? x.summary.trim() : "";
  const approval = x.status === "waiting" && x.approvalId ? x.approvalId : null;
  const href = approval ? `/approval/${approval}` : link ? chatHref(link.channelId, link.threadId) : null;
  const when = whenAt(t, i18n.language, x.at);
  const go = href ? () => router.push(href) : undefined;
  return (
    <View style={styles.run}>
      <View style={styles.rail}>
        <View style={[styles.node, { backgroundColor: node.bg }]}>
          {node.icon ? (
            <Icon name={node.icon} size={12} color={node.ink} />
          ) : (
            <View style={[styles.dash, { backgroundColor: node.ink }]} />
          )}
        </View>
        {last ? null : <View style={[styles.stem, { backgroundColor: c.line2 }]} />}
      </View>
      <View style={styles.grow}>
        {/* Its parts apart, not one button: the agent's words hold links and their own "Mostrar mais". */}
        <Pressable
          onPress={go}
          disabled={!go}
          accessibilityRole={go ? "button" : undefined}
          accessibilityLabel={`${outcome}, ${when}`}
          style={({ pressed }) => (pressed && go ? styles.pressed : null)}
        >
          <Text variant="subhead" style={[styles.bold, approval ? styles.underline : null]}>
            {outcome}
          </Text>
        </Pressable>
        {words ? <FoldedBody body={words} muted /> : null}
        {link && !approval ? (
          // Nothing added above: that is where its words' "Mostrar mais" is.
          <Pressable onPress={go} accessibilityRole="button" hitSlop={{ bottom: 13, left: 13, right: 13 }}>
            <Text variant="footnote" tone="muted" style={styles.open}>
              {t("routines.openInChat")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text variant="caption" tone="faint" style={styles.when}>
        {when}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  centerText: { textAlign: "center" },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 14, paddingTop: 8, paddingHorizontal: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 16, paddingHorizontal: 4 },
  block: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  strip: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  nexts: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  next: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  runs: { paddingVertical: 6 },
  run: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  rail: { alignSelf: "stretch", alignItems: "center", width: NODE },
  // Centered on the outcome's first line (subhead, 20 tall).
  node: {
    width: NODE,
    height: NODE,
    borderRadius: 6,
    marginTop: (SUBHEAD_LINE - NODE) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dash: { width: 8, height: 1.7, borderRadius: 999 },
  stem: { flex: 1, width: 1.5, marginTop: 4, marginBottom: -12 },
  underline: { textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
  open: { marginTop: 2 },
  when: { paddingTop: 2 },
  // The "x" glyph sits 10 px inside its 40 px button: 4 px more on the right reads as the left's 14.
  ahead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 6,
  },
  aheadMain: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
});
