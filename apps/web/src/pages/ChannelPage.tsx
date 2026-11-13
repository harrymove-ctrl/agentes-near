// Not compiled by React Compiler: views here read the live store and refs while rendering (the rows'
// memoization is written by hand).
"use no memo";

import type {
  Agent,
  AgentQuestion,
  Approval,
  ArtifactRef,
  Channel,
  HeldPlace,
  Member,
  MemoryUpdate,
  MessageMedia,
  Message as MessageType,
  ReplyRef,
  RunConsultation,
  ScreenKind,
  SecretRequest,
  ThreadInfo,
} from "@agenteschat/client";
import {
  ApiError,
  agentStateOfRun,
  browserHandoffOf,
  browserTrailOf,
  type ConnectionStatus,
  consultsIn,
  desktopTrailOf,
  heldRowsIn,
  inMainTimeline,
  isQuiet,
  isScreenTool,
  keys,
  type LiveRun,
  MESSAGES_PAGE,
  OPEN_THREAD,
  QUIET_AFTER_MS,
  runsInChannel,
  type StreamsState,
  sendHelpers,
  typingIn,
  useAddChannelMember,
  useAiStatus,
  useApproval,
  useApprovals,
  useCardApprovals,
  useChannelCategories,
  useChannelMembers,
  useChannels,
  useChannelThreads,
  useCreateMission,
  useDmReads,
  useDms,
  useHeldPlaces,
  useJoinChannel,
  useMarkChannelRead,
  useMarkThreadRead,
  useMessages,
  useMissionControl,
  useModels,
  usePlaceChannel,
  usePostMessage,
  useRoster,
  useSendVoice,
  useSettings,
  usesBrowser,
  useTaskManager,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
  useThreadRange,
  useUpdateChannel,
  useWaiting,
  useWikiTree,
} from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import { barElapsed, barEntries, entriesOffScreen, runElapsed, waitsForWords } from "@agenteschat/client/lib/activity";
import type { AgentTab } from "@agenteschat/client/lib/agent-edit";
import { foldTalk, TALK_LINE_CHARS, talksToAgent } from "@agenteschat/client/lib/agent-talk";
import { looksLikeApiKey } from "@agenteschat/client/lib/api-key-text";
import { approvalCardItems, asOfNow, cardDeadline } from "@agenteschat/client/lib/approval-card";
import { artifactRefs } from "@agenteschat/client/lib/artifacts";
import { canTalk, unavailableNotice } from "@agenteschat/client/lib/audience";
import { accessInput, accessOf, accessValid, type ChannelAccess } from "@agenteschat/client/lib/channel-access";
import { channelRefsOf } from "@agenteschat/client/lib/channel-refs";
import {
  entersWithMotion,
  greetingSuggestions,
  isScrollUpKey,
  messageUsage,
  nearBottom,
  type RunPosition,
  runPosition,
  screenAboveEnd,
  usageLine,
} from "@agenteschat/client/lib/chat";
import { firstUnreadId, opensAtLastRead } from "@agenteschat/client/lib/chat-look";
import { choiceReplyLine } from "@agenteschat/client/lib/choices";
import { draftKeyOf } from "@agenteschat/client/lib/composer-drafts";
import { consultsForLine } from "@agenteschat/client/lib/consult-group";
import { consultationsOf } from "@agenteschat/client/lib/consultations";
import { deviceWaitOf } from "@agenteschat/client/lib/devices";
import { clearDraft, peekDraft } from "@agenteschat/client/lib/drafts";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { errorCode, errorText, restrictionLine, runErrorText, runFailureLine } from "@agenteschat/client/lib/errors";
import { everyoneWord, isEveryoneMention, mentionsReader, offersEveryone } from "@agenteschat/client/lib/everyone";
import { fileIcon, fitsUpload, formatBytes, MAX_UPLOAD_MB, previewKind } from "@agenteschat/client/lib/files";
import { dayLabel, formatFullDate, formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { issueTakenOf, issueWorkOf, taskConversationOf } from "@agenteschat/client/lib/issues";
import { workAnchorBody, workContinuable, workIsOver } from "@agenteschat/client/lib/long-work";
import { supersededBrainNotices } from "@agenteschat/client/lib/machine-outages";
import { hasWideBlock, plainLine } from "@agenteschat/client/lib/markdown";
import { isMediaAfterReply, isMediaAlone, messageMediaOf, quoteText, textOrMedia } from "@agenteschat/client/lib/media";
import { serverBody } from "@agenteschat/client/lib/message-body";
import {
  isOpenMission,
  missionCommandOf,
  missionLinkOf,
  missionPlanChangeOf,
  missionPlanOf,
  missionReportOf,
  missionSetupOf,
  missionSuggestionOf,
  parseMissionCommand,
  taskNoticeOf,
} from "@agenteschat/client/lib/missions";
import { noAiCardOf } from "@agenteschat/client/lib/no-ai";
import { isTalkerReply, noticeOf, routineReportText, talkerWaited } from "@agenteschat/client/lib/notices";
import { brainUnavailableOf, isOfflineNotice } from "@agenteschat/client/lib/outages";
import { can, leavesChannel, makesAgents, managesChannel, setsAutoReply } from "@agenteschat/client/lib/permissions";
import { reachHandoffs } from "@agenteschat/client/lib/reach";
import { localMeta, replyOf } from "@agenteschat/client/lib/reply";
import { isReminderMessage, reminderBody, routineReplyOf } from "@agenteschat/client/lib/routines";
import { picksForMe, replyAloneKey } from "@agenteschat/client/lib/routing";
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { hiddenCount, tasksOf, todayStart } from "@agenteschat/client/lib/task-manager";
import { contextMarks, hiddenByThreads, rangeCandidates, threadStartOf } from "@agenteschat/client/lib/threads";
import { buildTimeline, lastPostedId, mergeTimeline, type TimelineItem } from "@agenteschat/client/lib/timeline";
import { usageWaitOf } from "@agenteschat/client/lib/usage-pause";
import { appVia } from "@agenteschat/client/lib/via";
import { voiceOf } from "@agenteschat/client/lib/voice";
import { barStep, showsActivity, splitCanceled } from "@agenteschat/client/lib/work";
import {
  AffixInput,
  Avatar,
  Button,
  Composer,
  type ComposerCommand,
  ComposerFile,
  type ComposerFormatLabels,
  type ComposerVoice,
  cx,
  DayDivider,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  EmptyState,
  EventPillAction,
  Field,
  FORMAT_KINDS,
  type FormatKind,
  Icon,
  type IconName,
  Input,
  isIdHandle,
  Kbd,
  Locked,
  Mention,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  Message,
  MessageLookContext,
  MessageText,
  PixelSpinner,
  SavedNote,
  Skeleton,
  SkeletonConversationRows,
  SkeletonGroup,
  Spinner,
  skeletonOnScreen,
  type VoiceNotice,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useRouter } from "@tanstack/react-router";
import {
  Children,
  createContext,
  Fragment,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { tokenizeBody } from "@/chat/body";
import { ChatMedia } from "@/chat/ChatMedia";
import { ChatVoice } from "@/chat/ChatVoice";
import { useConversationLook } from "@/chat/look";
import { MessageBody } from "@/chat/MessageBody";
import { useBrowserOffline } from "@/chat/offline";
import { readingLanding } from "@/chat/reading";
import {
  blockRowByRun,
  nextSlots,
  type RunSlot,
  rowShows,
  SLOT_HOLD_MS,
  sameSlots,
  waitingLast,
} from "@/chat/run-slots";
import { dividerIsFar, earlierKey, firstNewKey, landedKey, pillParts, unseenOf } from "@/chat/unseen";
import { ActionCard } from "@/components/ActionCard";
import { AgentActionReceipts } from "@/components/AgentActions";
import { ActorAvatar, AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { AgentPanel } from "@/components/AgentPanel";
import { ApprovalAsk, ApprovalGroupAsk } from "@/components/ApprovalAsk";
import { InlineApproval } from "@/components/ApprovalItem";
import { AgentPanelContext, AgentPanelShownContext, useOpenAgentPanel } from "@/components/agent-panel-context";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ImageSet } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { MessageWorkLine } from "@/components/BackgroundWork";
import { HeldBrowserCard, RunBrowserCard, useHeldTakeover } from "@/components/browser/BrowserCard";
import { BrowserHandoffCard } from "@/components/browser/BrowserHandoffCard";
import { BrowserTrailCard } from "@/components/browser/BrowserTrailCard";
import { requestBrowserCard } from "@/components/browser/open";
import { CategorySelect } from "@/components/ChannelCategoryDialogs";
import { ChannelHeader } from "@/components/ChannelHeader";
import { ChannelPermissions } from "@/components/ChannelPermissions";
import { ChannelPinnedBar } from "@/components/ChannelPins";
import { InlineProposal, MemoryChangeCard, QuestionCard, SecretCard } from "@/components/ChatCards";
import {
  AppViaTag,
  NoticeLine,
  RoutineReport,
  RoutineTag,
  SpeedFallbackLine,
  StopPill,
  StopsProvider,
  stopsOf,
  UnshownLine,
  useStopNotice,
} from "@/components/ChatNotices";
import { QueueWaitTurns, useAgentsMachineId } from "@/components/ComputerQueue";
import { ConsultationPanel } from "@/components/ConsultationPanel";
import {
  ConsultAnswerLine,
  type ConsultGroups,
  ConsultGroupsProvider,
  ConsultHelpingTag,
  ConsultPairRow,
  useConsultGroups,
  useReplyConsults,
} from "@/components/ConsultGroup";
import { CorrectionAsk } from "@/components/CorrectionAsk";
import { type ChannelActions, ChannelActionsContext, useChannelActions } from "@/components/channel-actions";
import { DatePill, type DatePillHandle } from "@/components/DatePill";
import { DeleteChannelDialog } from "@/components/DeleteChannelDialog";
import { MenuEntries } from "@/components/DesktopMenus";
import { DeviceWaitCard } from "@/components/devices/DeviceWaitCard";
import { useArchiveChannelWithUndo } from "@/components/entity-menus";
import { FeedbackOfferRow } from "@/components/FeedbackOffer";
import { InPlaceProvider } from "@/components/InPlace";
import { HandedTaskChips, IssueTakenLine, IssueWorkCard } from "@/components/IssueWork";
import { ArrivalCard, useArrival } from "@/components/invite/Arrival";
import { InviteOfferRow, useInviteDialog, useInviteOffer } from "@/components/invite/InviteDialog";
import { useLeaveChannelWithUndo } from "@/components/LeaveChannelDialog";
import { useUploadFailed } from "@/components/Limits";
import { LiveCodeToggle, type SteerNote } from "@/components/LiveCode";
import { ErrorState, LoadingConversation } from "@/components/Loading";
import { AwayPill, WaitingCard } from "@/components/MachineOutages";
import { useMediaTabs } from "@/components/MediaPicker";
import { MemberPickerRows, memberOf, type PickKey, useMemberRows } from "@/components/MemberPicker";
import { MessageFeedback } from "@/components/MessageFeedback";
import { MessageMoreMenu, PersonMessageActions, ReplyButton, useMessageMenu } from "@/components/MessageMore";
import { MessageReceipts, SeenMark } from "@/components/MessageReceipts";
import { MembersColumn, MembersSheet } from "@/components/members/MembersColumn";
import { MissionPanelProvider } from "@/components/missions/MissionBits";
import {
  AutoApprovedLine,
  groupAutoApproved,
  MissionDecisionCard,
  MissionDeliveryCard,
  MissionEphemeral,
  MissionLinkCard,
  MissionPlanCard,
  MissionPlanChangeLine,
  MissionReportExtras,
  MissionReviewCard,
  MissionSetupCard,
  MissionStartLink,
  MissionSuggestionBar,
  TaskNoticeLine,
} from "@/components/missions/MissionCards";
import { MissionCommandCard } from "@/components/missions/MissionCommandCard";
import { NewMissionDialog } from "@/components/missions/MissionDialogs";
import { NavToggle } from "@/components/NavDrawer";
import { CHANNEL_NAME, ChannelAccessChoice, toChannelName } from "@/components/NewChannelDialog";
import { FailedRunFix, KeyGuardDialog, NoAiBanner, NoAiCard, useNoAiAutoOpen } from "@/components/NoAi";
import { useNewAgent } from "@/components/new-agent/NewAgentDialog";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { AuthorStatus } from "@/components/Presence";
import { ProfileTrigger } from "@/components/ProfileCard";
import { ReachLines } from "@/components/ReachLines";
import { MessageReactions, useEmojiLabels } from "@/components/Reactions";
import {
  type AskRegistry,
  AskRegistryProvider,
  createAskRegistry,
  type PendingAsk,
  sameAsk,
  showRequest,
  useExpired,
  WaitMark,
} from "@/components/RequestCard";
import { SidePanel } from "@/components/SidePanel";
import { ActivitySky, ChannelWelcome, colorOf } from "@/components/Sky";
import { isStoppable, StopButton, useContinueRun, useStopRun, useWasContinued } from "@/components/StopRun";
import { SearchResultsPanel } from "@/components/search/SearchResultsPanel";
import { TeamChecks } from "@/components/TeamChecks";
import { ReplyChips } from "@/components/TeamPlan";
import { ToLatest } from "@/components/ToLatest";
import { LiveTools, SavedTools } from "@/components/ToolCalls";
import { AgentTasksPanel } from "@/components/tasks/AgentTasksPanel";
import { AgentTasksContext } from "@/components/tasks/agent-tasks-context";
import { RangeBar, RangeRows, useRangeAdjust } from "@/components/threads/RangeSelect";
import {
  ArchivedThreadsNote,
  ChannelThreadsContext,
  type ChannelThreadsView,
  ClosedThreadLine,
  ThreadReplyLine,
  ThreadStartLine,
  useChannelThreadsView,
} from "@/components/threads/ThreadLines";
import { UsageWaitCancel, UsageWaitClosed } from "@/components/UsagePauseCard";
import { PushAskContext, PushAskInline, usePushAsk } from "@/components/WebPush";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { BarAlsoTyping, BarPhrase, BarStep, ConsultClock, WorkingStack } from "@/components/WorkingLine";
import { useChannelSearch } from "@/hooks/useChannelSearch";
import { useComposerDraft } from "@/hooks/useComposerDraft";
import { useDirectory } from "@/hooks/useDirectory";
import { useDmSidebar, useMembersColumn } from "@/hooks/useMembersColumn";
import { useMentionSearch } from "@/hooks/useMentionSearch";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useHeaderSearch } from "@/hooks/useWorkspaceSearch";
import { TYPED_VALUES } from "@/i18n";
import { onAgentPanel, takeAgentPanel } from "@/lib/agent-panel-ask";
import { onChannelDetails, takeChannelDetails } from "@/lib/channel-details";
import { selectingIn } from "@/lib/context-menu";
import { desktopPlatform, useDocumentTitle } from "@/lib/desktop";
import { holdOnScreen } from "@/lib/island";
import { typingInField } from "@/lib/keys";
import { lookOf } from "@/lib/look";
import { threadSearch, useThreadPanel } from "@/lib/open-param";
import { reportPainted } from "@/lib/perf";
import { useToast } from "@/lib/toast";
import {
  reconcileChannelRuns,
  useChannelRealtime,
  useConnectionStatus,
  useDismissRun,
  useLive,
  useLiveStore,
  useStreams,
  useTypingSender,
} from "@/realtime/context";
import { ThreadPage } from "./ThreadPage";

/** One clock for every "· 12 s" on screen: the block and the card above the box never differ by a second. */
const secondClock = (() => {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      subs.add(fn);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const f of subs) f();
        }, 1000);
      }
      return () => {
        subs.delete(fn);
        if (subs.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    get: () => now,
  };
})();
const still = () => () => {};
/** The shared clock while `active` (else it holds still). */
const useSecond = (active: boolean) => useSyncExternalStore(active ? secondClock.subscribe : still, secondClock.get);

/** Live statuses of a run still at work on its conversation (a new message steers into it). */
const WORKING: ReadonlySet<string> = new Set(["thinking", "queued", "running", "waiting_approval"]);

/** The sidebar of a DM with an agent, as its header's toggle reads it. */
export interface DmSideControl {
  open: boolean;
  /** It sits beside the chat (not over it, not given up to a thread or the agent's page). */
  docked: boolean;
  toggle: () => void;
}

/** Header and empty state of a channel, or of a DM (same layout). */
export interface ChannelChrome {
  /** A page's own header; a function gets the header search's way into its results and the sidebar (a DM's). */
  header?: ReactNode | ((h: { onSearch: () => void; side: DmSideControl | null }) => ReactNode);
  emptyText?: string;
  /** Composer label/placeholder target, e.g. "Ada" instead of "#eng". */
  composerTarget?: string;
  /** A DM with this agent: it answers every message (optimistic "pensando…" is allowed). */
  dmAgentId?: string;
  /** A DM with this person: their face on my latest message once they read it. */
  dmPersonId?: string;
  /** The agent won't answer me: the composer is off and says why ("O Theo só responde a Walter."). */
  locked?: string;
  /** Beside `locked`: a way in (who manages agents lets themselves talk to it). */
  lockedAction?: ReactNode;
  /** Empty conversation: "Diga oi para o Theo". */
  emptyTitle?: string;
  /** Empty conversation: first messages to pick (they go to the composer). */
  suggestions?: string[];
  /** Above the messages (a thread's origin and context block). */
  top?: ReactNode;
  /**
   * Always at the conversation's top, in place of its empty state and of the no-AI banner (the right hand's greeting
   * and first cards, ADR 0137, which say it themselves).
   */
  intro?: ReactNode;
  /** The composer's label and placeholder ("Responder na thread"). */
  composerLabel?: string;
  /** In place of the composer (an archived thread's read-only note). */
  composerReplacement?: ReactNode;
  /** Under the composer (a mission someone only reads: "para pedir algo, peça para participar"). */
  composerNote?: ReactNode;
  /** A thread in the panel beside its channel: a section, not the page's main. */
  panel?: boolean;
  /** A thread view where a person's reply makes it a "Responder" thread (`openThread` on the post). */
  openThread?: boolean;
  /**
   * A task's conversation (ADR 0145): "@" offers the whole workspace as one list (an agent that sees the task joins
   * it when mentioned), and the root, which stands for the task, isn't drawn.
   */
  task?: boolean;
}

const sameRuns = (a: LiveRun[], b: LiveRun[]) => a.length === b.length && a.every((r, i) => r === b[i]);
const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((r, i) => r === b[i]);

/** Going to a message: how many older pages to look through (the server's largest), and how long it stays lit. */
const FOCUS_MAX_PAGES = 25;
const FOCUS_PAGE = 200;
const HIGHLIGHT_MS = 2400;
/** A scroll within this long after a wheel/touch/key/pointer counts as the person's. */
const GESTURE_MS = 1500;
/**
 * Scrolled up but idle this long (no wheel/touch/key/pointer on the list), or away from the window:
 * a new message brings the list to it instead of waiting behind the pill.
 */
const IDLE_CATCH_UP_MS = 20_000;
/** Older messages per scroll-up page. */
const OLDER_PAGE = 50;
/** Older pages a channel already loaded, and whether there are no more. */
type OlderPages = { pages: MessageType[]; done: boolean };
/** Same limit as the server (`MAX_MESSAGE_ATTACHMENTS`). */
const MAX_ATTACHMENTS = 10;

/** A file picked for the next message: uploading, uploaded (with its Drive ref) or failed. */
interface PendingFile {
  key: string;
  name: string;
  icon: IconName;
  size: number;
  /** An image's local thumbnail (an object URL, revoked when the file leaves the composer). */
  preview?: string;
  status: "uploading" | "done" | "failed";
  ref?: ArtifactRef;
}

/** Scrolls to a message on screen and gives it the soft highlight; false when it isn't there. */
function highlightMessage(scroller: HTMLElement | null, messageId: string) {
  const el = scroller?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!el) return false;
  el.scrollIntoView?.({ block: "center" });
  // Rows off screen are laid out at an estimated height until drawn (`content-visibility`): once the
  // ones around it are drawn, center it again. They are drawn by the next frame's rendering, which runs
  // after its animation callbacks, so the second centering waits for a task after that frame.
  requestAnimationFrame(() => setTimeout(() => el.scrollIntoView?.({ block: "center" }), 0));
  // A soft plate that fades (CSS; static with reduced motion).
  el.classList.add("ac-msg--focus");
  setTimeout(() => el.classList.remove("ac-msg--focus"), HIGHLIGHT_MS);
  return true;
}

/** "Respondendo a Ana" on top of the composer; its × or Esc drops it. Marked so Esc goes here before the panel. */
function QuoteBar({ name, onCancel }: { name: string; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="composer-quote" data-esc-layer="">
      <Icon name="reply" size={16} />
      <span className="composer-quote__who">{t("channel.replyingTo", { name })}</span>
      <button type="button" className="composer-reply__close" aria-label={t("channel.cancelReply")} onClick={onCancel}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The line above a reply: face, name and one line of what it answers; opens the original, or says it is gone. */
function QuotedMessage({ reply }: { reply: ReplyRef }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  // The directory's current name; the one saved with the quote when they are gone.
  const known =
    reply.author.type === "agent"
      ? dir.agentById.get(reply.author.id ?? "")?.name
      : dir.memberById.get(reply.author.id ?? "")?.name;
  const name = known || reply.authorName || dir.authorName(reply.author);
  // A quoted GIF or sticker has no words: its word stands for it (ADR 0091).
  const excerpt = quoteText(t, reply);
  if (reply.deleted) return <span className="msg-quote msg-quote--gone">{t("channel.quoteGone")}</span>;
  return (
    <button
      type="button"
      className="msg-quote"
      aria-label={t("channel.quoteOf", { name, excerpt })}
      onClick={() => {
        // In the channel's timeline a thread's reply isn't a row: it is in its thread. A thread view has no panel.
        if (reply.threadId && actions?.openThread) actions.openThread(reply.threadId, reply.messageId);
        else actions?.jumpTo?.(reply.messageId);
      }}
    >
      {reply.author.id ? (
        <ActorAvatar actor={{ type: reply.author.type, id: reply.author.id }} name={name} size="xs" />
      ) : null}
      <span className="msg-quote__who" aria-hidden="true">
        @{name}
      </span>
      <span className="msg-quote__excerpt" aria-hidden="true">
        {excerpt}
      </span>
    </button>
  );
}

/** A channel with real-time messages, streaming agent replies and inline approvals. */
export function ChannelPage({
  channelId,
  chrome,
  fallback,
  focusMessageId,
  adjustThreadId,
  thread,
}: {
  channelId: string;
  chrome?: ChannelChrome;
  /** "Ajustar trecho": the selection of this thread's range, in place of the timeline. */
  adjustThreadId?: string;
  /** Thread view: this thread's conversation (root and replies), with replies going to it. */
  thread?: ThreadInfo;
  /** Open at this message (a copied link): load around it, scroll to it and highlight it. */
  focusMessageId?: string;
  /** DMs may not be in the channel list: the page still works with this. */
  fallback?: Channel;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const router = useRouter();
  const channels = useChannels(org.id);
  const channel = channels.data?.find((c) => c.id === channelId) ?? fallback;
  // A DM's link (a message link copied there) names its channel: the DM's own page opens it, at the message.
  const dms = useDms(org.id);
  const dm = channel ? undefined : dms.data?.find((d) => d.channelId === channelId);
  // "#loja · Acme": the window's name in the app (Window menu, Mission Control), the tab's in a browser.
  useDocumentTitle(channel && !fallback && !thread ? `#${channel.name} · ${org.name}` : undefined);

  if (channels.isPending && !fallback) return <ChannelSkeleton />;
  if (dm) {
    const search = {
      ...threadSearch(router.state.location.search as Record<string, unknown>),
      ...(focusMessageId ? { m: focusMessageId } : {}),
    };
    return dm.with.type === "agent" ? (
      <Navigate
        to="/org/$orgId/dm/agent/$agentId"
        params={{ orgId: org.id, agentId: dm.with.id }}
        search={search}
        replace
      />
    ) : (
      <Navigate
        to="/org/$orgId/dm/person/$userId"
        params={{ orgId: org.id, userId: dm.with.id }}
        search={search}
        replace
      />
    );
  }
  if (!channel && dms.isPending) return <ChannelSkeleton />;
  if (!channel) {
    return (
      <main className="shell__main">
        <div className="page page--mid">
          <EmptyState icon="channel">{t("channel.notFound")}</EmptyState>
        </div>
      </main>
    );
  }
  return (
    // "Arquivos", "Ver plano", "Ver no arquivo": any mission card here opens the same files panel.
    <MissionPanelProvider>
      {/* A routine or a task an agent names here opens in its dialog over the conversation; leaving it closes it. */}
      <InPlaceProvider key={`${channel.id}:${thread?.id ?? ""}:${adjustThreadId ?? ""}`}>
        <ChannelView
          channel={channel}
          chrome={chrome}
          focusMessageId={focusMessageId}
          adjustThreadId={adjustThreadId}
          thread={thread}
        />
      </InPlaceProvider>
    </MissionPanelProvider>
  );
}

/**
 * The whole conversation loading (header, messages, composer) with the real layout, so nothing jumps when it
 * arrives: the header's one row (a thread's in the panel), the same message rows the conversation shows while its
 * messages load, and the composer's box at its resting height (its text line and its toolbar, no bar in it).
 */
export function ChannelSkeleton({
  thread,
  panel,
  dm,
}: {
  thread?: boolean;
  panel?: boolean;
  /** A DM's header: the face (an agent's square, a person's circle), the name and its line, the computer. */
  dm?: "agent" | "person";
} = {}) {
  const { t } = useTranslation();
  const Tag = panel ? "section" : "main";
  return (
    <Tag className={cx("shell__main shell__main--chat", panel && "thread-panel__chat")}>
      <SkeletonGroup label={t("common.loadingMessages")} className="channel__skeleton">
        {dm ? (
          <header className="channel__header">
            <NavToggle />
            <Skeleton shape={dm === "agent" ? "square" : "circle"} width={36} height={36} />
            <div className="thread-head__text">
              <span className="channel__skeleton-title">
                <Skeleton width={140} height={14} />
              </span>
              <span className="channel__skeleton-meta">
                <Skeleton width={220} height={10} />
              </span>
            </div>
            {dm === "agent" && <Skeleton shape="block" width={88} height={28} />}
          </header>
        ) : thread ? (
          // `ThreadHeader`: back to the channel (as a page), who, the title and its line, ⋯ (and, in the panel,
          // full screen and close).
          <header className={cx("channel__header thread-head", panel && "thread-head--panel")}>
            {!panel && (
              <>
                <NavToggle />
                <Skeleton shape="block" width={28} height={28} />
              </>
            )}
            <span className="thread-head__who">
              <Skeleton shape="circle" width={24} height={24} />
            </span>
            <div className="thread-head__text">
              <span className="channel__skeleton-title">
                <Skeleton width={180} height={14} />
              </span>
              <span className="channel__skeleton-meta">
                <Skeleton width={140} height={10} />
              </span>
            </div>
            {(panel ? [0, 1, 2] : [0]).map((i) => (
              <Skeleton key={i} shape="block" width={28} height={28} />
            ))}
          </header>
        ) : (
          // `ChannelHeader`'s rows: the # and the name on its line, the glyphs after them.
          <header className="channel__header">
            <NavToggle />
            <div className="ac-actline channel__line">
              <div className="channel__head-text">
                <span className="channel__title">
                  <span className="channel__skeleton-title">
                    <Skeleton shape="block" width={20} height={20} />
                  </span>
                  <span className="channel__skeleton-title">
                    <Skeleton width={140} height={14} />
                  </span>
                </span>
              </div>
              <div className="channel__acts">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} shape="block" width={20} height={20} />
                ))}
              </div>
            </div>
          </header>
        )}
        <div className="channel__messages">
          <div className="channel__spacer" aria-hidden="true" />
          <SkeletonConversationRows />
        </div>
        <div className="channel__composer">
          <div className="ac-composer channel__composer-skeleton" aria-hidden="true">
            <span className="channel__composer-skeleton-line" />
            <div className="ac-composer__tools">
              <Skeleton shape="block" className="channel__composer-skeleton-send" />
            </div>
          </div>
        </div>
      </SkeletonGroup>
    </Tag>
  );
}

