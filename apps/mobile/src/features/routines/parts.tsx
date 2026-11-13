import type { Routine } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  pausedFix,
  type RoutineFix,
  routineStateTime,
  routineStateWords,
  runPixels,
  usageContinueBlock,
  usageContinueOffered,
} from "@agenteschat/client/lib/routine-view";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, Chip, LineIcon, PixelOrbit, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { routineHref, widgetHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNamesComputers } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import {
  useNextText,
  useRoutineControls,
  useRoutineMenu,
  useRunWords,
  useSay,
  useTargetLabel,
  useWhenText,
} from "./hooks";
import {
  FIX_ICON,
  isDoneOnce,
  isPaused,
  isReminder,
  isRunning,
  mailTrouble,
  routineTitle,
  STATE_ICON,
  targetIcon,
  whenIcon,
} from "./logic";
import { RunStrip } from "./RunPixels";

/** The routine's state as a chip ("Pausada: o agente não está mais no canal", "Falhando (3 seguidas)"…). */
export function StateChip({ routine: r }: { routine: Routine }) {
  const { t, i18n } = useTranslation();
  const say = useSay();
  const dir = useDirectory();
  const names = useNamesComputers();
  const state = routineStateWords(r, routineStateTime(t, i18n.language, r), names);
  if (r.state === "running")
    return (
      <Chip
        label={say(state)}
        leading={<PixelOrbit color={agentLook(dir.agentById.get(r.agentId)).color} size={10} />}
      />
    );
  return <Chip label={say(state)} icon={STATE_ICON[state.icon]} />;
}

/**
 * A run waiting on its plan's or budget's limit (the web's note): it picks up by itself. Paused near the limit,
 * Continuar agora lets it go on now for its creator, the agent's owner and admins (everyone else sees the button
 * greyed with the reason); at the limit itself there is nothing to continue.
 */
export function UsagePausedNote({
  routine: r,
  controls,
}: {
  routine: Routine;
  controls: ReturnType<typeof useRoutineControls>;
}) {
  const { t } = useTranslation();
  const blocked = usageContinueBlock(r);
  if (!usageContinueOffered(r))
    return (
      <View style={styles.usagePause}>
        <Text variant="footnote" tone="muted">
          {t("routines.usagePause.lineLimit")}
        </Text>
      </View>
    );
  return (
    <View style={styles.usagePause}>
      <Text variant="footnote" tone="muted">
        {t("routines.usagePause.line")}
      </Text>
      <Button
        size="sm"
        variant="primary"
        icon="play"
        label={t("usageCard.continue")}
        disabled={blocked !== null}
        loading={controls.action.isPending}
        onPress={controls.continueUsage}
      />
      {blocked ? (
        <Text variant="footnote" tone="muted">
          {t(`routines.usagePause.${blocked}`)}
        </Text>
      ) : null}
    </View>
  );
}

/** The one-tap fix of a paused routine ("Adicionar agente ao canal", "Assumir rotina", "Retomar"). */
export function FixButton({ fix, controls }: { fix: RoutineFix; controls: ReturnType<typeof useRoutineControls> }) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant={fix === "resume" ? "secondary" : "primary"}
      icon={FIX_ICON[fix]}
      label={t(`routines.fix.${fix}`)}
      loading={controls.action.isPending}
      onPress={() => controls.fix(fix)}
    />
  );
}

/** A row's measures: the agent's face, the gap after it, the side inset. */
const AVATAR = 36;
const GAP = 12;
const SIDE = 16;

/**
 * One routine in the list (the web's row, laid out for the phone): the agent, the title, where it delivers and
 * its chips (a reminder, a mailbox to reconnect, a state that needs a look, its fix); then on lines of their own
 * the "when" with the next run, and the last runs in pixels with a caption. Tapping opens the routine, where it is
 * paused and edited; a long press, its actions.
 */
