import type { Issue, IssueColumn } from "@agenteschat/client";
import { useTaskUnread } from "@agenteschat/client";
import { dueLabel, dueTone } from "@agenteschat/client/lib/format";
import { githubLinkLabel } from "@agenteschat/client/lib/github-link";
import { type CardState, cardState, cardStateText, cardWaits, isOpen } from "@agenteschat/client/lib/issues";
import { codeAndBoldParts } from "@agenteschat/client/lib/markdown";
import { stepPhrase } from "@agenteschat/client/lib/work";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  Chip,
  Icon,
  IconButton,
  type IconName,
  PixelOrbit,
  Sky,
  Text,
  type TextProps,
  TOOL_H,
  textLineOf,
  useFontScale,
  useReducedMotion,
} from "@/ui";
import { SocialMark } from "@/ui/auth/SocialMarks";
import { mediaRowAxis } from "@/ui/media-row";
import { router } from "@/ui/navigation";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { MentionCount, MONO, Tile, useSurface } from "../shared/parts";
import { criteriaProgress, type IssueState, issueState, latestPr } from "./logic";

/** An agent's step in the person's words ("Mexeu nos arquivos do PC · trips.service.ts"), as the web says it. */
export function useStepText() {
  const { t } = useTranslation();
  return useCallback(
    (step: Parameters<typeof stepPhrase>[1] | null | undefined) => (step ? stepPhrase(t, step) : ""),
    [t],
  );
}

/** A column's name as people read it: its own, or the stage's when it has none ("A fazer"). */
export function useColumnLabel() {
  const { t } = useTranslation();
  return useCallback((c: Pick<IssueColumn, "name" | "stage">) => c.name ?? t(`issues.status.${c.stage}`), [t]);
}

/**
 * A board column inside a stage (only where the board is customized): its name, whole, and count. In A fazer, for who
 * may create tasks, "+" at its end opens Nova tarefa in that column (the web's column head); a long name's first line
 * sits on the button's middle.
 */
export function ColumnHeader({ label, count, onNew }: { label: string; count: number; onNew?: () => void }) {
  const { t } = useTranslation();
  const line = textLineOf("small", useFontScale()).height;
  const onButton = onNew ? { paddingTop: Math.max(0, (TOOL_H - line) / 2) } : null;
  return (
    <View style={[styles.column, onNew && styles.columnActs]} accessibilityRole="header">
      <Text variant="small" tone="muted" style={[styles.columnName, onButton]}>
        {label}
      </Text>
      <Text variant="small" tone="faint" style={onButton}>
        {count}
      </Text>
      {onNew ? (
        <View style={styles.columnEnd}>
          <IconButton small icon="plus" label={t("issues.newIn", { column: label })} onPress={onNew} />
        </View>
      ) : null}
    </View>
  );
}

