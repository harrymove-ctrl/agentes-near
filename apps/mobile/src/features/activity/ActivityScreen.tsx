import {
  type AppNotification,
  type Approval,
  type Routine,
  useAiStatus,
  useNotificationAction,
  useNotifications,
  useRoutines,
} from "@agenteschat/client";
import { approvalDetail, approvalSummary, approvalTitle } from "@agenteschat/client/lib/approval-words";
import { restrictionLine } from "@agenteschat/client/lib/errors";
import { timeLeft, upperFirst } from "@agenteschat/client/lib/format";
import { mediaWord } from "@agenteschat/client/lib/media";
import { latestText } from "@agenteschat/client/lib/message-body";
import { usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { useLocalSearchParams } from "expo-router";
import type { TFunction } from "i18next";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  HoldButton,
  type IconName,
  LargeTitleScreen,
  LIST_AVATAR,
  LIST_INSET,
  ListRow,
  PersonAvatar,
  PULL_TINT,
  PullOrbit,
  SectionHeader,
  SkeletonList,
  SwipeRow,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { approvalAction } from "../approvals/logic";
import { ApprovalMark, ApprovalWhy, useApprovalSource, useApproveNow } from "../approvals/parts";
import type { AskKind } from "../chat/ask-store";
import { ASK_ICON, AskButtons } from "../chat/asks";
import { dashboardWaitingCard } from "../dashboards/logic";
import { isDeviceNotice } from "../devices/logic";
import { DeviceNoticeActions, DeviceNoticeCard } from "../devices/notices";
import { notificationHref, notificationWebPath, routineHref } from "../links/logic";
import { openWebPath } from "../links/open-web";
import { ChangeRequestCard } from "../right-hand/SettingsCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { useWaitingApprovals } from "../shared/queries";
import { RetryLine, TeamSkyEmpty } from "../shared/TeamSkyEmpty";
import { useTabHeader } from "../shared/tabHeader";
import { WaitingCard, WaitingSource } from "../shared/WaitingCard";
import { UsageLimitActions } from "../usage/people";
import {
  type ActivityFilter,
  activitySections,
  type DayGroup,
  emojisOf,
  joinRequestLine,
  nextRoutine,
  placeOf,
  type SayWords,
  subtitleOf,
  upcomingDay,
  type WaitingCardKind,
  waitingCardOf,
} from "./logic";
import { useNoticeTitle } from "./noticeTitle";

/**
 * Atividade: what waits on you on top as the chat's request cards (who asks, the kind, the deadline, the exact
 * request, why, and the decision on the card: Aprovar · Recusar, the page's one primary on the first card), or,
 * with nothing waiting, the sky with the team and "Nada esperando você", then the next real event (a routine's next
 * run); then the rest by day as loose rows. How many wait is said once, on the section (the pills carry no counts).
 * Swipe a row right to mark read or unread, left for "Feito" (a toast offers Desfazer). Tapping opens where it
 * happened. Loading: rows of the list's own shape; a load that failed is one gray line over what was kept.
 */
export function ActivityScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  // `?filter=waiting`: opened from Conversas' "Esperando você" (selects Esperando; each visit with it does).
  const params = useLocalSearchParams<{ filter?: string; at?: string }>();
  const [filter, setFilter] = useState<ActivityFilter>(params.filter === "waiting" ? "waiting" : "all");
  const asked = params.filter === "waiting" ? (params.at ?? "link") : null;
  useEffect(() => {
    if (asked) setFilter("waiting");
  }, [asked]);
  const list = useNotifications(orgId, filter);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const { waiting, days } = activitySections(items, filter);
  const waitingCount = Math.max(waiting.length, counts?.waiting ?? waiting.length);
  const pull = usePullRefresh(list.refetch);
  const header = useTabHeader();
  const reduced = useReducedMotion();
  // A card decided while the page shows fades out and the rest close up; a new one fades in.
  const cardMotion = reduced ? {} : { entering: CARD_IN, exiting: CARD_OUT, layout: LinearTransition };
  return (
    <LargeTitleScreen
      title={t("mobile.activity.title")}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={PULL_TINT} />}
      pullMark={<PullOrbit refreshing={pull.refreshing} />}
    >
      <Filters
        items={[
          { key: "all", label: t("mobile.activity.filter.all") },
          // The count is the section's, once.
          { key: "waiting", label: t("mobile.activity.filter.waiting") },
          { key: "done", label: t("mobile.activity.filter.done") },
        ]}
        value={filter}
        onChange={(key) => setFilter(key as ActivityFilter)}
      />
      {waiting.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.home.waiting")} count={waitingCount} />
          <LayoutAnimationConfig skipEntering skipExiting>
            <View style={styles.cards}>
              {waiting.map((n, i) => (
                <Animated.View key={n.id} {...cardMotion}>
                  {isDeviceNotice(n.kind) ? (
                    <DeviceNoticeCard item={n} first={i === 0} />
                  ) : (
                    <WaitingCardView item={n} first={i === 0} />
                  )}
                </Animated.View>
              ))}
            </View>
          </LayoutAnimationConfig>
        </>
      ) : list.isLoading ? (
        <>
          <SectionHeader title={t("mobile.activity.day.today")} />
          <SkeletonList rows={3} />
          <SectionHeader title={t("mobile.activity.day.yesterday")} />
          <SkeletonList rows={1} />
        </>
      ) : list.isError && !list.data ? (
        <RetryLine onRetry={() => void list.refetch()} />
      ) : filter !== "done" ? (
        <AllClear />
      ) : days.length === 0 ? (
        <EmptyState size="inline" title={t("mobile.activity.noneDone")} />
      ) : null}
      {/* Kept rows under a load that failed: the line says so, what loaded stays readable. */}
      {list.isError && list.data && !list.isLoading ? <RetryLine onRetry={() => void list.refetch()} /> : null}
      {days.map(([group, groupItems]) => (
        <View key={group}>
          <SectionHeader title={t(`mobile.activity.day.${group satisfies DayGroup}`)} />
          {/* Loose rows on the page, as Conversas' (no card around them). */}
          {groupItems.map((n, i) => (
            <ActivityRow key={n.id} item={n} divider={i > 0} />
          ))}
        </View>
      ))}
      {list.hasNextPage ? (
        <Pressable
          onPress={() => void list.fetchNextPage()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.more, pressed && styles.morePressed]}
        >
          <Text variant="small" tone="muted">
            {t("mobile.activity.more")}
          </Text>
        </Pressable>
      ) : null}
    </LargeTitleScreen>
  );
}

