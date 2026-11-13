import {
  type Actor,
  ApiError,
  type Issue,
  type IssueColumn,
  type IssuePriority,
  type IssueStatus,
  keys,
  useAiStatus,
  useApi,
  useChannels,
  useIssue,
  useIssueAction,
  useIssueColumns,
  useTaskUnread,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { capitalize, dueLabel, relativeTime } from "@agenteschat/client/lib/format";
import { githubLinkLabel, isGithubLink } from "@agenteschat/client/lib/github-link";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { webUrl } from "@agenteschat/client/lib/guards";
import {
  canDeleteIssue,
  conversationLine,
  deleteIssueText,
  isOpen,
  PRIORITIES,
  STATUSES,
} from "@agenteschat/client/lib/issues";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  View,
} from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedHeader,
  Icon,
  IconButton,
  type IconName,
  LineIcon,
  Locked,
  OPTION_ROW,
  PixelOrbit,
  SCREEN_X,
  Text,
  TOOL_H,
  TOUCH,
  textLineOf,
  useFontScale,
  useReducedMotion,
  useToast,
} from "@/ui";
import { SocialMark } from "@/ui/auth/SocialMarks";
import { router } from "@/ui/navigation";
import { openConnectAi } from "../ai/NoAiCard";
import { MessageText } from "../chat/MessageText";
import { IssueWorkLine, useShareWork } from "../chat/WorkLine";
import { chatHref } from "../links/logic";
import { confirmAction } from "../settings/parts";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import {
  type ActionItem,
  ActionList,
  errorHaptic,
  FocusLive,
  MentionCount,
  PushedHeader,
  successHaptic,
  tapHaptic,
  useSurface,
} from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { useWhoSeesLabel } from "../shared/WhoSees";
import { IssueActivityFeed } from "./IssueActivity";
import {
  columnChoices,
  columnOfIssue,
  criteriaProgress,
  DUE_CHOICES,
  dueDateOf,
  issueState,
  minutesSince,
  stageCustomized,
  taskConversationHref,
  workLines,
} from "./logic";
import { GithubChip, useColumnLabel, useStepText } from "./parts";
import { useStartAgent } from "./useStartAgent";

/**
 * One task (called "tarefa" in the app): where it came from, the big title, its state, priority
 * and who has it; the agent's card with its live steps; the description, the acceptance criteria (checked
 * here too), what is linked (the source message, Drive files, PRs) and its sub-issues. Conversar and Concluir
 * at the bottom; "…" moves it to another board column, changes priority and who does it, as the web allows.
 */
export function IssueScreen({ number, focusId = null }: { number: number; focusId?: string | null }) {
  return (
    <SheetHostProvider>
      <IssueView number={number} focusId={focusId} />
    </SheetHostProvider>
  );
}

