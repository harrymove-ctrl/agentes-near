import {
  browserHandoffOf,
  browserTrailOf,
  desktopTrailOf,
  keys,
  type Message,
  type MessageReceipt,
  type ReplyRef,
  type RunConsultation,
  type ScreenKind,
  type ThreadInfo,
  useApi,
  useConsultations,
  useContinuedRun,
  useReactions,
  useRoles,
  useToggleReaction,
  useWaiting,
} from "@agenteschat/client";
import { foldTalk, TALK_LINE_CHARS, talksToAgent } from "@agenteschat/client/lib/agent-talk";
import { APP_BRANDS } from "@agenteschat/client/lib/apps";
import { channelRefsOf } from "@agenteschat/client/lib/channel-refs";
import { type RunPosition, runAround } from "@agenteschat/client/lib/chat";
import { mineOnRight } from "@agenteschat/client/lib/chat-look";
import { choiceReplyLine } from "@agenteschat/client/lib/choices";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import { CONTINUE_ERRORS, errorCode, errorText } from "@agenteschat/client/lib/errors";
import { mentionsReader } from "@agenteschat/client/lib/everyone";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { issueWorkOf } from "@agenteschat/client/lib/issues";
import { workAnchorBody, workContinuable, workIsOver } from "@agenteschat/client/lib/long-work";
import { brainUnavailableOf } from "@agenteschat/client/lib/machine-outages";
import { isMediaAfterReply, messageMediaOf } from "@agenteschat/client/lib/media";
import { memberRoleColor } from "@agenteschat/client/lib/member-groups";
import { serverBody } from "@agenteschat/client/lib/message-body";
import { missionSetupOf } from "@agenteschat/client/lib/missions";
import { isTalkerReply, routineReportText, talkerWaited } from "@agenteschat/client/lib/notices";
import { can } from "@agenteschat/client/lib/permissions";
import { reachHandoffs } from "@agenteschat/client/lib/reach";
import { replyOf } from "@agenteschat/client/lib/reply";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { appVia } from "@agenteschat/client/lib/via";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { showsActivity, splitCanceled } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type GestureResponderEvent, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  type EntryExitAnimationFunction,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  withTiming,
} from "react-native-reanimated";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  CHROME_MAX_SCALE,
  Count,
  EventPillAction,
  haptics,
  Icon,
  InkOrbit,
  LineIcon,
  PressScale,
  ProviderLogo,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { InstructionProposals } from "../agents/InstructionProposalCard";