/**
 * One thing waiting on you, as the chat's request card (`WaitingCard`): who asks and the kind in the chat's words
 * and icons (amber, the waiting color), the deadline or where and when at the right, the exact request in words, why
 * in muted, what it goes through on one quiet line, and the decision on the card: an approval decided here
 * (Aprovar or Agora não), a question Responder. The whole card opens it too.
 */
/** `first`: the page's first card carries its one primary; the others decide or open in secondary. */
function WaitingCardView({ item: n, first = false }: { item: AppNotification; first?: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const now = useNow();
  const act = useNotificationAction(orgId);
  const card = waitingCardOf(n);
  // A widget's alert, or an agent asking to publish a dashboard (ADR 0135): its own word, line and "Open".
  const dash = dashboardWaitingCard(n, t as unknown as (key: string, values?: Record<string, unknown>) => string);
  // A request's title in words, from the request itself (the notification keeps the tool's raw title).
  const waitingApprovals = useWaitingApprovals();
  const request = waitingApprovals.find((a) => a.id === n.source.approvalId);
  // One notification per approval card: how many on it still wait for you.
  const onCard = request?.messageId ? waitingApprovals.filter((a) => a.messageId === request.messageId).length : 0;
  // Decided here when it stands for one request this person may decide; a card of several opens where they are.
  const decidable = card.kind === "approval" && request?.canDecide && onCard <= 1 ? request : null;
  // Someone asking to join: who asked (the first names, how many in all), with their faces.
  const join = card.kind === "join" ? joinRequestLine(t, n) : null;
  const notice = useNoticeTitle(n);
  const title =
    card.kind === "approval" && request
      ? [approvalTitle(t, request), onCard > 1 ? t("approval.all.waitingCount", { count: onCard }) : null]
          .filter(Boolean)
          .join(" · ")
      : join
        ? join.text
        : card.kind === "limit"
          ? notice.title
          : (dash?.title ?? card.title);
  // A routine's trouble opens the routine; the computer being ready, Connect an AI while no agent has one.
  const ai = useAiStatus(orgId, n.kind === "computer_ready").data;
  const href = notificationHref(n, ai);
  // No screen of its own in the app (the workspace's billing hold): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const actor = n.actors[0];
  const who = actor ? { type: actor.type === "agent" ? "agent" : "person", id: actor.id } : null;
  const name = dir.nameOf(who);
  const kind = dash ? { icon: "chart" as const, label: dash.kind } : kindOf(t, card.kind, n.source.screen);
  const left = card.expiresAt ? timeLeft(t, card.expiresAt, new Date(now)) : null;
  const place = placeOf(n);
  const where = [place ? t("mobile.chats.waitIn", { where: place }) : null, when.short(n.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  const button = dash ? t("mobile.activityNow.open") : t(`mobile.activityNow.${card.action}`);
  const open = () => {
    if (n.readAt === null) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openWebPath(web);
  };
  // Whoever asks leads the card: an agent (with its sky), a person, or the people asking to join.
  const leading =
    who && who.type !== "agent" ? (
      <Face who={who} size={36} live={false} />
    ) : join ? (
      <View style={styles.faces}>
        {join.faces.map((face, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two names at most, and two people can share one
          <View key={`${i}-${face}`} style={i > 0 ? styles.overlap : undefined}>
            <PersonAvatar name={face} size={30} />
          </View>
        ))}
      </View>
    ) : null;
  return (
    <WaitingCard
      agentId={who?.type === "agent" ? who.id : null}
      leading={leading}
      name={name}
      kind={kind}
      title={title}
      onPress={href || web ? open : undefined}
      accessibilityLabel={[name, kind.label, title].filter(Boolean).join(", ")}
      expires={left !== null && card.expiresAt ? { createdAt: n.createdAt, expiresAt: card.expiresAt } : null}
      where={where}
      decision={decidable ? <ApproveHere approval={decidable} primary={first} /> : undefined}
      action={
        (href || web) && card.kind !== "limit"
          ? { label: button, onPress: open, variant: first ? "primary" : "secondary" }
          : null
      }
    >
      {/* Who asked while nobody watched, then why (ADR 0053 §8), as on the request itself. */}
      {card.kind === "approval" ? (
        <ApprovalWhy approval={{ origin: n.latest.origin ?? null, why: n.latest.text ?? null }} name={name} />
      ) : null}
      {card.kind === "approval" && request && onCard <= 1 ? <ApprovalSource approval={request} /> : null}
      {card.kind === "limit" ? (
        <>
          <Text variant="footnote" tone="muted">
            {usageLimitLine(t, n)}
          </Text>
          <UsageLimitActions n={n} />
        </>
      ) : null}
    </WaitingCard>
  );
}

/**
 * Each kind in the chat request card's words and icons ("Pede sua aprovação" with the shield, "Pergunta", "Precisa de
 * você no navegador" or "no computador"); what the chat never asks keeps Atividade's (Membros, Limite).
 */
function kindOf(t: TFunction, kind: WaitingCardKind, screen?: string): { icon: IconName; label: string } {
  const ask: AskKind | null =
    kind === "approval" || kind === "question" || kind === "secret"
      ? kind
      : kind === "browser"
        ? screen === "desktop"
          ? "desktop"
          : "browser"
        : null;
  if (ask) return { icon: ASK_ICON[ask], label: t(`ask.kind.${ask}`) };
  return { icon: OWN_ICON[kind as keyof typeof OWN_ICON], label: t(`mobile.activityNow.kind.${kind}`) };
}

const OWN_ICON = { join: "members", limit: "chart" } as const;

/**
 * The request's decision on the card, as the chat's: Aprovar (held to approve when it is high risk; the page's
 * primary only on its first card) and Recusar, which asks why on the request's own screen. Words alone, no icon in
 * the button.
 */
function ApproveHere({ approval: a, primary }: { approval: Approval; primary: boolean }) {
  const { t } = useTranslation();
  const { approve, pending, high } = useApproveNow(a);
  return (
    <AskButtons
      primary={
        high ? (
          <HoldButton size="card" label={t("mobile.approval.hold")} onConfirm={() => approve()} />
        ) : (
          <Button
            variant={primary ? "primary" : "secondary"}
            size="card"
            wide
            label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
            disabled={pending}
            onPress={() => approve()}
          />
        )
      }
      secondary={
        <Button
          variant="secondary"
          size="card"
          wide
          label={t("mobile.approval.refuse")}
          onPress={() => router.push(`/approval/${a.id}?mode=refuse`)}
        />
      }
    />
  );
}

/** What the request goes through, as the chat's card says it: an email's to and subject, else the app and its call. */
function ApprovalSource({ approval: a }: { approval: Approval }) {
  const { i18n } = useTranslation();
  const source = useApprovalSource(a);
  const detail = a.email
    ? [a.email.to.join(", "), a.email.subject].filter(Boolean).join(" · ")
    : !a.connector
      ? approvalDetail(a, i18n.language)
      : [source.name, approvalSummary(a, i18n.language)].filter(Boolean).join(" · ");
  return detail ? <WaitingSource mark={<ApprovalMark approval={a} size={20} />} text={detail} /> : null;
}

/**
 * Nothing waits on you, right on the page: the sky with the team on its horizon, "Nada esperando você" and one calm
 * line (no card, no button), then the next real event as one line (a routine's next run: its agent, its name and
 * when), which opens the routine; the history follows within the first thumb.
 */
function AllClear() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const deleting = Boolean(useOrg().org?.deletion);
  const dir = useDirectory();
  const routines = useRoutines(orgId);
  // Being deleted, its routines' slots pass: none is next (the server says so too, once the list is read again).
  const next = useMemo(() => (deleting ? null : nextRoutine<Routine>(routines.data ?? [])), [deleting, routines.data]);
  const nextAgent = next ? dir.agentById.get(next.agentId) : undefined;
  const when = useWhen();
  const date = next?.nextRunAt ? nextRunWords(t, when, next.nextRunAt) : null;
  const reduced = useReducedMotion();
  // The last card decided: the clear page fades in where the cards were.
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
      <TeamSkyEmpty title={t("mobile.activityNow.clear.title")} text={t("mobile.activityNow.clear.text")} />
      {/* The next run as a row of the list below it: who, the routine's name on one line, and when. */}
      {next ? (
        <>
          <SectionHeader title={t("routines.panel.nexts")} />
          <ListRow
            onPress={() => router.push(routineHref(next.id))}
            accessibilityRole="button"
            leading={
              nextAgent ? (
                <AgentFace agentId={nextAgent.id} size={LIST_AVATAR - 2} live={false} />
              ) : (
                <Tile icon="clock" size={LIST_AVATAR} />
              )
            }
            title={next.name}
            sub={
              date
                ? nextAgent
                  ? t("mobile.activityNow.next.routineOf", { agent: nextAgent.name, when: date })
                  : t("mobile.activityNow.next.routine", { when: date })
                : null
            }
            subLines={1}
          />
        </>
      ) : null}
    </Animated.View>
  );
}

/** When the next run is: "hoje às 18:00", "amanhã às 9:00", "qua, 12 nov às 9:00". */
function nextRunWords(t: TFunction, when: ReturnType<typeof useWhen>, iso: string): string {
  const day = upcomingDay(iso);
  const time = when.time(iso);
  const date =
    day === "today"
      ? t("mobile.activityNow.next.today", { time })
      : day === "tomorrow"
        ? t("mobile.activityNow.next.tomorrow", { time })
        : t("mobile.activityNow.next.later", {
            day: new Intl.DateTimeFormat(when.locale, { weekday: "short", day: "numeric", month: "short" })
              .format(new Date(iso))
              .replace(/\./g, ""),
            time,
          });
  return date;
}

/**
 * One item, in Conversas' row: the faces, who did what (the names bold)
 * and when, the snippet and where; a red dot on the right while unread. Swipe right to mark read or unread,
 * left for "Feito"; tapping opens where it happened.
 */
const ActivityRow = memo(function ActivityRow({ item: n, divider }: { item: AppNotification; divider: boolean }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const when = useWhen();
  const toast = useToast();
  const act = useNotificationAction(orgId);
  // A routine's trouble opens the routine; the computer being ready, Connect an AI while no agent has one.
  const ai = useAiStatus(orgId, n.kind === "computer_ready").data;
  const href = notificationHref(n, ai);
  // No screen of its own in the app (the workspace's billing hold): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const unread = n.readAt === null;

  // Who did what, as the island says it too; a restriction or several agents' failures go under it.
  const { parts, names, title, restriction, failed } = useNoticeTitle(n);
  // Coded words in the person's language: why a routine paused or failed, who asked for an approval.
  const say: SayWords = (w, otherwise = "") => {
    const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
  };
  // A GIF or a sticker with no words says which (ADR 0091).
  const line = subtitleOf(
    n,
    say,
    (kind) => mediaWord(t, kind),
    (l) => latestText(t, l),
  );
  const sub = restriction
    ? restrictionLine(t, restriction.code, restriction.facts)
    : n.kind === "usage_limit"
      ? usageLimitLine(t, n)
      : failed
        ? failed.sub
        : // A widget's or routine's name is often its line too: said once ("Assinaturas hoje", not twice).
          [emojisOf(n).join(" "), [...new Set([line, placeOf(n)].filter(Boolean))].join(" · ")]
            .filter(Boolean)
            .join(" ");
  const time = when.short(n.updatedAt);
  // As Conversas' rows: line 1 who (the names alone, one line, the time on their baseline), line 2 what they did and
  // where. A sentence that doesn't open with the names (or has none) is line 1 itself, on one line too.
  const [lead = "", did = ""] = parts;
  const byNames = !failed && !restriction && parts.length === 2 && lead.trim() === "" && Boolean(names);
  const action = byNames ? upperFirst(did.trim(), i18n.language) : "";
  const second = byNames ? [action, sub].filter(Boolean).join(" · ") : sub;

  // The swipe taps on its own (SwipeRow); VoiceOver's actions call these too.
  const toggleRead = () => act.mutate({ type: "read", item: n, read: unread });
  // In "Feitas" the same swipe moves it back to the inbox. Marked done, a toast offers the way back for a moment.
  const isDone = Boolean(n.doneAt);
  const done = () => {
    act.mutate({ type: "done", item: n, done: !isDone });
    if (!isDone)
      toast({
        title: t("mobile.activity.doneToast"),
        subtitle: title,
        action: { label: t("mobile.activity.undo"), onPress: () => act.mutate({ type: "done", item: n, done: false }) },
      });
  };
  const doneLabel = isDone ? t("mobile.activity.restore") : t("mobile.activity.done");
  const open = () => {
    if (unread) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openWebPath(web);
  };
  const faces = n.actors.slice(0, n.count > 1 ? 2 : 1);
  const leading =
    faces.length === 0 ? (
      <Tile icon="bell" size={LIST_AVATAR} />
    ) : faces.length === 1 ? (
      <Face who={faceOf(faces[0])} size={faces[0]?.type === "agent" ? LIST_AVATAR - 2 : LIST_AVATAR} live={false} />
    ) : (
      <View style={styles.stack}>
        <View style={styles.back}>
          <Face who={faceOf(faces[0])} size={STACKED} live={false} />
        </View>
        <View style={[styles.front, { backgroundColor: c.bg, borderRadius: STACKED * 0.3 + 2 }]}>
          <Face who={faceOf(faces[1])} size={STACKED} live={false} />
        </View>
      </View>
    );
  const a11y = [title, sub, time, unread ? t("mobile.activity.unread") : null].filter(Boolean).join(", ");
  return (
    <View>
      <SwipeRow
        left={{
          label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread"),
          icon: unread ? "check" : "bell",
          color: c.agent,
          ink: c.onAgent,
          onAction: toggleRead,
        }}
        // On the green, the page's color reads in both themes (white in light, near black on dark's light green).
        right={{ label: doneLabel, icon: isDone ? "undo" : "archive", color: c.ok, ink: c.bg, onAction: done }}
      >
        <View style={{ backgroundColor: c.bg }}>
          <ListRow
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            accessibilityActions={[
              { name: "read", label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread") },
              { name: "done", label: doneLabel },
            ]}
            onAccessibilityAction={(e) => (e.nativeEvent.actionName === "read" ? toggleRead() : done())}
            dot={unread}
            unread={unread}
            leading={leading}
            title={byNames ? names : title}
            time={time}
            sub={second || null}
            subLines={restriction ? 0 : undefined}
          />
        </View>
      </SwipeRow>
      {/* A change someone sent with "Pedir a um admin" (ADR 0137): decided on its card, here. */}
      {n.kind === "change_request" ? (
        <View style={styles.change}>
          <ChangeRequestCard n={n} />
        </View>
      ) : null}
      {/* The agent's model left its plan's list: another one chosen from here. */}
      {n.kind === "plan_model_dropped" && href && !n.doneAt ? (
        <View style={styles.change}>
          <Button variant="secondary" size="sm" label={t("mobile.activity.chooseModel")} onPress={open} />
        </View>
      ) : null}
      {/* An agent holds the person's phone: Stop, right here. */}
      {isDeviceNotice(n.kind) ? (
        <View style={styles.change}>
          <DeviceNoticeActions item={n} />
        </View>
      ) : null}
      {/* A person asks for more (ADR 0141): raised or refused right here. */}
      {n.kind === "usage_limit" && n.latest.statusTo === "request" && !n.doneAt ? (
        <View style={styles.change}>
          <UsageLimitActions n={n} />
        </View>
      ) : null}
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
    </View>
  );
});

/** Two faces share the avatar box (grouped items: reactions, replies). */
const STACKED = 36;
const faceOf = (a: AppNotification["actors"][number] | undefined) =>
  a ? { type: a.type === "agent" ? "agent" : "person", id: a.id } : null;

const styles = StyleSheet.create({
  // Cards 12 apart, at the screen's margin.
  cards: { gap: 12, paddingHorizontal: 16 },
  change: { paddingHorizontal: 16, paddingBottom: 12 },
  wpressed: { opacity: 0.85 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  grow: { flex: 1, minWidth: 0 },
  // Nothing waiting, on the page itself: the sky band edge to edge, its crew, the words, the next event's line.
  // One event line: the 16-point mark on the first line, the words, when at the end.
  stack: { width: LIST_AVATAR, height: LIST_AVATAR },
  back: { position: "absolute", top: 0, left: 0 },
  front: { position: "absolute", right: -2, bottom: -2, padding: 2 },
  bold: { fontWeight: "600" },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  more: { alignItems: "center", paddingVertical: 16 },
  morePressed: { opacity: 0.6 },
});

const CARD_IN = FadeIn.duration(160);
const CARD_OUT = FadeOut.duration(120);