function IssueView({ number, focusId }: { number: number; focusId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const scroll = useRef<ScrollViewInstance>(null);
  const issue = useIssue(orgId, number);
  const qc = useQueryClient();
  // Pulling down brings the activity too (comments, events), not only the task.
  const pull = usePullRefresh(() =>
    Promise.all([
      issue.refetch(),
      issue.data ? qc.refetchQueries({ queryKey: keys.issueActivity(orgId, issue.data.id) }) : null,
    ]),
  );
  const sheet = useSheet();
  // Out of reach since it opened (someone changed who sees it): what's on screen goes.
  const i = issue.error instanceof ApiError && issue.error.status === 404 ? undefined : issue.data;
  const openConversation = useOpenConversation();
  // A notice or a link named a message of its conversation: straight there, once.
  const focused = useRef(false);
  useEffect(() => {
    if (!i || !focusId || focused.current) return;
    focused.current = true;
    openConversation(i, focusId);
  }, [i, focusId, openConversation]);
  if (!i) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <PushedHeader title={`#${number}`} solid={false} />
        <View style={styles.center}>
          {issue.isError ? (
            <Text tone="muted" style={styles.centerText}>
              {t("issues.notFound")}
            </Text>
          ) : (
            <ActivityIndicator color={c.muted} />
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={`#${i.number}`}
        solid={false}
        right={
          <View style={styles.barRight}>
            <FinishWord issue={i} />
            <IconButton
              icon="more"
              label={t("mobile.issues.more")}
              onPress={() => sheet.open(<IssueMenu issue={i} />)}
            />
          </View>
        }
      />
      <FocusLive>
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={styles.scroll}
        >
          <Head issue={i} />
          <WorkCard issue={i} />
          <IssueWorkLine issue={i} style={styles.section} />
          <ConversationRow issue={i} onOpen={() => openConversation(i)} />
          <Description issue={i} />
          <Criteria issue={i} />
          <Linked issue={i} />
          <SubIssues issue={i} />
          <IssueActivityFeed issue={i} />
        </ScrollView>
      </FocusLive>
    </View>
  );
}

/** Opens the task's conversation (ADR 0145), made on first use, at `messageId` when one is named. */
function useOpenConversation() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const toast = useToast();
  return useCallback(
    (i: Issue, messageId?: string | null) => {
      void (async () => {
        try {
          const at = i.conversation ?? (await api.issues.conversation(orgId, i.id));
          router.push(taskConversationHref(at, messageId));
        } catch {
          toast({ title: t("mobile.app.failed"), icon: "x" });
        }
      })();
    },
    [api, orgId, toast, t],
  );
}

/**
 * The task's conversation, one row: who took part, "6 mensagens", "Trabalhando" while an agent is at it, else when
 * it last moved; nobody yet: "Conversar sobre a tarefa". Opens the thread screen.
 */
function ConversationRow({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  // Mentions of me there not read yet: red before the chevron, as Conversa on the web.
  const { mentions } = useTaskUnread(useOrgId(), issue.id);
  const line = conversationLine(issue);
  const label = line ? t("issues.conversation.messages", { count: line.count }) : t("issues.conversation.start");
  const state = line?.working
    ? t("threads.status.working")
    : line?.lastAt
      ? relativeTime(t, i18n.language, line.lastAt)
      : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        t("issues.conversation.title"),
        label,
        state,
        mentions > 0 ? t("shell.unreadMentions", { count: mentions }) : null,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onOpen}
      style={({ pressed }) => [styles.talk, surface, pressed && styles.pressed]}
    >
      <Icon name="chat" size={18} color={c.muted} />
      {line ? (
        <View style={styles.faces}>
          {line.people.map((p) => (
            <Face key={`${p.type}:${p.id}`} who={p} size={20} live={false} />
          ))}
        </View>
      ) : null}
      <Text variant="body" style={[styles.bold, styles.grow]} numberOfLines={1}>
        {label}
      </Text>
      {state ? (
        <Text variant="small" tone="muted">
          {state}
        </Text>
      ) : null}
      <MentionCount count={mentions} />
      <Icon name="right" size={16} color={c.faint} />
    </Pressable>
  );
}

/**
 * "#134" and the title on one row, "Criada pelo Atlas a partir do Sentry · #tech" under it, then its fields as the
 * web's strip, in its order: Coluna, Responsável, Prioridade, Prazo, Quem vê, each opening its picker; its GitHub link.
 */