import { ProposalCard } from "../agents/ProposalCard";
import { CostlyProposalCard } from "../ai/CostlyProposalCard";
import { NoAiCard } from "../ai/NoAiCard";
import { OfferCard } from "../ai/OfferCard";
import { StretchCard } from "../ai/StretchCard";
import { UsagePauseCard, UsageWaitCancel } from "../ai/UsagePauseCard";
import { HandoffCard } from "../browser/HandoffCard";
import { TrailCard } from "../browser/TrailCard";
import { DeviceWait } from "../devices/DeviceWait";
import { deviceWaitOf } from "../devices/logic";
import { MessageFiles } from "../files/MessageFiles";
import { chatHref, consultationHref, routineHref } from "../links/logic";
import { DecisionCard, MissionCard, PlanCard, ReviewCard, SetupFailedCard } from "../missions/cards";
import { AwayPill, BrainWait } from "../outages/WaitCard";
import { SettingsProposals } from "../right-hand/SettingsCard";
import { ReplyChips, TeamCard } from "../right-hand/TeamCard";
import { TeamWeek } from "../right-hand/TeamWeekCard";
import { AgentFace, Face, withAgentFaces } from "../shared/Face";
import { useColors, useDirectory, useMeId, useMyHandle, useNamesComputers, useOrgId, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { VoiceMessage } from "../voice/VoiceMessage";
import { ReceiptMark } from "./AgentReceipts";
import { secretRequestOf } from "./ask-store";
import { ChatMedia } from "./ChatMedia";
import { ConsultPairRow, useRunConsults } from "./ConsultGroup";
import { ApprovalInline, QuestionCard, ThreadLink } from "./cards";
import { FeedbackOfferRow } from "./FeedbackOffer";
import { HandedTaskChips, IssueWorkCard } from "./issue-work";
import { cacheContinued } from "./live";
import {
  approvalIdOf,
  artifactsOf,
  CHAT_TEXT_MAX_SCALE,
  chatNameOf,
  chatTimeOf,
  consultationsOf,
  DOUBLE_TAP_MS,
  hangsUnder,
  hidesBody,
  MSG_AVATAR,
  MSG_GAP,
  MSG_INSET,
  mayStopRun,
  missionCardRef,
  missionLinkOf,
  missionPlanOf,
  nameInk,
  questionOf,
  reactionPills,
  rowFrame,
  workStepsOf,
} from "./logic";
import { lookRows, RowPartContext, useRhythm, useRowLook } from "./look";
import { MessageText } from "./MessageText";
import { QuoteAbove, QuotePlate } from "./QuoteLine";
import { ReachLines } from "./ReachLines";
import { Receipts } from "./Receipts";
import { SecretCard } from "./SecretCard";
import { SpeedFallbackLine, StopPill } from "./StoppedLine";
import { useStoppedRun } from "./stopped-runs";
import { TeamChecks } from "./TeamChecks";
import { SavedTools, TurnTools } from "./ToolCalls";
import { recentTurn, stepLimitOf, stoppedOf, turnOpener } from "./turn";
import { MessageWorkLine } from "./WorkLine";

/** A run's message asks whether a take over still holds its browser only this recently (older: events only). */
const TRAIL_RECENT_MS = 12 * 60 * 60_000;

/**
 * One message: the face and name (dropped when grouped), a pin mark when
 * pinned, what it consulted, its text, the cards it carries and the reactions. Long press opens its
 * actions (the screen's sheet). An agent's reply takes its live block's place: its tools stay one closed
 * line under its words and what it changed ("Usou N ferramentas"), the same place live, kept and saved, and a
 * stopped one says so with "Continuar". A person's message's
 * receipt is a mark in a line the row already has (`ReceiptMark`), so it never changes the row's height: after the
 * time under my turn, whether an agent read it ("lê na próxima pausa", "leu") or who read it in a DM; at the end of
 * someone else's name line, the agents' receipt of their latest message.
 */
export const MessageRow = memo(function MessageRow({
  message: m,
  grouped: groupedIn,
  newTurn,
  meId,
  thread,
  onLongPress,
  onRetry,
  onQuote,
  receipt,
  seenBy,
  readOnly = false,
  inThread = false,
  run: runAt = "solo",
  above,
  aboveThread = false,
}: {
  message: Message;
  grouped: boolean;
  /** Next in its turn, but under something else: it takes a turn's gap. */
  newTurn?: boolean | undefined;
  /** My own row's place in a run of my rows (`runPosition`): the corners it shares square off, the time ends it. */
  run?: RunPosition;
  /** The message it groups under, and whether that one shows its thread's link: what hangs under it ends the run. */
  above?: Message;
  aboveThread?: boolean;
  meId: string | null;
  /** Its thread, when it is the root of one the conversation shows as a link. */
  thread?: ThreadInfo;
  /** Absent where it is read only. */
  onLongPress?: (m: Message) => void;
  onRetry?: (m: Message) => void;
  /** A tap on what it answers. */
  onQuote?: (reply: ReplyRef) => void;
  /** The agents' receipt its mark shows: the latest person's message's, on it or on its turn's first row. */
  receipt?: MessageReceipt;
  /** A DM between people: who read this message, my latest. */
  seenBy?: string;
  /** Shown where the person can't act on it (two agents' conversation): no long press, reactions or block. */
  readOnly?: boolean;
  /** On its thread's own screen: a long message between agents is read whole there. */
  inThread?: boolean;
}) {
  const { t, i18n } = useTranslation();
  // Mine and not sent for lack of a connection: it waits and goes by itself when the connection is back.
  const offline = useWaiting(m.local === "failed" ? m.clientId : null);
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const isAgent = m.author.type === "agent";
  const agent = isAgent && m.author.id ? dir.agentById.get(m.author.id) : undefined;
  const accent = agent ? agentLook(agent).color : undefined;
  const color = agentLook(agent).color;
  const name = dir.nameOf(m.author) || t("mobile.chat.someone");
  const meta = m.meta;
  // What a routine found, told by its agent (as on the web): a small tag, and the report it answers on demand
  // (that report's own line folds into this message).
  const routine = routineReplyOf(m);
  const [reportOpen, setReportOpen] = useState(false);
  const qc = useQueryClient();
  const orgId = useOrgId();
  const { org } = useOrg();
  const report = routine?.noticeId
    ? routineReportText(
        [
          ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
          ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
        ],
        routine.noticeId,
      )
    : null;
  // A plain reminder: the agent's own message with a "Lembrete" label (the server's prefix dropped).
  const reminder = isReminderMessage(meta);
  // A short reply it gave while its task kept working (the talker): its message, "enquanto trabalha".
  const talker = isAgent && isTalkerReply(meta);
  // A person's message sent through a connected AI app (ADR 0119): "via Claude".
  const via = m.author.type === "person" ? appVia(meta) : null;
  const viaMark = via?.brand ? APP_BRANDS[via.brand] : undefined;
  // What the server wrote itself is said in the person's language; a stopped reply drops the server's note. Where a
  // task ran is said only where the workspace has more than one computer.
  const names = useNamesComputers();
  const said = hidesBody(m)
    ? ""
    : reminderBody(splitCanceled(serverBody(t, m.body, meta, i18n.language, names), meta).body, meta);
  // A long work's anchor once it's over: no promise left, and dimmed (its line says how it ended).
  const body = m.longWork ? workAnchorBody(t, said, meta, m.longWork) : said;
  const workOver = Boolean(m.longWork && workIsOver(m.longWork));
  // The person's pick on a choice card (ADR 0124): one compact line, not a bubble.
  const choiceReply = meta?.choiceReply && body ? <ChoiceReply text={choiceReplyLine(body)} /> : null;
  const consulted = isAgent && m.author.id ? consultationsOf(meta) : [];
  // A long message from one agent to another (ADR 0034): its first paragraph and "Ler tudo", which pushes its
  // thread's screen with it whole. On that screen, and where it is read only, it stays whole.
  const talk = useMemo(
    () =>
      isAgent &&
      !inThread &&
      !readOnly &&
      !m.local &&
      talksToAgent(m, (handle) => agentsByAnyHandle(dir.agents).get(handle)?.id)
        ? foldTalk(body, TALK_LINE_CHARS.phone)
        : null,
    [isAgent, inThread, readOnly, m, body, dir.agents],
  );
  // A GIF or a sticker (ADR 0091); with no words, the message is the picture alone (no empty bubble).
  const media = messageMediaOf(meta);
  // The one an agent adds after its own reply carries the reply's run: the run's tools, questions and stop line
  // stay on the reply, never shown twice.
  const mediaAfter = isAgent && isMediaAfterReply(meta);
  // It asked other agents first: one row right before it (its run's questions on the run's first message here, and
  // the ones its `meta.consulted` names), so it shows its face and name again under that row.
  const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);
  const rhythm = useRhythm();
  const consults = useRunConsults(
    isAgent && !m.local && !readOnly && !mediaAfter ? m.agentRunId : null,
    m,
    m.id,
    consulted,
    reached,
  );
  const pair =
    isAgent && m.author.id && consults.length > 0 ? (
      <ConsultPairRow askerId={m.author.id} channelId={m.channelId} items={consults} />
    ) : null;
  const grouped = groupedIn && !pair;
  // A question to another agent (in their DM) carries the asking run: its work shows on that run's reply.
  const ownWork = isAgent && Boolean(m.agentRunId) && !meta?.consultation && !mediaAfter;
  const steps = ownWork ? workStepsOf(meta) : null;
  // Posted by a run answering another agent's question from here (its approval, question, secret): whom it helps.
  const consultations = useConsultations(
    orgId,
    m.channelId,
    isAgent && Boolean(m.agentRunId) && !readOnly && !mediaAfter,
  );
  const helping =
    isAgent && m.agentRunId && !readOnly && !mediaAfter
      ? consultations.data?.find((x) => x.consultedRunId === m.agentRunId)
      : undefined;
  // No `onLongPress` where the system's menu takes the hold (iOS): the row adds nothing of its own to it.
  const press =
    readOnly || !onLongPress
      ? undefined
      : () => {
          tapHaptic();
          onLongPress(m);
        };
  // Two taps on a message send the thumbs up without opening anything: one light tap, the emoji pops where the
  // finger was and the pill grows in under the words; holding still opens the menu with every reaction. The line
  // "Toque duplo = 👍" sits under one agent's message until it has been seen once.
  const reduced = useReducedMotion();
  const cachedReactions = useReactions(orgId, m.id, false);
  const toggleThumbs = useToggleReaction(orgId, m.id);
  const lastTap = useRef(0);
  const [pop, setPop] = useState<{ x: number; y: number; at: number } | null>(null);
  const canReact = !readOnly && !m.local;
  const onTap = canReact
    ? (e: GestureResponderEvent) => {
        const at = Date.now();
        if (at - lastTap.current > DOUBLE_TAP_MS) {
          lastTap.current = at;
          return;
        }
        lastTap.current = 0;
        haptics.light();
        const mine =
          reactionPills(cachedReactions.data ?? m.reactions, meId).find((p) => p.reaction === THUMBS)?.mine ?? false;
        toggleThumbs.mutate({ reaction: THUMBS, on: !mine });
        setPop({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY, at });
        teachDoubleTap();
      }
    : undefined;
  useEffect(() => {
    if (!pop) return;
    const timer = setTimeout(() => setPop(null), POP_MS);
    return () => clearTimeout(timer);
  }, [pop]);
  const popNode = pop ? (
    <Animated.View
      key={pop.at}
      pointerEvents="none"
      entering={reduced ? undefined : POP_IN}
      exiting={reduced ? undefined : POP_OUT}
      style={[styles.pop, { left: pop.x - POP / 2, top: pop.y - POP / 2 }]}
    >
      <Text style={styles.popEmoji} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        👍
      </Text>
    </Animated.View>
  ) : null;
  const hint = useDoubleTapHint(canReact && isAgent && !groupedIn ? m.id : null);
  const hintNode = hint ? (
    <Text variant="caption" tone="faint" style={styles.hint}>
      {t("mobile.chat.doubleTapHint")}
    </Text>
  ) : null;
  const stopped = isAgent && m.agentRunId && !mediaAfter ? stoppedOf(meta) : null;
  // The reply of a run that reached its step limit: the same line, with Continuar.
  const atLimit = isAgent && m.agentRunId && !stopped && !mediaAfter ? stepLimitOf(meta) : null;
  // A long work's end after its AI provider failed: Continuar under it too.
  const providerCut = isAgent && m.agentRunId && !stopped && !atLimit ? workContinuable(meta) : null;
  // This reply just took its live block's place here: the same tools (and the messages it read) stay.
  const [kept] = useState(() => (ownWork && m.agentRunId ? recentTurn(m.agentRunId, Date.now()) : null));
  // The line its block opened with stays above the tools, where it was, instead of moving into them (`turnOpener`).
  const opened = kept ? turnOpener(kept.items, body) : null;
  const approvalId = approvalIdOf(meta);
  const review = missionCardRef(meta, "missionReview");
  const decision = missionCardRef(meta, "missionDecision");
  const plan = missionPlanOf(meta);
  // Preparing the mission's copy of the project failed (ADR 0044): the card with "Tentar de novo".
  const setup = missionSetupOf(meta);
  const link = missionLinkOf(meta);
  const files = artifactsOf(meta);
  const aboveReactions = useReactions(orgId, above?.id ?? "", false).data;
  const ownReactions = useReactions(orgId, m.id, false).data;
  const run = runAround(
    runAt,
    above ? hangsUnder(above, aboveThread, aboveReactions, meId) : false,
    hangsUnder(m, Boolean(thread), ownReactions, meId),
  );
  const question = isAgent ? questionOf(meta) : null;
  // An agent asks a person for a secret for its computer (ADR 0027).
  const secret = isAgent ? secretRequestOf(meta) : null;
  // An agent proposes a change to the workspace's context or to an agent's instructions: decided right here.
  // The agent needs a person in its browser (ADR 0040): the request, live.
  const handoff = isAgent ? browserHandoffOf(meta) : null;
  // A card in a row of its own under the same author's words stands as far off them as in the same row.
  const cardRow = !body && !media && Boolean(meta?.actionCard || approvalId || question || secret || handoff);
  const rowGap = !grouped || newTurn ? rhythm.turn : cardRow ? rhythm.card : rhythm.part;
  const cardTop = body || media ? rhythm.card - rhythm.part : 0;
  // Where it browsed, or what it did on its desktop, after the run (as on the web): the steps' card.
  // Step summaries, no picture: activity, so the person's setting hides them like the tool block.
  const trails =
    isAgent && m.author.id && !m.local && showsActivity(org)
      ? {
          browser: browserTrailOf(meta),
          desktop: desktopTrailOf(meta),
          recent: Date.now() - Date.parse(m.createdAt) < TRAIL_RECENT_MS,
        }
      : null;
  // Calls that have their own card under the message (where it browsed, its desktop) stay out of its tools.
  const onCards: ScreenKind[] = [
    ...(trails?.browser.length ? (["browser"] as const) : []),
    ...(trails?.desktop.length ? (["desktop"] as const) : []),
  ];
  // "Esperando o MacBook Air voltar": its brain's computer is offline (the card, when it says which computer).
  // Waiting for a device someone brought (a phone, another computer): its own pill, with what can be done about it.
  const deviceWait = isAgent && deviceWaitOf(meta) !== null;
  const brainWait = isAgent && !deviceWait && Boolean(brainUnavailableOf(meta)?.machineId);
  // The root of an issue's work thread (asked an agent to implement it): the issue card.
  const issueWork = issueWorkOf(meta);
  // My own message. In the styles that keep it apart, a bubble on the right with no face or name; in the others, a row
  // like anyone's.
  const mine = m.author.type === "person" && Boolean(meId) && m.author.id === meId;
  const look = useRowLook();
  // The name over the words and its time follow the person's Tamanho do texto, as the words do.
  const nameSize = look.text ? chatNameOf(look.text) : undefined;
  const timeSize = look.text ? chatTimeOf(look.text) : undefined;
  const onRight = mine && mineOnRight(look.style);
  const bubbled = look.style === "bubbles";
  const compact = look.style === "compact";
  const { scheme } = useTheme();
  const roles = useRoles(orgId).data?.roles;
  const member = m.author.type === "person" && m.author.id ? dir.memberById.get(m.author.id) : undefined;
  const roleColor = member ? memberRoleColor(member, roles ?? []) : undefined;
  const nameColor = !bubbled
    ? undefined
    : isAgent
      ? nameInk(color, scheme === "dark")
      : roleColor
        ? nameInk(roleColor as AgentColorName, scheme === "dark")
        : undefined;
  const solidInk = bubbled && look.tone === "strong" ? ON_SOLID : undefined;
  const quote = replyOf(meta);
  const myHandle = useMyHandle();
  const mentionsMe = !mine && mentionsReader({ body, meta }, myHandle);

  // The cards it carries: above an agent's tools, which come last.
  const cards = (
    <>
      {issueWork ? (
        <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
      ) : null}
      {meta?.missionStart ? <MissionCard threadId={m.id} /> : null}
      {link ? <MissionCard missionId={link.missionId} /> : null}
      {plan ? <PlanCard missionId={plan.missionId} goal={plan.goal} /> : null}
      {review ? <ReviewCard missionId={review.missionId} reviewId={review.id} /> : null}
      {setup ? (
        <SetupFailedCard
          {...(setup.missionId ? { missionId: setup.missionId } : {})}
          threadId={m.threadId}
          error={setup.error}
          {...(setup.reason === "branch_missing" ? { lostBranch: setup.branch ?? null } : {})}
        />
      ) : null}
    </>
  );
  const missionDecision = decision ? <DecisionCard missionId={decision.missionId} decisionId={decision.id} /> : null;
  // Under everything: the thread it started, its reactions and whether it went out.
  const foot = (
    <>
      {thread && !meta?.missionStart ? (
        <View style={onRight ? styles.meEnd : undefined}>
          <ThreadLink thread={thread} />
        </View>
      ) : null}
      {readOnly ? null : <Reactions message={m} meId={meId} end={onRight} />}
      {m.local === "pending" && meta?.voiceAccepted === true ? null : m.local === "pending" ||
        (m.local === "failed" && offline) ? (
        <Sending offline={offline} end={onRight} />
      ) : m.local === "failed" ? (
        // A 16-point caption: 14 of slop gives the retry its 44-point target.
        <Pressable
          onPress={() => onRetry?.(m)}
          accessibilityRole="button"
          hitSlop={14}
          style={({ pressed }) => pressed && styles.pressedDim}
        >
          <Text variant="caption" tone="danger" style={onRight ? styles.meStatus : undefined}>
            {t("mobile.chat.failed")}
          </Text>
          {/* Why, as it came: a voice note that never left says what stopped it instead of waiting in silence. */}
          {typeof meta?.sendError === "string" ? (
            <Text variant="caption" tone="faint" numberOfLines={2} style={onRight ? styles.meStatus : undefined}>
              {meta.sendError}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </>
  );

  if (onRight) {
    const stamp = (
      <View style={styles.stamp}>
        <Text variant="caption" tone="muted" style={solidInk ? { color: solidInk } : undefined}>
          {when.time(m.createdAt)}
        </Text>
        <ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} {...(solidInk ? { ink: solidInk } : {})} />
      </View>
    );
    // A voice message and a choice's answer lead with their own player or line, so their time stays under them.
    const myBubble = bubbled && Boolean(body) && !voiceOf(meta) && !choiceReply;
    // A voice message's player, a choice's answer, the bubble, or the GIF or sticker or the files of a message
    // with no words, leads.
    const lead = voiceOf(meta) ? (
      <View style={styles.meFiles}>
        <VoiceMessage message={m} />
      </View>
    ) : choiceReply ? (
      <View style={styles.meFiles}>{choiceReply}</View>
    ) : body ? (
      <View
        style={[
          bubbled ? lookRows.bubble : styles.bubble,
          styles.bubbleEnd,
          BUBBLE_RUN[run],
          { backgroundColor: (bubbled && look.fill) || c.bubble },
        ]}
      >
        {quote ? <QuotePlate reply={quote} onJump={onQuote} {...(solidInk ? { ink: solidInk } : {})} /> : null}
        <View style={bubbled ? styles.bubbleLine : undefined}>
          <MessageText
            body={body}
            muted={m.local === "pending"}
            selectable={false}
            accent={accent}
            channelRefs={channelRefsOf(m.meta)}
            everyone={m.meta?.mentionsEveryone === true}
            {...(solidInk ? { ink: solidInk } : {})}
          />
          {bubbled && !m.local ? stamp : null}
        </View>
      </View>
    ) : media ? (
      <View style={styles.meFiles}>
        <ChatMedia media={media} align="end" liveId={m.id} />
      </View>
    ) : files.length > 0 ? (
      <View style={styles.meFiles}>
        <MessageFiles files={files} align="end" />
      </View>
    ) : null;
    return (
      <Pressable
        onPress={onTap}
        onLongPress={press}
        delayLongPress={380}
        accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
        style={({ pressed }) => [styles.me, rowFrame(rhythm.block, rowGap), pressed && press && styles.mePressed]}
      >
        <RowPartContext.Provider value={cardTop}>
          <View style={[styles.meParts, { gap: rhythm.part }]}>
            {m.pinned ? (
              <View style={[styles.pinLine, styles.meEnd, { marginBottom: PIN_GAP - rhythm.part }]}>
                <PinMark />
                <Text variant="caption" tone="faint">
                  {t("mobile.pins.mark")}
                </Text>
              </View>
            ) : null}
            {/* With no words there is no bubble to hold it. */}
            {quote && (!body || voiceOf(meta) || choiceReply) ? (
              <View style={styles.meEnd}>
                <QuotePlate reply={quote} onJump={onQuote} />
              </View>
            ) : null}
            {lead}
            {body && media ? (
              <View style={styles.meFiles}>
                <ChatMedia media={media} align="end" liveId={m.id} />
              </View>
            ) : null}
            {(body || media) && files.length > 0 ? (
              <View style={styles.meFiles}>
                <MessageFiles files={files} align="end" />
              </View>
            ) : null}
            {cards}
            {missionDecision}
            {foot}
          </View>
        </RowPartContext.Provider>
        {/* One time per run of my rows (they group a few minutes apart), under its last, the receipt's mark ending
            its line; a send in flight says so. */}
        {!m.local && (run === "end" || run === "solo") && !myBubble ? (
          <View style={[styles.meTime, { marginTop: rhythm.part / 2 }]}>
            <Text variant="caption" tone="faint">
              {when.time(m.createdAt)}
            </Text>
            <ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />
          </View>
        ) : null}
        {popNode}
      </Pressable>
    );
  }

  // Under a name, or in a bubble with it: the same line, its time last. In `bubbles` it goes in the bubble's end when
  // there is one; in a DM's bubble the line is only what a tag has to say. A row with no bubble (a card alone) keeps
  // the name ahead of its time, as anywhere else: a time alone beside a face reads as a broken line.
  const who = (inBubble: boolean) => (
    <View
      style={[
        styles.who,
        m.author.type === "person" && !inBubble && !compact && styles.whoRoom,
        (inBubble || compact || !words) && styles.whoTight,
      ]}
    >
      {!inBubble || look.names ? (
        <Text
          variant="footnote"
          tone="ink2"
          style={[styles.name, nameSize, nameColor ? { color: nameColor } : undefined]}
          numberOfLines={1}
          maxFontSizeMultiplier={nameSize ? CHAT_TEXT_MAX_SCALE : undefined}
        >
          {name}
        </Text>
      ) : null}
      {reminder ? <Tag icon="bell" label={t("channel.reminder")} /> : null}
      {via ? (
        <Tag
          icon="sparkle"
          lead={viaMark ? <ProviderLogo id={viaMark} size="xs" /> : undefined}
          label={t("apps.via", { name: via.name })}
          hint={t("apps.viaTip", { person: name, name: via.name })}
        />
      ) : null}
      {routine ? (
        // The tag opens the routine (Rotinas, as on the web); "Ver relatório" beside it unfolds the report.
        <Tag
          icon="clock"
          label={t("channel.routineTag", { name: routine.name })}
          onPress={() => router.push(routineHref(routine.id))}
          hint={t("channel.routineTagTip")}
        />
      ) : null}
      {routine && report ? (
        <Pressable
          onPress={() => setReportOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityState={{ expanded: reportOpen }}
          hitSlop={NAME_LINE_SLOP}
          style={({ pressed }) => [styles.shrink, pressed && styles.pressedDim]}
        >
          <Text variant="caption" tone="muted" numberOfLines={1} style={styles.medium}>
            {reportOpen ? t("channel.routineReportHide") : t("channel.routineReport")}
          </Text>
        </Pressable>
      ) : null}
      {talker ? (
        <Text
          variant="caption"
          tone="faint"
          numberOfLines={1}
          style={styles.shrink}
          accessibilityHint={t(talkerWaited(meta) ? "chat.notice.talkerWaitingTip" : "chat.notice.talkerTip")}
        >
          {t(talkerWaited(meta) ? "chat.notice.talkerWaiting" : "chat.notice.talker")}
        </Text>
      ) : null}
      {helping ? <HelpingTag consultation={helping} channelId={m.channelId} /> : null}
      {!reminder && !routine && !talker && !helping && agent?.role && !bubbled && !compact ? (
        <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
          {agent.role}
        </Text>
      ) : null}
      {inBubble || compact ? null : (
        <Text
          variant="footnote"
          tone="faint"
          style={timeSize}
          maxFontSizeMultiplier={timeSize ? CHAT_TEXT_MAX_SCALE : undefined}
        >
          {when.time(m.createdAt)}
        </Text>
      )}
      {brainWait ? <AwayPill message={m} /> : null}
      {m.pinned ? <PinMark /> : null}
      {(receipt || seenBy) && !m.local && !inBubble ? (
        <View style={compact ? undefined : [styles.whoMark, nameSize ? { height: nameSize.lineHeight } : null]}>
          <ReceiptMark message={m} mine={mine} receipt={receipt} seenBy={seenBy} />
        </View>
      ) : null}
    </View>
  );
  const pinLine =
    grouped && m.pinned ? (
      <View style={[styles.pinLine, { marginBottom: PIN_GAP }]}>
        <PinMark />
        <Text variant="caption" tone="faint">
          {t("mobile.pins.mark")}
        </Text>
      </View>
    ) : null;
  const messageWords = body ? (
    <MessageText
      body={body}
      muted={m.local === "pending"}
      selectable={false}
      accent={accent}
      channelRefs={channelRefsOf(m.meta)}
      everyone={m.meta?.mentionsEveryone === true}
    />
  ) : null;
  const words = deviceWait ? (
    <DeviceWait message={m} fallback={messageWords} />
  ) : brainWait ? (
    <BrainWait message={m} fallback={messageWords} />
  ) : choiceReply ? (
    choiceReply
  ) : body ? (
    <MessageText
      body={talk ? talk.lead : body}
      muted={m.local === "pending" || workOver}
      selectable={false}
      accent={accent}
      channelRefs={channelRefsOf(m.meta)}
      everyone={m.meta?.mentionsEveryone === true}
    />
  ) : null;
  // The bubble holds its words, the tags of its name line and, at its end, the time; a row with none keeps its line.
  const inBubble = bubbled && Boolean(body) && !brainWait && !deviceWait && !choiceReply;
  const tagged = Boolean(reminder || via || routine || talker || helping || m.pinned);
  const opener = opened?.said ? <MessageText body={opened.said} selectable={false} accent={accent} /> : null;
  // Outside a bubble the line it opened with is a part of its own, as the web's second text.
  const openerPart = opener && words ? <View style={{ marginBottom: rhythm.part }}>{opener}</View> : opener;
  const reportOpened =
    report && reportOpen ? (
      <View
        style={[
          styles.report,
          { borderLeftColor: c.line },
          (inBubble || opener || words) && { marginBottom: rhythm.part },
        ]}
      >
        <MessageText body={report} />
      </View>
    ) : null;

  const quoteAbove = Boolean(quote && !inBubble);
  const nameOrWords = Boolean(inBubble || !grouped || pinLine || reportOpened || opener || words);
  return (
    <>
      {pair}
      {quote && !inBubble ? <QuoteAbove look={look} reply={quote} onJump={onQuote} gap={rowGap} /> : null}
      <Pressable
        onPress={onTap}
        onLongPress={press}
        delayLongPress={380}
        accessibilityHint={press ? t("mobile.chat.longPressHint") : undefined}
        style={({ pressed }) => [
          styles.msg,
          bubbled && lookRows.bubblesRow,
          compact && lookRows.compactRow,
          rowFrame(rhythm.block, rowGap),
          // On the quote it answers, its plate never over it.
          quoteAbove && styles.replied,
          // A mention of me: the row's tint says it, with round corners; no accent bar on its left edge. In bubbles the
          // bubble says it.
          mentionsMe && !inBubble && { backgroundColor: `${c.amber}17`, borderRadius: 14 },
          pressed && press && { backgroundColor: c.sunken },
        ]}
      >
        {compact ? (
          <Text variant="caption" tone="faint" style={lookRows.compactClock}>
            {when.time(m.createdAt)}
          </Text>
        ) : null}
        {look.faces ? (
          <View style={[styles.avslot, bubbled && lookRows.bubblesSlot, compact && lookRows.compactSlot]}>
            {grouped ? null : <Face who={m.author} size={compact ? 18 : bubbled ? 30 : 34} live={false} />}
          </View>
        ) : null}
        <View style={[styles.body, { gap: rhythm.part }]}>
          <RowPartContext.Provider value={cardTop}>
            {nameOrWords ? (
              <View>
                {inBubble ? (
                  <>
                    {pinLine}
                    {reportOpened}
                    <View
                      style={[
                        lookRows.bubble,
                        OTHER_RUN[run],
                        { backgroundColor: mentionsMe ? `${c.amber}21` : c.bubble },
                      ]}
                    >
                      {!grouped && (look.names || tagged) ? who(true) : null}
                      {quote ? <QuotePlate reply={quote} onJump={onQuote} /> : null}
                      {opener}
                      <View style={styles.bubbleLine}>
                        {words}
                        <View style={styles.stamp}>
                          <Text variant="caption" tone="muted">
                            {when.time(m.createdAt)}
                          </Text>
                          {receipt || seenBy ? (
                            <ReceiptMark message={m} mine={mine} receipt={receipt} seenBy={seenBy} />
                          ) : null}
                        </View>
                      </View>
                    </View>
                  </>
                ) : compact && !grouped ? (
                  <>
                    <View style={styles.compactLine}>
                      {who(false)}
                      {!reportOpened && !opener ? words : null}
                    </View>
                    {reportOpened}
                    {openerPart}
                    {reportOpened || opener ? words : null}
                  </>
                ) : (
                  <>
                    {grouped ? null : who(false)}
                    {pinLine}
                    {reportOpened}
                    {openerPart}
                    {words}
                  </>
                )}
              </View>
            ) : null}
            {talk && !brainWait ? (
              <Pressable
                onPress={() => router.push(chatHref(m.channelId, m.threadId ?? m.id))}
                accessibilityRole="button"
                hitSlop={8}
                style={({ pressed }) => [styles.talkMore, pressed && styles.pressedDim]}
              >
                <Text variant="footnote" tone="muted" style={styles.medium}>
                  {t("chat.talk.readAll")}
                </Text>
                <Text variant="footnote" tone="faint">
                  · {t("chat.talk.more", { count: talk.more })}
                </Text>
                <Icon name="right" size={13} color={c.faint} />
              </Pressable>
            ) : null}
            {media ? <ChatMedia media={media} liveId={m.id} /> : null}
            {voiceOf(meta) ? <VoiceMessage message={m} /> : null}
            {isAgent && meta?.speedFallback === true ? <SpeedFallbackLine message={m} /> : null}
            {(stopped || atLimit || providerCut) && m.agentRunId ? (
              <StoppedLine
                message={m}
                runId={m.agentRunId}
                stopped={
                  stopped ?? {
                    byUserId: null,
                    continuedRunId: atLimit?.continuedRunId ?? providerCut?.continuedRunId ?? null,
                  }
                }
                limit={providerCut ? "failed" : atLimit ? (atLimit.stuck ? "stuck" : "steps") : undefined}
              />
            ) : null}
            {isAgent && m.actions?.length ? <Receipts message={m} onTap={onTap} onLongPress={press} /> : null}
            {isAgent ? <HandedTaskChips message={m} /> : null}
            {isAgent ? <TeamChecks message={m} /> : null}
            {isAgent ? <ReachLines message={m} /> : null}
            {isAgent ? <FeedbackOfferRow message={m} /> : null}
            {isAgent && m.longWork ? <MessageWorkLine message={m} threaded={Boolean(thread)} /> : null}
            {files.length > 0 ? <MessageFiles files={files} /> : null}
            {trails && m.author.id && trails.browser.length > 0 ? (
              <TrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                steps={trails.browser}
                stopped={stopped}
                recent={trails.recent}
              />
            ) : null}
            {trails && m.author.id && trails.desktop.length > 0 ? (
              <TrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                steps={trails.desktop}
                stopped={stopped}
                screen="desktop"
              />
            ) : null}
            {cards}
            {/* Its tools after its words, what it changed and its cards: the same place live, kept and saved. */}
            {kept ? (
              <TurnTools
                items={opened?.lines ?? kept.items}
                agentName={agent?.name ?? name}
                color={color}
                quoteOf={(id) => kept.quotes[id]}
                done
                settled
              />
            ) : steps && m.agentRunId ? (
              <SavedTools
                runId={m.agentRunId}
                meta={meta}
                agentName={agent?.name ?? name}
                color={color}
                skipScreens={onCards}
              />
            ) : null}
            {/* What waits for a person's click comes last, after the words and the tools. */}
            {isAgent ? <NoAiCard message={m} /> : null}
            {isAgent ? <StretchCard message={m} /> : null}
            {isAgent ? <CostlyProposalCard message={m} /> : null}
            {isAgent ? <UsagePauseCard message={m} /> : null}
            {isAgent ? <UsageWaitCancel message={m} /> : null}
            {isAgent ? <ProposalCard message={m} /> : null}
            {isAgent ? <TeamCard message={m} /> : null}
            {isAgent ? <ReplyChips message={m} /> : null}
            {isAgent ? <OfferCard message={m} /> : null}
            {isAgent ? <InstructionProposals message={m} /> : null}
            {isAgent ? <SettingsProposals message={m} /> : null}
            {isAgent ? <TeamWeek message={m} /> : null}
            {approvalId ? <ApprovalInline approvalId={approvalId} messageId={m.id} /> : null}
            {handoff ? <HandoffCard handoff={handoff} /> : null}
            {question ? <QuestionCard key={`${question.id}:${question.status}`} question={question} /> : null}
            {secret ? <SecretCard key={`${secret.id}:${secret.status}`} request={secret} /> : null}
            {missionDecision}
            {foot}
          </RowPartContext.Provider>
          {hintNode}
        </View>
        {popNode}
      </Pressable>
    </>
  );
});

/** Reactions are stored by name: the thumbs up is `+1` (feedback to the agent). */
const THUMBS = "+1";
/** The emoji that pops where the finger was: its box, and how long it stays. */
const POP = 24;
const POP_MS = 420;

let taught: boolean | null = null;
const isTaught = () => {
  if (taught === null) taught = readValueSync(STORED.doubleTapTaught) === "1";
  return taught;
};
function teachDoubleTap() {
  if (taught === true) return;
  taught = true;
  writeValueSync(STORED.doubleTapTaught, "1");
}
/** The one row that carries the hint this time (the first agent's row to ask for it). */
let hintOwner: string | null = null;
/** How long the hint has to be on screen to count as seen. */
const HINT_SEEN_MS = 6000;

/**
 * Whether this row shows "Toque duplo = 👍": one row per app run, never again once it has been on screen for a
 * while or the person double tapped anywhere.
 */
function useDoubleTapHint(id: string | null): boolean {
  const [shown] = useState(() => {
    if (!id || isTaught()) return false;
    if (hintOwner === null) hintOwner = id;
    return hintOwner === id;
  });
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(teachDoubleTap, HINT_SEEN_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
}

/** My message on its way: "Enviando" only past half a second; offline, a clock and when it will go. */
function Sending({ offline, end }: { offline: boolean; end: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 500);
    return () => clearTimeout(timer);
  }, []);
  if (!offline && !slow) return null;
  return (
    <View style={[styles.status, end && styles.statusEnd]}>
      {offline ? <Icon name="clock" size={12} color={c.faint} /> : <InkOrbit size={10} color={c.faint} />}
      <Text variant="caption" tone="faint">
        {offline ? t("mobile.chat.offlineWait") : t("mobile.chat.sending")}
      </Text>
    </View>
  );
}

/**
 * A reply someone stopped: what it wrote stays, with one pill under it, "You stopped Ada · 14:16 | Continue | Add a
 * reason" ("At the step limit | Continue" under the reply of a run that reached its step limit). The run's stop
 * notice, when the conversation has it, gives the pill its words (who, the reason, "Add a reason") and draws nothing
 * itself (`stoppedRunsOf`). Continue picks up from where it stopped (a new run) and goes away once it did, for
 * everyone.
 */
function StoppedLine({
  message: m,
  runId,
  stopped,
  limit,
}: {
  message: Message;
  runId: string;
  stopped: { byUserId: string | null; continuedRunId: string | null };
  /**
   * It ended at its step limit, or because it got stuck, or its long work failed on its AI provider (the end's text
   * already says so, so only Continue shows): nobody stopped it.
   */
  limit?: "steps" | "stuck" | "failed";
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const meId = useMeId();
  const dir = useDirectory();
  const org = useOrg().org;
  const { colors: c, shadows } = useTheme();
  const [busy, setBusy] = useState(false);
  // The stop's notice, when it is in this conversation: who stopped it, the reason, its time.
  const stop = useStoppedRun(limit ? null : runId);
  // Continued here or on another device (`run.continued`), or already in the message's meta.
  const continued = useContinuedRun(m.id) ?? stopped.continuedRunId;
  const byMe = Boolean(meId) && (stop?.notice.byUserId || stopped.byUserId) === meId;
  // Without a notice and a name for whoever stopped it, or nobody did: the words the reply alone can say.
  const fallback = limit
    ? limit === "failed"
      ? null
      : t(limit === "stuck" ? "mobile.chat.stopped.stuck" : "mobile.chat.stopped.limit")
    : byMe
      ? t("mobile.chat.stopped.byYou")
      : stopped.byUserId && dir.nameOf({ type: "person", id: stopped.byUserId })
        ? t("mobile.chat.stopped.by", { name: dir.nameOf({ type: "person", id: stopped.byUserId }) })
        : t("mobile.chat.stopped.plain");
  const owner = m.author.id ? dir.agentById.get(m.author.id)?.ownerUserId : null;
  const loaded = [
    ...(qc.getQueryData<Message[]>(keys.messages(orgId, m.channelId)) ?? []),
    ...((m.threadId && qc.getQueryData<Message[]>(keys.thread(orgId, m.channelId, m.threadId))) || []),
  ];
  // Same people who may stop it (the server checks again): an admin, the agent's owner, or who asked.
  const may =
    byMe ||
    mayStopRun(
      { agentId: m.author.id ?? "", threadId: m.threadId ?? m.id, triggerMessageId: null },
      { meId, manageAgents: can(org, "manage_agents"), agentOwnerId: owner, messages: loaded },
    );
  const open = may && !continued && !busy;
  const onContinue = () => {
    setBusy(true);
    api.agents
      .continueRun(orgId, runId)
      .then(({ runId: newRunId }) => cacheContinued(qc, orgId, m.channelId, m.id, newRunId))
      .catch((err: unknown) => {
        setBusy(false);
        // Refused for a reason it can say (already continued, the agent busy here, not allowed): say it.
        // The event or a refetch hides the button when it has no job left.
        const code = errorCode(err);
        toast({
          title: code && CONTINUE_ERRORS.has(code) ? errorText(t, err) : t("mobile.chat.stopped.failed"),
          icon: "x",
        });
      });
  };
  if (fallback === null) {
    // Its text already says why (its long work's provider failed): Continue alone, nothing to say.
    if (!open) return null;
    return (
      <View style={styles.stopped}>
        <PressScale
          onPress={onContinue}
          accessibilityRole="button"
          // 26 points tall in the line: the slop gives it the 44 a finger needs.
          hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
          style={[styles.continue, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
        >
          <View style={styles.continueIn}>
            <Icon name="play" size={12} color={c.ink} />
            <Text variant="caption" tone="ink" style={styles.medium} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {t("mobile.chat.stopped.continue")}
            </Text>
          </View>
        </PressScale>
      </View>
    );
  }
  const agentName = dir.nameOf(m.author) || t("channel.unknownAgent");
  return (
    <View style={styles.stopped}>
      <StopPill
        agent={agentName}
        notice={stop?.notice}
        at={stop?.message.createdAt}
        byUserId={limit ? null : stopped.byUserId}
        fallback={fallback}
        cont={
          !continued && (open || busy) ? (
            <EventPillAction
              key="continue"
              lead="play"
              label={t("mobile.chat.stopped.continue")}
              loading={busy}
              onPress={onContinue}
            />
          ) : null
        }
      />
    </View>
  );
}

/** The person's pick sent from a choice card (ADR 0124): a check and what they picked. */
function ChoiceReply({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={styles.choiceReply}>
      <LineIcon name="check" size={13} color={c.muted} variant="footnote" />
      <Text variant="footnote" tone="ink" style={[styles.medium, styles.shrink]}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A small neutral chip next to the name ("Lembrete", "Rotina «Bom dia»"): icon, no colored dot. With
 * `onPress` it opens what it stands for (the routine a message answers).
 */
function Tag({
  icon,
  lead,
  label,
  onPress,
  hint,
}: {
  icon: "bell" | "clock" | "sparkle";
  /** In place of the icon (an app's mark). */
  lead?: ReactNode;
  label: string;
  onPress?: () => void;
  hint?: string;
}) {
  const c = useColors();
  const chip = (
    <View style={[styles.tag, { backgroundColor: c.sunken }]} accessibilityHint={onPress ? undefined : hint}>
      {lead ?? <Icon name={icon} size={12} color={c.muted} />}
      <Text variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return chip;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityHint={hint}
      hitSlop={NAME_LINE_SLOP}
      style={({ pressed }) => [styles.tagPress, pressed && styles.pressedDim]}
    >
      {chip}
    </Pressable>
  );
}

/** On a card this agent posted while answering another agent's question: "ajudando o Theo · Ver conversa". */
function HelpingTag({ consultation: c, channelId }: { consultation: RunConsultation; channelId: string }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const from = agentGrammar(dir.agentById.get(c.agentId)?.name ?? t("mobile.chat.someone"));
  return (
    <>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
        {withAgentFaces(
          t("chat.consultPanel.helping", { name: from.name, context: from.context }),
          [{ name: from.name, agentId: c.agentId }],
          12,
        )}
      </Text>
      <Pressable
        onPress={() => router.push(consultationHref(c.id, channelId))}
        accessibilityRole="button"
        hitSlop={NAME_LINE_SLOP}
        style={({ pressed }) => [styles.shrink, pressed && styles.pressedDim]}
      >
        <Text variant="caption" tone="muted" numberOfLines={1} style={styles.medium}>
          {t("chat.consultPanel.see")}
        </Text>
      </Pressable>
    </>
  );
}

/** Pinned: a small neutral pin (no colored dot). */
function PinMark() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.pin} accessible accessibilityLabel={t("mobile.pins.mark")}>
      <Icon name="pin" size={12} color={c.faint} />
    </View>
  );
}

/** People's pills show a count (mine outlined); an agent that reacted shows its face. */
function Reactions({ message: m, meId, end }: { message: Message; meId: string | null; end: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { colors: c, reducedMotion: reduced } = useTheme();
  const cached = useReactions(orgId, m.id, false);
  const toggle = useToggleReaction(orgId, m.id);
  const pills = reactionPills(cached.data ?? m.reactions, meId);
  const shown = pills.length > 0 && !m.local;
  // A pill someone adds or takes back while the row shows fades and the others slide aside; those there when the row
  // mounts (scrolling to it) just show, and none lingers when the row goes.
  const motion = reduced ? {} : { entering: PILL_IN, exiting: PILL_OUT, layout: PILL_MOVE };
  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      {shown ? (
        <View style={[styles.reacts, end && styles.meEnd]}>
          {pills.flatMap((p) => [
            ...(p.people > 0
              ? [
                  <Animated.View key={`p:${p.reaction}`} {...motion}>
                    {/* The press's own light tap is the toggle's haptic. */}
                    <PressScale
                      onPress={() => toggle.mutate({ reaction: p.reaction, on: !p.mine })}
                      fill={false}
                      // 30 drawn, 44 to the finger; not sideways, where the next pill is 6 away.
                      hitSlop={REACT_SLOP}
                      accessibilityRole="button"
                      accessibilityLabel={t("mobile.chat.reactionLabel", { emoji: p.emoji, count: p.people })}
                      accessibilityState={{ selected: p.mine }}
                      contentStyle={[styles.react, { backgroundColor: c.sunken }, p.mine && { borderColor: c.ink2 }]}
                    >
                      <Text variant="subhead" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                        {p.emoji}
                      </Text>
                      <Count value={p.people} size={14} />
                    </PressScale>
                  </Animated.View>,
                ]
              : []),
            ...p.agentIds.map((agentId) => (
              <Animated.View
                key={`a:${p.reaction}:${agentId}`}
                {...motion}
                accessible
                accessibilityLabel={t("mobile.chat.agentReacted", { emoji: p.emoji })}
                style={[styles.react, { backgroundColor: c.sunken }]}
              >
                <Text variant="subhead" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                  {p.emoji}
                </Text>
                <AgentFace agentId={agentId} size={16} live={false} />
              </Animated.View>
            )),
          ])}
        </View>
      ) : null}
    </LayoutAnimationConfig>
  );
}

const REACT_SLOP = { top: 7, bottom: 7 };
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** A pill arriving: from 0.95 and clear to whole, in 150 ms (never from nothing). */
const PILL_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.95 }] },
    animations: {
      opacity: withTiming(1, { duration: 150, easing: EASE_OUT }),
      transform: [{ scale: withTiming(1, { duration: 150, easing: EASE_OUT }) }],
    },
  };
};
const PILL_OUT = FadeOut.duration(120);
const PILL_MOVE = LinearTransition.duration(200);
/** The emoji at the finger: in at once, rising a little as it leaves. */
const POP_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 0 }, { scale: 0.95 }] },
    animations: {
      opacity: withTiming(1, { duration: 120, easing: EASE_OUT }),
      transform: [
        { translateY: withTiming(-10, { duration: 300, easing: EASE_OUT }) },
        { scale: withTiming(1, { duration: 150, easing: EASE_OUT }) },
      ],
    },
  };
};
const POP_OUT = FadeOut.duration(160);