export const RoutineRow = memo(function RoutineRow({
  routine: r,
  now,
  divider,
  live,
}: {
  routine: Routine;
  /** "Now" in milliseconds, ticking each minute ("Próxima em 10 min" stays true). */
  now: number;
  divider: boolean;
  live: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const controls = useRoutineControls(r);
  const menu = useRoutineMenu(r, "list");
  const whenText = useWhenText();
  const nextText = useNextText();
  const words = useRunWords();
  const targetLabel = useTargetLabel();
  const at = new Date(now);
  const look = agentLook(dir.agentById.get(r.agentId));
  const title = routineTitle(r);
  const agent = dir.nameOf({ type: "agent", id: r.agentId });
  const done = isDoneOnce(r);
  const paused = isPaused(r);
  const running = isRunning(r);
  const trouble = mailTrouble(r);
  const muted = paused || done;
  // Something needs a look (a reason it paused, failures, waiting for a computer or a person): a chip says it.
  const needsLook = !done && routineStateWords(r).tone === "waiting";
  const fix = r.canManage && needsLook ? pausedFix(r) : null;
  // Paused near its plan's limit: said quietly (it picks up by itself), with no fix.
  const showState = needsLook || r.state === "usage_paused";
  const delivery =
    r.target.type === "conversation"
      ? t("routines.deliversIn", { agent, place: targetLabel(r.target) })
      : t("routines.deliversTo", { agent, target: targetLabel(r.target) });
  const next = nextText(r, at);
  // A widget's routine opens its widget, where it is changed (ADR 0135).
  const href = r.target.type === "widget" ? widgetHref(r.target.widgetId, r.target.dashboardId) : routineHref(r.id);
  return (
    <Pressable
      onPress={() => router.push(href)}
      onLongPress={menu.open}
      delayLongPress={380}
      accessibilityRole="button"
      accessibilityLabel={[title, delivery, whenText(r), next].filter(Boolean).join(", ")}
      // The row is one element to a screen reader: the long press's menu is its action.
      accessibilityActions={[{ name: "menu", label: menu.label }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "menu") menu.open();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }, done && styles.done]}
    >
      {/* The lists' hairline (`ListRow`'s tone), not the lighter card line. */}
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.top}>
        <AgentFace agentId={r.agentId} size={AVATAR} live={live} mode={running ? "run" : paused ? "rest" : "idle"} />
        <View style={styles.main}>
          {/* Whole, never cut with "…": a long name, where it delivers and when wrap. */}
          <Text variant="body" style={[styles.title, muted ? { color: c.muted } : null]}>
            {title}
          </Text>
          <View style={styles.line}>
            <LineIcon variant="footnote" name={targetIcon(r.target)} size={13} color={c.faint} />
            <Text variant="footnote" tone="muted" style={styles.shrink}>
              {delivery}
            </Text>
          </View>
          {isReminder(r) || trouble || showState ? (
            <View style={styles.chips}>
              {isReminder(r) ? <Chip icon="bell" label={t("routines.reminder")} /> : null}
              {trouble ? (
                <Chip
                  icon="mail"
                  label={trouble === "error" ? t("mail.routine.error") : t("mail.routine.needsReconnect")}
                />
              ) : null}
              {showState ? <StateChip routine={r} /> : null}
              {fix && fix !== "resume" ? <FixButton fix={fix} controls={controls} /> : null}
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.below}>
        <View style={styles.when}>
          {/* On the schedule's first line's reading middle (a fixed 2-point nudge sat it above the letters). */}
          <LineIcon variant="subhead" name={whenIcon(r)} size={14} color={c.muted} />
          <View style={styles.grow}>
            <Text variant="subhead" tone={paused ? "muted" : "ink2"}>
              {whenText(r)}
            </Text>
            {next ? (
              <Text variant="footnote" tone={running ? "ink2" : "faint"} style={running ? styles.bold : null}>
                {next}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.runs}>
          <RunStrip
            runs={runPixels(r.recentRuns)}
            color={look.color}
            running={running}
            label={words.label(r)}
            dim={muted}
          />
          <Text variant="caption" tone="faint" style={styles.shrink}>
            {words.caption(r, at)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { paddingVertical: 12, paddingHorizontal: SIDE, gap: 8 },
  done: { opacity: 0.7 },
  usagePause: { gap: 8, paddingTop: 16, paddingHorizontal: 4, alignItems: "flex-start" },
  divider: { position: "absolute", top: 0, right: 0, left: SIDE + AVATAR + GAP, height: StyleSheet.hairlineWidth },
  top: { flexDirection: "row", alignItems: "flex-start", gap: GAP },
  main: { flex: 1, minWidth: 0, gap: 4, paddingTop: 1 },
  title: { fontWeight: "600" },
  // The delivery's words and the when's below start on one column: 13 + 8 = 14 + 7.
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 },
  below: { marginLeft: AVATAR + GAP, gap: 8 },
  when: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  runs: { flexDirection: "row", alignItems: "center", gap: 10 },
  bold: { fontWeight: "600" },
});

/**
 * The routine's agent can't read what its trigger needs (none of the mailboxes, the picked one, a connection), as the
 * web's: the cause, and its profile, where who connected it gives the agent access.
 */
export function AgentAccessNote({
  agentId,
  words,
  values,
}: {
  agentId: string;
  words: string;
  values?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const name = useDirectory().agentById.get(agentId)?.name ?? "";
  return (
    <View style={accessStyles.note}>
      <Note icon="lock">{t(words, { ...agentGrammar(name), ...values })}</Note>
      <Button
        variant="secondary"
        size="sm"
        label={t("mail.routine.giveAccess")}
        onPress={() => router.push(`/agent/${agentId}` as never)}
      />
    </View>
  );
}

const accessStyles = StyleSheet.create({
  note: { gap: 8, paddingHorizontal: 16, paddingTop: 12, alignItems: "flex-start" },
});