function Head({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const channel = i.channelId ? channels.data?.find((x) => x.id === i.channelId) : undefined;
  const from =
    i.source.type === "message"
      ? t("mobile.issues.fromMessage")
      : i.source.type === "agent"
        ? t("mobile.issues.fromAgent")
        : i.source.type === "webhook"
          ? t("mobile.issues.fromWebhook", { provider: i.source.provider })
          : null;
  const creator = dir.nameOf(i.createdBy);
  // It starts the line now, under the title.
  const line = capitalize(
    [
      [creator ? t("mobile.issues.createdBy", { name: creator }) : null, from].filter(Boolean).join(" "),
      channel ? `#${channel.name}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    i18n.language,
  );
  const assignee = i.assignee;
  const whoSees = useWhoSeesLabel();
  const pickers = useIssuePickers(i);
  const audience = i.audience ?? { mode: "everyone" as const };
  return (
    <View style={styles.head}>
      <Text variant="display2" accessibilityRole="header" style={styles.bigTitle} maxFontSizeMultiplier={1.4}>
        <Text variant="display2" tone="faint" style={styles.number} maxFontSizeMultiplier={1.4}>
          #{i.number}
        </Text>{" "}
        {i.title}
      </Text>
      {line ? (
        <Text variant="small" tone="faint">
          {line}
        </Text>
      ) : null}
      <View style={styles.chips}>
        <PropChip
          label={t("issues.column")}
          value={pickers.column ? pickers.columnLabel(pickers.column) : t(`issues.status.${i.status}`)}
          icon={STAGE_ICON[i.status]}
          onPress={pickers.pickColumn}
        />
        <PropChip
          label={t("issues.form.assignee")}
          value={assignee ? dir.nameOf(assignee) : t("issues.noAssignee")}
          {...(assignee ? { leading: <Face who={assignee} size={20} live={false} /> } : { icon: "person" as const })}
          onPress={pickers.pickAssignee}
        />
        <PropChip
          label={t("issues.form.priority")}
          value={t(`issues.priority.${i.priority}`)}
          icon="flag"
          onPress={pickers.pickPriority}
        />
        <PropChip
          label={t("issues.due")}
          value={i.dueDate ? dueLabel(t, i18n.language, i.dueDate) : t("issues.noDue")}
          icon="clock"
          onPress={pickers.pickDue}
        />
        <PropChip
          label={t("whoSees.label")}
          value={whoSees(audience)}
          icon={audience.mode === "people" ? "lock" : "globe"}
          onPress={pickers.pickWhoSees}
        />
        {i.githubUrl ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={i.githubUrl}
            onPress={() => {
              const url = webUrl(i.githubUrl);
              if (url) void Linking.openURL(url).catch(() => undefined);
            }}
          >
            <GithubChip url={i.githubUrl} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The stage's mark on the strip's Coluna. */
const STAGE_ICON: Record<IssueStatus, IconName> = {
  todo: "circle",
  in_progress: "clock",
  in_review: "code",
  done: "checkc",
  canceled: "x",
};

/** The strip's value line at the default text size: one line makes the 32 control. */
const PROP_LINE = textLineOf("subhead", 1).height;

/**
 * A field on the head's strip: 32 high in the field look, its icon or face and its value; a press opens its picker. A
 * value wider than the screen wraps inside it, never cut, its icon or face on the first line.
 */
function PropChip({
  label,
  value,
  icon,
  leading,
  onPress,
}: {
  label: string;
  value: string;
  icon?: IconName;
  leading?: ReactNode;
  onPress: () => void;
}) {
  const c = useColors();
  const line = textLineOf("subhead", useFontScale()).height;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      hitSlop={{ top: (TOUCH - TOOL_H) / 2, bottom: (TOUCH - TOOL_H) / 2 }}
      style={({ pressed }) => [
        styles.prop,
        { backgroundColor: c.sunken, borderColor: c.line2 },
        pressed && styles.pressed,
      ]}
    >
      <View style={{ height: line, justifyContent: "center" }}>
        {leading ?? (icon ? <Icon name={icon} size={16} color={c.muted} /> : null)}
      </View>
      <Text variant="subhead" style={styles.propText}>
        {value}
      </Text>
    </Pressable>
  );
}

/** Pastes, changes or removes the task's GitHub link. */
function GithubLinkForm({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const action = useIssueAction(useOrgId());
  const toast = useToast();
  const [text, setText] = useState(i.githubUrl ?? "");
  const [invalid, setInvalid] = useState(false);
  const save = (githubUrl: string | null) =>
    action.mutate(
      { type: "update", id: i.id, patch: { githubUrl } },
      {
        onSuccess: () => {
          sheet.close();
          toast({ title: t("mobile.issues.changed") });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  const submit = () => {
    const url = text.trim();
    if (url && !isGithubLink(url)) return setInvalid(true);
    save(url || null);
  };
  return (
    <>
      <SheetTitle title={t("issues.github.label")} />
      <Locked when={action.isPending}>
        <TextArea
          multiline={false}
          minHeight={44}
          value={text}
          onChangeText={(v) => {
            setText(v);
            setInvalid(false);
          }}
          onSubmitEditing={submit}
          placeholder={t("issues.github.placeholder")}
          accessibilityLabel={t("issues.github.label")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          autoFocus
        />
      </Locked>
      {invalid ? (
        <Text variant="small" style={{ color: c.warn }}>
          {t("issues.github.invalid")}
        </Text>
      ) : null}
      <Button variant="primary" wide label={t("common.save")} loading={action.isPending} onPress={submit} />
      {i.githubUrl ? (
        <Button
          variant="ghost"
          wide
          label={t("issues.github.remove")}
          disabled={action.isPending}
          onPress={() => save(null)}
        />
      ) : null}
    </>
  );
}

/** The agent's work: its live steps (an orbit on the current one), what it waits for, or that it stopped. */
function WorkCard({ issue: i }: { issue: Issue }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const now = useNow(30_000);
  const stepText = useStepText();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const ai = useAiStatus(orgId);
  const reduced = useReducedMotion();
  const w = i.work;
  if (!w || i.assignee?.type !== "agent" || !isOpen(i)) return null;
  // Stopped because the agent has nothing to think with: say so, and the way out is connecting one.
  const noAi = aiStateOf(ai.data, w.agentId) === "no_ai";
  const agent = dir.agentById.get(i.assignee.id);
  const name = agent?.name ?? "";
  const color = agentLook(agent).color;
  const state = issueState(i);
  const mins = minutesSince(w.since, now);
  const sub =
    state === "stalled"
      ? t("mobile.issues.stalledSince", { when: relativeTime(t, i18n.language, w.since) })
      : state === "waiting"
        ? t("mobile.issues.waitsYou")
        : mins < 1
          ? t("mobile.issues.justStarted")
          : t("mobile.issues.workingFor", { count: mins });
  const last = w.steps.length - 1;
  const lines = workLines(t, w.steps, state === "running");
  return (
    <View style={[styles.work, surface]}>
      <View style={styles.workHead}>
        <Face who={i.assignee} size={24} mode={state === "running" ? "run" : state === "stalled" ? "rest" : "idle"} />
        <Text variant="body" numberOfLines={1} style={[styles.bold, styles.shrink]}>
          {name}
        </Text>
        <Text variant="body" tone="muted" style={styles.grow} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {state === "stalled" ? (
        <>
          {w.steps[last] ? (
            <Text variant="small" tone="muted">
              {t("issues.work.lastStep", { step: stepText(w.steps[last]) })}
            </Text>
          ) : null}
          {noAi ? (
            <Text variant="small" tone="muted">
              {t("noAi.agent", agentGrammar(name))}
            </Text>
          ) : w.reason ? (
            <Text variant="small" tone="muted">
              {t(`issues.work.reason.${w.reason}`)}
            </Text>
          ) : null}
          <View>
            {noAi ? (
              <Button
                variant="primary"
                size="sm"
                icon="brain"
                label={t("mobile.ai.connect")}
                onPress={() => openConnectAi({ agentId: w.agentId })}
              />
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="right"
                label={t("issues.work.continue")}
                disabled={action.isPending}
                onPress={() =>
                  action.mutate(
                    { type: "ask", id: i.id, agentId: w.agentId },
                    {
                      onSuccess: () =>
                        toast({ title: t("issues.work.resumed", agentGrammar(name)), agentId: w.agentId }),
                      onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
                    },
                  )
                }
              />
            )}
          </View>
        </>
      ) : lines.length > 0 ? (
        <View style={styles.steps}>
          {/* A step the agent takes while the person watches fades in; the ones already there don't. */}
          <LayoutAnimationConfig skipEntering>
            {lines.map((l) => (
              <Animated.View
                key={l.key}
                entering={reduced ? undefined : FadeIn.duration(160)}
                layout={reduced ? undefined : LinearTransition.duration(220)}
                style={styles.stepRow}
              >
                {/* On the step's first line: a step that wraps had its mark centred between its lines. */}
                {l.going ? (
                  <LineIcon variant="small" size={12}>
                    <PixelOrbit color={color} size={12} />
                  </LineIcon>
                ) : (
                  <LineIcon
                    variant="small"
                    name={l.step.outcome === "refused" ? "x" : "checkc"}
                    size={13}
                    color={c.faint}
                  />
                )}
                <Text variant="small" tone={l.last ? "ink2" : "muted"} style={styles.grow}>
                  {l.text}
                </Text>
              </Animated.View>
            ))}
          </LayoutAnimationConfig>
        </View>
      ) : state === "running" ? (
        <Text variant="small" tone="muted">
          {t("issues.work.starting")}
        </Text>
      ) : null}
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View>
      <GroupedHeader>{title}</GroupedHeader>
      {children}
    </View>
  );
}

function Description({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  return (
    <Group title={t("issues.description")}>
      <View style={styles.desc}>
        {i.description.trim() ? (
          <MessageText body={i.description} />
        ) : (
          <Text variant="body" tone="faint">
            {t("issues.noDescription")}
          </Text>
        )}
      </View>
    </Group>
  );
}

/** "Critérios de aceite · 0 de 3": a check box per criterion (anyone who can see the issue may check). */
function Criteria({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  // The tap shows at once; the issue comes back from the server with it.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  if (i.criteria.length === 0) return null;
  const criteria = i.criteria.map((x) => ({ ...x, done: pending[x.id] ?? x.done }));
  const p = criteriaProgress({ criteria });
  return (
    <Group
      title={`${t("issues.criteria")} · ${t("mobile.issues.criteriaOf", { done: p?.done ?? 0, total: p?.total ?? 0 })}`}
    >
      <View style={[styles.card, surface]}>
        {criteria.map((x, k) => (
          <Pressable
            key={x.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: x.done }}
            accessibilityLabel={x.text}
            onPress={() => {
              tapHaptic();
              const done = !x.done;
              setPending((s) => ({ ...s, [x.id]: done }));
              action.mutate(
                { type: "criterion", id: i.id, criterionId: x.id, done },
                {
                  onSettled: () =>
                    setPending((s) => {
                      const { [x.id]: _, ...rest } = s;
                      return rest;
                    }),
                  onError: () => {
                    errorHaptic();
                    toast({ title: t("mobile.app.failed"), icon: "x" });
                  },
                },
              );
            }}
            style={({ pressed }) => [styles.crit, pressed && { backgroundColor: c.sunken }]}
          >
            {k > 0 ? <View style={[styles.critLine, { backgroundColor: c.line }]} /> : null}
            <View
              style={[styles.box, x.done ? { backgroundColor: c.ink } : { borderWidth: 1.5, borderColor: c.line2 }]}
            >
              {x.done ? <Icon name="check" size={13} color={c.bg} /> : null}
            </View>
            <Text variant="body" tone={x.done ? "faint" : "ink"} style={[styles.grow, x.done && styles.struck]}>
              {x.text}
            </Text>
            {x.done && x.doneBy?.type === "agent" ? <Face who={x.doneBy} size={18} live={false} /> : null}
          </Pressable>
        ))}
      </View>
    </Group>
  );
}

function LinkRow({
  icon,
  label,
  onPress,
  first,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  first: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      style={({ pressed }) => [styles.link, pressed && { backgroundColor: c.sunken }]}
    >
      {!first ? <View style={[styles.linkLine, { backgroundColor: c.line }]} /> : null}
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name={icon} size={16} color={c.muted} />
      </View>
      <Text variant="body" numberOfLines={1} style={styles.grow}>
        {label}
      </Text>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** Ligados: the message it came from, the Drive files, the pull requests. */
function Linked({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const rows: { key: string; icon: IconName; label: string; onPress: () => void }[] = [];
  if (i.source.type === "message") {
    const { channelId } = i.source;
    const channel = channels.data?.find((x) => x.id === channelId);
    rows.push({
      key: "source",
      icon: "chat",
      label: channel ? t("mobile.issues.linkMessage", { channel: channel.name }) : t("mobile.issues.linkMessagePlain"),
      onPress: () => router.push(chatHref(channelId)),
    });
  }
  for (const a of i.artifacts)
    rows.push({
      key: `a:${a.id}`,
      icon: "doc",
      label: a.title,
      onPress: () => router.push({ pathname: "/file/[id]", params: { id: a.id } }),
    });
  for (const pr of i.pullRequests)
    rows.push({
      key: `pr:${pr.number}`,
      icon: "code",
      label: t("issues.pr", { number: pr.number }),
      onPress: () => {
        // Only a web address opens; anything else the issue holds stays inert.
        const url = webUrl(pr.url);
        if (url) void Linking.openURL(url).catch(() => undefined);
      },
    });
  if (rows.length === 0) return null;
  return (
    <Group title={t("issues.links")}>
      <View style={[styles.card, surface]}>
        {rows.map((r, k) => (
          <LinkRow key={r.key} icon={r.icon} label={r.label} onPress={r.onPress} first={k === 0} />
        ))}
      </View>
    </Group>
  );
}

function SubIssues({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const surface = useSurface();
  const subs = i.subIssues ?? [];
  if (subs.length === 0) return null;
  return (
    <Group title={t("mobile.issues.subIssues")}>
      <View style={[styles.card, surface]}>
        {subs.map((s, k) => (
          <LinkRow
            key={s.id}
            icon={s.status === "done" ? "checkc" : "circle"}
            label={`#${s.number} ${s.title} · ${t(`issues.status.${s.status}`)}`}
            onPress={() => router.push(`/issues/${s.number}`)}
            first={k === 0}
          />
        ))}
      </View>
    </Group>
  );
}