/** The turn's last corner, cut as a card's is, on the side my bubble stands. */
const BUBBLE_CUT = 6;

/** A row under the quote it answers: they read as one. */
const QUOTE_GAP = 2;
/** A pin's caption stays on its message, as a name on its words. */
const PIN_GAP = 2;

/** The bubble's corners by its place in a run of my rows: the sides it shares with its neighbours square off. */
const BUBBLE_RUN: Record<RunPosition, { borderTopRightRadius?: number; borderBottomRightRadius?: number }> = {
  solo: { borderBottomRightRadius: BUBBLE_CUT },
  start: { borderBottomRightRadius: 6 },
  mid: { borderTopRightRadius: 6, borderBottomRightRadius: 6 },
  end: { borderTopRightRadius: 6, borderBottomRightRadius: BUBBLE_CUT },
};

/** Anyone else's bubble in `bubbles`: the same, on the left. */
const OTHER_RUN: Record<RunPosition, { borderTopLeftRadius?: number; borderBottomLeftRadius?: number }> = {
  solo: {},
  start: { borderBottomLeftRadius: 6 },
  mid: { borderTopLeftRadius: 6, borderBottomLeftRadius: 6 },
  end: { borderTopLeftRadius: 6 },
};

/** Words and time on my solid bubble. */
const ON_SOLID = "#ffffff";