function ChannelView({
  channel,
  chrome,
  focusMessageId,
  adjustThreadId,
  thread,
}: {
  channel: Channel;
  chrome?: ChannelChrome;
  focusMessageId?: string;
  adjustThreadId?: string;
  thread?: ThreadInfo;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const rightHandLook = useRightHandLook();
  const isMember = channel.isMember;
  // An administrator reads every channel without joining it (ADR 0151): only what needs being in it waits for Entrar.
  const readable = isMember || (!chrome && can(org, "administrator"));
  const members = useChannelMembers(org.id, channel.id, readable);
  const channelMessages = useMessages(org.id, channel.id, readable);
  // A DM with a person: their face on my latest message once they read it (live: `channel.read`).
  const reads = useDmReads(org.id, channel.id, Boolean(chrome?.dmPersonId) && isMember);
  const seenId = useMemo(
    () => (reads.data ? seenMessageId(channelMessages.data ?? [], me.user.id, reads.data) : null),
    [reads.data, channelMessages.data, me.user.id],
  );
  // Thread view: the thread's root and replies (the channel's page still holds my unsent replies).
  const threadMessages = useThreadMessages(org.id, thread && readable ? channel.id : undefined, thread?.id ?? "");
  const messages = thread ? threadMessages : channelMessages;
  // Our notifications ask, under the message it follows in the channel's own list (never a thread's, never read only).
  const topLevel = useMemo(() => channelMessages.data?.filter((m) => !m.threadId), [channelMessages.data]);
  const pushAsk = usePushAsk(thread || !isMember ? undefined : topLevel);
  // Read from the server (a thread's root the channel held stands in until then: its replies are still unknown).
  const serverRead = messages.isSuccess && !messages.isPlaceholderData;
  // The channel's threads: closed lines, context marks, markers (not in a thread view or while adjusting).
  const listsThreads = readable && !thread;
  const openThreads = useChannelThreads(org.id, channel.id, "all", listsThreads);
  const archivedThreads = useChannelThreads(org.id, channel.id, "archived", listsThreads);
  const threadList = useMemo(
    () => [...(openThreads.data?.threads ?? []), ...(archivedThreads.data?.threads ?? [])],
    [openThreads.data, archivedThreads.data],
  );
  // Live runs shown here: a thread view shows its own; the channel, those answering in the channel
  // (asked there). A thread's runs are in its panel; the channel shows its line. A "pensando…"
  // the app guessed hangs off the message sent: shown here when that message is in the channel.
  const topLevelIds = useMemo(
    () => new Set((channelMessages.data ?? []).flatMap((m) => (m.threadId ? [] : [m.id]))),
    [channelMessages.data],
  );
  const runVisible = useRef<(r: { threadId: string | null; provisional?: boolean }) => boolean>(() => true);
  runVisible.current = thread ? (r) => r.threadId === thread.id : (r) => inMainTimeline(r, topLevelIds);
  const scopedRuns = (s: StreamsState) => runsInChannel(s, channel.id).filter((r) => runVisible.current(r));
  const live = useLiveStore();
  const join = useJoinChannel(org.id, channel.id);
  // A newcomer's first #general greets them (ADR 0090), in the place of the day's greeting.
  const arrival = useArrival(channel);
  const arriving = arrival.show && !thread;
  const sendTyping = useTypingSender(channel.id, thread?.id);
  // ⌘K "Pedir a um agente" leaves the text for this DM's composer.
  const draftKey = chrome?.dmAgentId ? `agent:${chrome.dmAgentId}` : null;
  // What I typed and didn't send stays in this browser: switching conversations or reloading keeps it.
  const [draft, setDraft] = useComposerDraft(
    me.user.id,
    draftKeyOf(channel.id, thread?.id),
    draftKey ? peekDraft(draftKey) : undefined,
  );
  // A first task handed with a blank at its end ("…para este cliente:"): a hint to finish it, gone at the first key.
  const [handed] = useState(() => (draftKey ? peekDraft(draftKey) : undefined));
  const finishing = handed !== undefined && /:\s*$/.test(handed) && draft === handed;
  // Stopping is immediate, nothing asked (what it did stays, "Continuar" picks it up): the composer's
  // button when the box is empty, or Esc anywhere on the page (composer empty, nothing open).
  const { canStop: mayStop, stop: stopRun } = useStopRun();
  const stoppableKey = useStreams((s) =>
    scopedRuns(s)
      .filter((r) => isStoppable(r) && !r.stopping)
      .map((r) => r.runId)
      .join(" "),
  );
  /** The most recent run at work here (anyone writing chooses "Juntar" or "Parar e mandar" for it). */
  const busyTarget = stoppableKey
    ? scopedRuns(live.get().streams)
        .filter((r) => isStoppable(r) && !r.stopping)
        .at(-1)
    : undefined;
  /** The most recent run here that I may stop. */
  const stopTarget = stoppableKey
    ? scopedRuns(live.get().streams)
        .filter((r) => isStoppable(r) && !r.stopping && mayStop(r))
        .at(-1)
    : undefined;
  const draftRef = useRef("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || draftRef.current.trim()) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      // An Esc in another field (the search, a card's answer) is that field's: the composer stops agents on its own.
      if (typingInField(e.target)) return;
      // An Esc from a panel is that panel's, and one from the conversation beside a thread isn't the thread's.
      const inPanel = e.target instanceof Element && Boolean(e.target.closest(".thread-panel"));
      if (!stopTarget || inPanel !== Boolean(chrome?.panel)) return;
      e.preventDefault();
      stopRun(stopTarget);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // "Ir para" from another conversation's results: they stay open here.
  const headerSearch = useHeaderSearch();
  const [carried] = useState(() => {
    const search = headerSearch?.carry.current;
    return search?.channelId === channel.id && !thread ? search : null;
  });
  // The thread open in the panel beside the channel ("Responder", a thread's line); `reply`: to its composer.
  const [panel, setPanel] = useThreadPanel(!thread);
  // "Responder" in a thread view: the next message from here answers this one (`meta.replyTo`).
  const [quote, setQuote] = useState<MessageType | null>(null);
  // Before the panel's Esc, whose close the bar holds back (`data-esc-layer`), and before the composer's, which stops
  // an agent: spent here, they see it taken.
  useEffect(() => {
    if (!quote) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      // The composer's Esc lets go of the reply first; another field's (the search, a card's answer) is that field's.
      if (typingInField(e.target) && !(e.target as Element).closest('[id^="composer-"]')) return;
      e.preventDefault();
      setQuote(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [quote]);
  // The header search's results, in the same panel (one panel at a time; a thread a hit opened goes over them).
  const [searchOpen, setSearchOpen] = useState(Boolean(carried));
  // The thread a hit opened: it goes over the results, where any other thread takes their place.
  const hitThread = useRef(carried?.thread);
  const carry = headerSearch?.carry;
  useEffect(() => {
    if (!searchOpen || !carry) return;
    return () => {
      if (carry.current?.channelId === channel.id) carry.current = null;
    };
  }, [searchOpen, carry, channel.id]);
  // "Ver perfil" (a DM's header, the profile card): the agent's page in the same place, at a tab when a card asks
  // (its memory, at the item it names); one panel at a time. Its opener again closes it (`close`, counted, so unsaved
  // edits ask first).
  const [profile, setProfile] = useState<{ agentId: string; tab?: AgentTab; item?: string; close?: number } | null>(
    null,
  );
  // What had the focus when the profile opened: it gets it back when the panel closes.
  const profileOpener = useRef<HTMLElement | null>(null);
  const closeProfile = useCallback(() => {
    setProfile(null);
    const opener = profileOpener.current;
    profileOpener.current = null;
    // After the frame: a closing "Descartar e sair" dialog hands focus back when it unmounts, to a page that's gone.
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  }, []);
  // The conversation stays in use beside the page: what would take the panel's place asks first over unsaved edits.
  const profileKeeps = useCallback(() => {
    if (!document.querySelector(".thread-panel [data-dirty]")) return false;
    setProfile((open) => open && { ...open, close: (open.close ?? 0) + 1 });
    return true;
  }, []);
  // A thread the URL brings back (Back, Forward) takes the panel's place like one opened from here, unless unsaved
  // edits hold it.
  const panelId = panel?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new thread; the rest close around it
  useEffect(() => {
    if (!panelId || profileKeeps()) return;
    setProfile(null);
    setConsultId(null);
    if (panelId !== hitThread.current) setSearchOpen(false);
  }, [panelId]);
  // A question an agent asked another from here, opened from its line in the reply ("Theo ⇄ Iris"): one panel too.
  const [consultId, setConsultId] = useState<string | null>(null);
  // A DM with an agent: its tasks (ADR 0128), from the pill in the header; one panel too, any other one closes it.
  const [tasksOpen, setTasksOpen] = useState(false);
  useEffect(() => {
    if (panel || profile || consultId || searchOpen) setTasksOpen(false);
  }, [panel, profile, consultId, searchOpen]);
  const toggleTasks = useCallback(() => {
    if (profileKeeps()) return;
    setPanel(null);
    setProfile(null);
    setConsultId(null);
    setSearchOpen(false);
    setTasksOpen((open) => !open);
  }, [profileKeeps, setPanel]);
  const outerPanel = useOpenAgentPanel();
  const openAgentPanel = useCallback(
    (agentId: string, tab?: AgentTab, item?: string) => {
      if (profileKeeps()) return;
      setPanel(null);
      setSearchOpen(false);
      setConsultId(null);
      const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setProfile((open) => {
        if (open?.agentId === agentId && open.tab === tab && open.item === item)
          return { ...open, close: (open.close ?? 0) + 1 };
        profileOpener.current = from;
        return { agentId, tab, item };
      });
    },
    [profileKeeps, setPanel],
  );
  // A sidebar row's settings button, an agent's picture: its page beside this conversation, or beside its own once it
  // shows.
  const shownAgent = profile?.agentId;
  useEffect(() => {
    if (chrome?.panel) return;
    const open = () => {
      const ask = takeAgentPanel();
      if (ask && !(ask.keep && ask.agentId === shownAgent)) openAgentPanel(ask.agentId, ask.tab);
    };
    open();
    return onAgentPanel(open);
  }, [chrome?.panel, openAgentPanel, shownAgent]);
  // "Mudar algo" on a mission's plan: the next message goes to its executor ("Respondendo: Plano").
  const [missionReply, setMissionReply] = useState<{ missionId: string; label: string } | null>(null);
  // `/summary` and `/plan`: a card only I see, under the conversation.
  const [ephemeral, setEphemeral] = useState<{ kind: "summary" | "plan"; missionId: string } | null>(null);
  // `/mission` with several agents and none named: "Nova missão" with the goal filled in.
  const [missionDraft, setMissionDraft] = useState<string | null>(null);
  draftRef.current = draft;
  useEffect(() => {
    if (!draftKey) return;
    // Text left here is for the person to finish: the caret waits at its end.
    const box = composer.current;
    if (peekDraft(draftKey) && box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    clearDraft(draftKey);
  }, [draftKey]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const membersColumn = useMembersColumn();
  const dmSidebar = useDmSidebar();
  // Opened from a sidebar row's "Adicionar pessoas ou agentes": straight to adding, and closing that closes it all.
  const [addFirst, setAddFirst] = useState(false);
  // The members column's "Adicionar pessoa ou agente": the details' add flow alone, as from a sidebar row.
  const addsMembers = isMember && managesChannel(channel, me.user.id, org);
  const addMembers = () => {
    setAddFirst(true);
    setDetailsOpen(true);
  };
  // "Editar canal" from the sidebar's right click: the details open once this channel shows.
  useEffect(() => {
    if (chrome?.header) return;
    const open = () => {
      const ask = takeChannelDetails(channel.id);
      if (!ask) return;
      setAddFirst(ask === "add");
      setDetailsOpen(true);
    };
    open();
    return onChannelDetails(open);
  }, [channel.id, chrome?.header]);
  // An agent mentioned from outside the channel: offer to add it.
  const [offer, setOffer] = useState<string | null>(null);
  const mentionSearch = useMentionSearch(
    chrome?.task ? undefined : members.data,
    chrome?.dmAgentId || chrome?.dmPersonId ? "dm" : "channel",
    offersEveryone(org, Boolean(chrome?.dmAgentId || chrome?.dmPersonId)),
  );
  const channelSearch = useChannelSearch();
  const composer = useRef<HTMLTextAreaElement>(null);
  const emojiPicker = useEmojiLabels();
  const emojiLabels = useMemo(() => ({ ...emojiPicker, button: t("channel.emoji") }), [emojiPicker, t]);
  const formatLabels: ComposerFormatLabels = useMemo(
    () => ({
      ...(Object.fromEntries(FORMAT_KINDS.map((k) => [k, t(`composer.format.${k}`)])) as Record<FormatKind, string>),
      toolbar: t("composer.format.toolbar"),
      linkText: t("composer.format.linkText"),
    }),
    [t],
  );
  useChannelRealtime(org.id, channel.id, readable);
  useNoAiAutoOpen(channel.id, isMember);

  const channelAgents = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "agent")
        .map((m) => dir.agentById.get(m.id))
        .filter((a): a is Agent => Boolean(a)),
    [members.data, dir.agentById],
  );
  // What the channel suggests or picks for me goes to an agent that answers me (`canTalk`: who manages agents can't
  // talk to a locked one either), one people can read: a handle that is an id only when every agent's is.
  const queueMachine = useAgentsMachineId(useMemo(() => channelAgents.map((a) => a.id), [channelAgents]));
  const talkable = channelAgents.filter(canTalk);
  const suggestedAgent = talkable.find((a) => !isIdHandle(a.handle)) ?? talkable[0];
  const channelPeople = useMemo(
    () =>
      (members.data ?? [])
        .filter((m) => m.type === "person")
        .map((m) => dir.memberById.get(m.id))
        .filter((p): p is Member => Boolean(p)),
    [members.data, dir.memberById],
  );

  /** Agents of this channel the text mentions (instant "pensando…" before the server answers). */
  const mentioned = (body: string) =>
    tokenizeBody(body)
      .flatMap((tok) => (tok.type === "mention" ? [dir.agentByHandle.get(tok.handle.toLowerCase())] : []))
      .filter((a): a is Agent => Boolean(a && canTalk(a) && channelAgents.some((c) => c.id === a.id)))
      .map((a) => a.id);

  const toast = useToast();
  const qc = useQueryClient();
  const post = usePostMessage(org.id, channel.id, {
    me: { id: me.user.id },
    mentioned,
    // Optimistic "pensando…" only for an explicit @mention or an agent DM. Anything else is the
    // router's call: wait for `message.routed` / `agent.thinking` from the server.
    onOptimistic: (local) => {
      const agents = local.mentionedAgentIds.length
        ? local.mentionedAgentIds
        : chrome?.dmAgentId && !chrome.locked
          ? [chrome.dmAgentId]
          : [];
      // An agent already at work here takes the message into that work ("lê na próxima pausa"): the
      // server starts no second run, so no second "pensando…" (a DM: any of its runs here; a thread: there).
      const atWork = (agentId: string) =>
        Object.values(live.get().streams.runs).some(
          (r) =>
            !r.provisional &&
            r.agentId === agentId &&
            r.channelId === channel.id &&
            WORKING.has(r.status) &&
            (chrome?.dmAgentId ? true : Boolean(local.threadId) && r.threadId === local.threadId),
        );
      const fresh = agents.filter((id) => !atWork(id));
      if (fresh.length > 0) live.expect(channel.id, local.id, fresh, local.threadId ?? undefined);
      // No one guessed in a channel with agents: the router picks, and its `message.routed` always follows. The
      // clock at once, as its own `message.routing` says; a GIF or a sticker alone routes to nobody, so no clock.
      else if (agents.length === 0 && !chrome?.dmAgentId && channelAgents.length > 0 && !isMediaAlone(local))
        live.apply({ type: "message.routing", channelId: channel.id, messageId: local.id, step: "plan" });
    },
    onSent: (message, local) => live.retarget(local.id, message.id),
    // A thread archived meanwhile (`thread.archived`), GIFs or stickers turned off or a GIF gone (`message.media_*`):
    // say so in the person's language. Without a connection (or with the server restarting) it waits instead, "sai
    // quando a conexão voltar" (`useSendWaiting`).
    onFailed: (error) => {
      const code = errorCode(error);
      if (code?.startsWith("thread.") || code?.startsWith("message.media_") || code === "message.reply_not_found")
        toast.show(errorText(t, error), "error");
    },
  });
  const { send, retry } = sendHelpers(post);
  const sendVoice = useSendVoice(org.id, channel.id, {
    me: { id: me.user.id },
    onRefused: (error) =>
      toast.show(errorCode(error) === "voice_limit" ? t("voice.limit") : errorText(t, error), "error"),
  });
  const status = useConnectionStatus();

  const api = useApi();
  // Reading the channel marks it read: the sidebar's badges (channel and DM) clear at once. Only while the tab is
  // in view: an answer arriving in a tab left in the background is unread, and its notification pushes (ADR 0071).
  const markChannelRead = useMarkChannelRead(org.id).mutate;
  // On screen, this conversation raises no notice on the island (ADR 0071 §9): its messages already show here.
  const screenThread = thread?.id ?? null;
  useEffect(() => holdOnScreen({ channelId: channel.id, threadId: screenThread }), [channel.id, screenThread]);
  const lastId = lastPostedId(channelMessages.data);
  useEffect(() => {
    if (!isMember || !lastId) return;
    const mark = () => {
      if (document.visibilityState === "visible") markChannelRead(channel.id);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [markChannelRead, channel.id, isMember, lastId]);
  // A thread open in view: its replies are read (its unread and the Threads mark clear, on every device).
  const markThreadRead = useMarkThreadRead(org.id).mutate;
  const threadId = thread?.id;
  const lastReplyId = threadId && !threadMessages.isPlaceholderData ? lastPostedId(threadMessages.data) : undefined;
  useEffect(() => {
    if (!threadId || !isMember || !lastReplyId) return;
    const mark = () => {
      if (document.visibilityState === "visible") markThreadRead(threadId);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [markThreadRead, threadId, isMember, lastReplyId]);

  // The skeleton was on screen: the real messages fade in (once).
  const hadSkeleton = useRef(messages.isLoading);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (!serverRead || !hadSkeleton.current) return;
    hadSkeleton.current = false;
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), 400);
    return () => clearTimeout(timer);
  }, [serverRead]);

  // Person messages loaded over HTTP start their receipts.
  useEffect(() => {
    if (messages.data) live.seed(messages.data);
  }, [messages.data, live]);

  // Older pages, loaded on scroll-up. Kept in the query cache, so they belong to this session: signing
  // out clears them, and they never show to whoever signs in next in the same tab.
  const olderKey = keys.olderPages(org.id, channel.id);
  const [older, setOlder] = useState<MessageType[]>(() => qc.getQueryData<OlderPages>(olderKey)?.pages ?? []);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "done">(() =>
    qc.getQueryData<OlderPages>(olderKey)?.done ? "done" : "idle",
  );
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = (limit = OLDER_PAGE) => {
    // A thread view loads its whole conversation at once.
    if (thread || olderState !== "idle" || !messages.data) return;
    const oldest = older[0] ?? messages.data[0];
    if (!oldest || messages.data.length < MESSAGES_PAGE) {
      setOlderState("done");
      return;
    }
    setOlderState("loading");
    api.chat
      .messages(org.id, channel.id, { before: oldest.createdAt, limit })
      .then((page) => {
        // Keep what's on screen where it is: remember the distance from the bottom.
        const el = scroller.current;
        if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
        setOlder((prev) => {
          const known = new Set(prev.map((m) => m.id));
          const next = [...page.filter((m) => !known.has(m.id)), ...prev];
          qc.setQueryData<OlderPages>(olderKey, { pages: next, done: page.length < limit });
          return next;
        });
        setOlderState(page.length < limit ? "done" : "idle");
      })
      .catch(() => setOlderState("idle"));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when older rows were prepended
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollTop = el.scrollHeight - a.height + a.top;
  }, [older]);

  // The channel's messages: only what was said in the channel (agents asked there answer there).
  // Every thread with replies is one line under its root; its replies live in the panel.
  const channelList = useMemo(() => {
    if (thread) return null;
    const top = [...older, ...(channelMessages.data ?? [])];
    const hidden = hiddenByThreads(threadList, top);
    // My replies from the panel wait in the channel's page until sent: they belong to the thread.
    const visible = top.filter((m) => !m.threadId && !hidden(m));
    const lines = new Map<string, { thread: ThreadInfo; count: number }>();
    for (const x of threadList) {
      // A range thread has its marker, a mission its card, a closed thread its own line.
      if (x.state !== "open" || x.context || x.mission || x.replyCount === 0) continue;
      lines.set(x.id, { thread: x, count: x.replyCount });
    }
    return { visible, lines };
  }, [thread, older, channelMessages.data, threadList]);
  // The channel's threads as the timeline draws them (none in a thread view).
  const threadsView = useMemo<ChannelThreadsView | null>(() => {
    if (thread || !channelList) return null;
    return {
      byId: new Map(threadList.filter((x) => x.state !== "archived").map((x) => [x.id, x])),
      marks: contextMarks(threadList, [...older, ...(channelMessages.data ?? [])], channel.id),
      open: panel?.id ?? null,
      lines: channelList.lines,
    };
  }, [thread, channelList, threadList, older, channelMessages.data, channel.id, panel?.id]);
  // The agents at work here: a follow-up's line that woke one stays while its turn runs (`settledNotices`).
  const workingKey = useStreams((s) => [...new Set(scopedRuns(s).map((r) => r.agentId))].sort().join(" "));
  const agentsAtWork = useMemo(() => new Set(workingKey ? workingKey.split(" ") : []), [workingKey]);
  const timeline = useMemo(() => {
    if (thread) {
      // The thread's conversation. One made from a range: not its root (the channel's marker) nor the
      // moved messages (written before the root; the context block lists them).
      const mine = (channelMessages.data ?? []).filter((m) => m.local && m.threadId === thread.id);
      // A task's conversation: not its root, which stands for the task beside it (ADR 0145).
      const list = mergeTimeline(threadMessages.data ?? [], [mine]).filter(
        (m) =>
          !taskConversationOf(m.meta) &&
          (!thread.context || m.local || (m.id !== thread.id && m.createdAt > thread.createdAt)),
      );
      const passed = supersededBrainNotices(list);
      return buildTimeline(
        list.filter((m) => !passed.has(m.id)),
        [],
        [],
        agentsAtWork,
      );
    }
    const visible = channelList?.visible ?? [];
    const passed = supersededBrainNotices(visible);
    const items = buildTimeline(
      visible.filter((m) => !passed.has(m.id)),
      [],
      [],
      agentsAtWork,
    );
    // A marker, a closed line or a thread's line is not a message: nothing groups under it.
    const special = (m: MessageType) =>
      Boolean(threadStartOf(m.meta)) ||
      threadsView?.byId.get(m.id)?.state === "closed" ||
      Boolean(channelList?.lines.has(m.id));
    return ungroupAfter(items, special);
  }, [thread, channelList, channelMessages.data, threadMessages.data, threadsView, agentsAtWork]);

  // The agents' blocks (one per run, from "pensando" to its final message: `chat/run-slots.ts`), at the end. They
  // change when runs start or end, never on another of a run's events.
  const liveRunsKey = useStreams((s) =>
    scopedRuns(s)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map((r) => `${r.runId}\t${r.agentId}\t${r.provisional ? 1 : 0}`)
      .join("\n"),
  );
  const landedRuns = useMemo(
    () =>
      new Set(timeline.flatMap((i) => (i.kind === "message" && i.message.agentRunId ? [i.message.agentRunId] : []))),
    [timeline],
  );
  const slotsRef = useRef<RunSlot[]>([]);
  // Every block's key by run (the final message is drawn under it), kept for this view.
  const runKeys = useRef(new Map<string, string>());
  const [holdTick, setHoldTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `holdTick` re-checks blocks waiting for their message
  const slots = useMemo(() => {
    const onScreen = liveRunsKey
      ? liveRunsKey.split("\n").map((line) => {
          const [runId = "", agentId = "", provisional] = line.split("\t");
          return { runId, agentId, provisional: provisional === "1" };
        })
      : [];
    // Its message is in a cache already (it lands in the timeline on the next render), or came without its body and
    // is being read: hold the block.
    const expected = (runId: string) =>
      Boolean(live.get().streams.landing?.[runId]) ||
      qc
        .getQueriesData<MessageType[]>({ queryKey: ["org", org.id, "channel", channel.id] })
        .some(([, list]) => Array.isArray(list) && list.some((m) => m?.agentRunId === runId));
    const next = nextSlots(slotsRef.current, onScreen, {
      landed: (runId) => landedRuns.has(runId),
      expected,
      now: Date.now(),
    });
    for (const slot of next) runKeys.current.set(slot.runId, slot.key);
    const kept = sameSlots(slotsRef.current, next) ? slotsRef.current : next;
    slotsRef.current = kept;
    return kept;
  }, [liveRunsKey, landedRuns, holdTick, qc, org.id, channel.id, live]);
  // A block waiting for its message: look again once the wait is over (it goes if nothing came).
  useEffect(() => {
    if (!slots.some((x) => x.goneAt !== null)) return;
    const timer = setTimeout(() => setHoldTick((n) => n + 1), SLOT_HOLD_MS + 50);
    return () => clearTimeout(timer);
  }, [slots]);
  const slotsKey = slots.map((x) => x.key).join(" ");
  // Questions the agents asked other agents from here, drawn inside the replies that asked them: how their answers'
  // notices draw, and which ones the working line leaves to a reply near the end (a run at work draws none yet).
  const consultRows = useMemo(() => timeline.flatMap((i) => (i.kind === "message" ? [i.message] : [])), [timeline]);
  const liveRuns = useMemo(() => new Set(slots.map((slot) => slot.runId)), [slots]);
  const consultGroups = useConsultGroups(channel.id, consultRows, liveRuns, consultId);

  // Newest at the bottom: follow new messages and streaming text while the person is at the
  // bottom; if they scrolled up, the round button at the top right leads back instead of jumping.
  const scroller = useRef<HTMLElement>(null);
  // More than a screen above the end: the round button shows even with nothing new below. Never while pinned to
  // the end, so it stays gone while its own click glides down.
  const [far, setFar] = useState(false);
  const measureFar = (el: HTMLElement) =>
    setFar(!stick.current && screenAboveEnd(el.scrollHeight - el.scrollTop - el.clientHeight, el.clientHeight));
  const datePill = useRef<DatePillHandle>(null);
  // "Última mensagem lida" with something unread: it opens at the "Novas" line, kept as it was on opening because
  // reading moves it. Threads open at their end.
  const dmRead = useDms(org.id).data?.find((d) => d.channelId === channel.id);
  const [readFrom] = useState(() => {
    const unread = channel.unreadCount ?? dmRead?.unread ?? 0;
    return !thread && !focusMessageId && !adjustThreadId && opensAtLastRead(org.chatPrefs, unread)
      ? { at: channel.lastReadAt ?? dmRead?.lastReadAt }
      : null;
  });
  // Otherwise every conversation opens at its last message (coming back to one included).
  // Opened at a message: not pinned to the bottom until the person scrolls down.
  const stick = useRef(!focusMessageId && !readFrom);
  const lastScrollTop = useRef<number | null>(null);
  // A smooth scroll in progress: its intermediate positions don't mean "the person scrolled up".
  const autoScrollUntil = useRef(0);
  // Where the last glide down was headed (its end then): the end moving past it is what the glide missed.
  const glideEnd = useRef(0);
  // The last wheel/touch/key/pointer on the list: scroll events without one are layout, not the person.
  const lastGesture = useRef(0);
  const markGesture = () => {
    lastGesture.current = Date.now();
  };
  // The last gesture that can move the list up (wheel up, an up key, a finger, the scrollbar). Only a scroll up
  // right after one of these lets go of the bottom: content at the end shrinking clamps scrollTop lower too, and
  // right after a wheel down or a click on a row (a tools block folding) that read as "the person scrolled up".
  const lastUpGesture = useRef(0);
  const markUpGesture = () => {
    lastGesture.current = Date.now();
    lastUpGesture.current = lastGesture.current;
  };
  // The last wheel or finger: a window without focus is still being read while these come (a click doesn't count).
  const lastScrollGesture = useRef(0);
  const markScrollGesture = () => {
    lastScrollGesture.current = Date.now();
  };
  // Scrolling up always lets go at once: no waiting to leave the "near bottom" band or for a glide to end.
  const letGo = () => {
    stick.current = false;
    autoScrollUntil.current = 0;
  };
  // Long answers open at their start: rows by someone else (`data-read-id`; an agent's is the run's
  // id, shared by the live row and its final message) that already landed, and whether one is held
  // with its first line at the top ("Fim da resposta" shows until the person reaches the end).
  const landed = useRef(new Set<string>());
  // When the first page arrived (rows before that, and right after, are the conversation opening).
  const readyAt = useRef(0);
  if (serverRead && !readyAt.current) readyAt.current = Date.now();
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  const setHold = (on: boolean) => {
    holdingRef.current = on;
    setHolding(on);
  };
  /** The newest row, when it is an agent's answer (walked from the end: no query over every row). */
  const newestAnswer = () => {
    let el = scroller.current?.lastElementChild ?? null;
    while (el && !el.classList.contains("ac-msg")) el = el.previousElementSibling;
    return el instanceof HTMLElement && el.dataset.readId ? el : null;
  };
  /** The person saw the end of the conversation: its newest answer never jumps back to its start. */
  const markRead = () => {
    const id = newestAnswer()?.dataset.readId;
    if (id) landed.current.add(id);
  };
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  // Scrolled up while things arrive: the first unseen row ("Novas" goes before it), an agent that
  // started meanwhile, and the divider (it fades ~3.5 s after the person gets there).
  const [unseenFrom, setUnseenFrom] = useState<string | null>(null);
  const [unseenRun, setUnseenRun] = useState(false);
  const [divider, setDivider] = useState<{ key: string; fading: boolean } | null>(null);
  const dividerTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dropDividerTimers = () => {
    for (const timer of dividerTimers.current) clearTimeout(timer);
    dividerTimers.current = [];
  };
  useEffect(
    () => () => {
      for (const timer of dividerTimers.current) clearTimeout(timer);
    },
    [],
  );
  const unseenFromRef = useRef<string | null>(null);
  const dividerOn = useRef(false);
  /**
   * Something arrived out of view: the divider before `key` (the first one since the person left). `up`: it landed
   * above the divider already drawn (a message placed before its post, `PLACE_KEPT_MS`), which moves there.
   */
  const markUnseen = (key: string, up = false) => {
    if (unseenFromRef.current !== null && !up) return;
    unseenFromRef.current = key;
    dropDividerTimers();
    dividerOn.current = true;
    setUnseenFrom(key);
    setDivider({ key, fading: false });
  };
  /** The person reached what was new: the pill goes, the divider fades a little later. */
  const clearUnseen = () => {
    if (unseenFromRef.current !== null) {
      unseenFromRef.current = null;
      setUnseenFrom(null);
    }
    setUnseenRun(false);
    if (!dividerOn.current || dividerTimers.current.length > 0) return;
    dividerTimers.current = [
      setTimeout(() => setDivider((d) => (d ? { ...d, fading: true } : d)), 3500),
      setTimeout(() => {
        dividerTimers.current = [];
        dividerOn.current = false;
        setDivider(null);
      }, 4100),
    ];
  };
  const openedAt = useRef(Date.now());
  // A new message came while the person was scrolled up and idle: go to it once the divider is drawn.
  const catchUp = useRef(false);
  /** Scrolled up but not reading: no gesture on the list for a while, or the window elsewhere; never mid-selection. */
  const idleAway = () => {
    if (selectingIn(scroller.current)) return false;
    if (document.hidden) return true;
    // A wheel still scrolls a window without focus: whoever does that is reading, not away.
    if (typeof document.hasFocus === "function" && !document.hasFocus())
      return Date.now() - lastScrollGesture.current > IDLE_CATCH_UP_MS;
    // Right after opening, the same grace as a fresh scroll.
    return Date.now() - Math.max(lastGesture.current, openedAt.current) > IDLE_CATCH_UP_MS;
  };
  /**
   * At the bottom: follow it, unless the newest row is an agent's answer taller than the list. That
   * one lands once with its first line at the top (and a brief highlight); then nothing pulls the list.
   */
  const follow = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    const row = newestAnswer();
    const id = row?.dataset.readId;
    // Rows there while the conversation opens were already read: it opens at the end.
    const opening = !readyAt.current || Date.now() - readyAt.current < 1500;
    if (row && id && opening) landed.current.add(id);
    else if (row && id && !landed.current.has(id)) {
      const box = el.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const land = readingLanding({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        rowTop: rect.top - box.top + el.scrollTop,
        rowHeight: rect.height,
      });
      if (land.held) {
        landed.current.add(id);
        stick.current = false;
        setHold(true);
        clearUnseen();
        if (smooth && !reducedMotionRef.current && typeof el.scrollTo === "function") {
          autoScrollUntil.current = Date.now() + 600;
          el.scrollTo({ top: land.top, behavior: "smooth" });
        } else el.scrollTop = land.top;
        return;
      }
    }
    if (smooth && !reducedMotionRef.current && typeof el.scrollTo === "function") {
      autoScrollUntil.current = Date.now() + 600;
      glideEnd.current = el.scrollHeight - el.clientHeight;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else el.scrollTop = el.scrollHeight;
    clearUnseen();
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  // Pinned to the bottom: anything that grows (an agent's words, images, cards, the skeleton turning
  // into messages, fonts) keeps the latest message in view until the person scrolls. A ResizeObserver
  // on the rows does it (at most once a frame, after layout), not a loop per streaming delta.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list only exists for members; re-attach when it appears
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // What grew during a glide down (the activity bar opening as the message goes out, the first words) is
    // followed once the glide ends: the glide stops at the end it was given. It glides on to the new end, never
    // jumps there; what grows during that second glide (words streaming in) is caught up at once after it.
    // Only when the end did move: new rows report their first size during every glide, and a second glide for
    // nothing would hold what grows in its 600ms (the first words of a reply) for one jump at its end.
    let later: ReturnType<typeof setTimeout> | undefined;
    // When the glide this observer started itself ends.
    let ownGlide = 0;
    const pin = (afterGlide = false) => {
      if (!stick.current) return;
      const wait = autoScrollUntil.current - Date.now();
      clearTimeout(later);
      if (wait > 0) later = setTimeout(() => pin(true), wait);
      else if (
        afterGlide &&
        autoScrollUntil.current !== ownGlide &&
        el.scrollHeight - el.clientHeight > glideEnd.current + 1
      ) {
        followRef.current(true);
        ownGlide = autoScrollUntil.current;
      } else followRef.current();
    };
    const ro = new ResizeObserver(() => pin());
    for (const child of Array.from(el.children)) ro.observe(child);
    ro.observe(el);
    // Only rows that came in are watched (observing every row again on each change cost a pass per delta).
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            for (const r of records) for (const n of Array.from(r.addedNodes)) if (n instanceof Element) ro.observe(n);
          });
    mo?.observe(el, { childList: true });
    return () => {
      clearTimeout(later);
      ro.disconnect();
      mo?.disconnect();
    };
  }, [isMember]);
  const lastKey = timeline.at(-1)?.key;
  const previousLastKey = useRef(lastKey);
  /** The person asked for the end (the round button, "Fim da resposta", a correction sent). */
  const toBottom = (smooth = false) => {
    markRead();
    setFar(false);
    const el = scroller.current;
    if (el) {
      if (smooth && !reducedMotion && typeof el.scrollTo === "function") {
        autoScrollUntil.current = Date.now() + 600;
        glideEnd.current = el.scrollHeight - el.clientHeight;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else el.scrollTop = el.scrollHeight;
    }
    stick.current = true;
    setHold(false);
    clearUnseen();
  };
  const previousSlots = useRef(slotsKey);
  const previousKeys = useRef<ReadonlySet<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever rows or agents' blocks come
  useLayoutEffect(() => {
    // A new row glides down (streaming text is followed by the ResizeObserver above).
    // Not while the channel is still loading (first page, thread replies): that lands at once.
    const before = previousLastKey.current;
    const newRow = before !== lastKey;
    const settled = before !== undefined && Date.now() - openedAt.current > 1500;
    previousLastKey.current = lastKey;
    const keysBefore = previousKeys.current;
    previousKeys.current = new Set(timeline.map((i) => i.key));
    const blocks = previousSlots.current.split(" ");
    const shown = slotsKey.split(" ");
    const newBlock = shown.some((k) => k && !blocks.includes(k));
    // Runs whose block just went: each one's message can sit above rows that came after it (`PLACE_KEPT_MS`).
    const gone = new Set(
      [...runKeys.current].flatMap(([runId, key]) => (blocks.includes(key) && !shown.includes(key) ? [runId] : [])),
    );
    previousSlots.current = slotsKey;
    if (scroller.current) measureFar(scroller.current);
    if (stick.current) follow((newRow || newBlock) && settled);
    // Holding a long answer at its start: "Fim da resposta" already leads to what comes after it.
    else if (!holdingRef.current) {
      const landed = gone.size > 0 ? landedKey(timeline, blockRowByRun(timeline, new Set()), gone, keysBefore) : null;
      const first = earlierKey(timeline, newRow ? firstNewKey(timeline, before) : null, landed);
      if (first) {
        const drawn = unseenFromRef.current !== null;
        markUnseen(
          first,
          drawn && first !== unseenFromRef.current && earlierKey(timeline, unseenFromRef.current, first) === first,
        );
        // Nobody reading up there: go to what is new (as the pill would), once its divider is drawn.
        if (settled && idleAway()) {
          if (drawn) openUnseen();
          else catchUp.current = true;
        }
      }
      if (newBlock) setUnseenRun(true);
    }
  }, [lastKey, slotsKey]);

  // Which agents' blocks are on screen: the line above the composer speaks only for those out of view.
  // By run: a "pensando…" hands its block (same key) to the real run, and that run must count as in view.
  // A block's row draws only once it has something to show (`RunBlock`, `rowShows`): then it is measured again.
  const [rowsDrawn, setRowsDrawn] = useState(0);
  const rowDrawn = useCallback(() => setRowsDrawn((n) => n + 1), []);
  const inView = useBlocksInView(scroller, `${slots.map((x) => x.runId).join(" ")} ${rowsDrawn}`);
  const outOfView = useMemo(() => (runId: string) => !inView.has(runId), [inView]);
  // Requests waiting for you that scrolled out of view: the same line says so first (waiting beats working).
  // Their cards register with this view's scroller (`RowsProvider` around it, not around the panels).
  const [askRegistry] = useState(createAskRegistry);
  const asksOut = useAsksOutOfView(scroller, askRegistry, isMember);
  const seeAsk = (id: string) => showRequest(scroller.current, id, !reducedMotion);
  // A DM with an agent: its tasks (ADR 0128), a pill in the header while it has any, opening them in the side panel.
  const tasksAgentId = chrome?.dmAgentId && !thread ? chrome.dmAgentId : null;
  // Asked every 5 s: a pill beside the conversation, not the page that follows every task (3 s).
  const taskView = useTaskManager(org.id, {
    since: todayStart(),
    enabled: Boolean(tasksAgentId) && isMember,
    pollMs: 5_000,
  });
  const agentTasks = useMemo(
    () => (tasksAgentId ? tasksOf(taskView.data?.tasks ?? [], tasksAgentId) : []),
    [taskView.data, tasksAgentId],
  );
  /** "Ver" on that line: back to the agent's block. */
  const seeRun = (runId: string) => {
    const row = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-run-id]") ?? []).find(
      (el) => el.dataset.runId === runId,
    );
    row?.scrollIntoView?.({ block: "end", behavior: reducedMotion ? "auto" : "smooth" });
  };

  // Dev only: "click → first paint of messages".
  const fromCache = useRef(messages.data !== undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reports once the rows (or an empty channel) are on screen
  useEffect(() => {
    if (timeline.length > 0 || serverRead) reportPainted(channel.id, channel.name, fromCache.current);
  }, [timeline.length > 0, serverRead, channel.id, channel.name]);

  // `[[` in the composer links wiki pages.
  const wikiPages = useWikiTree(org.id);
  // Composer context: who it goes to (the DM agent, or the agents @mentioned in the draft).
  const dmAgent = chrome?.dmAgentId ? dir.agentById.get(chrome.dmAgentId) : undefined;
  const look = useConversationLook(
    Boolean(chrome?.dmAgentId || chrome?.dmPersonId || thread?.channelKind === "dm"),
    dmAgent ? colorOf(dmAgent) : undefined,
  );
  const namedLook = useMemo(() => ({ ...look, names: true, faces: true }), [look]);
  const draftAgents = useMemo(
    () =>
      [
        ...new Set(
          tokenizeBody(draft).flatMap((tok) =>
            tok.type === "mention" ? [dir.agentByHandle.get(tok.handle.toLowerCase())?.id] : [],
          ),
        ),
      ]
        .map((id) => (id ? dir.agentById.get(id) : undefined))
        .filter((a): a is Agent => Boolean(a)),
    [draft, dir.agentByHandle, dir.agentById],
  );
  const pillAgents = dmAgent ? [dmAgent] : draftAgents;
  const composerPills =
    pillAgents.length > 0 || missionReply ? (
      <>
        {missionReply && (
          <span className="ac-composer__pill composer-reply">
            <Icon name="message" size={14} />
            <span className="ac-composer__pill-text">{t("missions.reply.pill", { label: missionReply.label })}</span>
            <button
              type="button"
              className="composer-reply__close"
              aria-label={t("missions.reply.cancel")}
              onClick={() => setMissionReply(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        )}
        {pillAgents.map((a) => (
          <span key={a.id} className="ac-composer__agent">
            <AgentAvatar agentId={a.id} channelId={channel.id} name={a.name} size="xs" />
            <span className="ac-composer__pill-text">{a.name}</span>
          </span>
        ))}
      </>
    ) : undefined;
  // "/" commands, for the DM agent or the channel's suggested agent.
  const commandAgent = dmAgent ?? suggestedAgent;
  const navigateTo = useNavigate();
  const commandPrefix = dmAgent || !commandAgent ? "" : `@${commandAgent.handle} `;
  const cg = agentGrammar(commandAgent?.name ?? "");
  const commands: ComposerCommand[] = commandAgent
    ? [
        {
          key: "report",
          label: t("composer.report"),
          description: t("composer.reportText", cg),
          leading: <Icon name="document" size={16} />,
          insert: `${commandPrefix}${t("composer.reportInsert")}`,
        },
        {
          key: "routine",
          label: t("composer.routine"),
          description: t("composer.routineText"),
          leading: <Icon name="routines" size={16} />,
          insert: "",
          onPick: () => void navigateTo({ to: "/org/$orgId/routines", params: { orgId: org.id } }),
        },
        {
          key: "pc",
          label: t("composer.pc"),
          description: t("composer.pcText", cg),
          leading: <Icon name="code" size={16} />,
          insert: `${commandPrefix}${t("composer.pcInsert")}`,
        },
      ]
    : [];
  // Mission commands (English, like the server's): `/mission` anywhere with an agent; the rest in a mission's thread.
  const threadMission = useThreadMission(org.id, thread?.id);
  const homeMission = threadMission.data && isOpenMission(threadMission.data) ? threadMission.data : null;
  if (commandAgent && !homeMission) {
    commands.push({
      key: "mission",
      label: "/mission",
      description: t("missions.commands.mission"),
      leading: <Icon name="flag" size={16} />,
      insert: "/mission ",
    });
  }
  if (homeMission) {
    const run = (text: string) => () => void runCommand(text);
    const can = homeMission.canAct;
    commands.push(
      ...[
        { key: "summary" as const, icon: "layers" as const, show: true },
        { key: "plan" as const, icon: "document" as const, show: true },
        { key: "pause" as const, icon: "pause" as const, show: can && homeMission.status === "active" },
        { key: "resume" as const, icon: "play" as const, show: can && homeMission.status === "paused" },
        { key: "stop" as const, icon: "stop" as const, show: can && homeMission.status !== "proposed" },
      ]
        .filter((c) => c.show)
        .map((c) => ({
          key: c.key,
          label: `/${c.key}`,
          description: t(`missions.commands.${c.key}`),
          leading: <Icon name={c.icon} size={16} />,
          ...(c.key === "stop" ? { insert: "/stop" } : { insert: "", onPick: run(`/${c.key}`) }),
        })),
    );
  }
  const createMission = useCreateMission(org.id);
  const missionControl = useMissionControl(org.id);
  /** `/mission`, `/stop`, `/pause`, `/resume`, `/summary`, `/plan`: nothing is posted. True when handled. */
  async function runCommand(text: string): Promise<boolean> {
    const cmd = parseMissionCommand(text);
    if (!cmd) return false;
    setDraft("");
    if (cmd.command === "mission") {
      const named = mentioned(cmd.arg)[0];
      const agentId = named ?? dmAgent?.id ?? (talkable.length === 1 ? talkable[0]?.id : undefined);
      if (!agentId) {
        setMissionDraft(cmd.arg);
        return true;
      }
      createMission.mutate(
        { agentId, goal: cmd.arg, ...(thread ? { threadId: thread.id } : { channelId: channel.id }) },
        {
          onSuccess: (mission) => {
            toast.show(t("missions.new.created", { name: dir.agentById.get(agentId)?.name ?? "" }));
            if (mission.threadId !== thread?.id) {
              void navigateTo({
                to: "/org/$orgId/threads/$threadId",
                params: { orgId: org.id, threadId: mission.threadId },
              });
            }
          },
          onError: (error) => toast.show(errorText(t, error), "error"),
        },
      );
      return true;
    }
    const mission = threadMission.data;
    if (!mission) {
      toast.show(t("missions.commands.noMission"), "error");
      return true;
    }
    if (cmd.command === "summary" || cmd.command === "plan") {
      setEphemeral({ kind: cmd.command, missionId: mission.id });
      return true;
    }
    const action = cmd.command;
    missionControl.mutate(
      { missionId: mission.id, action },
      {
        onSuccess: (out) =>
          toast.show(
            action === "stop"
              ? t("missions.toast.stopped", { count: out.canceledTasks ?? 0 })
              : t(`missions.toast.${action}`),
          ),
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
    return true;
  }

  // Any new page of data (first load, refetch, cache → server) re-pins while at the bottom,
  // without waiting for observers (some environments have none).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the data changes
  useLayoutEffect(() => {
    if (stick.current && Date.now() >= autoScrollUntil.current) follow();
  }, [messages.dataUpdatedAt, timeline.length]);

  // `?m=` (or a quote clicked): find the message (paging back up to FOCUS_MAX_PAGES), scroll to it,
  // highlight it once.
  const [focusTarget, setFocusTarget] = useState(focusMessageId);
  const [focusDone, setFocusDone] = useState(!focusMessageId);
  const focusPages = useRef(0);
  const jumping = useRef(false);
  const found = focusTarget ? timeline.some((i) => i.kind === "message" && i.message.id === focusTarget) : false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: steps while the timeline grows
  useEffect(() => {
    if (focusDone || !focusTarget || !serverRead) return;
    if (found) {
      setFocusDone(true);
      // A search hit's Ir para: the message is there, so the panel over it goes (the header's field keeps the words).
      if (jumping.current && !panel) setSearchOpen(false);
      jumping.current = false;
      stick.current = false;
      highlightMessage(scroller.current, focusTarget);
      return;
    }
    // A thread view holds all it can show: nothing to page in.
    if (thread || olderState === "done" || focusPages.current >= FOCUS_MAX_PAGES) {
      // A cached page refreshing may still bring it.
      if (messages.isFetching) return;
      setFocusDone(true);
      // Pressed from here: the person stays where they were.
      if (jumping.current) {
        jumping.current = false;
        // A quote's original that's gone already says so: only a search hit may be gone by now.
        if (searchOpen) toast.show(t("channel.jumpMissing"), "error");
        else toast.show(t("channel.jumpTooFar"));
        return;
      }
      // Not here (or too far back): said, and at the bottom as usual.
      stick.current = true;
      toBottom();
      toast.show(t("channel.jumpMissing"), "error");
      return;
    }
    if (olderState === "idle") {
      focusPages.current += 1;
      loadOlder(FOCUS_PAGE);
    }
  }, [found, focusDone, focusTarget, serverRead, olderState, older.length, messages.isFetching]);
  /** A quote was clicked: the original on screen, or paged in like `?m=`. */
  const jumpTo = (messageId: string) => {
    if (highlightMessage(scroller.current, messageId)) {
      stick.current = false;
      if (!panel) setSearchOpen(false);
      return;
    }
    focusPages.current = 0;
    jumping.current = true;
    setFocusTarget(messageId);
    setFocusDone(false);
  };
  // A message link to this same conversation (a pill) changes only `?m=`: the page stays, so jump to it.
  const linked = useRef(focusMessageId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `?m=`
  useEffect(() => {
    if (!focusMessageId || focusMessageId === linked.current) return;
    linked.current = focusMessageId;
    jumpTo(focusMessageId);
  }, [focusMessageId]);

  // Files for the next message: uploaded to the Drive (this channel) right away; sending waits for them.
  const [files, setFiles] = useState<PendingFile[]>([]);
  const uploadFailed = useUploadFailed();
  // Thumbnails are object URLs: freed when a file leaves the composer and when the page goes.
  const previews = useRef(new Set<string>());
  const dropFiles = (keep: (f: PendingFile) => boolean) => {
    for (const f of files) {
      if (keep(f) || !f.preview) continue;
      objectUrls.revoke(f.preview);
      previews.current.delete(f.preview);
    }
    setFiles((prev) => prev.filter(keep));
  };
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) objectUrls.revoke(url);
      urls.clear();
    };
  }, []);
  const addFiles = (list: File[]) => {
    const room = MAX_ATTACHMENTS - files.length;
    if (list.length > room) toast.show(t("channel.tooManyFiles", { max: MAX_ATTACHMENTS }), "error");
    for (const file of list.slice(0, Math.max(0, room))) {
      if (!fitsUpload(file)) {
        toast.show(t("files.tooLarge", { name: file.name, max: MAX_UPLOAD_MB }), "error");
        continue;
      }
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const update = (patch: Partial<PendingFile>) =>
        setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
      const preview = previewKind(file.type) === "image" ? (objectUrls.create(file) ?? undefined) : undefined;
      if (preview) previews.current.add(preview);
      setFiles((prev) => [
        ...prev,
        { key, name: file.name, icon: fileIcon(file.name, file.type), size: file.size, preview, status: "uploading" },
      ]);
      api.artifacts
        .upload(org.id, file, { channelId: channel.id })
        .then((saved) => update({ status: "done", ref: { id: saved.id, version: saved.version, title: saved.title } }))
        .catch((error) => {
          update({ status: "failed" });
          uploadFailed(error);
        });
    }
    composer.current?.focus();
  };
  const attached = files.flatMap((f) => (f.status === "done" && f.ref ? [f.ref] : []));
  const uploading = files.some((f) => f.status === "uploading");

  // A key pasted in the message: nothing goes out until the person chooses (`KeyGuardDialog`).
  const [keyAsk, setKeyAsk] = useState<{ text: string; key: string; interrupt?: boolean } | null>(null);
  const onSend = (text: string, opts?: { interrupt?: boolean; keyChecked?: boolean }) => {
    if (uploading || (!text && attached.length === 0)) return;
    const key = opts?.keyChecked ? null : looksLikeApiKey(text);
    if (key) {
      setKeyAsk({ text, key, interrupt: opts?.interrupt });
      return;
    }
    if (attached.length === 0 && parseMissionCommand(text)) {
      void runCommand(text);
      return;
    }
    if (missionReply && text) {
      const target = missionReply;
      setDraft("");
      setMissionReply(null);
      api.missions
        .message(org.id, target.missionId, text)
        .then((out) => toast.show(out.delivered ? t("missions.reply.sent") : t("missions.reply.queued")))
        .catch((error) => {
          setDraft(text);
          toast.show(errorText(t, error), "error");
        });
      return;
    }
    toBottom(true);
    setDraft("");
    const meta = localMeta(quote, quote ? dir.authorName(quote.author) : "", attached);
    setQuote(null);
    // From the thread panel or page: the reply makes it a "Responder" thread (out of the channel's timeline).
    if (thread && chrome?.openThread) meta[OPEN_THREAD] = true;
    // "Parar e mandar" (⌘↵): the agent drops the step it is on and reads this now.
    send(text, thread ? thread.id : null, meta, opts?.interrupt ? { steer: "now" } : undefined);
    dropFiles(() => false);
  };
  // A GIF or a sticker from the picker (ADR 0091): one click sends it here, as a message of its own (no text), shown
  // at once like any message I send. The tabs read the latest handler, so they stay the same across keystrokes.
  const sendMediaNow = useRef<(media: MessageMedia) => void>(() => {});
  sendMediaNow.current = (media) => {
    toBottom(true);
    const meta: Record<string, unknown> = { ...localMeta(quote, quote ? dir.authorName(quote.author) : "", []), media };
    setQuote(null);
    if (thread && chrome?.openThread) meta[OPEN_THREAD] = true;
    send("", thread ? thread.id : null, meta);
  };
  const sendMedia = useCallback((media: MessageMedia) => sendMediaNow.current(media), []);
  const mediaTabs = useMediaTabs(sendMedia);
  // Voice messages (ADR 0100), where this person can write and the workspace has them; a reply to a mission goes in
  // text, to the mission. The recording goes in the box's thread, and the box stays as it was.
  const voiceSettings = useSettings(org.id);
  const voiceOn = Boolean(voiceSettings.data?.voiceAvailable && voiceSettings.data.voiceMessages);
  const voice: ComposerVoice | undefined =
    voiceOn && !chrome?.locked && !missionReply
      ? {
          scope: `${channel.id}:${thread?.id ?? ""}`,
          allowed: async () => {
            const { allowed } = await api.voice.allowed(org.id).catch(() => ({ allowed: true }));
            if (!allowed) toast.show(t("voice.limit"));
            return allowed;
          },
          onTake: ({ blob, durationMs, peaks }) => {
            toBottom(true);
            setQuote(null);
            void sendVoice({
              blob,
              durationMs,
              peaks,
              threadId: thread ? thread.id : null,
              replyTo: quote?.id ?? null,
              language: i18n.language.split("-")[0] ?? null,
            });
          },
          onNotice: (notice: VoiceNotice) => {
            if (notice === "blocked") {
              toast.show(t(desktopPlatform() === "mac" ? "voice.blockedMac" : "voice.blockedWeb"), "error");
            } else {
              toast.show(t(`voice.${notice}`), notice === "deleted" ? undefined : "error");
            }
          },
          labels: {
            record: t("voice.record"),
            recording: t("voice.recording"),
            pause: t("voice.pause"),
            resume: t("voice.resume"),
            discard: t("voice.discard"),
            send: t("voice.send"),
            listen: t("voice.listen"),
            stopListening: t("voice.stopListening"),
            keys: t("voice.keys"),
            keysHold: t("voice.keysHold"),
            keysPaused: t("voice.keysPaused"),
            left: (seconds) => t("voice.left", { seconds }),
          },
        }
      : undefined;
  // While an agent works here: the send button turns into stop (box empty), and typing offers
  // "Juntar ao que ele faz" (↵) or "Parar e mandar" (⌘↵).
  const stopName = stopTarget ? (dir.agentById.get(stopTarget.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const stopGrammar = agentGrammar(stopName);
  const working = stopTarget
    ? {
        stopLabel: t("run.stopAgent", stopGrammar),
        stopText: `${t("run.stopAgent", stopGrammar)} · Esc`,
        onStop: () => stopRun(stopTarget),
      }
    : null;
  // The choice is for anyone who writes while an agent works (the stop button only for who may stop it).
  const busyGrammar = agentGrammar(
    busyTarget ? (dir.agentById.get(busyTarget.agentId)?.name ?? t("channel.unknownAgent")) : "",
  );
  const choice = busyTarget
    ? {
        label: t("run.choice.label", busyGrammar),
        joinLabel: t("run.choice.join", busyGrammar),
        interruptLabel: t("run.choice.interrupt"),
        hint: (c: "join" | "interrupt", mod: string) => (
          <>
            <Kbd>↵</Kbd> {c === "join" ? t("run.choice.joins") : t("run.choice.interrupts")} · <Kbd>{mod}↵</Kbd>{" "}
            {c === "join" ? t("run.choice.interrupts") : t("run.choice.joins")}
          </>
        ),
      }
    : undefined;
  // The round button's count (red for a mention of me), and its label: how many, who spoke, who is writing now.
  const myHandle = dir.memberById.get(me.user.id)?.handle?.toLowerCase();
  const unseenSummary = useMemo(
    () => unseenOf(timeline, unseenFrom, me.user.id, myHandle),
    [timeline, unseenFrom, me.user.id, myHandle],
  );
  const writingAgents = useStreams((s) =>
    scopedRuns(s)
      .filter((r) => r.status === "running")
      .map((r) => r.agentId)
      .filter((id, i, all) => all.indexOf(id) === i)
      .join(" "),
  );
  const pillOn = unseenFrom !== null || unseenRun;
  const pillWriting = pillOn && writingAgents ? writingAgents.split(" ") : [];
  const pillAuthors = unseenSummary.authors.filter((a) => !(a.type === "agent" && pillWriting.includes(a.id ?? "")));
  const pillText = pillParts(
    t,
    unseenSummary.count,
    pillAuthors.map((a) => dir.authorName(a)),
    pillWriting.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    unseenSummary.mentionsMe,
  );
  /** A catch-up while away: to the "Novas" divider when it is far up, else to the end. On opening: no glide. */
  const openUnseen = (glide = true) => {
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>(".channel__unread");
    // Without layout (no size) there is nothing to measure: the end.
    if (el && line && line.offsetHeight > 0) {
      const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      if (dividerIsFar(top, el.scrollHeight, el.clientHeight)) {
        if (!glide) {
          // Rows off screen have an estimated height until drawn (`content-visibility`): as `highlightMessage`.
          const land = () => line.scrollIntoView?.({ block: "start" });
          land();
          requestAnimationFrame(() => setTimeout(land, 0));
          return;
        }
        autoScrollUntil.current = Date.now() + 600;
        if (!reducedMotion && typeof el.scrollTo === "function") el.scrollTo({ top: top - 12, behavior: "smooth" });
        else el.scrollTop = top - 12;
        clearUnseen();
        return;
      }
    }
    toBottom(glide);
  };
  const landingAtRead = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the divider a catch-up asked for is drawn
  useLayoutEffect(() => {
    if (!catchUp.current || unseenFrom === null) return;
    catchUp.current = false;
    openUnseen(!landingAtRead.current);
    landingAtRead.current = false;
  }, [unseenFrom]);
  // Opening at the last read message: the line goes before the first unread one, once the messages are in.
  const atReadDone = useRef(!readFrom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the page with them arrives
  useLayoutEffect(() => {
    if (atReadDone.current || !serverRead) return;
    const items = timeline.flatMap((i) => (i.kind === "message" ? [i] : []));
    const id = firstUnreadId(
      items.map((i) => i.message),
      readFrom?.at,
      me.user.id,
    );
    const key = items.find((i) => i.message.id === id)?.key;
    if (!key) {
      // A page kept from an earlier visit has none of them: the end, until the fresh one lands.
      atReadDone.current = !messages.isFetching;
      stick.current = true;
      followRef.current();
      return;
    }
    atReadDone.current = true;
    stick.current = false;
    landingAtRead.current = true;
    catchUp.current = true;
    markUnseen(key);
  }, [serverRead, messages.isFetching]);
  const emptySuggestions = useMemo(() => {
    if (chrome?.suggestions) return chrome.suggestions.map((text) => ({ label: text, text }));
    const a = suggestedAgent;
    // The chip names the agent as a sent message shows its mention; the text keeps the handle.
    return a
      ? greetingSuggestions(t, a.role).map((s) => ({ label: `@${a.name} ${s}`, text: `@${a.handle} ${s}` }))
      : [];
  }, [chrome?.suggestions, suggestedAgent, t]);

  // "Ajustar trecho": the channel's messages that can be in the range (and the moved ones, back in
  // their place), with the selection band in place of the timeline and its bar in place of the composer.
  const adjustInfo = useThreadInfo(org.id, adjustThreadId);
  const adjusting = adjustInfo.data;
  const movedMessages = useThreadRange(org.id, adjusting, Boolean(adjusting?.context?.moved));
  const adjustList = useMemo(() => {
    if (!adjusting) return [];
    const moved = adjusting.context?.moved ? (movedMessages.data ?? []) : [];
    return rangeCandidates(
      mergeTimeline([...older, ...(channelMessages.data ?? [])], [moved.map((m) => ({ ...m, threadId: null }))]),
    );
  }, [adjusting, movedMessages.data, older, channelMessages.data]);
  const adjust = useRangeAdjust({
    thread: adjusting,
    list: adjustList,
    channelName: channel.name,
    onDone: () => {},
  });
  // The range starts further back than what is loaded: page back to it (like `?m=`).
  const adjustFirst = adjusting?.context?.firstMessageId;
  const adjustFound = adjustList.some((m) => m.id === adjustFirst);
  // biome-ignore lint/correctness/useExhaustiveDependencies: steps while older pages arrive
  useEffect(() => {
    if (!adjustFirst || adjustFound || !serverRead || olderState !== "idle") return;
    loadOlder();
  }, [adjustFirst, adjustFound, serverRead, olderState, older.length]);
  // Esc leaves the selection (back to the thread).
  useEffect(() => {
    if (!adjusting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      adjust.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The rows read these through context: the value stays the same object across renders (a keystroke
  // in the composer must not redraw every message); each call reaches this render's handlers.
  const latestActions = useRef<Required<ChannelActions>>(null as never);
  latestActions.current = {
    insertMention: (handle) => {
      setDraft((d) => `${d.trim() ? `${d.trim()} ` : ""}@${handle} `);
      composer.current?.focus();
    },
    retry: (local) => {
      stick.current = true;
      retry(local);
    },
    resend: (body) => send(body),
    focusComposer: () => composer.current?.focus(),
    fillComposer: (text) => {
      setDraft(text);
      composer.current?.focus();
    },
    followBottom: () => {
      if (stick.current && Date.now() >= autoScrollUntil.current) follow();
    },
    channelAgents,
    // "Responder": in a thread view the next message answers this one (there are no threads in a thread); in a
    // channel, the message's thread opens in the panel (a reply there starts it).
    reply: thread
      ? (message) => {
          setMissionReply(null);
          setQuote(message);
          composer.current?.focus();
        }
      : (message) => {
          if (profileKeeps()) return;
          setProfile(null);
          setConsultId(null);
          setSearchOpen(false);
          setPanel({ id: message.threadId ?? message.id, reply: true });
        },
    openThread: (id, focus) => {
      if (profileKeeps()) return;
      setProfile(null);
      setConsultId(null);
      setSearchOpen(false);
      setPanel({ id, reply: false, focus });
    },
    openConsultation: (id) => {
      if (profileKeeps()) return;
      setProfile(null);
      setPanel(null);
      setSearchOpen(false);
      setConsultId(id);
    },
    requestCorrection: (message, text) => {
      const handle = message.author.type === "agent" ? dir.agentById.get(message.author.id ?? "")?.handle : undefined;
      toBottom(true);
      send(
        handle ? `@${handle} ${text}` : text,
        thread ? thread.id : (message.threadId ?? null),
        localMeta(message, dir.authorName(message.author), []),
      );
    },
    jumpTo,
    replyToMission: (missionId, label) => {
      setQuote(null);
      setMissionReply({ missionId, label });
      composer.current?.focus();
    },
  };
  const inThread = Boolean(thread);
  // A thread with no composer (archived, read only here) has nothing for "Responder" to do.
  const replies =
    !thread || !(chrome?.composerReplacement || chrome?.locked || channel.can?.post === false || org.deletion);
  const actions = useMemo<ChannelActions>(() => {
    const now = () => latestActions.current;
    return {
      insertMention: (handle) => now().insertMention(handle),
      retry: (local) => now().retry(local),
      resend: (body) => now().resend(body),
      focusComposer: () => now().focusComposer(),
      fillComposer: (text) => now().fillComposer(text),
      followBottom: () => now().followBottom(),
      channelAgents,
      reply: replies ? (message) => now().reply(message) : undefined,
      // A thread view has no panel: its links go to the thread's page.
      openThread: inThread ? undefined : (id, focus) => now().openThread(id, focus),
      // In a thread view the question opens in place, inside the reply's block.
      openConsultation: inThread ? undefined : (id) => now().openConsultation(id),
      requestCorrection: (message, text) => now().requestCorrection(message, text),
      jumpTo: (messageId) => now().jumpTo(messageId),
      replyToMission: (missionId, label) => now().replyToMission(missionId, label),
    };
  }, [channelAgents, inThread, replies]);

  // A DM with an agent: the agent's chip sits in the composer's toolbar row.
  const agentDm = Boolean(chrome?.dmAgentId) && !thread;
  const tasksControl = useMemo(
    () => (tasksAgentId ? { tasks: agentTasks, open: tasksOpen, toggle: toggleTasks } : null),
    [tasksAgentId, agentTasks, tasksOpen, toggleTasks],
  );
  const Tag = chrome?.panel ? "section" : "main";
  // Enter in the header search: its results in the panel, in place of any other.
  const openSearch = () => {
    if (profileKeeps()) return;
    setPanel(null);
    setProfile(null);
    setConsultId(null);
    setSearchOpen(true);
  };
  // Anything open in the column's place: its toggle closes that and shows the column.
  const paneOpen = Boolean(panel || profile || searchOpen || consultId || tasksOpen);
  const toggleColumn = (column: { open: boolean; toggle: () => void }) => {
    if (!paneOpen) return column.toggle();
    if (profileKeeps()) return;
    setPanel(null);
    setProfile(null);
    setSearchOpen(false);
    setConsultId(null);
    setTasksOpen(false);
    if (!column.open) column.toggle();
  };
  const side: DmSideControl | null =
    agentDm && dmAgent
      ? {
          open: !paneOpen && dmSidebar.open,
          // A side panel floats over the conversation: the column stays under it, so nothing moves behind the scrim.
          docked: dmSidebar.column,
          toggle: () => toggleColumn(dmSidebar),
        }
      : null;
  // It takes over from the conversation's skeleton (`ChannelSkeleton`): no second entrance of the whole view.
  const [continues] = useState(skeletonOnScreen);

  return (
    <PushAskContext.Provider value={pushAsk}>
      {/* A thread inside the panel opens profiles in its channel's panel, not inside itself. */}
      <AgentPanelContext.Provider value={chrome?.panel ? outerPanel : openAgentPanel}>
        <MessageLookContext.Provider value={look}>
          <ChannelActionsContext.Provider value={actions}>
            <ChannelThreadsContext.Provider value={threadsView}>
              {/* A DM with an agent reads as one centered column; channels, threads and DMs between people
            are a left-aligned team chat. */}
              <Tag
                className={cx("shell__main shell__main--chat", chrome?.panel && "thread-panel__chat")}
                data-continues={continues || undefined}
              >
                {/* A page's own header (a DM's) gets the agent's tasks for its pill (`AgentTasksPill`). */}
                {chrome?.header ? (
                  <AgentTasksContext.Provider value={tasksControl}>
                    <AgentPanelShownContext.Provider value={profile?.agentId ?? null}>
                      {typeof chrome.header === "function"
                        ? chrome.header({ onSearch: openSearch, side })
                        : chrome.header}
                    </AgentPanelShownContext.Provider>
                  </AgentTasksContext.Provider>
                ) : (
                  <ChannelHeader
                    channel={channel}
                    isMember={readable}
                    queueMachine={queueMachine}
                    people={channelPeople}
                    agents={channelAgents}
                    membersOpen={!paneOpen && membersColumn.open}
                    onMembers={() => toggleColumn(membersColumn)}
                    onDetails={() => setDetailsOpen(true)}
                    onSearch={openSearch}
                  />
                )}
                {/* Under the header: the conversation, and the members beside it (the header spans both, as Discord's). */}
                <div className="channel__body">
                  <div className="channel__col">
                    {isMember && (
                      <ChannelPinnedBar
                        channelId={channel.id}
                        channelName={chrome ? undefined : channel.name}
                        threadId={thread?.id}
                      />
                    )}
                    {!chrome && isMember && arriving && (
                      <ArrivalCard
                        channel={channel}
                        onSayHi={() => composer.current?.focus()}
                        onClose={arrival.close}
                      />
                    )}
                    {!chrome && isMember && !arriving && (
                      <ChannelWelcome channelId={channel.id} messages={messages.data} agents={channelAgents} />
                    )}

                    {!readable ? (
                      <div className="channel__empty">
                        <EmptyState
                          icon="channel"
                          title={t("channel.notMemberTitle")}
                          actions={
                            <Button
                              variant="primary"
                              onClick={() => join.mutate()}
                              disabled={join.isPending}
                              loading={join.isPending}
                            >
                              {t("channel.join", { channel: channel.name })}
                            </Button>
                          }
                        >
                          {t("channel.notMemberText")}
                        </EmptyState>
                      </div>
                    ) : (
                      <>
                        {olderState === "loading" && (
                          <div className="channel__older" role="status">
                            <span className="channel__older-pill">
                              <Spinner size={14} />
                              {t("channel.loadingOlder")}
                            </span>
                          </div>
                        )}
                        {olderState !== "loading" && <DatePill scroller={scroller} ref={datePill} />}
                        <RowsProvider asks={askRegistry} stop={stopTarget?.runId} drawn={rowDrawn}>
                          <section
                            ref={scroller}
                            className="channel__messages"
                            data-look={look.style}
                            data-faces={look.faces ? undefined : "false"}
                            data-fresh={fresh || undefined}
                            aria-label={t("channel.messages")}
                            aria-live="polite"
                            aria-relevant="additions"
                            onWheel={(e) => {
                              markScrollGesture();
                              if (e.deltaY < 0) {
                                markUpGesture();
                                letGo();
                              } else markGesture();
                            }}
                            onTouchMove={() => {
                              markScrollGesture();
                              markUpGesture();
                            }}
                            // On the list itself, not on a row: its scrollbar.
                            onPointerDown={(e) => (e.target === e.currentTarget ? markUpGesture() : markGesture())}
                            onKeyDown={(e) => (isScrollUpKey(e) ? markUpGesture() : markGesture())}
                            onScroll={(e) => {
                              const previousTop = lastScrollTop.current;
                              lastScrollTop.current = e.currentTarget.scrollTop;
                              measureFar(e.currentTarget);
                              // Only the person scrolling unpins (or loads older pages); layout changes never do.
                              const byPerson = Date.now() - lastGesture.current < GESTURE_MS;
                              // A drag selecting text past the top edge scrolls up too: the person is reading.
                              const upByPerson =
                                Date.now() - lastUpGesture.current < GESTURE_MS ||
                                (byPerson && selectingIn(e.currentTarget));
                              if (byPerson) datePill.current?.poke();
                              if (byPerson && e.currentTarget.scrollTop < 240) loadOlder();
                              if (upByPerson && previousTop !== null && e.currentTarget.scrollTop < previousTop) {
                                letGo();
                                return;
                              }
                              const near = nearBottom(e.currentTarget);
                              if (!near && (!byPerson || Date.now() < autoScrollUntil.current)) return;
                              // Pinned again only when the person comes back down, not by layout.
                              const movedDown = previousTop !== null && e.currentTarget.scrollTop > previousTop;
                              if (near && !stick.current && !(byPerson && movedDown)) return;
                              stick.current = near;
                              if (near) clearUnseen();
                              // The person reached the end by themselves: the answer was read, the hold is over.
                              if (near && byPerson) {
                                markRead();
                                if (holdingRef.current) setHold(false);
                              }
                            }}
                          >
                            {/* Pushes short channels down, next to the composer. */}
                            <div className="channel__spacer" aria-hidden="true" />
                            {chrome?.top}
                            {chrome?.intro}
                            {messages.isLoading && <LoadingConversation />}
                            {messages.isError && !messages.data && (
                              <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
                            )}
                            {serverRead &&
                              timeline.length === 0 &&
                              slots.length === 0 &&
                              !thread &&
                              !adjusting &&
                              !chrome?.intro && (
                                <div className="channel__empty">
                                  <EmptyState
                                    size="panel"
                                    icon="message"
                                    // A DM with a person is about them: its agent everywhere else.
                                    agent={
                                      chrome?.dmPersonId
                                        ? undefined
                                        : (lookOf(dir.agentById.get(chrome?.dmAgentId ?? "")) ?? rightHandLook)
                                    }
                                    title={
                                      channel.can?.post === false
                                        ? t("chat.readOnlyEmpty")
                                        : (chrome?.emptyTitle ?? t("chat.sayHiChannel", { channel: channel.name }))
                                    }
                                    actions={
                                      emptySuggestions.length > 0 && channel.can?.post !== false ? (
                                        <fieldset className="channel__suggestions">
                                          <legend className="ac-visually-hidden">{t("chat.suggestions")}</legend>
                                          {emptySuggestions.map((s) => (
                                            <Button
                                              key={s.text}
                                              size="sm"
                                              onClick={() => {
                                                setDraft(s.text);
                                                composer.current?.focus();
                                              }}
                                            >
                                              {s.label}
                                            </Button>
                                          ))}
                                        </fieldset>
                                      ) : undefined
                                    }
                                  >
                                    {channel.can?.post === false
                                      ? undefined
                                      : (chrome?.emptyText ?? (chrome?.dmPersonId ? undefined : t("chat.sayHiText")))}
                                  </EmptyState>
                                </div>
                              )}
                            {adjustThreadId ? (
                              <RangeRows
                                adjust={adjust}
                                scroller={scroller}
                                renderMessage={(m) => (
                                  <ErrorBoundary resetKey={m} fallback={unshownLine}>
                                    <TimelineMessage
                                      message={m}
                                      grouped={false}
                                      entering={false}
                                      modelLabels={NO_LABELS}
                                    />
                                  </ErrorBoundary>
                                )}
                              />
                            ) : (
                              <>
                                <Timeline
                                  items={timeline}
                                  ready={serverRead}
                                  slots={slots}
                                  runKeys={runKeys.current}
                                  divider={divider}
                                  channelId={channel.id}
                                  runVisible={runVisible}
                                  dmPersonId={thread ? undefined : chrome?.dmPersonId}
                                  consultGroups={consultGroups}
                                  seenId={thread ? null : seenId}
                                />
                                {/* A thread's root is on screen from the channel: only its replies are loading. */}
                                {thread && messages.isPlaceholderData && thread.replyCount > 0 && (
                                  <LoadingConversation count={Math.min(thread.replyCount, 6)} />
                                )}
                                {!thread && (
                                  <ArchivedThreadsNote
                                    channelId={channel.id}
                                    count={archivedThreads.data?.threads.length ?? 0}
                                  />
                                )}
                              </>
                            )}
                            {ephemeral && (
                              <MissionEphemeral
                                kind={ephemeral.kind}
                                missionId={ephemeral.missionId}
                                onClose={() => setEphemeral(null)}
                              />
                            )}
                            <LiveMemoryCards channelId={channel.id} />
                            <LiveNotices channelId={channel.id} />
                          </section>
                        </RowsProvider>
                        <ToLatest
                          shown={!adjustThreadId && (far || pillOn)}
                          count={unseenSummary.count}
                          mentionsMe={unseenSummary.mentionsMe}
                          label={
                            pillText.length > 0
                              ? t("channel.newPill.label", { text: pillText.join(" · ") })
                              : t("channel.toLatest")
                          }
                          onClick={() => toBottom(true)}
                        />
                        {holding && (
                          <div className="channel__pill">
                            <Button size="sm" className="ac-new-messages" onClick={() => toBottom(true)}>
                              <Icon name="chevronDown" size={16} />
                              {t("channel.endOfReply")}
                            </Button>
                          </div>
                        )}
                        <div className="channel__composer">
                          <ConnectionBanner status={status} />
                          {!chrome?.intro && !org.deletion && (
                            <NoAiBanner agentIds={channelAgents.map((a) => a.id)} dmAgentId={chrome?.dmAgentId} />
                          )}
                          <ActivityBar
                            channelId={channel.id}
                            threadId={thread?.id ?? null}
                            visible={runVisible}
                            outOfView={outOfView}
                            onSee={seeRun}
                            asks={asksOut}
                            onSeeAsk={seeAsk}
                            stoppable={stopTarget?.runId}
                            consultBlocks={consultGroups.nearEnd}
                          />
                          {adjustThreadId ? (
                            <RangeBar adjust={adjust} />
                          ) : org.deletion ? (
                            // Being deleted, it reads as ever and takes no message (ADR 0088 §7).
                            <p className="channel__notice channel__readonly ac-iconline" role="status">
                              <Icon name="lock" size={16} />
                              <span>{t("deleting.composer")}</span>
                            </p>
                          ) : chrome?.composerReplacement ? (
                            chrome.composerReplacement
                          ) : !isMember ? (
                            <div className="channel__notice channel__readonly channel__admin-read" role="status">
                              <span className="ac-iconline">
                                <Icon name="eye" size={16} />
                                <span>{t("channel.adminReading")}</span>
                              </span>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => join.mutate()}
                                disabled={join.isPending}
                                loading={join.isPending}
                              >
                                {t("channel.join", { channel: channel.name })}
                              </Button>
                            </div>
                          ) : channel.can?.post === false ? (
                            // The channel's exceptions keep me from sending here (ADR 0134): reading stays open.
                            <p className="channel__notice channel__readonly ac-iconline" role="status">
                              <Icon name="lock" size={16} />
                              <span>{t("channel.perms.readOnlyComposer")}</span>
                            </p>
                          ) : (
                            <>
                              <Composer
                                header={
                                  quote ? (
                                    <QuoteBar
                                      name={dir.authorName(quote.author)}
                                      onCancel={() => {
                                        setQuote(null);
                                        composer.current?.focus();
                                      }}
                                    />
                                  ) : finishing ? (
                                    <div className="composer-quote" role="note">
                                      <Icon name="edit" size={16} />
                                      <span className="composer-quote__who">{t("teamPlan.firstTask.finish")}</span>
                                    </div>
                                  ) : undefined
                                }
                                attachments={
                                  files.length > 0
                                    ? files.map((f) => (
                                        <ComposerFile
                                          key={f.key}
                                          name={f.name}
                                          icon={f.icon}
                                          preview={f.preview}
                                          detail={formatBytes(i18n.language, f.size)}
                                          status={f.status}
                                          statusLabel={
                                            f.status === "uploading"
                                              ? t("channel.uploading")
                                              : f.status === "failed"
                                                ? t("channel.uploadFailed")
                                                : undefined
                                          }
                                          removeLabel={t("channel.removeFile", { name: f.name })}
                                          onRemove={() => dropFiles((x) => x.key !== f.key)}
                                        />
                                      ))
                                    : undefined
                                }
                                onFiles={chrome?.locked ? undefined : addFiles}
                                canSendEmpty={attached.length > 0}
                                sendBlocked={uploading}
                                format={formatLabels}
                                emoji={mediaTabs ? { ...emojiLabels, button: mediaTabs.button } : emojiLabels}
                                pickerTabs={mediaTabs?.tabs}
                                pickerLabels={mediaTabs?.labels}
                                id={`composer-${thread?.id ?? channel.id}`}
                                textareaRef={composer}
                                keepsEsc={Boolean(stopTarget) && !chrome?.panel}
                                value={draft}
                                onChange={(v) => {
                                  setDraft(v);
                                  if (v.trim()) sendTyping(v);
                                }}
                                onSend={onSend}
                                working={chrome?.locked ? null : working}
                                choice={choice}
                                voice={voice}
                                disabled={Boolean(chrome?.locked)}
                                label={
                                  chrome?.composerLabel ??
                                  (chrome?.composerTarget
                                    ? t("channel.composerDm", { name: chrome.composerTarget })
                                    : t("channel.composerLabel", { channel: channel.name }))
                                }
                                placeholder={
                                  // DMs name the person or agent ("Mensagem para Theo"); channels keep "#nome".
                                  chrome?.composerLabel ??
                                  (chrome?.composerTarget
                                    ? t("channel.composerDm", { name: chrome.composerTarget })
                                    : t("channel.composerPlaceholder", { channel: channel.name }))
                                }
                                sendLabel={t("channel.send")}
                                sendText={t("channel.send")}
                                attachLabel={t("channel.attach")}
                                pills={composerPills}
                                inlinePills={agentDm}
                                links={{
                                  listLabel: t("wiki.editor.suggest"),
                                  search: (q) =>
                                    (wikiPages.data ?? [])
                                      .filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()))
                                      .slice(0, 8)
                                      .map((p) => ({
                                        key: `wiki:${p.slug}`,
                                        insert: p.title,
                                        label: p.title,
                                        description: p.folder || undefined,
                                        leading: <Icon name="book" size={16} />,
                                      })),
                                }}
                                commands={
                                  commands.length > 0
                                    ? { listLabel: t("composer.commands"), list: commands }
                                    : undefined
                                }
                                channels={{ search: channelSearch, listLabel: t("channelRefs.list") }}
                                mentions={{
                                  search: mentionSearch,
                                  listLabel: t("mentions.list"),
                                  onPick: (item) => {
                                    // A DM takes no new member, so there is nothing to offer there.
                                    const dm = Boolean(chrome?.dmAgentId || chrome?.dmPersonId);
                                    if (item.note && !dm && item.key.startsWith("agent:")) setOffer(item.key.slice(6));
                                  },
                                }}
                              />
                              {offer && (
                                <AddToChannelOffer
                                  channelId={channel.id}
                                  agentId={offer}
                                  onDone={() => setOffer(null)}
                                />
                              )}
                              <KeyGuardDialog
                                ask={keyAsk}
                                onClose={() => setKeyAsk(null)}
                                onSend={() => {
                                  setKeyAsk(null);
                                  if (keyAsk) onSend(keyAsk.text, { interrupt: keyAsk.interrupt, keyChecked: true });
                                }}
                                onEdit={(text) => {
                                  setKeyAsk(null);
                                  setDraft(text);
                                  composer.current?.focus();
                                }}
                              />
                              {chrome?.composerNote && !chrome.locked && (
                                <p className="ac-composer__hint">{chrome.composerNote}</p>
                              )}
                              {chrome?.locked && (
                                <p className="ac-composer__hint">
                                  {chrome.locked} {chrome.lockedAction}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      </>
                    )}

                    {!chrome?.header && (
                      <ChannelDetails
                        open={detailsOpen}
                        onOpenChange={(open) => {
                          setDetailsOpen(open);
                          if (!open) setAddFirst(false);
                        }}
                        channel={channel}
                        startAdding={addFirst}
                      />
                    )}
                    {missionDraft !== null && (
                      <NewMissionDialog
                        open
                        onOpenChange={(o) => !o && setMissionDraft(null)}
                        initialGoal={missionDraft}
                        initialChannelId={chrome?.dmAgentId ? undefined : channel.id}
                        initialAgentId={suggestedAgent?.id}
                      />
                    )}
                  </div>
                  {/* A thread, the search's results or an agent's page floats over the conversation (`SidePanel`), one
                  at a time; the members column stays under it. */}
                  {profile ? (
                    <AgentPanel
                      key={`${profile.agentId}:${profile.tab ?? ""}:${profile.item ?? ""}`}
                      agentId={profile.agentId}
                      tab={profile.tab}
                      item={profile.item}
                      closeRequest={profile.close}
                      onClose={closeProfile}
                    />
                  ) : consultId ? (
                    /* Rows from more than the two people of a DM: they keep their names there too. */
                    <MessageLookContext.Provider value={namedLook}>
                      <ConsultationPanel
                        key={consultId}
                        channelId={channel.id}
                        channelName={chrome?.composerTarget ? null : channel.name}
                        consultationId={consultId}
                        onClose={() => setConsultId(null)}
                        onTalk={(handle) => {
                          setConsultId(null);
                          actions.insertMention(handle);
                        }}
                        onAnswer={() => {
                          setConsultId(null);
                          actions.focusComposer();
                        }}
                        renderMessage={(m, grouped) => (
                          <ErrorBoundary resetKey={m} fallback={unshownLine}>
                            <TimelineMessage
                              message={m}
                              grouped={grouped}
                              entering={false}
                              modelLabels={NO_LABELS}
                              readOnly
                            />
                          </ErrorBoundary>
                        )}
                      />
                    </MessageLookContext.Provider>
                  ) : tasksOpen && tasksAgentId ? (
                    <AgentTasksPanel
                      agentId={tasksAgentId}
                      channelId={channel.id}
                      tasks={agentTasks}
                      ended={taskView.data?.ended ?? []}
                      hidden={hiddenCount(taskView.data?.hidden, tasksAgentId)}
                      onClose={() => setTasksOpen(false)}
                    />
                  ) : panel || searchOpen ? (
                    <SidePanel
                      label={t(panel ? "threads.side.label" : "searchPage.panel.label")}
                      onClose={() => {
                        setPanel(null);
                        setSearchOpen(false);
                      }}
                    >
                      {searchOpen && (
                        <MessageLookContext.Provider value={namedLook}>
                          <SearchResultsPanel
                            channelId={channel.id}
                            hidden={Boolean(panel)}
                            jumping={focusDone ? undefined : focusTarget}
                            onClose={() => setSearchOpen(false)}
                            onOpenThread={(id, focus) => {
                              hitThread.current = id;
                              setPanel({ id, reply: false, focus });
                            }}
                          />
                        </MessageLookContext.Provider>
                      )}
                      {panel && (
                        <ThreadPage
                          key={`${panel.id}:${panel.focus ?? ""}`}
                          threadId={panel.id}
                          reply={panel.reply}
                          focusMessageId={panel.focus}
                          onClose={() => {
                            setPanel(null);
                            setSearchOpen(false);
                          }}
                          {...(searchOpen ? { onBack: () => setPanel(null) } : {})}
                          onGone={() => {
                            setPanel(null, { replace: true });
                            toast.show(t("threads.view.notFoundTitle"));
                          }}
                          onSeeInChannel={(messageId, channelId) => {
                            if (channelId !== channel.id) return false;
                            setPanel(null);
                            // The panel covers the conversation: the results close too (the header's field keeps the
                            // words, one click brings them back).
                            setSearchOpen(false);
                            jumpTo(messageId);
                            return true;
                          }}
                        />
                      )}
                    </SidePanel>
                  ) : (
                    side &&
                    dmAgent &&
                    dmSidebar.sheet && <AgentSidebar agent={dmAgent} onClose={dmSidebar.closeSheet} />
                  )}
                  {side && dmAgent && side.docked && !dmSidebar.sheet ? (
                    <AgentSidebar agent={dmAgent} />
                  ) : (
                    !chrome &&
                    membersColumn.column && (
                      <MembersColumn
                        channel={channel}
                        people={channelPeople}
                        agents={channelAgents}
                        {...(addsMembers ? { onAdd: addMembers } : {})}
                      />
                    )
                  )}
                </div>
              </Tag>
              {!chrome && !profile && membersColumn.sheet && (
                <MembersSheet
                  channel={channel}
                  isMember={readable}
                  people={channelPeople}
                  agents={channelAgents}
                  onDetails={() => {
                    membersColumn.closeSheet();
                    setDetailsOpen(true);
                  }}
                  {...(addsMembers
                    ? {
                        onAdd: () => {
                          membersColumn.closeSheet();
                          addMembers();
                        },
                      }
                    : {})}
                  onClose={membersColumn.closeSheet}
                />
              )}
            </ChannelThreadsContext.Provider>
          </ChannelActionsContext.Provider>
        </MessageLookContext.Provider>
      </AgentPanelContext.Provider>
    </PushAskContext.Provider>
  );
}

/** Rows right after a thread marker or a closed thread's line keep their own header. */
function ungroupAfter(items: TimelineItem[], special: (m: MessageType) => boolean): TimelineItem[] {
  let after = false;
  return items.map((item) => {
    if (item.kind !== "message") {
      after = false;
      return item;
    }
    const out = after && item.grouped ? { ...item, grouped: false } : item;
    after = special(item.message);
    return out;
  });
}

const unshownLine = () => <UnshownLine />;
const unshownPart = () => <UnshownLine part />;

/**
 * Each part of a message (its text, a card, its receipts) in its own boundary: one that fails to draw is a quiet line
 * and the text and the other parts stay. The row's boundary still holds the rest (the header).
 */
function Parts({ resetKey, children }: { resetKey: unknown; children: ReactNode }) {
  return Children.map(children, (part) => {
    if (part == null) return null;
    return (
      <ErrorBoundary resetKey={resetKey} fallback={unshownPart}>
        {part}
      </ErrorBoundary>
    );
  });
}

/**
 * Persisted rows, then the agents' live blocks at the end (their replies are posted there, after what people sent
 * meanwhile). One flat keyed list: an answer seen live is drawn under its block's key, so the final message takes a
 * drawn block's place without a remount. Memoized: a run's events don't re-render it.
 */
const Timeline = memo(function Timeline({
  items,
  ready,
  slots,
  runKeys,
  divider,
  channelId,
  runVisible,
  dmPersonId,
  consultGroups,
  seenId = null,
}: {
  items: ReturnType<typeof buildTimeline>;
  /** The first page loaded: rows from then on slide in. */
  ready: boolean;
  /** The agents' blocks at work (`chat/run-slots.ts`). */
  slots: RunSlot[];
  /** Each block's key by run id: its final message is drawn under it. */
  runKeys: Map<string, string>;
  /** "Novas": before this row, fading once the person got there. */
  divider: { key: string; fading: boolean } | null;
  /** This conversation's channel, and which runs' threads it shows (a held browser card's place). */
  channelId: string;
  runVisible: { current: (r: { threadId: string | null; provisional?: boolean }) => boolean };
  /** A DM with this person: my turns' time lines keep the slot of their face (`SeenMark`). */
  dmPersonId?: string;
  /** The agents' questions to other agents: inside the replies that asked, and how their answers draw. */
  consultGroups: ConsultGroups;
  /** My message they read last: their face is its receipt. */
  seenId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const models = useModels();
  const modelLabels = useMemo(
    () => new Map((models.data?.models ?? []).map((m) => [m.id, m.label] as const)),
    [models.data],
  );
  const [mountedAt] = useState(() => Date.now());
  // Rows that failed to draw: the row after one keeps its own header, or under the quiet line it would read as more of
  // whoever's header is above. ponytail: never cleared, so a row that draws again leaves the next one its header until
  // the conversation is reopened.
  const [unshown, setUnshown] = useState<ReadonlySet<string>>(() => new Set());
  const markUnshown = (key: string | null) => key !== null && setUnshown((s) => (s.has(key) ? s : new Set(s).add(key)));
  // Keys of the first load (idempotent, so a double render in StrictMode agrees).
  const initialKeys = useRef<Set<string> | null>(null);
  if (ready && initialKeys.current === null) initialKeys.current = new Set(items.map((i) => i.key));
  const initial = initialKeys.current;
  // A block slides in once, when it first shows (not the ones already working when the page opened).
  const blockEnters = useRef(new Map<string, boolean>());
  const threadsView = useChannelThreadsView();
  // Threads a mission link card already points to (the agent's reply): their start marker stays out.
  const linked = useMemo(
    () =>
      new Set(
        items.flatMap((i) => {
          const link = i.kind === "message" ? missionLinkOf(i.message.meta) : null;
          return link ? [link.threadId] : [];
        }),
      ),
    [items],
  );
  // Commands allowed without a card, a minute apart: one line for the run of them.
  const autoApproved = useMemo(
    () => groupAutoApproved(items.flatMap((i) => (i.kind === "message" ? [i.message] : []))),
    [items],
  );
  /** A closed thread is one line; the root of a thread made from a range is its marker (or stub). */
  const threadRow = (key: string, m: MessageType) => {
    // What reached an agent's conversation (a routine's report nobody answered yet, another agent's
    // answer): quiet lines, never a person's or the agent's own voice.
    if (noticeOf(m.meta)) {
      // An answer the reply that asked already shows (`ConsultGroup`): not drawn twice when that reply is close,
      // one line leading to it when it is farther up.
      const fold = consultGroups.folds.get(m.id);
      if (fold?.fold === "hide") return <Fragment key={key} />;
      if (fold?.fold === "line") return <ConsultAnswerLine key={key} message={m} fold={fold} />;
      return <NoticeLine key={key} message={m} />;
    }
    // A mission's automatic lines (the plan changed, the computer went offline, a task ended): not a voice.
    if (missionPlanChangeOf(m.meta)) return <MissionPlanChangeLine key={key} message={m} />;
    if (taskNoticeOf(m.meta)) return <TaskNoticeLine key={key} message={m} />;
    // An agent took an issue made from this conversation: one quiet line with its link.
    if (issueTakenOf(m.meta)) return <IssueTakenLine key={key} message={m} />;
    if (autoApproved.hidden.has(m.id)) return <Fragment key={key} />;
    const autoGroup = autoApproved.groups.get(m.id);
    if (autoGroup) return <AutoApprovedLine key={key} messages={autoGroup} />;
    if (!threadsView) return null;
    const info = threadsView.byId.get(m.id);
    if (info?.state === "closed") return <ClosedThreadLine key={key} thread={info} />;
    const start = threadStartOf(m.meta);
    if (start && !start.moved && linked.has(m.id)) return <Fragment key={key} />;
    // A thread that has a mission (also ones proposed before the link card existed): the same mission card.
    if (start && info?.mission) {
      return (
        <div key={key} className="mi-linkrow" data-message-id={m.id}>
          <MissionLinkCard link={{ missionId: info.mission.id, threadId: m.id }} />
        </div>
      );
    }
    return start ? <ThreadStartLine key={key} message={m} start={start} thread={info} /> : null;
  };
  // A run can post more than one message (text before a card, the card, the final reply): only its
  // last one is drawn under the block's key, the others under their own (keys stay unique).
  const blockRows = useMemo(() => blockRowByRun(items, new Set(slots.map((s) => s.runId))), [items, slots]);
  // Each run's last message here carries its browser card while a take over holds it (`HeldBrowserCard`).
  // The sticker or GIF an agent adds after its reply (ADR 0091) is never its run's last message: the reply is.
  const lastByRun = useMemo(() => {
    const out = new Map<string, string>();
    for (const i of items)
      if (i.kind === "message" && i.message.agentRunId && !isMediaAfterReply(i.message.meta))
        out.set(i.message.agentRunId, i.key);
    return out;
  }, [items]);
  // Every agent at work has its block; the ones still waiting for their first words stay last.
  const waitingKey = useStreams((s) =>
    slots
      .filter((x) => {
        const r = s.runs[x.runId];
        return r && waitsForWords(r);
      })
      .map((x) => x.runId)
      .join(" "),
  );
  const drawn = useMemo(() => {
    const waiting = new Set(waitingKey.split(" "));
    return waitingLast(slots, (runId) => waiting.has(runId));
  }, [slots, waitingKey]);
  // A take over whose run has no live block and no message here: its card at the end (`HeldBrowserRow`).
  const heldPlaces = useHeldPlaces();
  const held = useMemo(
    () =>
      heldRowsIn(heldPlaces, {
        channelId,
        visible: (threadId) => runVisible.current({ threadId: threadId ?? null }),
        live: new Set(slots.map((x) => x.runId)),
        landed: new Set(lastByRun.keys()),
      }),
    [heldPlaces, channelId, runVisible, slots, lastByRun],
  );
  const shownMessages = useMemo(() => items.flatMap((i) => (i.kind === "message" ? [i.message] : [])), [items]);
  // One stop, one pill: a stopped task's notice goes into its reply's pill while that reply (or its block) is here.
  const stops = useMemo(
    () =>
      stopsOf(
        shownMessages,
        slots.map((s) => s.runId),
      ),
    [shownMessages, slots],
  );
  const rows: ReactElement<{ message?: MessageType }>[] = [];
  const afterUnshown = () => unshown.has(rows.at(-1)?.key ?? "");
  const blockRow = (slot: RunSlot) => {
    if (!blockEnters.current.has(slot.key)) blockEnters.current.set(slot.key, ready && Date.now() - mountedAt > 1500);
    return (
      <RunBlock
        key={slot.key}
        runId={slot.runId}
        grouped={false}
        entering={blockEnters.current.get(slot.key) ?? false}
        modelLabels={modelLabels}
      />
    );
  };
  for (const [at, item] of items.entries()) {
    const grouped = item.kind === "message" && item.grouped && !afterUnshown();
    const after = items[at + 1];
    // Where it sits in its author's run: my own rows' bubbles square the corners they share.
    const run = runPosition(grouped, after?.kind === "message" && after.grouped && !unshown.has(item.key));
    if (divider?.key === item.key) {
      rows.push(
        <div key="unread-divider" className="channel__unread" data-fade={divider.fading || undefined}>
          {t("channel.unreadDivider")}
        </div>,
      );
    }
    if (item.kind === "day") {
      rows.push(
        <DayDivider key={item.key} day={item.iso}>
          {dayLabel(t, i18n.language, item.iso)}
        </DayDivider>,
      );
      continue;
    }
    if (item.kind !== "message") continue;
    const m = item.message;
    const special = threadRow(item.key, m);
    if (special) {
      rows.push(special);
      continue;
    }
    const entering = initial !== null && entersWithMotion(item.key, m.createdAt, initial, mountedAt);
    const blockKey = m.agentRunId && blockRows.get(m.agentRunId) === item.key ? runKeys.get(m.agentRunId) : undefined;
    rows.push(
      blockKey && m.agentRunId ? (
        // Seen live: the same block, grouped as it was while it worked.
        <RunBlock
          key={blockKey}
          runId={m.agentRunId}
          message={m}
          grouped={grouped}
          entering={false}
          modelLabels={modelLabels}
          contextMark={threadsView?.marks.has(m.id)}
          replyContext={item.context}
          lastOfRun={lastByRun.get(m.agentRunId) === item.key}
          run={run}
        />
      ) : (
        <TimelineMessage
          key={item.key}
          message={m}
          grouped={grouped}
          entering={entering}
          modelLabels={modelLabels}
          contextMark={threadsView?.marks.has(m.id)}
          replyContext={item.context}
          lastOfRun={Boolean(m.agentRunId && lastByRun.get(m.agentRunId) === item.key)}
          dmPersonId={dmPersonId}
          seen={m.id === seenId}
          helping={m.agentRunId && !isMediaAfterReply(m.meta) ? consultGroups.helping.get(m.agentRunId) : undefined}
          run={run}
        />
      ),
    );
  }
  rows.push(<QueueWaitTurns key="queue-waits" channelId={channelId} messages={shownMessages} />);
  for (const slot of drawn) rows.push(blockRow(slot));
  for (const place of held) rows.push(<HeldBrowserRow key={`held-${place.runId}`} place={place} />);
  // A row that fails to draw (data this build doesn't expect) is one quiet line: the rest of the conversation, the
  // sidebar and the composer keep working. Its message changing draws it again: a live block that broke has none,
  // so streaming never retries it, and its final message landing does.
  return (
    <ConsultGroupsProvider value={consultGroups}>
      <StopsProvider value={stops}>
        {rows.map((row) => (
          <ErrorBoundary
            key={row.key}
            resetKey={row.props.message}
            onError={() => markUnshown(row.key)}
            fallback={unshownLine}
          >
            {row}
          </ErrorBoundary>
        ))}
      </StopsProvider>
    </ConsultGroupsProvider>
  );
});

/**
 * A person holds the agent's browser (Assumir) for a run that has no live block and posted nothing
 * here (it paused without a word, or ended): the card stays at the end of its conversation, as the
 * agent's row, until the browser is handed back.
 */
function HeldBrowserRow({ place }: { place: HeldPlace }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const held = useHeldTakeover(place.agentId, place.runId);
  if (!held) return null;
  const name = dir.agentById.get(place.agentId)?.name ?? t("channel.unknownAgent");
  return (
    <Message
      agent
      stacked
      bare
      avatar={<AgentAvatar agentId={place.agentId} name={name} state="idle" />}
      author={name}
      time={t("common.now")}
    >
      <HeldBrowserCard agentId={place.agentId} runId={place.runId} name={name} />
    </Message>
  );
}

/** A run's last message asks whether a take over still holds its browser only this recently (older: events only). */
const HELD_RECENT_MS = 12 * 60 * 60_000;

/** Model names for the rows of "Ajustar trecho" (no usage line is shown there). */
const NO_LABELS = new Map<string, string>();

/** The live run as a message, while it has none (the block's header comes from the run): from when it started. */
function liveMessageOf(r: LiveRun): MessageType {
  return {
    id: `live:${r.runId}`,
    channelId: r.channelId,
    threadId: r.threadId,
    author: { type: "agent", id: r.agentId },
    body: "",
    mentionedAgentIds: [],
    agentRunId: r.runId,
    meta: {},
    createdAt: new Date(r.startedAt ?? Date.now()).toISOString(),
  } as MessageType;
}

/**
 * One agent's answer, from "pensando" to its final message: the live run while it works (drawn only for what it has
 * to show meanwhile, its browser card; its words show whole once posted), then the message, in the same component (same
 * element: nothing remounts or flashes). A message whose live row was drawn takes that row's place; one whose row never
 * drew slides in like any new row. Subscribed by run id, so a run's events re-render only this block.
 */
function RunBlock({
  runId,
  message,
  grouped,
  ...rest
}: {
  runId: string;
  message?: MessageType;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
  contextMark?: boolean;
  replyContext?: ReplyRef;
  lastOfRun?: boolean;
  run?: RunPosition;
}) {
  const run = useStreams((s) => (message ? undefined : s.runs[runId]));
  const last = useRef<LiveRun | undefined>(undefined);
  if (run) last.current = run;
  const live = message ? undefined : (run ?? last.current);
  const liveId = live?.runId;
  const liveAgent = live?.agentId;
  const liveChannel = live?.channelId;
  const liveThread = live?.threadId;
  const liveStart = live?.startedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the placeholder only depends on who and when
  const placeholder = useMemo(
    () => (live ? liveMessageOf(live) : null),
    [liveId, liveAgent, liveChannel, liveThread, liveStart],
  );
  // At work the bar above the composer speaks for it, and the block draws only for something to show (`rowShows`).
  // A run gone quiet meanwhile draws for "sem notícias · Atualizar": wake when that moment comes.
  const waits = Boolean(live && !message && waitsForWords(live));
  useDue(live?.lastEventAt ?? liveStart ?? null, QUIET_AFTER_MS, waits);
  const hidden = Boolean(live && !message && !rowShows(live, Date.now()));
  const shown = message ?? placeholder;
  // Its live row on the page: the view measures which blocks are in view again (the bar speaks for those out of it).
  const rowDrawn = useContext(RowDrawnContext);
  const drawnRun = live && !message && !hidden ? live.runId : null;
  useLayoutEffect(() => {
    if (drawnRun) rowDrawn?.();
  }, [drawnRun, rowDrawn]);
  const wasDrawn = useRef(false);
  if (drawnRun) wasDrawn.current = true;
  if (!shown || hidden) return null;
  // At work it never groups under the agent's own message: it starts as the waiting row with its face, and taking the
  // face away when the words arrive would move the row. Its saved message groups as any other.
  const together = message ? grouped : false;
  return (
    <TimelineMessage
      message={shown}
      live={live ?? null}
      seenLive={message ? last.current : undefined}
      grouped={together}
      {...rest}
      entering={rest.entering || Boolean(message && !wasDrawn.current)}
    />
  );
}

/**
 * "O Theo só responde a Walter.": only I see it (`agent.unavailable`, never
 * stored), right after my message that mentioned the agent.
 */
function LiveNotices({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const notices = useLive((s) => s.notices[channelId]);
  if (!notices?.length) return null;
  return (
    <>
      {notices.map((n) => (
        <p key={n.key} className="channel__notice ac-iconline" role="status">
          <Icon name="lock" size={16} />
          <span>
            {unavailableNotice(t, n, dir.agentById.get(n.agentId), (id) => dir.memberById.get(id)?.name, dir.roleName)}
          </span>
        </p>
      ))}
    </>
  );
}

/** `memory.updated` cards (live, they aren't in the message list). */
function LiveMemoryCards({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const cards = useLive((s) => s.memory[channelId]);
  return (
    <>
      {(cards ?? []).map((c) => {
        const name = dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent");
        return (
          <Message
            key={c.key}
            agent
            stacked
            bare
            avatar={<AgentAvatar agentId={c.agentId} name={name} state="idle" />}
            author={name}
            time={t("common.now")}
          >
            <MemoryChangeCard update={c.update} agentId={c.agentId} />
          </Message>
        );
      })}
    </>
  );
}

/**
 * The block's header: the time it started, as any message. What it is doing and for how long is the
 * bar's above the composer (saying it twice was noise).
 */
function RunClock({ run }: { run: LiveRun }) {
  const { i18n } = useTranslation();
  const [at] = useState(() => new Date(run.startedAt ?? Date.now()).toISOString());
  return <time dateTime={at}>{formatTime(i18n.language, at)}</time>;
}

/** The run whose live row offers its stop: the bar's rule, the latest run here the viewer may stop. */
const RowStopContext = createContext<string | undefined>(undefined);
/** Told when a run's live row is drawn, so the view measures which blocks are in view again. */
const RowDrawnContext = createContext<(() => void) | undefined>(undefined);

/** What the conversation's rows read from their view: the requests' registry, which row stops, and "a row drew". */
function RowsProvider({
  asks,
  stop,
  drawn,
  children,
}: {
  asks: AskRegistry;
  stop: string | undefined;
  drawn: () => void;
  children: ReactNode;
}) {
  return (
    <AskRegistryProvider value={asks}>
      <RowDrawnContext.Provider value={drawn}>
        <RowStopContext.Provider value={stop}>{children}</RowStopContext.Provider>
      </RowDrawnContext.Provider>
    </AskRegistryProvider>
  );
}

/**
 * The end of an agent's live row: "· 12 s" (the bar's clock) and its stop. The bar says neither while the row is on
 * screen, so they sit where the eye already is. The clock keeps its room from the start, so the stop never shifts
 * when the seconds appear.
 */
function RunTail({ run }: { run: LiveRun }) {
  const { t } = useTranslation();
  const atWork = run.status === "thinking" || run.status === "queued" || run.status === "running";
  const now = useSecond(atWork);
  const stoppable = useContext(RowStopContext) === run.runId;
  const { stop } = useStopRun();
  if (!atWork && !stoppable) return null;
  return (
    <span className="run-tail">
      {atWork && <span className="run-tail__clock ac-num">{runElapsed(t, run, now)}</span>}
      {stoppable && <StopButton run={run} onStop={stop} place="row" />}
    </span>
  );
}

/** Under a live block: "sem notícias há 4 min · Atualizar" (what it does now is the bar's to say). */
function LiveRunStatus({ run }: { run: LiveRun }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const liveStore = useLiveStore();
  // A run with no news for minutes (orphaned by a restart?): say so and offer to check.
  const [, tick] = useState(0);
  useEffect(() => {
    const again = () => tick((n) => n + 1);
    const timer = setInterval(again, 15_000);
    // Back to the tab after a while: check right away.
    window.addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, []);
  const [checking, setChecking] = useState(false);
  if (!isQuiet(run)) return null;
  const recheck = () => {
    setChecking(true);
    void reconcileChannelRuns(api, liveStore, org.id, run.channelId, [run.runId])
      .then((dropped) => {
        if (dropped) void qc.invalidateQueries({ queryKey: keys.messages(org.id, run.channelId) });
      })
      .finally(() => setChecking(false));
  };
  return (
    <div className="run-status">
      <p className="ac-msg__activity run-quiet">
        {t("run.quiet", {
          minutes: Math.max(3, Math.floor((Date.now() - (run.lastEventAt ?? run.startedAt ?? 0)) / 60_000)),
        })}
        {" · "}
        <Button variant="ghost" size="sm" loading={checking} onClick={recheck}>
          {t("run.refresh")}
        </Button>
      </p>
    </div>
  );
}

/**
 * Under a stopped answer: "Parado por você · Continuar", or "No limite de passos · Continuar" under the
 * reply of a run that reached its step limit, or just Continuar under the end of a long work its AI provider failed. Continuar starts a new run of the same agent from where it
 * stopped; it goes away for everyone once someone pressed it.
 */
function StoppedLine({
  runId,
  byUserId,
  note,
  limit,
  owner,
  message,
}: {
  runId: string | null | undefined;
  byUserId: string | null | undefined;
  /** The server's line, for older messages without a person in the meta. */
  note?: string | null;
  /**
   * The run ended at its step limit, or because it got stuck (`meta.stepLimit`), or its long work failed on its AI
   * provider (`meta.workEnd`, whose text already says so): nobody stopped it.
   */
  limit?: "steps" | "stuck" | "failed";
  /** Who may continue: the same people who may stop it. */
  owner: { agentId: string; channelId: string; threadId: string; triggerMessageId?: string | null } | null;
  /** The stopped reply, once it is saved (its meta says when it was continued). */
  message?: MessageType;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const { canStop } = useStopRun();
  const cont = useContinueRun();
  const continued = useWasContinued(runId, message);
  const stop = useStopNotice(runId);
  // Its words when no person stopped it: the step limit, stuck; long work its provider cut off says it in its text.
  const fallback = limit ? (limit === "failed" ? null : t(limit === "stuck" ? "run.stuck" : "run.stepLimit")) : note;
  const said = Boolean(stop || byUserId || fallback);
  // Only a run a person stopped, one at its step limit, or long work its provider cut off, picks up again.
  const can = Boolean(runId && (byUserId || stop || limit) && owner && !continued && canStop(owner));
  if (!said && !can) return null;
  // Nothing to say (its text already says why): Continuar alone.
  if (!said && runId)
    return (
      <p className="ac-msg__activity run-canceled">
        <button type="button" className="run-continue" disabled={cont.isPending} onClick={() => cont.mutate(runId)}>
          <Icon name="play" size={14} />
          {t("run.continueRun")}
        </button>
      </p>
    );
  const go =
    can && runId ? (
      <EventPillAction
        lead={<Icon name="play" size={14} />}
        disabled={cont.isPending}
        onClick={() => cont.mutate(runId)}
      >
        {t("run.continueRun")}
      </EventPillAction>
    ) : undefined;
  const agent = owner ? (dir.anyAgent(owner.agentId)?.name ?? t("channel.unknownAgent")) : t("channel.unknownAgent");
  return (
    <StopPill
      agent={agent}
      who={{ notice: stop?.notice, at: stop?.at, byUserId }}
      fallback={fallback}
      cont={go}
      channelId={owner?.channelId ?? message?.channelId ?? ""}
      className="run-canceled"
    />
  );
}

/** Shows only after `ms` while `on` ("enviando" waits half a second: most sends never show it). */
/** True from `from + ms` on (now when `from` is unknown, i.e. counted from the mount), while `on`. */
function useDue(from: number | null, ms: number, on: boolean) {
  const [start] = useState(() => Date.now());
  const at = (from ?? start) + ms;
  const [, tick] = useState(0);
  const wait = at - Date.now();
  useEffect(() => {
    if (!on || wait <= 0) return;
    const again = () => tick((n) => n + 1);
    const timer = setTimeout(again, wait);
    // Back to the tab after a while: look again at once (a sleeping computer's timers run late).
    window.addEventListener("focus", again);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", again);
    };
  }, [on, wait]);
  return !on || wait <= 0;
}

function useAfter(ms: number, on: boolean) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms, on]);
  return on && late;
}

/**
 * Above the composer when the connection drops: "Sem conexão. O que você mandar sai sozinho quando
 * voltar." (what is sent meanwhile waits and goes out on its own), then "Conectado de novo" for 1.6 s.
 * A socket that only reconnects for a moment says nothing.
 */
function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  const { t } = useTranslation();
  const offline = useBrowserOffline();
  const reconnecting = status === "reconnecting";
  const [longReconnect, setLongReconnect] = useState(false);
  useEffect(() => {
    if (!reconnecting) {
      setLongReconnect(false);
      return;
    }
    const timer = setTimeout(() => setLongReconnect(true), 1500);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  const down = offline || (reconnecting && longReconnect);
  const [back, setBack] = useState(false);
  const wasDown = useRef(false);
  useEffect(() => {
    if (down) {
      wasDown.current = true;
      setBack(false);
      return;
    }
    if (!wasDown.current) return;
    wasDown.current = false;
    setBack(true);
    const timer = setTimeout(() => setBack(false), 1600);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down && !back) return null;
  return (
    <p className="channel__conn ac-iconline" data-back={!down || undefined} role="status">
      <Icon name={down ? "cloud" : "check"} size={16} />
      {down ? t("channel.offline") : t("channel.backOnline")}
    </p>
  );
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * The live blocks (`data-run-id`) at least partly inside the scroller: measured once when they come
 * (no frame of the line above the composer for a block in plain sight), then by an IntersectionObserver.
 */
function useBlocksInView(scroller: { current: HTMLElement | null }, key: string) {
  const [inView, setInView] = useState<Set<string>>(() => new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` changes when blocks come or go
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-run-id]"));
    const box = root.getBoundingClientRect();
    const now = new Set<string>();
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.height > 0 && r.bottom > box.top && r.top < box.bottom) now.add(row.dataset.runId ?? "");
    }
    setInView((prev) => (sameSet(prev, now) ? prev : now));
    if (typeof IntersectionObserver === "undefined" || rows.length === 0) return;
    const io = new IntersectionObserver(
      (entries) =>
        setInView((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.runId ?? "";
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return sameSet(prev, next) ? prev : next;
        }),
      { root, threshold: 0 },
    );
    for (const row of rows) io.observe(row);
    return () => io.disconnect();
  }, [key]);
  return inView;
}

const sameAsks = (a: PendingAsk[], b: PendingAsk[]) => a.length === b.length && a.every((x, i) => sameAsk(x, b[i]));

/** Earlier in the conversation first. */
const byPlace = (a: HTMLElement, b: HTMLElement) =>
  a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

/**
 * The requests waiting for the viewer whose cards are out of the scroller's view, in the conversation's order.
 * A card counts as on screen once 40px of it show at the top or 60px at the bottom (the composer's fade).
 * The cards register themselves (`AskRegistry`) and one IntersectionObserver watches them, so nothing scans the
 * rows while an agent writes; the list is published only when it changes.
 */
function useAsksOutOfView(scroller: { current: HTMLElement | null }, registry: AskRegistry, on: boolean) {
  const [out, setOut] = useState<PendingAsk[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list only exists for members; re-attach when it appears
  useEffect(() => {
    const root = scroller.current;
    setOut((prev) => (prev.length === 0 ? prev : []));
    if (!root || typeof IntersectionObserver === "undefined") return;
    // Each card: on screen (true), off (false), or not measured yet (null: not said, so no flash in the bar).
    const seen = new Map<HTMLElement, boolean | null>();
    const publish = () => {
      const next = [...registry.cards]
        .filter(([el]) => seen.get(el) === false)
        .sort(([a], [b]) => byPlace(a, b))
        .map(([, ask]) => ask);
      setOut((prev) => (sameAsks(prev, next) ? prev : next));
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (seen.has(el)) seen.set(el, e.isIntersecting);
        }
        publish();
      },
      { root, rootMargin: "-40px 0px -60px 0px", threshold: 0 },
    );
    // A card came, changed or left: watch the new ones, let go of the gone, say what changed.
    const sync = () => {
      for (const el of [...seen.keys()]) {
        if (registry.cards.has(el)) continue;
        io.unobserve(el);
        seen.delete(el);
      }
      for (const el of registry.cards.keys()) {
        // Only cards inside this scroller: anywhere else they would never read as in view.
        if (seen.has(el) || !root.contains(el)) continue;
        seen.set(el, null);
        io.observe(el);
      }
      publish();
    };
    const unsubscribe = registry.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      io.disconnect();
    };
  }, [registry, on]);
  return out;
}

/**
 * The bar right above the composer, one for everyone at work here and always one width: a glass pill (in
 * the first agent's color while agents work), their small faces (the typing dots first when only people type)
 * and one line that says it all. An agent whose live row is on screen is left out: the row says its step, its
 * time and its stop. Its row out of view, or no words of its own yet (there is no thinking row in the conversation),
 * the bar speaks for it: its face, its step, its time, "Ver" once its row is there, and its stop.
 */
function ActivityBar({
  channelId,
  threadId,
  visible,
  outOfView,
  onSee,
  asks,
  onSeeAsk,
  stoppable,
  consultBlocks,
}: {
  channelId: string;
  /** A thread view: who types there (null: who types in the conversation itself). */
  threadId: string | null;
  /** Which runs belong here (a thread view shows only its own). */
  visible?: { current: (r: { threadId: string | null; provisional?: boolean }) => boolean };
  /** The run's block is not on screen ("Ver" brings it back). */
  outOfView: (runId: string) => boolean;
  /** "Ver": back to that block. */
  onSee: (runId: string) => void;
  /** Requests waiting for the viewer out of view: the bar says the first one instead of who works. */
  asks: PendingAsk[];
  /** "Ver" on a request: scrolls to it and lights it up. */
  onSeeAsk: (id: string) => void;
  /** The run Esc stops (the pill shows its stop). */
  stoppable?: string;
  /** Runs whose questions a block near the end shows (`ConsultGroup`): the line doesn't say them again. */
  consultBlocks: ReadonlySet<string>;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const all = useStreams((s) => runsInChannel(s, channelId).filter((r) => visible?.current(r) ?? true), sameRuns);
  const runs = all.filter((r) => r.status !== "failed");
  const typing = useLive((s) => s.typing[channelId]);
  // Ticks while someone is on it (a question out counts: seen on the last render).
  const asking = useRef(false);
  const now = useSecond(runs.length > 0 || Boolean(typing) || asking.current);
  // An agent asking another one: "Dev está perguntando ao Infra… 0:12" (its run pauses meanwhile).
  const heard = useLive(
    (s) => consultsIn(s.consults, channelId, now).filter((c) => visible?.current(c) ?? true),
    sameList,
  );
  // A reply near the end shows its questions with where each is and its clock: the asker's own work stays here.
  const consults = consultsForLine(heard, consultBlocks);
  asking.current = consults.length > 0;
  const ids = typingIn({ [channelId]: typing ?? {} }, channelId, now, me.user.id, threadId);
  // At work, its row shows only what it has to show meanwhile (its browser card): the bar says what it does, for how
  // long, and stops it. A row that says all that (none at work now) leaves the agent out while it is in view.
  const rowInView = (r: LiveRun) => !waitsForWords(r) && !outOfView(r.runId);
  const entries = entriesOffScreen(
    barEntries(
      runs,
      ids,
      (id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"),
      (id) => dir.memberById.get(id)?.name,
      consults,
    ),
    runs,
    rowInView,
  );
  const { stop } = useStopRun();
  const active = entries.length > 0;
  const agents = entries.filter((e) => e.type === "agent");
  // The strip behind the bar (and the orbit) take the color of the first agent at work.
  const firstAgent = agents[0];
  // The time, "Ver" and the stop are one agent's: with several, the line can't say whose (the composer still stops).
  const soloRun = agents.length === 1 && firstAgent ? runs.find((r) => r.agentId === firstAgent.id) : undefined;
  // Only while its row is out of view (a question it asks keeps its phrase here, its row in view or not).
  const soloAway = soloRun && !rowInView(soloRun) ? soloRun : undefined;
  const took = soloAway ? barElapsed(t, entries, runs, now) : null;
  // The row's own words for what it does now, after its name; a question out keeps its own phrase.
  const step = soloAway && firstAgent && !firstAgent.consult ? barStep(t, soloAway, i18n.language, now) : null;
  // Agents running code: "Ver código" with the live code and output.
  const coding = runs.filter(
    (r) => !rowInView(r) && r.code && (r.work ?? []).some((w) => w.kind === "call" && w.running),
  );
  // An agent working in its browser: the bar says so, and a click opens its browser card in the conversation.
  // Its row in view draws its browser card itself.
  const browsing = runs.find((r) => usesBrowser(r) && !rowInView(r));
  const openBrowser = browsing ? () => requestBrowserCard({ agentId: browsing.agentId }) : undefined;
  // A request waiting for you, out of view: the bar says that instead (waiting beats working).
  const ask = asks[0];
  const askName = ask ? (dir.anyAgent(ask.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const pill = !ask && active;
  return (
    <>
      {coding.map((r) =>
        r.code ? (
          <LiveCodeToggle
            key={r.runId}
            name={dir.agentById.get(r.agentId)?.name ?? t("channel.unknownAgent")}
            code={r.code}
            output={r.output ?? []}
          />
        ) : null,
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the "No navegador" button inside is the keyboard way; the pill is a bigger target */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same */}
      <div
        className="ac-typing"
        aria-live="polite"
        data-active={active || Boolean(ask)}
        data-ask={ask ? true : undefined}
        data-browser={pill && openBrowser ? true : undefined}
        onClick={
          pill && openBrowser
            ? (e) => {
                // Its own buttons (Ver) keep their job.
                if ((e.target as HTMLElement).closest("button, [role=dialog]")) return;
                openBrowser();
              }
            : undefined
        }
      >
        {ask && (
          <>
            <ActivitySky color={colorOf(dir.anyAgent(ask.agentId))} />
            <span className="ac-typing__avatars" aria-hidden="true">
              <span className="ac-typing__tok">
                <AgentAvatar agentId={ask.agentId} size="xs" name={askName} state="waiting" />
              </span>
            </span>
            <WaitMark />
            <span className="ac-typing__text">
              {/* What it asks is the agent's or a person's own text: shown as written, never read as markup. */}
              <Trans
                i18nKey={`ask.bar.${ask.kind}` as const}
                values={{ name: askName, what: ask.what }}
                components={{ b: <b /> }}
                {...TYPED_VALUES}
              />
            </span>
            {asks.length > 1 && (
              <span className="ac-typing__more">{t("ask.bar.more", { count: asks.length - 1 })}</span>
            )}
            <span className="ac-typing__sep" aria-hidden="true" />
            <button type="button" className="ac-typing__see" onClick={() => onSeeAsk(ask.id)}>
              {t("ask.bar.see")}
            </button>
            {/* An agent still at work keeps its stop at the end; the line stays the request. */}
            {soloAway && stoppable === soloAway.runId && <StopButton run={soloAway} onStop={stop} place="bar" />}
          </>
        )}
        {pill && (
          <>
            {firstAgent && <ActivitySky color={colorOf(dir.agentById.get(firstAgent.id))} />}
            {/* Agents at work: their faces open the pill (their rows are out of view); people only typing: the dots
                first. */}
            {!firstAgent && (
              <span className="ac-typing__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            )}
            <WorkingStack entries={entries} />
            {/* The phrase turns: the old one leaves upward, the new one comes from below. Names in ink. */}
            <span className="ac-typing__text">
              {step !== null && firstAgent ? (
                <BarStep name={firstAgent.name} step={step} />
              ) : (
                <BarPhrase entries={entries} />
              )}
            </span>
            <ConsultClock entries={entries} now={now} />
            {took && <span className="ac-typing__elapsed ac-num">{took}</span>}
            {step !== null && <BarAlsoTyping entries={entries} />}
            {openBrowser && (
              <Button
                size="sm"
                variant="ghost"
                icon="globe"
                iconOnly
                className="ac-typing__browser"
                aria-label={t("browser.watch.title")}
                title={t("browser.watch.open")}
                onClick={openBrowser}
              />
            )}
            {/* "Ver" once its row is in the conversation (before that, there is nothing to go back to). */}
            {soloAway && rowShows(soloAway, now) && (
              <>
                <span className="ac-typing__sep" aria-hidden="true" />
                <button type="button" className="ac-typing__see" onClick={() => onSee(soloAway.runId)}>
                  {t("run.strip.see")}
                </button>
              </>
            )}
            {soloAway && stoppable === soloAway.runId && <StopButton run={soloAway} onStop={stop} place="bar" />}
          </>
        )}
      </div>
    </>
  );
}

/**
 * One row; agent replies get feedback actions, people's messages get receipts. With `live`, the agent's
 * answer while it works (its steps, its words arriving, how to stop it): the same component, so the
 * final message takes over in place (`RunBlock`).
 */
export const TimelineMessage = memo(function TimelineMessage({
  message: m,
  grouped,
  entering,
  modelLabels,
  contextMark,
  replyContext,
  live = null,
  seenLive,
  lastOfRun = false,
  dmPersonId,
  seen = false,
  helping,
  readOnly = false,
  run = "solo",
}: {
  message: MessageType;
  grouped: boolean;
  entering: boolean;
  modelLabels: Map<string, string>;
  /** Part of a thread's context (still in the channel): the quiet mark in the gutter. */
  contextMark?: boolean;
  /** Shown away from the message it answers: that message, quoted above (`buildTimeline`). */
  replyContext?: ReplyRef;
  /** The run still at work (the row is its live block; `message` is a placeholder). */
  live?: LiveRun | null;
  /** This answer was watched live here: its last live state (the steps fold into "3 passos"). */
  seenLive?: LiveRun;
  /** The last message of its run here: it carries the run's browser card while a take over holds it. */
  lastOfRun?: boolean;
  /** A DM with this person: my turn's time line keeps the slot of their face (`SeenMark`). */
  dmPersonId?: string;
  /** My latest message, which they read: their face in that slot. */
  seen?: boolean;
  /** Posted by a run answering another agent's question from here: "ajudando o Theo · Ver conversa". */
  helping?: RunConsultation;
  /** Shown where the person can't act on it (a question opened in the panel): no feedback, reactions or menu. */
  readOnly?: boolean;
  /** Its place in its author's run (`runPosition`): on my own rows, which bubble corners square off. */
  run?: RunPosition;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const qc = useQueryClient();
  const dismissRun = useDismissRun();
  const liveFailed = live?.status === "failed";
  const failedWhy = liveFailed ? runErrorText(t, live?.errorCode, live?.errorParams) : null;
  // Refused by the workspace's standing: its own words, not the server's English.
  const refusal = liveFailed ? restrictionLine(t, live?.errorCode, live?.errorParams) : null;
  const liveWaiting = live?.status === "waiting_approval";
  // At work: its words show whole once posted. Meanwhile its face and what it has to show (its browser card, a quiet
  // run's notice), no name or time; the bar above the composer says what it does, for how long, and stops it.
  const waiting = Boolean(live && waitsForWords(live));
  // A sent message that waits for the connection: not "Não enviada", it goes out on its own.
  const queued = useWaiting(m.local === "failed" ? m.clientId : undefined);
  const local = m.local === "failed" && queued ? "pending" : m.local;
  const slowSend = useAfter(500, local === "pending");
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const pushAsk = useContext(PushAskContext);
  const threadsView = useChannelThreadsView();
  const threadLine = threadsView?.lines.get(m.id);
  const [active, setActive] = useState(false);
  const agent = m.author.type === "agent" ? dir.agentById.get(m.author.id ?? "") : undefined;
  const person = m.author.type === "person" ? dir.memberById.get(m.author.id ?? "") : undefined;
  // An agent's message that mentions agents has one too: whom it handed work to, and who it only mentioned (ADR 0089).
  const receipted = (m.author.type === "person" || m.mentionedAgentIds.length > 0) && !m.local;
  // Mine in a DM between people: the slot of their face, from the moment it is sent, so it never rewraps a line.
  const own = m.author.type === "person" && m.author.id === me.user.id;
  const seenSlot = dmPersonId !== undefined && own;
  const name = dir.authorName(m.author);
  // What a routine found, told by its agent (`meta.routine`): a tag that opens the routine, and the report
  // it answers on demand (that report's own line folds into this message).
  const routine = routineReplyOf(m);
  const [reportOpen, setReportOpen] = useState(false);
  const report = routine?.noticeId
    ? routineReportText(
        [
          ...(qc.getQueryData<MessageType[]>(keys.messages(org.id, m.channelId)) ?? []),
          ...((m.threadId && qc.getQueryData<MessageType[]>(keys.thread(org.id, m.channelId, m.threadId))) || []),
        ],
        routine.noticeId,
      )
    : null;
  // A short reply it gave while its task kept working (the talker): its message, "enquanto trabalha".
  const talker = m.author.type === "agent" && isTalkerReply(m.meta);
  const wikiLink = useWikiLinkRenderer();
  /** A message that went into this run's work, as the well inside it shows it. */
  const steerNote = (messageId: string): SteerNote | undefined => {
    const lists = [
      qc.getQueryData<MessageType[]>(keys.messages(org.id, m.channelId)),
      m.threadId ? qc.getQueryData<MessageType[]>(keys.thread(org.id, m.channelId, m.threadId)) : undefined,
    ];
    const found = lists.flatMap((l) => l ?? []).find((x) => x.id === messageId);
    if (!found) return undefined;
    return {
      author: dir.authorName(found.author),
      mine: found.author.type === "person" && found.author.id === me.user.id,
      text: plainLine(textOrMedia(t, found.body, found.meta)),
    };
  };
  // A stopped run's message (`meta.canceled`): the text so far, and "Interrompido por Walter" as a note.
  // A text the server wrote (`meta.bodyCode`, a deploy's notice) is shown in the person's language.
  const stopped = useMemo(
    () => splitCanceled(serverBody(t, m.body, m.meta, i18n.language), m.meta),
    [t, m.body, m.meta, i18n.language],
  );
  const said = reminderBody(stopped.body, m.meta);
  // A long work's anchor once it's over: no promise left, and dimmed (its line says how it ended).
  const body = m.longWork ? workAnchorBody(t, said, m.meta, m.longWork) : said;
  const workOver = Boolean(m.longWork && workIsOver(m.longWork));
  // The person's pick on a choice card (ADR 0124): one compact line.
  const choiceReply = Boolean(m.meta?.choiceReply);
  // My own message with a code block or a table: the bubble takes the row's whole width.
  const wide = useMemo(() => own && hasWideBlock(body), [own, body]);
  // A long message from one agent to another (ADR 0034): its first paragraph here and "Ler tudo", which opens it
  // whole in its thread, beside the chat. In a thread view (no panel), where it is already read, it stays whole.
  const openThread = !live && !m.local && !readOnly ? actions?.openThread : undefined;
  const talk = useMemo(
    () =>
      openThread && talksToAgent(m, (handle) => dir.agentByHandle.get(handle)?.id)
        ? foldTalk(body, TALK_LINE_CHARS.web)
        : null,
    [openThread, m, body, dir.agentByHandle],
  );
  const talkThread = m.threadId ?? m.id;
  // The reply of a run that reached its step limit, or that stopped because it got stuck: Continuar under it too.
  const ended = stopped.canceled ? undefined : (m.meta?.stepLimit as { stuck?: unknown } | undefined);
  const atLimit = ended ? (ended.stuck === true ? "stuck" : "steps") : undefined;
  // A long work's end after its AI provider failed: Continuar under it as well.
  const providerCut = m.author.type === "agent" && Boolean(workContinuable(m.meta));

  const channelName = useChannels(org.id).data?.find((c) => c.id === m.channelId)?.name;
  // A plain reminder: the agent's own message, with a small "Reminder" label.
  const reminder = isReminderMessage(m.meta);
  const via = m.author.type === "person" ? appVia(m.meta) : null;
  const myHandle = dir.memberById.get(me.user.id)?.handle?.toLowerCase();
  const mentionsMe =
    !(m.author.type === "person" && m.author.id === me.user.id) && mentionsReader({ body, meta: m.meta }, myHandle);
  const renderMention = (handle: string, key: string) => {
    // The mention of everyone: the reader's own word, marked as a mention of them.
    if (isEveryoneMention(m.meta, handle))
      return (
        <Mention key={key} className="ac-mention--me">
          @{everyoneWord(i18n.language)}
        </Mention>
      );
    const a = dir.agentByHandle.get(handle.toLowerCase());
    const p = a ? undefined : dir.memberByHandle.get(handle.toLowerCase());
    if (!a && !p) return `@${handle}`;
    const isMe = !!p && p.userId === me.user.id;
    const actor = a ? { type: "agent" as const, id: a.id } : { type: "person" as const, id: p?.userId ?? "" };
    const shown = a?.name ?? p?.name ?? handle;
    return (
      <ProfileTrigger
        key={key}
        actor={actor}
        label={t("profile.of", { name: shown })}
        className="profile-trigger--mention"
      >
        <Mention tone={dir.mentionTone(handle)} className={isMe ? "ac-mention--me" : undefined}>
          @{shown}
        </Mention>
      </ProfileTrigger>
    );
  };
  const meta = m.meta ?? {};
  const approvalId = typeof meta.approvalId === "string" ? meta.approvalId : null;
  const proposalId = typeof meta.proposalId === "string" ? meta.proposalId : null;
  const memoryUpdates = Array.isArray(meta.memoryUpdates)
    ? (meta.memoryUpdates as MemoryUpdate[]).filter(isMemoryUpdate)
    : [];
  const question = isQuestion(meta.question) ? meta.question : null;
  const secretRequest = isSecretRequest(meta.secretRequest) ? meta.secretRequest : null;
  // The agent needs a person in its browser (ADR 0040): the request card.
  const browserHandoff = m.author.type === "agent" ? browserHandoffOf(meta) : null;
  // Where it browsed (`meta.browser`) and what it did on its desktop (`meta.desktop`): each card stays
  // after the run, and its steps leave the work list.
  // Step summaries, no picture: activity, so the person's setting hides them like the tool block.
  const trailsShown = m.author.type === "agent" && showsActivity(org);
  const browserTrail = useMemo(() => (trailsShown ? browserTrailOf(m.meta) : []), [trailsShown, m.meta]);
  const desktopTrail = useMemo(() => (trailsShown ? desktopTrailOf(m.meta) : []), [trailsShown, m.meta]);
  const onCards = useMemo(
    (): ScreenKind[] => [
      ...(browserTrail.length > 0 ? (["browser"] as const) : []),
      ...(desktopTrail.length > 0 ? (["desktop"] as const) : []),
    ],
    [browserTrail, desktopTrail],
  );
  // Files an agent made, or a person attached.
  const artifacts = artifactRefs(meta);
  // A GIF or a sticker (ADR 0091); with no words, the message is the picture alone.
  const media = useMemo(() => messageMediaOf(m.meta), [m.meta]);
  // A voice message is its recording: the player, and no text (ADR 0100).
  const voice = useMemo(() => voiceOf(m.meta), [m.meta]);
  // The one an agent adds after its own reply: a message of its own, not a reply (no feedback, no run's cards).
  const mediaAfter = isMediaAfterReply(m.meta);
  // The run this message answers for (its steps, its browser, the questions it asked): none for that one.
  const replyRun = mediaAfter ? null : m.agentRunId;
  // "Responder": the message this one quotes.
  const quoted = useMemo(() => replyOf(m.meta) ?? replyContext ?? null, [m.meta, replyContext]);
  // A mission's cards (ADR 0029): the plan, a decision, a review; a report says where it ran.
  const missionPlan = m.author.type === "agent" ? missionPlanOf(meta) : null;
  const missionDecision = m.author.type === "agent" && meta.missionDecision ? m : null;
  const missionReview = m.author.type === "agent" && meta.missionReview ? m : null;
  // The mission's end: what was delivered, what to check, Concluir missão / Pedir ajustes.
  const missionDelivery = m.author.type === "agent" && meta.missionDelivery ? m : null;
  // The executor asks to run a command off its allow list: the command card (Aprovar / Recusar / Aprovar sempre).
  const missionCommand = m.author.type === "agent" ? missionCommandOf(meta) : null;
  const missionReport = m.author.type === "agent" ? missionReportOf(meta) : null;
  const missionSuggestion = m.author.type === "person" ? missionSuggestionOf(meta) : null;
  // A mission proposed from here whose thread lives elsewhere: its link card under the reply.
  const missionLink = m.author.type === "agent" ? missionLinkOf(meta) : null;
  // Preparing the mission's copy of the project failed (ADR 0044): the card with "Tentar de novo".
  const missionSetup = missionSetupOf(meta);
  const missionCard = Boolean(
    missionPlan || missionDecision || missionReview || missionDelivery || missionCommand || missionSetup,
  );
  // The root of a mission in the channel: its work lives in its thread.
  const missionStart = !m.threadId && Boolean(meta.missionStart) && actions?.openThread !== undefined;
  // It asked other agents before answering: one row right before the reply, its run's questions (on the run's last
  // message here; a run at work shows them on none until its reply comes, the working line says them) and the ones
  // its `meta.consulted` names.
  const consulted = useMemo(() => (m.author.type === "agent" ? consultationsOf(m.meta) : []), [m.author.type, m.meta]);
  const reached = useMemo(() => reachHandoffs(m.meta), [m.meta]);
  const consults = useReplyConsults(
    m.author.type !== "agent" || m.local ? null : live ? m.agentRunId : lastOfRun ? replyRun : null,
    consulted,
    !live,
    reached,
  );
  const pair =
    m.author.type === "agent" && m.author.id && consults.length > 0 ? (
      <ConsultPairRow askerId={m.author.id} items={consults} />
    ) : null;
  // Nobody called it: it joined the conversation on its own (`meta.joined`).
  const joined = m.author.type === "agent" && meta.joined === true;
  const joinedTip = joined ? t("chat.joined.tip", agentGrammar(name)) : null;
  // The root of an issue's work thread (the person asked the agent to implement it): the issue card, no text.
  const issueWork = issueWorkOf(meta);
  // "O Claude Code não está disponível agora": its computer is offline; one card that waits, then says it's back.
  const brainNotice = m.author.type === "agent" ? brainUnavailableOf(meta) : null;
  const waitNotice = brainNotice && isOfflineNotice(brainNotice) ? brainNotice : null;
  // An agent's run parked until a device it named is back: one card that waits, then says it's back.
  const deviceWait = m.author.type === "agent" ? deviceWaitOf(meta) : null;
  // "Ada não vai responder porque não tem uma IA conectada": one card with Connect, in place of its text.
  const noAi = m.author.type === "agent" && noAiCardOf(meta) !== null;
  // An agent's card whose button opens the app's own dialog, filled in ("Conectar uma IA para Ada").
  const actionCard = m.author.type === "agent" && actionCardOf(meta) !== null;
  // Lodi's weekly card opens with its week in words: the message's text, in a bubble where words go, the card under it.
  const weekCard = actionCard && actionCardOf(meta)?.kind === "team_week";
  // "I'll answer when the plan resets": "Don't run it" while that run still waits.
  const usageWait = m.author.type === "agent" ? usageWaitOf(meta) : null;
  const card =
    approvalId ||
    waitNotice ||
    deviceWait ||
    noAi ||
    actionCard ||
    proposalId ||
    memoryUpdates.length > 0 ||
    question ||
    secretRequest ||
    missionCard ||
    issueWork;
  const feedback = !readOnly && m.author.type === "agent" && !card && !m.local && !live && !mediaAfter;
  const menu = useMessageMenu(m, channelName ?? "", {
    feedback,
    readOnly,
    agentName: agent?.name ?? t("channel.unknownAgent"),
  });
  // A row with a bar has the same actions in a menu that a tap opens on touch (an agent's sticker gets a person's).
  const personBar = (m.author.type === "person" || mediaAfter) && !m.local;
  const barred = !readOnly && (feedback || personBar);
  // Watched live here: the steps it took stay in the block, folded ("3 passos"), instead of the summary.
  const keptAll = seenLive?.work?.length ? seenLive.work : null;
  const keptSteps =
    keptAll && onCards.length > 0
      ? keptAll.filter((w) => !(w.kind === "call" && onCards.some((s) => isScreenTool(w.tool, s))))
      : keptAll;
  // What's in a `MessageText`, for the bubbles: the name opens the first, the time ends the last (a row with none keeps
  // them above its cards). At work, nothing: its words show whole once posted.
  const bodyShown = live
    ? false
    : !missionCard &&
      // A request says its action itself ("Pedido de aprovação: …" would repeat it).
      !approvalId &&
      // A secret request's card names the key itself: its fallback text ("Theo asked for a key") is for pushes.
      !secretRequest &&
      !issueWork &&
      !waitNotice &&
      !noAi &&
      !(actionCard && !weekCard) &&
      // A question's card already says it: its own text isn't repeated above.
      !(question && body.trim() === question.text.trim()) &&
      !voice &&
      !choiceReply &&
      Boolean(body.trim() || (!card && !stopped.canceled && artifacts.length === 0 && !media));
  // People see name, time and text; the date, model and tokens wait behind the time. An agent's sticker after its
  // reply carries the reply's run: its model and tokens are the reply's, never said twice.
  const usage = m.author.type === "agent" && !mediaAfter ? messageUsage(m) : null;
  const details = [
    formatFullDate(i18n.language, m.createdAt),
    usage ? usageLine(t, i18n.language, usage, { modelLabel: modelLabels.get(usage.model) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {pair}
      <Message
        agent={m.author.type === "agent"}
        data-message-id={live ? undefined : m.id}
        data-run-id={live?.runId}
        data-live={live?.status}
        // What someone else wrote (an agent's answer, a teammate's message): lands at its start when long, read
        // from the top (an answer shares its live block's id, so only once). Never your own message.
        data-read-id={
          m.local
            ? undefined
            : m.author.type === "agent"
              ? (replyRun ?? m.id)
              : m.author.type === "person" && m.author.id !== me.user.id
                ? m.id
                : undefined
        }
        grouped={grouped && !waiting && !pair}
        own={own}
        run={run}
        bare={waiting || !bodyShown}
        quote={quoted ? <QuotedMessage reply={quoted} /> : undefined}
        nameColor={dir.nameColorOf(m.author)}
        waiting={waiting}
        entering={entering}
        streaming={Boolean(live) && !liveFailed && !liveWaiting}
        className={cx(
          local && `ac-msg--local ac-msg--${local}`,
          contextMark && "msg--context",
          mentionsMe && "ac-msg--mentions-me",
          wide && "ac-msg--wide",
        )}
        onMouseEnter={feedback ? () => setActive(true) : undefined}
        onFocus={feedback ? () => setActive(true) : undefined}
        onContextMenu={live || readOnly ? undefined : menu.onContextMenu}
        avatar={
          m.author.id ? (
            <ProfileTrigger
              actor={{ type: m.author.type, id: m.author.id }}
              label={t("profile.of", { name })}
              decorative
            >
              {m.author.type === "agent" ? (
                // At work: thinking, then writing; a saved message: the agent at rest (one no longer in the team too).
                // A person's 👍/👎 on this message plays a face on it (`applyReactions`).
                // Both wear their presence badge (ADR 0084).
                <AgentAvatar
                  agentId={m.author.id}
                  name={name}
                  state={live ? agentStateOfRun(live) : "idle"}
                  reactionKey={live ? undefined : m.id}
                  presence
                />
              ) : person ? (
                <PersonAvatar id={person.userId} name={name} presence />
              ) : (
                <Avatar kind="person" name={name} />
              )}
            </ProfileTrigger>
          ) : m.author.type === "agent" ? (
            <AgentAvatar name={name} />
          ) : (
            <Avatar kind="person" name={name} imageUrl={person?.image} />
          )
        }
        author={
          m.author.id ? (
            <>
              <ProfileTrigger
                actor={{ type: m.author.type, id: m.author.id }}
                label={t("profile.of", { name })}
                className="profile-trigger--name"
              >
                {name}
              </ProfileTrigger>
              {/* The author's written status: its emoji, its words on hover (ADR 0084). */}
              <AuthorStatus actor={{ type: m.author.type, id: m.author.id }} />
              {reminder && (
                <span className="msg-reminder">
                  <Icon name="bell" size={14} />
                  {t("channel.reminder")}
                </span>
              )}
              {routine && (
                <RoutineTag
                  routine={routine}
                  report={report}
                  open={reportOpen}
                  onToggle={() => setReportOpen((o) => !o)}
                />
              )}
              {via && <AppViaTag via={via} person={name} />}
              {talker && (
                <span
                  className="msg-reminder msg-talker"
                  title={t(talkerWaited(m.meta) ? "chat.notice.talkerWaitingTip" : "chat.notice.talkerTip")}
                >
                  {t(talkerWaited(m.meta) ? "chat.notice.talkerWaiting" : "chat.notice.talker")}
                </span>
              )}
              {helping && <ConsultHelpingTag consultation={helping} />}
            </>
          ) : (
            name
          )
        }
        time={
          live ? <RunClock run={live} /> : <time dateTime={m.createdAt}>{formatTime(i18n.language, m.createdAt)}</time>
        }
        meta={m.local || live ? undefined : details}
        note={joinedTip ? { label: t("chat.joined.label"), tip: joinedTip } : undefined}
        // Its words arriving: its time and its stop after the time it started (the bar no longer says them).
        status={
          liveWaiting
            ? { icon: "waiting", label: t("channel.waitingApproval") }
            : local === "pending"
              ? {
                  // "enviando" only past half a second (most sends never show it); offline it says when it goes.
                  mark: slowSend ? <PixelSpinner size={14} /> : undefined,
                  label: (
                    <span className={slowSend ? undefined : "ac-visually-hidden"}>
                      {queued ? t("channel.sendingOffline") : t("channel.sending")}
                    </span>
                  ),
                }
              : waitNotice
                ? { label: <AwayPill notice={waitNotice} agentId={m.author.id ?? null} /> }
                : live && !waiting
                  ? { label: <RunTail run={live} /> }
                  : undefined
        }
        aside={
          receipted || seenSlot ? (
            <>
              {receipted && <MessageReceipts message={m} part="check" />}
              {seenSlot && <SeenMark personId={seen ? dmPersonId : undefined} />}
            </>
          ) : undefined
        }
        foot={receipted ? <MessageReceipts message={m} part="line" /> : undefined}
        menu={
          barred && menu.touch.length > 0
            ? { label: t("channel.actions", { name }), items: <MenuEntries entries={menu.touch} /> }
            : undefined
        }
        stacked={Boolean(card)}
      >
        {live && waiting ? (
          <Parts resetKey={m}>
            <LiveRunStatus run={live} />
            <RunBrowserCard run={live} name={name} />
            <span className="ac-visually-hidden">{t("channel.writing")}</span>
          </Parts>
        ) : live ? (
          // Ended badly while at work: what went wrong, how to fix it, and its tools as far as they got.
          <Parts resetKey={m}>
            {liveFailed && (
              <div className="ac-msg__error-row" role="alert">
                <p className="ac-msg__error ac-iconline">
                  <Icon name="alert" size={16} />
                  {/* A known code is said in words; the stored error (a computer's code) only on hover, unless the
                      words already say what it said. */}
                  <span title={!refusal && failedWhy && !live.errorParams?.detail ? live.error : undefined}>
                    {runFailureLine(t, name, { code: live.errorCode, params: live.errorParams }, i18n.language) ??
                      (live.error
                        ? t("channel.runFailed", { agent: name, reason: live.error })
                        : t("channel.runFailedNoReason", { agent: name }))}
                  </span>
                </p>
                {live.agentId && <FailedRunFix code={live.errorCode} agentId={live.agentId} />}
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="close"
                  aria-label={t("common.close")}
                  onClick={() => dismissRun(live.runId)}
                />
              </div>
            )}
            <LiveTools work={live.work ?? []} agentName={name} color={colorOf(agent)} steerNote={steerNote} stopped />
            {/* Last, after its tools: for the person still in control of its browser (they hand back from it). */}
            <RunBrowserCard run={live} name={name} />
          </Parts>
        ) : (
          <Parts resetKey={m}>
            {routine && report && reportOpen && <RoutineReport text={report} />}
            {bodyShown && (
              <MessageText key="body" style={workOver ? { opacity: 0.6 } : undefined}>
                <MessageBody
                  body={talk ? talk.lead : body}
                  resolveMention={dir.mentionName}
                  mentionTone={dir.mentionTone}
                  renderMention={renderMention}
                  wikiLink={wikiLink}
                  channelRefs={channelRefsOf(m.meta)}
                  accent={colorOf(agent)}
                  pinFrom={
                    m.author.type === "agent" && m.author.id && !m.local && !readOnly
                      ? { messageId: m.id, agentId: m.author.id }
                      : null
                  }
                />
                {talk && openThread && (
                  <button
                    type="button"
                    className="msg-talk__more"
                    aria-pressed={threadsView?.open === talkThread}
                    onClick={() => openThread(talkThread)}
                  >
                    {t("chat.talk.readAll")}
                    <span className="msg-talk__count">{t("chat.talk.more", { count: talk.more })}</span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                )}
              </MessageText>
            )}
            {choiceReply && (
              <p className="choice-reply">
                <Icon name="check" size={14} />
                <b>{choiceReplyLine(body)}</b>
              </p>
            )}
            {media && <ChatMedia media={media} />}
            {voice && <ChatVoice message={m} voice={voice} />}
            {m.author.type === "agent" && meta.speedFallback === true && <SpeedFallbackLine agent={agent} />}
            {(stopped.canceled || atLimit || providerCut) && (
              <StoppedLine
                runId={m.agentRunId}
                byUserId={stopped.byUserId}
                note={stopped.note}
                limit={providerCut ? "failed" : atLimit}
                owner={
                  m.author.type === "agent" && m.author.id
                    ? { agentId: m.author.id, channelId: m.channelId, threadId: m.threadId ?? m.id }
                    : null
                }
                message={m}
              />
            )}
            {local === "failed" && (
              <p className="ac-msg__error ac-iconline" role="alert">
                <Icon name="alert" size={16} />
                <span>{t("channel.notSent")}</span>
                <span aria-hidden="true">·</span>
                <button type="button" className="ac-link" onClick={() => actions?.retry(m)} style={inlineButton}>
                  {t("channel.retrySend")}
                </button>
              </p>
            )}
            {m.author.type === "agent" && !m.local && <AgentActionReceipts message={m} />}
            {m.author.type === "agent" && !m.local && <HandedTaskChips message={m} />}
            {m.author.type === "agent" && !m.local && <TeamChecks message={m} />}
            {m.author.type === "agent" && !m.local && <ReachLines message={m} />}
            {m.author.type === "agent" && !m.local && <FeedbackOfferRow message={m} />}
            {agent &&
              memoryUpdates
                .filter((u) => u.action !== "proposed")
                .map((u) => <MemoryChangeCard key={`${u.action}-${u.itemId}`} update={u} agentId={agent.id} />)}
            {browserTrail.length > 0 && m.author.id && !m.local && (
              <BrowserTrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                name={name}
                steps={browserTrail}
                stopped={stopped.canceled ? { byUserId: stopped.byUserId } : null}
                recent={Date.now() - Date.parse(m.createdAt) < HELD_RECENT_MS}
              />
            )}
            {desktopTrail.length > 0 && m.author.id && !m.local && (
              <BrowserTrailCard
                agentId={m.author.id}
                runId={m.agentRunId ?? null}
                name={name}
                steps={desktopTrail}
                stopped={stopped.canceled ? { byUserId: stopped.byUserId } : null}
                screen="desktop"
              />
            )}
            {lastOfRun && m.author.type === "agent" && m.author.id && replyRun && !m.local && (
              <HeldBrowserCard
                agentId={m.author.id}
                runId={replyRun}
                name={name}
                enabled={Date.now() - Date.parse(m.createdAt) < HELD_RECENT_MS}
              />
            )}
            {missionPlan && <MissionPlanCard plan={missionPlan} />}
            {missionReview && <MissionReviewCard message={missionReview} />}
            {missionSetup && <MissionSetupCard setup={missionSetup} threadId={m.threadId ?? null} />}
            {missionReport && <MissionReportExtras report={missionReport} message={m} />}
            {missionStart && <MissionStartLink message={m} />}
            {missionLink && <MissionLinkCard link={missionLink} />}
            {issueWork && (
              <IssueWorkCard work={issueWork} authorId={m.author.type === "person" ? (m.author.id ?? null) : null} />
            )}
            {artifacts.length > 0 && (
              <ImageSet refs={artifacts}>
                <div className="artifact-cards">
                  {artifacts.map((r) => (
                    <ArtifactCard key={`${r.id}@${r.version}`} artifact={r} />
                  ))}
                </div>
              </ImageSet>
            )}
            {/* Its tools after its words and what it changed: the same place live, kept and saved. */}
            {keptSteps?.length && seenLive ? (
              <LiveTools
                work={keptSteps}
                agentName={name}
                color={colorOf(agent)}
                steerNote={steerNote}
                done
                stopped={stopped.canceled}
              />
            ) : null}
            {/* A question to another agent (in their DM) carries the asking run: its work shows on that run's reply. */}
            {m.author.type === "agent" && replyRun && !card && !m.local && !keptAll && !m.meta?.consultation && (
              <SavedTools
                runId={replyRun}
                meta={m.meta}
                agentName={agent?.name ?? name}
                color={colorOf(agent)}
                skipScreens={onCards}
              />
            )}
            {/* What waits for a person's click comes last, after the words and the tools. */}
            {approvalId && (
              <MessageApproval messageId={m.id} approvalId={approvalId} agent={agent} members={dir.memberById} />
            )}
            {proposalId && <InlineProposal proposalId={proposalId} />}
            {agent &&
              memoryUpdates
                .filter((u) => u.action === "proposed")
                .map((u) => <MemoryChangeCard key={`${u.action}-${u.itemId}`} update={u} agentId={agent.id} />)}
            {waitNotice && <WaitingCard notice={waitNotice} agentId={m.author.id ?? null} />}
            {deviceWait && <DeviceWaitCard wait={deviceWait} message={m} />}
            {noAi && <NoAiCard message={m} />}
            {actionCard && <ActionCard message={m} />}
            {m.author.type === "agent" && !m.local && m.meta?.replyChips ? <ReplyChips message={m} /> : null}
            {pushAsk?.messageId === m.id && !readOnly && <PushAskInline agent={agent} onClose={pushAsk.close} />}
            {usageWait?.closed ? (
              <UsageWaitClosed message={m} wait={{ ...usageWait, closed: usageWait.closed }} />
            ) : (
              usageWait && !usageWait.canceled && !usageWait.ended && <UsageWaitCancel message={m} wait={usageWait} />
            )}
            {question && <QuestionCard question={question} />}
            {secretRequest && <SecretCard request={secretRequest} />}
            {browserHandoff && <BrowserHandoffCard handoff={browserHandoff} />}
            {missionDecision && <MissionDecisionCard message={missionDecision} />}
            {missionDelivery && <MissionDeliveryCard message={missionDelivery} />}
            {missionCommand && <MissionCommandCard command={missionCommand} />}
            {missionSuggestion && <MissionSuggestionBar message={m} suggestion={missionSuggestion} />}
            {/* Everyone's reactions (👍/👎 on an agent's reply are its feedback, in the same pills). */}
            {!m.local && !readOnly && <MessageReactions messageId={m.id} initial={m.reactions} feedback={feedback} />}
            {/* Long work (ADR 0121): how it stands, under the agent's "Vou cuidar disso". */}
            {m.longWork && !m.local && (
              <MessageWorkLine
                message={m}
                threaded={Boolean(threadLine)}
                inThread={!threadsView && (m.threadId ?? m.id) === (m.longWork.threadId ?? m.longWork.anchorMessageId)}
              />
            )}
            {/* A "Responder" thread went on from here: its line (opens the panel). */}
            {threadLine && <ThreadReplyLine thread={threadLine.thread} count={threadLine.count} />}
            {feedback && (
              <MessageFeedback
                messageId={m.id}
                agentName={agent?.name ?? t("channel.unknownAgent")}
                active={active}
                initial={m.reactions}
                quick={<ReplyButton message={m} />}
                more={<MessageMoreMenu entries={menu.more} />}
              />
            )}
            {feedback && <CorrectionAsk message={m} agentName={agent?.name ?? t("channel.unknownAgent")} />}
            {personBar && !(mediaAfter && readOnly) && (
              <PersonMessageActions message={m} authorName={name} more={menu.more} />
            )}
            {menu.dialog}
          </Parts>
        )}
      </Message>
    </>
  );
});

function isSecretRequest(v: unknown): v is SecretRequest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.name === "string" && typeof o.requestedForUserId === "string";
}

function isQuestion(v: unknown): v is AgentQuestion {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.text === "string" && typeof o.agentId === "string";
}

function isMemoryUpdate(v: unknown): v is MemoryUpdate {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.action === "string" && typeof o.itemId === "string" && typeof o.text === "string";
}

const inlineButton = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
};

/**
 * The request of a message with `meta.approvalId`: from the approvals list, or fetched by id. Requests the agent
 * asked later in this conversation join the same card (`messageId`): then one card lists them all.
 */
function MessageApproval({
  messageId,
  approvalId,
  agent,
  members,
}: {
  messageId: string;
  approvalId: string;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const listed: Approval | undefined = approvals.data?.find((a) => a.id === approvalId);
  const one = useApproval(org.id, approvalId, !listed && approvals.isSuccess);
  // Older than the list reaches: its card's requests by the card (the list holds everything newer than the first).
  const card = useCardApprovals(org.id, messageId, !listed && approvals.isSuccess);
  const approval = listed ?? one.data;
  const items = approvalCardItems([...(approvals.data ?? []), ...(card.data ?? [])], messageId, approval);
  // Past its deadline it has expired, even before the server's event says so.
  const expired = useExpired(approval?.status === "pending" ? approval.expiresAt : null);
  // Drawn again when the card's earliest deadline passes.
  useExpired(cardDeadline(items));
  if (!approval) return null;
  if (items.length > 1) {
    const now = items.map((a) => asOfNow(a));
    if (now.some((a) => a.status === "pending"))
      return <ApprovalGroupAsk items={now} agent={agent} members={members} />;
    return (
      <>
        {now.map((a) => (
          <InlineApproval key={a.id} approval={a} agent={agent} members={members} />
        ))}
      </>
    );
  }
  // Waiting: the agent asking, in the conversation; decided or expired: one line.
  if (approval.status === "pending" && !expired)
    return <ApprovalAsk approval={approval} agent={agent} members={members} />;
  return (
    <InlineApproval
      approval={expired ? { ...approval, status: "expired" } : approval}
      agent={agent}
      members={members}
    />
  );
}

/** Above this many members the channel details list gets a search field. */
const DETAILS_SEARCH_FROM = 8;

const ACCESS_LABEL = {
  public: "channel.visibilityPublic",
  private: "channel.visibilityPrivate",
  roles: "newChannel.roles",
} as const;

/** The channel settings' sections, for who manages it (ADR 0134). */
const SETTINGS_SECTIONS = [
  { id: "overview", icon: "settings" },
  { id: "permissions", icon: "shield" },
  { id: "members", icon: "members" },
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * "Detalhes do canal": the description edited in place under the name
 * (saves on blur, Enter or close), members grouped as agents and people, one "⋯" per row with how an
 * agent replies and "Tirar do canal".
 */
function ChannelDetails({
  open,
  onOpenChange,
  channel,
  startAdding = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
  /** Open on adding members (who manages the channel), with no details under it. */
  startAdding?: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const roster = useRoster(org.id, channel.id, open && channel.isMember);
  // What "on its own" means for my messages: who reads the ones that mention nobody.
  const routing = useAiStatus(org.id, open).data?.routing;
  const update = useUpdateChannel(org.id, channel.id);
  const editable = managesChannel(channel, me.user.id, org);
  const toast = useToast();
  const categories = useChannelCategories(org.id);
  const place = usePlaceChannel(org.id);
  const archive = useArchiveChannelWithUndo();
  const leaving = useLeaveChannelWithUndo();
  // Name: saved on blur or Enter, like the description.
  const [name, setName] = useState(channel.name);
  const [nameError, setNameError] = useState<string | undefined>();
  const categoryName =
    categories.data?.find((c) => c.id === channel.categoryId)?.name ?? t("channelCategories.noCategory");
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState(channel.topic);
  const [saved, setSaved] = useState(false);
  const [addingHere, setAdding] = useState(false);
  const adding = addingHere || (startAdding && editable);
  const [section, setSection] = useState<SettingsSection>("overview");
  // Who can join (ADR 0125): saved on each change once it means something (a role picked under "Departamentos").
  const [access, setAccess] = useState<ChannelAccess>(() => accessOf(channel));
  const accessKey = `${channel.visibility}:${(channel.audienceRoleIds ?? []).join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `accessKey` stands for the channel's access
  useEffect(() => {
    if (open) setAccess(accessOf(channel));
  }, [open, accessKey]);
  const saveAccess = (next: ChannelAccess) => {
    setAccess(next);
    if (!accessValid(next)) return;
    update.mutate(accessInput(next), {
      onSuccess: () => setSaved(true),
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  };
  // Going public opens the whole history to the workspace: asked first, like a removal.
  const [goingPublic, setGoingPublic] = useState(false);
  const changeAccess = (next: ChannelAccess) => {
    if (next.mode === "public" && channel.visibility !== "public") setGoingPublic(true);
    else saveAccess(next);
  };
  // Who is about to be removed: asked first, in a dialog of its own.
  const [removing, setRemoving] = useState<{ kind: "person" | "agent"; id: string; name: string } | null>(null);
  // The last description sent: blur and close both save, and closing with the X does both.
  const sentTopic = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(channel.name);
    setNameError(undefined);
  }, [open, channel.name]);
  useEffect(() => {
    if (!open) return;
    setTopic(channel.topic);
    sentTopic.current = null;
  }, [open, channel.topic]);
  useEffect(() => {
    if (!saved) return;
    const id = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(id);
  }, [saved]);
  const saveTopic = () => {
    const next = topic.trim();
    if (!editable || next === channel.topic || next === sentTopic.current) return;
    sentTopic.current = next;
    update.mutate(
      { topic: next },
      {
        onSuccess: () => setSaved(true),
        onError: () => {
          sentTopic.current = null;
        },
      },
    );
  };
  const saveName = () => {
    if (!editable || name === channel.name) return;
    if (!name) {
      setName(channel.name);
      return;
    }
    if (!CHANNEL_NAME.test(name)) {
      setNameError(t("newChannel.nameInvalid"));
      return;
    }
    update.mutate(
      { name },
      {
        onSuccess: () => {
          setNameError(undefined);
          setSaved(true);
        },
        onError: (e) =>
          setNameError(e instanceof ApiError && e.status === 409 ? t("channel.nameTaken", { name }) : errorText(t, e)),
      },
    );
  };
  // Inviting someone from Adicionar hands over to the invite dialog (ADR 0090): the details close as well, or they
  // would open again over it.
  const inviteInstead = () => {
    saveTopic();
    saveName();
    setAdding(false);
    onOpenChange(false);
  };
  const moveTo = (categoryId: string | null) =>
    place.mutate(
      { channelId: channel.id, categoryId },
      {
        onSuccess: () => setSaved(true),
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  const archiveIt = () => archive.run(channel, () => onOpenChange(false));
  // Deleting is for owners and admins, never #general; archiving is also for whoever made the channel.
  const deletable = can(org, "manage_channels") && channel.name !== "general";
  const [deleting, setDeleting] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.roster(org.id, channel.id) });
    void qc.invalidateQueries({ queryKey: keys.channelMembers(org.id, channel.id) });
  };
  const remove = useMutation({
    mutationFn: (r: { kind: "person" | "agent"; id: string }) =>
      api.chat.removeMember(org.id, channel.id, r.kind === "agent" ? { agentId: r.id } : { userId: r.id }),
    onSuccess: () => {
      refresh();
      setRemoving(null);
    },
  });
  const autoReply = useMutation({
    mutationFn: ({ agentId, on }: { agentId: string; on: boolean }) =>
      api.chat.setAutoReply(org.id, channel.id, agentId, on),
    onSuccess: refresh,
  });
  const leave = () => {
    saveTopic();
    saveName();
    onOpenChange(false);
  };
  const needle = q.trim().toLowerCase();
  const all = (roster.data ?? []).map((m) => ({
    key: `${m.type}-${m.id}`,
    kind: m.type,
    id: m.id,
    name: m.name,
    handle: m.handle ?? "",
    email: m.type === "person" ? (dir.memberById.get(m.id)?.email ?? "") : "",
    autoReply: Boolean(m.autoReply),
    setsReply: m.type === "agent" && setsAutoReply(channel, dir.agentById.get(m.id), me.user.id, org),
  }));
  const shown = all.filter((r) => !needle || `${r.name} ${r.handle} ${r.email}`.toLowerCase().includes(needle));
  const agents = shown.filter((r) => r.kind === "agent");
  const people = shown.filter((r) => r.kind === "person");
  const agentCount = all.filter((r) => r.kind === "agent").length;
  const inChannel = new Set((roster.data ?? []).map((m) => `${m.type}:${m.id}` as PickKey));
  const group = (label: string, count: number) => (
    <p className="member-group">
      <span className="ac-eyebrow">{label}</span>
      <span className="member-group__count">{count}</span>
    </p>
  );
  const membersList = (
    <DialogSearchList
      query={q}
      onQueryChange={setQ}
      search={all.length > DETAILS_SEARCH_FROM}
      searchLabel={t("channel.detailsSearch")}
      searchPlaceholder={t("channel.detailsSearch")}
      isEmpty={roster.isSuccess && shown.length === 0 && Boolean(needle)}
      emptyText={t("channel.detailsEmpty", { q })}
    >
      <p className="member-caption">
        {t(channel.visibility === "public" ? "channelMembers.captionOpen" : "channelMembers.caption")}
      </p>
      {agents.length > 0 && group(t("channelMembers.agents"), agentCount)}
      {agents.map((r) => (
        <div key={r.key} className="member-row">
          <OpensAgent agentId={r.id} onOpen={leave}>
            <ActorAvatar actor={{ type: "agent", id: r.id }} size="sm" name={r.name} />
          </OpensAgent>
          <span className="list-col">
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            <span className="small muted">
              {!r.autoReply
                ? t("channelMembers.mentionLine", { handle: r.handle })
                : !picksForMe(routing)
                  ? t(replyAloneKey(routing), agentGrammar(r.name))
                  : t("channelMembers.aloneLine", agentGrammar(r.name))}
            </span>
          </span>
          {r.setsReply && (
            <Menu
              align="end"
              label={t("channelMembers.actions", { name: r.name })}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="more"
                  aria-label={t("channelMembers.actions", { name: r.name })}
                  disabled={autoReply.isPending && autoReply.variables?.agentId === r.id}
                />
              }
            >
              <MenuRadioGroup
                label={t("channelMembers.replyHeading", agentGrammar(r.name))}
                value={r.autoReply ? "alone" : "mention"}
                onValueChange={(v) => autoReply.mutate({ agentId: r.id, on: v === "alone" })}
                options={[
                  {
                    value: "alone",
                    label: (
                      <>
                        {t("channelMembers.replyAlone", agentGrammar(r.name))}
                        <span className="ac-menu__desc">{t(replyAloneKey(routing), agentGrammar(r.name))}</span>
                      </>
                    ),
                  },
                  {
                    value: "mention",
                    label: (
                      <>
                        {t("channelMembers.replyMention")}
                        <span className="ac-menu__desc">
                          {t("channelMembers.replyMentionHelp", { handle: r.handle })}
                        </span>
                      </>
                    ),
                  },
                ]}
              />
              {editable && (
                <>
                  <MenuSeparator />
                  <MenuItem icon="close" danger onSelect={() => setRemoving({ kind: "agent", id: r.id, name: r.name })}>
                    {t("channelMembers.remove")}
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      ))}
      {people.length > 0 && group(t("channelMembers.people"), all.length - agentCount)}
      {people.map((r) => (
        <div key={r.key} className="member-row">
          <ActorAvatar actor={{ type: "person", id: r.id }} size="sm" name={r.name} />
          <span className="list-col">
            <span style={{ fontWeight: 600 }}>
              {r.name}
              {r.id === me.user.id && <span className="member-row__you">{t("common.you")}</span>}
            </span>
            <span className="small muted">{r.email}</span>
          </span>
          {/* Not on my own row: removing myself from my own list reads as a mistake. */}
          {editable && r.id !== me.user.id && (
            <Menu
              align="end"
              label={t("channelMembers.actions", { name: r.name })}
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="more"
                  aria-label={t("channelMembers.actions", { name: r.name })}
                />
              }
            >
              <MenuItem icon="close" danger onSelect={() => setRemoving({ kind: "person", id: r.id, name: r.name })}>
                {t("channelMembers.remove")}
              </MenuItem>
            </Menu>
          )}
        </div>
      ))}
      {editable && !needle && (
        <button type="button" className="member-row member-row--add" onClick={() => setAdding(true)}>
          <span className="member-row__plus" aria-hidden="true">
            <Icon name="plus" />
          </span>
          {t("channelMembers.addRow")}
        </button>
      )}
    </DialogSearchList>
  );
  return (
    <>
      <Dialog
        open={open && !adding && !removing && !goingPublic && !deleting}
        width={editable ? 760 : 600}
        onOpenChange={(o) => (o ? onOpenChange(o) : leave())}
        subtitle={t("channel.detailsSub", {
          category: categoryName,
          visibility: t(ACCESS_LABEL[accessOf(channel).mode]),
        })}
        title={
          <>
            {t("channel.detailsTitle", { channel: channel.name })}
            {editable && <SavedNote shown={saved} label={t("common.saved")} className="channel-topic__saved" />}
          </>
        }
        description={editable ? undefined : channel.topic || t("channel.noTopic")}
        closeLabel={t("common.close")}
      >
        {editable ? (
          // Discord's channel settings in our words (ADR 0134): a nav on the left, one section at a time.
          <div className="channel-settings">
            <nav className="channel-settings__nav" aria-label={t("channel.settingsNav.label")}>
              <ul>
                {SETTINGS_SECTIONS.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="settings__link"
                      aria-current={section === s.id ? "page" : undefined}
                      onClick={() => setSection(s.id)}
                    >
                      <Icon name={s.icon} size={18} />
                      {t(`channel.settingsNav.${s.id}`)}
                    </button>
                  </li>
                ))}
              </ul>
              {channel.name !== "general" && (
                <div className="channel-settings__danger">
                  {channel.isMember && (
                    <Button
                      variant="ghost"
                      icon="arrowRight"
                      className="channel-details__archive"
                      loading={leaving.pending}
                      onClick={() => leaving.run(channel, () => onOpenChange(false))}
                    >
                      {t("channel.leave")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    icon="archive"
                    className="channel-details__archive"
                    loading={archive.pending}
                    onClick={archiveIt}
                  >
                    {t("channel.archive")}
                  </Button>
                  {deletable && (
                    <Button
                      variant="ghost"
                      icon="trash"
                      className="channel-details__archive"
                      disabled={archive.pending}
                      onClick={() => {
                        saveTopic();
                        saveName();
                        setDeleting(true);
                      }}
                    >
                      {t("channel.delete")}
                    </Button>
                  )}
                </div>
              )}
            </nav>
            <div className="channel-settings__pane">
              {section === "overview" && (
                <DialogBody className="channel-category__fields">
                  <Field
                    label={t("channel.nameLabel")}
                    id="channel-edit-name"
                    hint={{
                      name: t("common.about", { label: t("channel.nameLabel") }),
                      text: channel.name === "general" ? t("channel.generalName") : t("channel.nameHelp"),
                    }}
                    error={nameError}
                  >
                    <AffixInput
                      prefix="#"
                      value={name}
                      disabled={channel.name === "general"}
                      onChange={(e) => {
                        setName(toChannelName(e.target.value));
                        setNameError(undefined);
                      }}
                      onBlur={saveName}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label={t("newChannel.topic")} id="channel-edit-topic">
                    <Input
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      onBlur={saveTopic}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      placeholder={t("channel.topicPlaceholder")}
                      maxLength={250}
                    />
                  </Field>
                  <Field label={t("channelCategories.category")} id="channel-edit-category">
                    <CategorySelect value={channel.categoryId ?? null} onChange={moveTo} canCreate={editable} />
                  </Field>
                </DialogBody>
              )}
              {section === "permissions" && (
                <DialogBody className="channel-category__fields">
                  {channel.name !== "general" && (
                    <ChannelAccessChoice value={access} onChange={changeAccess} idPrefix="channel-edit" showError />
                  )}
                  <ChannelPermissions channelId={channel.id} />
                </DialogBody>
              )}
              {section === "members" && membersList}
            </div>
          </div>
        ) : (
          <>
            {membersList}
            <DialogFooter note={t("channelMembers.readOnly")}>
              {leavesChannel(channel) && (
                <Button
                  variant="ghost"
                  icon="arrowRight"
                  loading={leaving.pending}
                  onClick={() => leaving.run(channel, () => onOpenChange(false))}
                >
                  {t("channel.leave")}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </Dialog>
      <DeleteChannelDialog
        channel={open && deleting ? channel : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => onOpenChange(false)}
      />
      <Dialog
        open={open && Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("channelMembers.removeTitle", { name: removing?.name ?? "", channel: channel.name })}
        description={t(
          removing?.kind === "agent" ? "channelMembers.removeAgentBody" : "channelMembers.removePersonBody",
          agentGrammar(removing?.name ?? ""),
        )}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>
            {t("channelMembers.removeConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={open && goingPublic}
        onOpenChange={(o) => !o && setGoingPublic(false)}
        title={t("newChannel.publicTitle", { channel: channel.name })}
        description={t("newChannel.publicBody")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setGoingPublic(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              setGoingPublic(false);
              saveAccess({ mode: "public", roleIds: [] });
            }}
          >
            {t("newChannel.publicConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
      <AddMembersDialog
        open={open && adding}
        onClose={() => {
          setAdding(false);
          if (startAdding) onOpenChange(false);
        }}
        onInvite={inviteInstead}
        channel={channel}
        exclude={inChannel}
        onAdded={refresh}
      />
    </>
  );
}

/** Adds people and agents to a channel (searchable, our checkboxes). */
function AddMembersDialog({
  open,
  onClose,
  onInvite,
  channel,
  exclude,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** The invite dialog or a new agent's page takes over: this closes with what opened it. */
  onInvite: () => void;
  channel: Channel;
  exclude: Set<PickKey>;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  useEffect(() => {
    if (open) {
      setQ("");
      setSelected(new Set());
    }
  }, [open]);
  const add = useMutation({
    mutationFn: async () => {
      for (const key of selected) await api.chat.addMember(org.id, channel.id, memberOf(key));
    },
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  // Who was in before Adicionar, also while it closes: the ones being added keep their rows.
  const rows = useMemberRows(q, useHeldWhile(exclude, add.isPending || !open), undefined, { channel: true });
  // An address nobody here has: invite them to the workspace and this channel (ADR 0090).
  const invite = useInviteOffer(q);
  const inviteDialog = useInviteDialog();
  const newAgent = useNewAgent();
  const navigate = useNavigate();
  const creates = makesAgents(org);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("channelMembers.addTitle", { channel: channel.name })}
      closeLabel={t("common.close")}
    >
      <Locked when={add.isPending}>
        <DialogSearchList
          query={q}
          onQueryChange={setQ}
          searchLabel={t("channelMembers.addSearch")}
          searchPlaceholder={t("channelMembers.addSearch")}
          isEmpty={false}
          emptyText=""
        >
          {rows.length === 0 && !invite && (
            <p className="ac-dialog__empty">
              {q.trim()
                ? t("channelMembers.addEmpty", { q: q.trim() })
                : t("channelMembers.addEveryone", { org: org.name, channel: channel.name })}
            </p>
          )}
          <MemberPickerRows
            rows={rows}
            selected={selected}
            onToggle={(key, on) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              })
            }
          />
          {invite && <InviteOfferRow email={invite} channel={channel} onPick={onInvite} />}
          {!invite && inviteDialog && can(org, "invite_people") && (
            <button
              type="button"
              className="member-row member-row--add"
              onClick={() => {
                onInvite();
                inviteDialog.open({ channelId: channel.id });
              }}
            >
              <span className="member-row__plus" aria-hidden="true">
                <Icon name="mail" />
              </span>
              {t("shell.invite")}
            </button>
          )}
          {creates && (
            <button
              type="button"
              className="member-row member-row--add"
              onClick={() => {
                onInvite();
                // The new agent's dialog, starting it in this channel too (ADR 0164).
                if (newAgent) newAgent.open({ channelId: channel.id });
                else
                  void navigate({
                    to: "/org/$orgId/agents/new",
                    params: { orgId: org.id },
                    search: { channel: channel.id },
                  });
              }}
            >
              <span className="member-row__plus" aria-hidden="true">
                <Icon name="plus" />
              </span>
              {t("shell.createAgent")}
            </button>
          )}
        </DialogSearchList>
      </Locked>
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || add.isPending}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          {t("channelMembers.addConfirm", { count: selected.size })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Link to an agent profile (DM header). */
export function AgentProfileLink({ agentId, label }: { agentId: string; label: string }) {
  const { org } = useOrg();
  return (
    <Button asChild size="sm">
      <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId }}>
        {label}
      </Link>
    </Button>
  );
}

/** After "@" picks an agent that isn't in the channel: add it, or say who can. */
function AddToChannelOffer({ channelId, agentId, onDone }: { channelId: string; agentId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const add = useAddChannelMember(org.id);
  const toast = useToast();
  const name = dir.agentById.get(agentId)?.name ?? t("channel.unknownAgent");
  const admin = can(org, "manage_channels");
  return (
    <div className="mention-offer" role="status">
      <span className="small">{t("mentions.offer", { name })}</span>
      {admin ? (
        <Button
          size="sm"
          disabled={add.isPending}
          loading={add.isPending}
          onClick={() =>
            add.mutate(
              { channelId, member: { agentId } },
              {
                onSuccess: () => {
                  toast.show(t("mentions.added", { name }));
                  onDone();
                },
              },
            )
          }
        >
          {t("mentions.add")}
        </Button>
      ) : (
        <span className="small muted">{t("mentions.askAdmin")}</span>
      )}
      <Button size="sm" variant="ghost" onClick={onDone}>
        {t("mentions.dismiss")}
      </Button>
    </div>
  );
}