/** Concluir / Reabrir, the word in the bar. */
function FinishWord({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const open = isOpen(i);
  const status: IssueStatus = open ? "done" : "todo";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={action.isPending}
      hitSlop={6}
      style={({ pressed }) => [styles.barWord, pressed && styles.pressedWord]}
      onPress={() =>
        action.mutate(
          { type: "update", id: i.id, patch: { status } },
          {
            onSuccess: () => {
              successHaptic();
              toast({
                title: t(open ? "mobile.issues.finished" : "mobile.issues.reopened", { number: i.number }),
              });
            },
            onError: () => {
              errorHaptic();
              toast({ title: t("mobile.app.failed"), icon: "x" });
            },
          },
        )
      }
    >
      <Text variant="callout" style={[styles.bold, { color: c.agent }]}>
        {t(open ? "mobile.issues.finish" : "mobile.issues.reopen")}
      </Text>
    </Pressable>
  );
}

/**
 * The column picker: the board's columns grouped by stage (the stage as the header; a column without a name
 * reads as its stage). A board that isn't customized shows just the stages. Choosing one sends `columnId`.
 */
function ColumnPicker({
  issue: i,
  columns,
  onPick,
}: {
  issue: Issue;
  columns: IssueColumn[];
  onPick: (c: IssueColumn) => void;
}) {
  const { t } = useTranslation();
  const columnLabel = useColumnLabel();
  const current = columnOfIssue(i, columns)?.id;
  const stages = columnChoices(columns);
  const item = (c: IssueColumn): ActionItem => ({
    key: c.id,
    label: columnLabel(c),
    ...(c.id === current ? { trailing: <Icon name="check" size={18} /> } : {}),
    onPress: () => onPick(c),
  });
  if (!stages.some((s) => stageCustomized(s.columns)))
    return <ActionList items={stages.flatMap((s) => s.columns.map(item))} />;
  return (
    <>
      {stages.map((s) => (
        <View key={s.stage} style={styles.pickerStage}>
          <Text variant="label" accessibilityRole="header" style={styles.pickerTitle}>
            {t(`mobile.issues.section.${s.stage}`)}
          </Text>
          <ActionList items={s.columns.map(item)} />
        </View>
      ))}
    </>
  );
}