const styles = StyleSheet.create({
  // Readable turns: more room between turns, a quieter name and time.
  msg: {
    flexDirection: "row",
    gap: MSG_GAP,
    paddingLeft: MSG_INSET,
    paddingRight: 16,
  },
  replied: { marginTop: 0, paddingTop: QUOTE_GAP },
  avslot: { width: MSG_AVATAR, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  // A long pick wraps: the check stays on its first line.
  choiceReply: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 },
  // Wraps on a narrow phone: a routine's tag and "Ver relatório" go to the next line instead of off the edge.
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 4, marginBottom: 4 },
  // A person's name line keeps room at its end for the receipt's mark, with or without one, so a mark that comes
  // never wraps the line.
  whoRoom: { paddingRight: 40 },
  whoMark: { position: "absolute", top: 0, right: 0, height: 19, justifyContent: "center" },
  whoTight: { marginBottom: 0 },
  // The time ends the words' line when it fits; a longer text pushes it to a line of its own, at the bubble's end.
  bubbleLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "flex-end",
    columnGap: 8,
  },
  bubbleEnd: { alignSelf: "flex-end" },
  stamp: { flexDirection: "row", alignItems: "center", gap: 4, height: 16, marginLeft: "auto" },
  compactLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 1 },
  me: { paddingLeft: 64, paddingRight: 16, alignItems: "flex-end" },
  meParts: { alignSelf: "stretch" },
  meTime: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, height: 16 },
  mePressed: { opacity: 0.7 },
  meEnd: { alignSelf: "flex-end" },
  bubble: {
    maxWidth: "100%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  meFiles: { alignSelf: "stretch" },
  meStatus: { textAlign: "right" },
  status: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 18 },
  statusEnd: { alignSelf: "flex-end" },
  // The stop's pill (or Continue alone) under the reply's words; the body sets its top.
  stopped: { alignItems: "flex-start" },
  continue: {
    minHeight: 26,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  continueIn: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 8, paddingRight: 10 },
  medium: { fontWeight: "600" },
  talkMore: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    minHeight: 28,
  },
  pressedDim: { opacity: 0.6 },
  shrink: { flexShrink: 1 },
  // The chip's own shrink only works if what holds it can shrink too (a long routine name ends in "…").
  tagPress: { flexShrink: 1, maxWidth: "100%", alignSelf: "center" },
  pin: { alignSelf: "center" },
  // The routine report a message answers, unfolded under its name (like the notice line's text).
  report: { marginTop: 2, paddingLeft: 10, borderLeftWidth: 2 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "center",
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  pinLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  reacts: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  // The thumbs up where the finger was, over the row.
  pop: { position: "absolute", width: POP, height: POP, alignItems: "center", justifyContent: "center" },
  popEmoji: { fontSize: 22, lineHeight: 26 },
  hint: { marginTop: 4 },
  // The outline is always there (clear unless it is mine), so a pill keeps its size when I add or take mine.
  react: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: "transparent",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});

/** Taps on the name line's small words and chips (16 to 20 points tall) reach 44 points without spreading them. */
const NAME_LINE_SLOP = { top: 14, bottom: 14, left: 6, right: 6 };