/** A task's title, whole, with its `code` as the inline code pill and its **bold** (the web card's); no links. */
export function TaskTitle({ title, ...text }: { title: string } & Omit<TextProps, "children">) {
  const c = useColors();
  return (
    <Text {...text}>
      {codeAndBoldParts(title).map((part, k) =>
        part.mark ? (
          <RNText
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one title, in order
            key={k}
            style={part.mark === "code" ? [styles.code, { backgroundColor: c.sunken, color: c.ink2 }] : styles.heavy}
          >
            {part.text}
          </RNText>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

const STATE_ICON: Record<Exclude<IssueState, "running">, IconName> = {
  waiting: "wait",
  stalled: "pause",
  review: "code",
  progress: "clock",
  todo: "circle",
  done: "checkc",
  canceled: "x",
};

/** The issue's state as a chip: "Trabalhando" with the agent's orbit, "Em revisão · PR #212", "Esperando você"… */
export function StateChip({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const state = issueState(issue);
  const pr = latestPr(issue);
  const label =
    state === "review" && pr
      ? t("mobile.issues.state.reviewPr", { number: pr.number })
      : t(`mobile.issues.state.${state}`);
  if (state === "running") {
    const agent = issue.assignee?.type === "agent" ? dir.agentById.get(issue.assignee.id) : undefined;
    return <Chip label={label} leading={<PixelOrbit color={agentLook(agent).color} size={10} />} />;
  }
  return <Chip label={label} icon={STATE_ICON[state]} />;
}

/** Who has it: the agent's living body (moving while it works) or the person's face; nobody: an empty tile. */
export function AssigneeFace({ issue, size, live }: { issue: Issue; size: number; live: boolean }) {
  if (!issue.assignee) return <Tile icon="circle" size={size} />;
  const running = issue.work?.state === "running";
  return (
    <Face
      who={issue.assignee}
      size={issue.assignee.type === "agent" ? size : size - 4}
      mode={running ? "run" : issue.work?.state === "stalled" ? "rest" : "idle"}
      live={live}
    />
  );
}

/** The task's GitHub link as a chip: `repo#12`, with GitHub's mark. */
export function GithubChip({ url }: { url: string }) {
  const c = useColors();
  return <Chip label={githubLinkLabel(url)} leading={<SocialMark provider="github" color={c.muted} size={12} />} />;
}

/** A state's mark: the agent's orbit while it works; what calls on a person, or stopped, in the attention color. */
const CARD_STATE_ICON: Record<Exclude<CardState["kind"], "running">, IconName> = {
  approval: "shield",
  question: "help",
  stalled: "pause",
  blocked: "wait",
};

/** The one state of a task in words, as the web's card says it: "Pergunta algo", "Parado há 2 dias". */
export function useCardState(i: Issue) {
  const { t } = useTranslation();
  const state = cardState(i, Boolean(i.conversation?.working));
  return { state, words: state ? cardStateText(t, state) : null };
}

/** A state's mark and words, beside who has it on a card, after the name in a row. */
export function StateWords({ issue, state, words }: { issue: Issue; state: CardState; words: string }) {
  const c = useColors();
  const dir = useDirectory();
  const agent = issue.assignee?.type === "agent" ? dir.agentById.get(issue.assignee.id) : undefined;
  return (
    <View style={[styles.inline, styles.state]}>
      {state.kind === "running" ? (
        <PixelOrbit color={agentLook(agent).color} size={10} />
      ) : (
        <Icon
          name={state.kind === "blocked" && state.blocked.reason === "failed" ? "info" : CARD_STATE_ICON[state.kind]}
          size={14}
          color={c.warn}
        />
      )}
      <Text variant="small" style={[styles.bold, styles.shrink, { color: state.kind === "running" ? c.agent : c.ink }]}>
        {words}
      </Text>
    </View>
  );
}

/**
 * A card's one row of facts, wrapping between facts: the number, the label, the priority, the date in words (in the
 * attention color today, tomorrow and once late), the criteria, GitHub, the conversation's count with my mentions.
 */
function CardFacts({ issue: i, mentions, unread }: { issue: Issue; mentions: number; unread: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const [label, ...labels] = i.labels;
  const due = i.dueDate && isOpen(i) ? { text: dueLabel(t, i18n.language, i.dueDate), tone: dueTone(i.dueDate) } : null;
  const crit = criteriaProgress(i);
  const pr = latestPr(i);
  const talk = i.conversation?.count ?? 0;
  // A mark on the first line's middle, for a fact whose words wrap (a repository's name wider than the card).
  const mark = mediaRowAxis(12, textLineOf("caption", useFontScale())).face;
  return (
    <View style={styles.facts}>
      <Text variant="caption" tone="muted">
        #{i.number}
      </Text>
      {label ? <Chip label={label} /> : null}
      {labels.length > 0 ? (
        <Text variant="caption" tone="muted" accessibilityLabel={labels.join(", ")}>
          +{labels.length}
        </Text>
      ) : null}
      {i.priority !== "normal" ? (
        <View style={styles.inline}>
          <Icon name="flag" size={12} color={i.priority === "high" ? c.warn : c.faint} />
          <Text variant="caption" tone="muted">
            {t(`issues.priority.${i.priority}`)}
          </Text>
        </View>
      ) : null}
      {due ? (
        <View style={styles.inline}>
          <Icon name="clock" size={12} color={due.tone ? c.warn : c.faint} />
          <Text variant="caption" style={due.tone ? [styles.bold, { color: c.warn }] : { color: c.muted }}>
            {t("mobile.issues.until", { date: due.text })}
          </Text>
        </View>
      ) : null}
      {crit ? (
        <View style={styles.inline}>
          <Icon name="checkc" size={12} color={crit.done === crit.total ? c.ok : c.faint} />
          <Text variant="caption" tone="muted">
            {crit.done}/{crit.total}
          </Text>
        </View>
      ) : null}
      {pr ? (
        <View style={styles.inline}>
          <SocialMark provider="github" color={c.faint} size={12} />
          <Text variant="caption" tone="muted">
            {t("issues.pr", { number: pr.number })}
          </Text>
        </View>
      ) : null}
      {i.githubUrl ? (
        <View style={[styles.inline, styles.wraps]}>
          <View style={{ marginTop: mark }}>
            <SocialMark provider="github" color={c.faint} size={12} />
          </View>
          <Text variant="caption" tone="muted" style={styles.shrink}>
            {githubLinkLabel(i.githubUrl)}
          </Text>
        </View>
      ) : null}
      {talk > 0 || mentions > 0 ? (
        <View style={styles.inline}>
          <Icon name="chat" size={12} color={c.faint} />
          {talk > 0 ? (
            <Text variant="caption" tone={unread ? "ink" : "muted"} style={unread ? styles.heavy : undefined}>
              {talk}
            </Text>
          ) : null}
          <MentionCount count={mentions} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One task on the board, in the web card's three parts: the title, whole; one row of facts; who has it (the face 24,
 * moving while its agent works) and its one state. An agent waiting on a person puts its sky at the card's top, faded
 * in. A long name wraps beside the face, on the face's line first; a state that doesn't fit goes under, whole.
 */
export const BoardCard = memo(function BoardCard({ issue: i, live }: { issue: Issue; live: boolean }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const surface = useSurface();
  const reduced = useReducedMotion();
  const axis = mediaRowAxis(24, textLineOf("small", useFontScale()));
  const { state, words } = useCardState(i);
  const agent = i.assignee?.type === "agent" ? dir.agentById.get(i.assignee.id) : undefined;
  // Mentions of me not read in its conversation (ADR 0145), red as on the web's card.
  const { mentions, unread } = useTaskUnread(useOrgId(), i.id);
  return (
    <Pressable
      onPress={() => router.push(`/issues/${i.number}`)}
      accessibilityRole="button"
      accessibilityLabel={[
        t("issues.open", { number: i.number, title: i.title }),
        words,
        mentions > 0 ? t("shell.unreadMentions", { count: mentions }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      {cardWaits(state) ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(200)} style={styles.sky}>
          <Sky
            color={agentLook(agent).color}
            surface="raised"
            depth={0.55}
            fade={0.15}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      <TaskTitle title={i.title} variant="callout" style={styles.title} />
      <CardFacts issue={i} mentions={mentions} unread={unread > 0} />
      {i.assignee || state ? (
        <View style={styles.who}>
          {i.assignee ? (
            <View style={styles.person}>
              <View style={[styles.face, { marginTop: axis.face }]}>
                <AssigneeFace issue={i} size={24} live={live} />
              </View>
              <Text variant="small" tone="ink2" style={[styles.bold, styles.name, { paddingTop: axis.words }]}>
                {dir.nameOf(i.assignee)}
              </Text>
            </View>
          ) : null}
          {state && words ? <StateWords issue={i} state={state} words={words} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 12, gap: 8, overflow: "hidden" },
  pressed: { opacity: 0.85 },
  inline: { flexDirection: "row", alignItems: "center", gap: 4 },
  // A long state (a stopped run's reason) wraps inside the card instead of running past its edge.
  state: { flexShrink: 1, maxWidth: "100%" },
  // A fact wider than the card (a long repository's link) wraps its words inside it, its mark on the first line.
  wraps: { maxWidth: "100%", alignItems: "flex-start" },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  heavy: { fontWeight: "700" },
  title: { fontWeight: "600" },
  // The approval card's sky at the top, fading into the card (the web's 64px).
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 64 },
  // A narrow card wraps between the facts, never inside one.
  facts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 2 },
  // The face with the name, then the state; a state that doesn't fit goes to the next line whole.
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 4 },
  // Never the face alone on a line: the name wraps beside it.
  person: { flexDirection: "row", alignItems: "flex-start", gap: 8, flexShrink: 1 },
  // A person's photo is 20 (an agent's body 24): either sits in the 24 box, on the name's first line.
  face: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  name: { flexShrink: 1 },
  code: { fontFamily: MONO },
  column: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    paddingBottom: 2,
    paddingHorizontal: 4,
  },
  columnName: { fontWeight: "600", flexShrink: 1 },
  // With "+": the row as tall as the button, the words on its first line's middle.
  columnActs: { alignItems: "flex-start", paddingTop: 2 },
  columnEnd: { marginLeft: "auto" },
});