/**
 * What changes a task's fields, one sheet each: its column (or its stage while the board's columns load), who does
 * it (an agent is asked and starts), its priority, its due date and who sees it. The head's strip and "…" share them.
 */
function useIssuePickers(i: Issue) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const orgId = useOrgId();
  const dir = useDirectory();
  const meId = useMeId();
  const action = useIssueAction(orgId);
  const start = useStartAgent();
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const toast = useToast();
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const update = (patch: Parameters<typeof action.mutate>[0], done?: string) => {
    sheet.close();
    action.mutate(patch, {
      onSuccess: () => toast({ title: done ?? t("mobile.issues.changed") }),
      onError: failed,
    });
  };
  const assign = (who: Actor | null) => {
    if (who?.type === "agent") {
      sheet.close();
      start.run(i, who.id, { done: t("mobile.issues.changed") });
    } else update({ type: "update", id: i.id, patch: { assignee: who } });
  };
  const same = (a: Actor | null, b: Actor | null) => (a?.type ?? null) === (b?.type ?? null) && a?.id === b?.id;
  const pick = (items: ActionItem[]) => sheet.open(<ActionList items={items} />);
  const checked = (on: boolean) => (on ? { trailing: <Icon name="check" size={18} /> } : {});
  const statusItems = (): ActionItem[] =>
    STATUSES.map((s) => ({
      key: s,
      label: t(`issues.status.${s}`),
      ...checked(s === i.status),
      onPress: () => update({ type: "update", id: i.id, patch: { status: s } }),
    }));
  const people: Actor[] = [
    ...dir.agents.filter((a) => a.canTalk !== false).map((a) => ({ type: "agent" as const, id: a.id })),
    ...(meId ? [{ type: "person" as const, id: meId }] : []),
  ];
  const board = columns.data ?? [];
  const column = columnOfIssue(i, board);
  return {
    column,
    columnLabel,
    // Columns not loaded (or failed): the stages, as before the board had columns.
    pickColumn: () =>
      board.length > 0
        ? sheet.open(
            <ColumnPicker
              issue={i}
              columns={board}
              onPick={(c) =>
                update(
                  { type: "update", id: i.id, patch: { columnId: c.id } },
                  t("mobile.issues.moved", { number: i.number, column: columnLabel(c) }),
                )
              }
            />,
          )
        : pick(statusItems()),
    pickAssignee: () =>
      pick([
        ...people.map((who) => ({
          key: `${who.type}:${who.id}`,
          label: who.type === "person" && who.id === meId ? t("mobile.issues.you") : dir.nameOf(who),
          leading: <Face who={who} size={OPTION_ROW.face} live={false} />,
          ...checked(same(who, i.assignee)),
          onPress: () => assign(who),
        })),
        {
          key: "nobody",
          icon: "circle" as const,
          label: t("mobile.issues.nobody"),
          ...checked(i.assignee === null),
          onPress: () => assign(null),
        },
      ]),
    pickPriority: () =>
      pick(
        PRIORITIES.map((p: IssuePriority) => ({
          key: p,
          label: t(`issues.priority.${p}`),
          ...checked(p === i.priority),
          onPress: () => update({ type: "update", id: i.id, patch: { priority: p } }),
        })),
      ),
    pickDue: () =>
      pick(
        DUE_CHOICES.map((d) => ({
          key: d,
          label: t(`mobile.issues.form.dueChoice.${d}`),
          ...checked(dueDateOf(d) === i.dueDate),
          onPress: () => update({ type: "update", id: i.id, patch: { dueDate: dueDateOf(d) } }),
        })),
      ),
    pickWhoSees: () => {
      sheet.close();
      router.push({ pathname: "/who-sees", params: { number: i.number } });
    },
  };
}

/** "…": its column, priority, who does it (an agent is asked and starts), stop the agent, cancel. */
function IssueMenu({ issue: i }: { issue: Issue }) {
  const { t } = useTranslation();
  const c = useColors();
  const sheet = useSheet();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const action = useIssueAction(orgId);
  const toast = useToast();
  const openConversation = useOpenConversation();
  const shareWork = useShareWork(i);
  const pickers = useIssuePickers(i);
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(orgId, runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.issues(orgId) }),
  });
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const update = (patch: Parameters<typeof action.mutate>[0], done?: string) => {
    sheet.close();
    action.mutate(patch, {
      onSuccess: () => toast({ title: done ?? t("mobile.issues.changed") }),
      onError: failed,
    });
  };
  const whoSees = useWhoSeesLabel();
  const w = i.work;
  const items: ActionItem[] = [
    {
      key: "talk",
      icon: "chat" as const,
      label: t("mobile.issues.talk"),
      onPress: () => {
        sheet.close();
        openConversation(i);
      },
    },
    {
      key: "column",
      icon: "circle",
      label: t("mobile.issues.actions.status"),
      hint: pickers.column ? pickers.columnLabel(pickers.column) : t(`issues.status.${i.status}`),
      onPress: pickers.pickColumn,
    },
    {
      key: "priority",
      icon: "flag",
      label: t("mobile.issues.actions.priority"),
      hint: t(`issues.priority.${i.priority}`),
      onPress: pickers.pickPriority,
    },
    {
      key: "assignee",
      // Who it is, by their face, as a select shows its choice; a glyph only while nobody is.
      ...(i.assignee
        ? { leading: <Face who={i.assignee} size={OPTION_ROW.face} live={false} /> }
        : { icon: "agent" as const }),
      label: t("mobile.issues.actions.assignee"),
      hint: i.assignee ? dir.nameOf(i.assignee) : t("mobile.issues.nobody"),
      onPress: pickers.pickAssignee,
    },
    {
      key: "github",
      leading: <SocialMark provider="github" color={c.ink} size={18} />,
      label: t("issues.github.label"),
      ...(i.githubUrl ? { hint: githubLinkLabel(i.githubUrl) } : {}),
      onPress: () => sheet.open(<GithubLinkForm issue={i} />),
    },
    {
      key: "audience",
      icon: i.audience?.mode === "people" ? "lock" : "globe",
      label: t("whoSees.label"),
      hint: whoSees(i.audience ?? { mode: "everyone" }),
      onPress: pickers.pickWhoSees,
    },
  ];
  // Mostrar para todos lives here, not as a fourth action on the work's card (one row of actions there).
  if (shareWork)
    items.push({
      key: "share",
      icon: "globe",
      label: t("work.shareEveryone"),
      onPress: () => {
        sheet.close();
        if (!shareWork.pending) shareWork.share();
      },
    });
  if (w?.state === "running" && w.runId) {
    const runId = w.runId;
    items.push({
      key: "stop",
      icon: "pause",
      label: t("issues.work.stop"),
      onPress: () => {
        sheet.close();
        stop.mutate(runId, { onError: failed });
      },
    });
  }
  if (isOpen(i))
    items.push({
      key: "cancel",
      icon: "x",
      danger: true,
      label: t("mobile.issues.actions.cancel"),
      onPress: () =>
        update(
          { type: "update", id: i.id, patch: { status: "canceled" } },
          t("mobile.issues.actions.canceled", { number: i.number }),
        ),
    });
  if (canDeleteIssue(org, i, meId))
    items.push({
      key: "delete",
      icon: "trash",
      danger: true,
      label: t("issues.delete.action"),
      onPress: () => {
        sheet.close();
        const working = i.work && i.work.state !== "stalled" && i.assignee ? dir.nameOf(i.assignee) : null;
        confirmAction({
          title: t("issues.delete.title", { number: i.number }),
          text: deleteIssueText(t, i, working),
          action: t("issues.delete.confirm"),
          cancel: t("common.cancel"),
          onConfirm: () =>
            action.mutate(
              { type: "delete", id: i.id },
              {
                onSuccess: () => {
                  toast({ title: t("issues.delete.done", { number: i.number }) });
                  router.back();
                },
                onError: failed,
              },
            ),
        });
      },
    });
  return <ActionList items={items} />;
}

/** A criterion's check box, a link's tile, and the body's line (iOS) the box centers on. */
const BOX = 20;
const TILE = 30;
const BODY_LINE = 22;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  centerText: { textAlign: "center" },
  head: { paddingHorizontal: SCREEN_X, paddingTop: 6, gap: 6, marginBottom: 14 },
  bigTitle: { marginVertical: 4 },
  number: { fontWeight: "500" },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  prop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    minHeight: TOOL_H,
    maxWidth: "100%",
    paddingLeft: 10,
    paddingRight: 12,
    paddingVertical: (TOOL_H - PROP_LINE) / 2,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  propText: { fontWeight: "600", flexShrink: 1 },
  // The screen's cards: on the 16 margin, 12 apart (the conversation's card gap, CHAT_RHYTHM.card), radius 20 with the
  // cut corner. Measured: work card 16 → 16 from the edges, text at 16 + 14 + 24 face + 8 = 62; the work line's card on
  // the same 16 edges, its text at 16 + 40 = 56.
  work: {
    marginHorizontal: 16,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  section: { marginHorizontal: 16, marginTop: 12 },
  workHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  steps: { gap: 6 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  // A long name gives way to the state after it rather than pushing it off the card.
  shrink: { flexShrink: 1 },
  desc: { paddingHorizontal: SCREEN_X },
  card: { marginHorizontal: 16, borderRadius: 14, overflow: "hidden" },
  crit: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  // Each list's hairline starts at its words: past the box, or the tile, and the row's gap.
  critLine: { position: "absolute", top: 0, left: 14 + BOX + 10, right: 0, height: StyleSheet.hairlineWidth },
  linkLine: { position: "absolute", top: 0, left: 14 + TILE + 10, right: 0, height: StyleSheet.hairlineWidth },
  // Centered on the criterion's first line.
  box: {
    width: BOX,
    height: BOX,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    marginTop: (BODY_LINE - BOX) / 2,
  },
  struck: { textDecorationLine: "line-through" },
  link: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  pickerStage: { gap: 6 },
  pickerTitle: { paddingHorizontal: 4 },
  tile: { width: TILE, height: TILE, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  scroll: { paddingBottom: 40 },
  talk: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  faces: { flexDirection: "row", gap: 2 },
  barRight: { flexDirection: "row", alignItems: "center", gap: 2 },
  barWord: { paddingHorizontal: 10, height: 36, justifyContent: "center" },
  pressed: { opacity: 0.85 },
  pressedWord: { opacity: 0.6 },
});
