import { channelTopic, chatActivityTopic, orgTopic, type PubSub, userTopic } from "@agenteschat/adapters";
import { modelProvider } from "@agenteschat/providers";
import { plainLines } from "@agenteschat/ui/markdown";
import type { AgentActionView } from "./agent-actions";
import type { ConnectIntent } from "./ai-intent";
import type { ApprovalView } from "./approvals";
import type { ArtifactView } from "./artifacts";
import type { BlockStateView } from "./block-state";
import type { ChoicesView, PollView } from "./blocks";
import type { BrowserHandoffView } from "./browser/handoff";
import type { CalendarEventView, CalendarProposalView } from "./calendar";
import type { FeedbackOfferView } from "./feedback-offers";
import type { IssueActivityView, IssueView } from "./issues";
import type { MachineTaskView } from "./machine-tasks";
import { oneLine } from "./mail/text";
import type { MessageMemory } from "./message-memories";
import type { MessageView, ReactionCount } from "./messages";
import { stripSentinel } from "./reply-policy";
import type { TeamProposalCard } from "./team-proposals";
import { redactCredentials } from "./tool-detail";
import type { WorkView } from "./works";

/** What a memory tool changed, for the "memory updated" card (persisted in the reply's `meta.memoryUpdates`). */
export interface MemoryUpdate {
  action: "remembered" | "forgot" | "updated" | "proposed";
  itemId: string;
  text: string;
  previousText?: string | null;
  requestedByUserId: string;
  /** Undo: `POST /api/app/organizations/{orgId}/memories/{itemId}/revert`. Absent for proposals. */
  undo?: { method: "POST"; path: string };
  /** For `proposed`: the proposal to accept inline (the card's first), and whether the requester can decide one. */
  proposalId?: string;
  /** For `proposed`: every proposal on the card, one per agent and kind of change (older apps read `proposalId`). */
  proposalIds?: string[];
  canDecide?: boolean;
  /** `memory.remembered` | `memory.updated` | `memory.forgot` | `memory.proposed`: the app's own words, with `params`. */
  code?: string;
  params?: { text: string; previousText?: string | null };
}

import type { AgentQuestion } from "./questions";
import type { RunStatus } from "./runs";
import type { SecretRequestView } from "./secrets";
import type { ThreadChange, ThreadInfo, ThreadState } from "./threads";

/** Which step of the router's chain picked the agents for a message nobody mentioned (ADR 0074). */
export type DecidedBy =
  | { step: "jev" }
  | { step: "model"; model: string; provider: string }
  /** The author's own plan: `ownerId` is the author. */
  | { step: "plan"; brand: "claude" | "chatgpt"; ownerId: string }
  /**
   * `default`: nobody was picked, so the agent the person talks with, or the best placed one, answered (ADR 0074,
   * R5). `alone`: nobody was picked and the person is alone here with two or more agents, so the best placed one
   * answered (ADR 0137 §5). `coordinator` is only read: decisions stored before ADR 0137 retired the team's coordinator (ADR 0093).
   */
  | { step: "rule"; rule: RouterRule };

type RouterRule = "reply" | "only_agent" | "follow_up" | "coordinator" | "default" | "alone";

/** Why a routed message reached no agent: no step could read it, and no rule fit (`strategy` `none`). */
export const MENTION_NEEDED = "mention_needed";

/** The most a step line says of what the agent wrote: one short line, cut with "…". */
const STEP_WORDS_MAX = 120;
/** How much of a stretch is kept for it: its first sentence is all that is read. */
export const STEP_HELD_MAX = 600;

/**
 * What each run executing here wrote since its last call, held out of the chat (`createTurnText`): the words of its
 * next call's step line (`takeStepWords`), never posted.
 */
const stepHeld = new Map<string, string>();

export function holdStepWords(runId: string, text: string) {
  const held = text.slice(0, STEP_HELD_MAX);
  if (held.trim()) stepHeld.set(runId, held);
  else stepHeld.delete(runId);
}

/**
 * The step's words, once: the first sentence of what it wrote before the call, plain, on one short line, with no
 * credential (a key, a token in an address) and never the silence word.
 */
export function takeStepWords(runId: string): string | undefined {
  const held = stepHeld.get(runId);
  stepHeld.delete(runId);
  const line = held ? (plainLines(redactCredentials(stripSentinel(held)).replace(/\p{Cc}/gu, " "))[0] ?? "") : "";
  const sentence = /^.+?[.!?…:](?=\s|$)/u.exec(line)?.[0] ?? line;
  return oneLine(sentence.replace(/[.:]$/, ""), STEP_WORDS_MAX) || undefined;
}

const RULES = new Set(["reply", "only_agent", "follow_up", "coordinator", "default", "alone"]);

/**
 * `DecidedBy` from a stored decision's `strategy` (`jev`, `llm:<model>`, `plan:<kind>`, `rule:<name>`). Undefined
 * for anything else: a mention's judge, or a decision from before the chain.
 */
export function decidedByOf(strategy: string, authorUserId: string | null): DecidedBy | undefined {
  if (strategy === "jev") return { step: "jev" };
  const [step, rest = ""] = strategy.split(/:(.*)/s);
  if (step === "llm" && rest) return { step: "model", model: rest, provider: modelProvider(rest) ?? "" };
  if (step === "plan" && authorUserId && (rest === "claude_code" || rest === "codex")) {
    return { step: "plan", brand: rest === "codex" ? "chatgpt" : "claude", ownerId: authorUserId };
  }
  if (step === "rule" && RULES.has(rest)) return { step: "rule", rule: rest as RouterRule };
  return undefined;
}

/**
 * Real-time events sent to WebSocket clients subscribed to a channel. The
 * database is the source of truth; events only tell clients what changed.
 * Documented for the web app in docs/adr/0010-realtime.md.
 */
/** `threadId` null on agent events = the main timeline (DMs are flat). */
export type ChannelEvent =
  /**
   * A message was committed. `message` is omitted when too large for pub/sub: read it over HTTP. Its thread and run
   * come either way, so the app knows which live answer it ends while that read is on its way.
   */
  | {
      type: "message.created";
      channelId: string;
      messageId: string;
      message?: MessageView;
      threadId?: string | null;
      agentRunId?: string | null;
    }
  /** An agent run changed state (`running` = typing indicator). */
  | {
      type: "agent.run";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      status: RunStatus;
      /** Background work (a routine's run): not the conversation's "working" indicator. */
      background?: true;
      /** `waiting_input` parked on a provider outage: it retries by itself, nobody is asked. */
      outage?: true;
      /** `waiting_input` for its computer: in line for room (`queued`) or for it to come back (`away`). */
      computer?: "queued" | "away" | "line";
      /** `waiting_input` on its plan's limit or its budget: it answers when that renews, nobody is asked. */
      usage?: "plan" | "budget";
      error?: string;
      /** Stable code of `error` (`run.budget_exceeded`, `run.provider_error`…) and its params. */
      errorCode?: string;
      errorParams?: Record<string, string>;
    }
  /**
   * An agent will answer (mention, DM, router pick, or a run was claimed):
   * show "thinking" right away. `runId` is null when announced at post time,
   * before the run exists.
   */
  | {
      type: "agent.thinking";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string | null;
      /** Background work (a routine's run): not the conversation's "working" indicator. */
      background?: true;
    }
  /**
   * An agent asked another agent (`ask_agent`, ADR 0034), or handed it work (`kind` `note`, `tell_agent`, ADR 0095);
   * what comes of it arrives later as a notice: "Dev asked Infra…".
   */
  | {
      type: "agent.consulting";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      consultedAgentId: string;
      kind?: "note";
    }
  /**
   * An agent's question to another agent (`ask_agent`, ADR 0034), or the work it handed it (`kind` `note`), came
   * back: `status` answered, expired or failed.
   */
  | {
      type: "agent.consulted";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      consultedAgentId: string;
      status: "answered" | "expired" | "failed";
      kind?: "note";
    }
  /**
   * A question or hand-off still out changed without closing: the consulted agent stopped on a person (an approval,
   * a question, a secret) or on its computer, went back to work, or got more time while still at it. The app reloads
   * the conversation's questions (`GET …/consultations`).
   */
  | {
      type: "agent.consultation";
      channelId: string;
      threadId: string | null;
      runId: string;
      consultationId: string;
    }
  /**
   * The agent started a tool call (`tool` = its name; `connector` = the app, for MCP tools) or finished (`tool: null`,
   * with its `toolUseId`, `failed` when the tool answered with an error, `held` when it waits on a person).
   */
  | {
      type: "agent.tool";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      tool: string | null;
      connector?: string;
      /** The service it works in, for its logo (`ToolDefinition.service`), and a custom server's own icon. */
      service?: string;
      serviceIcon?: string;
      /**
       * A short label (≤ 80 chars): the skill, the issue (#131 or title), the Drive file, or the command a permission
       * check is about (Claude Code's own description of it, else its program and main argument). Built-in tools only.
       */
      detail?: string;
      /** The model's id of this call (live output refers to it). */
      toolUseId?: string;
      /** On the start: what the agent wrote right before this call, as one short line (`takeStepWords`). */
      said?: string;
      /** `run_code`: the code being run (≤ 4 KB, secrets masked). */
      code?: { language: string; source: string };
      /** `permission_prompt`: the whole command it checks, as one line (≤ 1000 chars, credentials masked). */
      command?: string;
      /** On the end (`tool: null`): the tool answered with an error. Never the error itself (it can carry data). */
      failed?: boolean;
      /** On a failed end: the gateway refused its arguments, the tool never ran. */
      slip?: boolean;
      /** On the end: it didn't run, it waits on a person (an approval, a question, a secret). */
      held?: boolean;
      /** On the end: a rule ("Aprovar sempre") let it run without asking, whose person, a reads one or not. */
      autoApproved?: { by: string | null; reads: boolean };
      /** On the end of a permission check it refused (`failed`): the policy's own reason, to the agent. */
      why?: string;
      /** With `why`: the refusal's code (`person`, `outside`…), which the apps say in the person's words. */
      refusal?: string;
      /**
       * A permission check waiting on a person: on its `held` end, its request; with no `toolUseId`, the person's
       * answer to that request (`failed` when they said no), which ends the line that waited for it.
       */
      requestId?: string;
    }
  /**
   * A computer brain's own call (Claude Code's Read or Grep, Codex's shell) that ran with no `agent.tool`: the brain
   * reports it once it ended. Its words (`said`, as on `agent.tool`) and its name are the waiting row's step line until
   * the next call. Never stored.
   */
  | {
      type: "agent.step";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      tool: string;
      said?: string;
    }
  /** What a computer command prints while it runs (throttled, ≤ 64 KB per call). */
  | {
      type: "agent.tool.output";
      channelId: string;
      threadId: string | null;
      runId: string;
      agentId: string;
      toolUseId?: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  /**
   * A browser command of the agent waits for a profile another agent or a person holds (ADR 0110): its card says
   * who has it. `wait: null` once it got the turn or gave up.
   */
  | {
      type: "agent.browser.waiting";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      wait: {
        profileId: string;
        name: string;
        holder: { type: "agent"; agentId: string; since: string } | { type: "person"; userId: string; since: string };
      } | null;
    }
  /** It writes (a model call's first text): the apps say so; its words wait for the message that posts them whole. */
  | { type: "agent.typing"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /** A long work changed (ADR 0121): moved, updated, waiting, queued or ended. Its anchor's line redraws from `work`. */
  | {
      type: "agent.work";
      channelId: string;
      /** Where the anchor is (the ask's thread; null: the main timeline). */
      threadId: string | null;
      agentId: string;
      runId: string | null;
      work: WorkView;
    }
  /** The agent stopped (done, failed or waiting for approval). */
  | {
      type: "agent.idle";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      background?: true;
    }
  | {
      type: "run.finished";
      channelId: string;
      threadId: string | null;
      agentId: string;
      background?: true;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled";
      /** `waiting_input` parked on a provider outage. */
      outage?: true;
      /** `waiting_input` for its computer: in line for room (`queued`) or for it to come back (`away`). */
      computer?: "queued" | "away" | "line";
      /** `waiting_input` on its plan's limit or its budget: it answers when that renews, nobody is asked. */
      usage?: "plan" | "budget";
      /** It ended without answering: on every message the run answers (a steered one too), as `message.handled`. */
      passed?: true;
      error?: string;
      errorCode?: string;
      errorParams?: Record<string, string>;
    }
  /**
   * A person's message went to the agent's task already in progress (one
   * active run per agent and conversation): it reads it at its next step.
   * `now`: the person asked it to stop and read it now ("Parar e mandar"): its current model
   * call is cut short. `stop`: the message asked to stop, and the run is being canceled (it can
   * arrive in a second event, after the stop judge).
   */
  | {
      type: "agent.run.steered";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageId: string;
      now?: true;
      stop?: boolean;
      /** Into a run waiting for its computer: in line for room (`queued`) or for it to come back (`away`). */
      computer?: "queued" | "away" | "line";
      /** Into a run waiting on its plan's limit or its budget. */
      usage?: "plan" | "budget";
    }
  /** The run read these messages sent while it worked (they are in its conversation now): "Ada leu". */
  | {
      type: "agent.run.read";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageIds: string[];
    }
  /**
   * Handed to a computer brain mid-turn (Claude Code reads it at its next tool boundary), not
   * confirmed read yet: "Ada recebeu". `agent.run.read` follows once the turn reports it read.
   */
  | {
      type: "agent.run.delivered";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageIds: string[];
    }
  /**
   * Messages a run took but never read (it ended, failed, was stopped or interrupted by a deploy)
   * went to a run of their own: nothing sent to an agent is dropped.
   */
  | {
      type: "agent.run.redispatched";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      newRunId: string;
      messageIds: string[];
    }
  /** The run ended without posting: nobody called it by name and it had nothing to add (`pass`). */
  | { type: "agent.passed"; channelId: string; threadId: string | null; agentId: string; runId: string }
  /**
   * A person's message reached a run that was waiting (help in the browser, another agent's answer,
   * an approval): `outcome` says what became of it. `resolved`: it ended the wait (e.g. "pronto,
   * loguei" closed the browser help as done). `woke`: the run stopped waiting and reads it now (the
   * wait stays open; its result comes later as a notice). `held`: it waits for the decision on a card.
   */
  | {
      type: "agent.run.wait_message";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      messageId: string;
      waitKind: string;
      outcome: "resolved" | "woke" | "held";
    }
  /**
   * A person pressed "Continuar" under a stopped reply (`messageId`): `newRunId` picks up where
   * `runId` stopped (its reply's `meta.canceled.continuedRunId`, or `meta.stepLimit.continuedRunId` after
   * its step limit), so every app hides the button.
   */
  | {
      type: "run.continued";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      newRunId: string;
      messageId: string;
    }
  /** A person stopped the run (`POST …/runs/{id}/cancel`): drop "pensando…" now; its text so far follows as a message. */
  | {
      type: "run.canceled";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      byUserId: string;
    }
  /** A person is typing (client frame `typing`). Clients drop it after `ttlMs`. */
  | { type: "user.typing"; channelId: string; threadId: string | null; userId: string; ttlMs: number }
  /** Who saw a message and who will answer (receipts). No router scores here. */
  | {
      type: "message.routed";
      channelId: string;
      messageId: string;
      seenBy: string[];
      pickedBy: string[];
      /** The run each picked agent answers with (new, steered into, or resumed by an answer). */
      runs?: { agentId: string; runId: string }[];
      /** Agents it mentions that won't answer (they don't reply to this person). */
      blocked?: string[];
      /**
       * Agents it only references: part of a person's request to another agent, or an agent's mention the judge read
       * as no hand-off (ADR 0089). No run, by design.
       */
      referenced?: string[];
      strategy: "mention" | "dm" | "router" | "none";
      /**
       * `no_ai`: the organization has no AI. `mention_needed`: no step could pick an agent (no Jev, no small
       * model, no plan of the author, no rule): a mention still calls one.
       */
      reason?: string;
      /** The router's step that picked (ADR 0074). */
      decidedBy?: DecidedBy;
      /** With `no_ai`: the Connect step the message asks for (`aiConnectIntent`). */
      intent?: ConnectIntent["intent"];
      provider?: string;
      autoOpen?: true;
    }
  /** The author's own plan reads a message nobody mentioned, which takes seconds: "Picking who answers" until `message.routed`. */
  | { type: "message.routing"; channelId: string; messageId: string; step: "plan" }
  | { type: "message.claimed"; channelId: string; messageId: string; agentId: string; runId: string }
  | {
      type: "message.handled";
      channelId: string;
      messageId: string;
      agentId: string;
      runId: string;
      status: "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled";
      /** `no_ai`: the agent has no AI to think with. */
      reason?: string;
      /** `failed`: why, for the app to word (`runErrorDetail`). */
      errorCode?: string;
      errorParams?: Record<string, string>;
      /** `waiting_input` parked on a provider outage. */
      outage?: true;
      /** `waiting_input` for its computer: in line for room (`queued`) or for it to come back (`away`). */
      computer?: "queued" | "away" | "line";
      /** `waiting_input` on its plan's limit or its budget: it answers when that renews, nobody is asked. */
      usage?: "plan" | "budget";
      /** It ended without answering: passed and posted nothing, or canceled before it ran. */
      passed?: true;
    }
  /** An agent changed its memory because a person asked (with an undo). */
  | {
      type: "memory.updated";
      channelId: string;
      threadId: string | null;
      agentId: string;
      runId: string;
      update: MemoryUpdate;
    }
  /** An agent asked a person something (`ask_user`), or the question was answered or expired. */
  | {
      type: "question.asked" | "question.answered";
      channelId: string;
      threadId: string | null;
      question: AgentQuestion;
    }
  /** An agent asked a person for a secret for its computer (ADR 0027), or the request closed. Never the value. */
  | {
      type: "secret.requested" | "secret.updated";
      channelId: string;
      threadId: string | null;
      secretRequest: SecretRequestView;
    }
  /** An agent's browser handoff changed (ADR 0040 §6): someone took control, or it ended. The card is `meta.browserHandoff`. */
  | {
      type: "browser.handoff.updated";
      channelId: string;
      threadId: string | null;
      handoff: BrowserHandoffView;
    }
  /** An issue of this channel was created or changed, or got a comment. */
  | { type: "issue.created" | "issue.updated"; channelId: string; issue: IssueView }
  | { type: "issue.deleted"; channelId: string; issueId: string; number: number }
  | { type: "issue.comment"; channelId: string; issueId: string; activity: IssueActivityView }
  /** An event of this channel's calendar was created. */
  | { type: "calendar.event_created" | "calendar.event_updated"; channelId: string; event: CalendarEventView }
  /** An agent's event proposal was confirmed or dismissed: its card (`meta.calendarProposal`) as it is now. */
  | {
      type: "calendar.proposal.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      proposal: CalendarProposalView;
    }
  /** An event (or some of its occurrences: `scope`) was deleted. */
  | {
      type: "calendar.event_deleted";
      channelId: string;
      eventId: string;
      scope: "this" | "following" | "all";
      occurrenceStart?: string;
    }
  /** A file was created or got a new version (Drive preview card). */
  | { type: "artifact.created" | "artifact.updated"; channelId: string; artifact: ArtifactView }
  /** A file was deleted (it shows as removed; restorable for 30 days). */
  | { type: "artifact.deleted"; channelId: string; artifactId: string }
  /** Channel membership changed (agents carry `autoReply`). */
  | {
      type: "channel.member_added" | "channel.member_removed" | "channel.member_updated";
      channelId: string;
      member: { type: "person" | "agent"; id: string; autoReply?: boolean };
    }
  /** A sensitive action waits for a person (`approval.created`) or was decided/expired (`approval.decided`). */
  | { type: "approval.created" | "approval.decided"; channelId: string; approval: ApprovalView }
  /**
   * A thread's state, title or context changed (ADR 0029). `thread` is the
   * fresh view when the server has it at hand (a reply that reopened a closed
   * thread sends only `state`). `messageIds`: messages that left the channel
   * (`moved`) or came back (`returned`).
   */
  | {
      type: "thread.updated";
      channelId: string;
      threadId: string;
      change: ThreadChange;
      state?: ThreadState;
      /** Without `following` (each person reads their own from the API). */
      thread?: Omit<ThreadInfo, "following" | "unread">;
      messageIds?: string[];
    }
  /** Someone reacted or took a reaction back: the message's reactions now (replace, don't merge). */
  | { type: "message.reactions"; channelId: string; messageId: string; reactions: ReactionCount[] }
  /** A vote came in or the poll closed (ADR 0113). */
  | { type: "poll.updated"; channelId: string; poll: PollView }
  /** Someone changed what a live block shows, for everyone (ADR 0113): the newest `rev` wins. */
  | { type: "block.state"; channelId: string; block: BlockStateView }
  /** A choice card was answered (ADR 0124). */
  | { type: "choices.updated"; channelId: string; choices: ChoicesView }
  /** A message was pinned in this channel (`GET …/channels/{id}/pins` lists them, newest first). */
  | {
      type: "message.pinned";
      channelId: string;
      messageId: string;
      threadId: string | null;
      pinnedByUserId: string;
      pinnedAt: string;
    }
  /** A message was unpinned. */
  | { type: "message.unpinned"; channelId: string; messageId: string }
  /** A person read this DM up to `lastReadAt` (DMs between people only: "Visto"). */
  | { type: "channel.read"; channelId: string; userId: string; lastReadAt: string }
  /** An agent saved something to memory from this person's message: its current memory marks. */
  | { type: "message.memories"; channelId: string; messageId: string; memories: MessageMemory[] }
  /**
   * Act with undo (ADR 0037 round 2): the receipts of an agent's message
   * changed (they were linked to it, or someone undid or redid one). `actions`
   * is the message's whole list now (replace, don't merge).
   */
  | {
      type: "message.actions";
      channelId: string;
      threadId: string | null;
      messageId: string;
      actions: AgentActionView[];
    }
  /**
   * A background task on a connected computer started, reported progress
   * (last line, files, elapsed), ended, was interrupted or resumed (ADR 0029).
   * `task` is its whole view (replace, don't merge); `threadId` null = main timeline.
   */
  | { type: "machine.task"; channelId: string; threadId: string | null; task: MachineTaskView }
  /**
   * A mission changed (ADR 0029): status, plan, participants, owner,
   * computer, a decision, a review, a suggestion, a task, a file edited on
   * the machine. `change` says what; small details ride along (`decision`,
   * `review`, `messageId`…); clients refetch `GET …/missions/{missionId}` for
   * the rest. `threadId` is the mission's home thread.
   */
  | {
      type: "mission.updated";
      channelId: string;
      threadId: string;
      missionId: string;
      status: "proposed" | "active" | "paused" | "done" | "canceled" | "awaiting_close";
      change: string;
      [key: string]: unknown;
    }
  /**
   * An agent's proposal of a new agent was decided (ADR 0081): what changed on its card (`meta.actionCard`). The
   * draft stays on the message: its instructions alone can be past a NOTIFY payload's limit.
   */
  | {
      type: "agent.proposal.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      state: "pending" | "creating" | "created" | "denied" | "superseded";
      agentId: string | null;
      decidedByUserId: string | null;
      decidedAt: string | null;
      /** Sent to whoever may create agents ("Pedir a um admin", ADR 0137). */
      askedAt?: string;
      /** Created in one click: the lines of its draft it got (ids only). */
      applied?: { channelIds: string[]; connectionIds: string[]; mailAccountIds: string[] };
      /** The routine made with it. */
      routineId?: string | null;
    }
  /** The right hand's team card changed (created, failed, adjusted, dismissed, undone, replaced): the whole card. */
  | {
      type: "team.proposal.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      card: TeamProposalCard;
    }
  /** A catalog action's card of the right hand was applied, dismissed or sent to whoever may: the whole card. */
  | {
      type: "action_card.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      card: Record<string, unknown>;
    }
  /** A device wait's card ended or changed (bring your own devices): the message's whole `meta.deviceWait` now. */
  | {
      type: "device_wait.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      deviceWait: Record<string, unknown>;
    }
  /** A report an agent offered was sent or put away (ADR 0160 §12): the message's whole `meta.feedbackOffer` now. */
  | {
      type: "feedback_offer.updated";
      channelId: string;
      threadId: string | null;
      messageId: string;
      offer: FeedbackOfferView;
    }
  /** The right hand looked at a card for someone (ADR 0139): its `meta.actionCard.delegate` now (null: nothing to say). */
  | {
      type: "card.delegate";
      channelId: string;
      threadId: string | null;
      messageId: string;
      delegate: Record<string, unknown> | null;
    };

const INLINE_LIMIT = 6000;

export async function publishChannelEvent(pubsub: PubSub | undefined, event: ChannelEvent): Promise<void> {
  if (!pubsub) return;
  try {
    await pubsub.publish(channelTopic(event.channelId), event);
  } catch {
    // Real-time is best effort: clients catch up from the API on reconnect.
  }
}

export async function publishMessageCreated(pubsub: PubSub, message: MessageView) {
  const inline = Buffer.byteLength(JSON.stringify(message)) <= INLINE_LIMIT;
  await publishChannelEvent(pubsub, {
    type: "message.created",
    channelId: message.channelId,
    messageId: message.id,
    ...(inline ? { message } : { threadId: message.threadId, agentRunId: message.agentRunId }),
  });
  try {
    await pubsub.publish(chatActivityTopic, {
      type: "channel.activity",
      channelId: message.channelId,
      threadId: message.threadId,
      authorUserId: message.author.type === "person" ? message.author.id : null,
      mentionedUserIds: message.mentionedUserIds,
    });
  } catch {
    // Best effort: the lists catch up when they're read again.
  }
}

/** Receipts of a routed message (`message.routed`), then "thinking" for each run it started, where the message is. */
export async function publishRouted(
  pubsub: PubSub | undefined,
  message: { id: string; channelId: string; threadId: string | null },
  routed: {
    strategy: "mention" | "dm" | "router" | "none";
    seenBy: string[];
    runs: { id: string; agentId: string }[];
    reason?: string;
    decidedBy?: DecidedBy;
    referenced?: string[];
  } & Partial<ConnectIntent>,
) {
  const { strategy, seenBy, runs, reason, decidedBy, referenced, ...intent } = routed;
  await publishChannelEvent(pubsub, {
    type: "message.routed",
    channelId: message.channelId,
    messageId: message.id,
    seenBy,
    pickedBy: runs.map((r) => r.agentId),
    runs: runs.map((r) => ({ agentId: r.agentId, runId: r.id })),
    strategy,
    ...(referenced?.length ? { referenced } : {}),
    ...(reason ? { reason } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...intent,
  });
  for (const run of runs) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: message.channelId,
      threadId: message.threadId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
}

/**
 * Organization events, consumed by the WebSocket server (not sent to clients
 * verbatim). A membership change drops the affected subscriptions at once
 * instead of waiting for a reconnect (docs/adr/0010-realtime.md).
 */
export type OrgEvent =
  /**
   * `userId` left or was removed: from one channel (`channelId`), or from the whole organization. `quiet` when it
   * wasn't someone else taking them out (they left, deleted their account, or were blocked): their apps say nothing.
   */
  | { type: "membership.revoked"; orgId: string; userId: string; channelId?: string; quiet?: true }
  /** The channel is gone for everyone. */
  | { type: "channel.archived"; orgId: string; channelId: string }
  /** Something every member of the org may see (org-wide issues, calendar): forwarded as `scope: "org"`. */
  | { type: "org.broadcast"; orgId: string; event: { type: string; [key: string]: unknown } };

/**
 * An org broadcast: an owner (`by`) deleted the workspace. It is read-only now (its people's sockets stay open), and it
 * goes for good at `dueAt` unless an owner restores it first.
 */
export type OrgDeletingEvent = {
  type: "org.deleting";
  orgId: string;
  dueAt: string;
  by: { id: string; name: string };
};

export async function publishOrgEvent(pubsub: PubSub | undefined, event: OrgEvent): Promise<void> {
  if (!pubsub) return;
  try {
    await pubsub.publish(orgTopic(event.orgId), event);
  } catch {
    // Best effort; access is still re-checked on every subscribe and HTTP request.
  }
}

/**
 * A routine's runs changed (one was queued, started or ended): the apps that show its runs fetch them again. Only its
 * id goes out; what each person may see of it stays behind the routines' own endpoints.
 */
export const publishRoutineRuns = (pubsub: PubSub | undefined, orgId: string, routineId: string) =>
  publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "routine.runs", orgId, routineId } });

/**
 * Something in the workspace's Vault changed (ADR 0144): an item, a connection, a sync. Nothing else goes out, not
 * even which item: each app fetches again what its person may see.
 */
export type VaultChangedEvent = { type: "vault.changed"; orgId: string };

export const publishVaultChanged = (pubsub: PubSub | undefined, orgId: string) =>
  publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "vault.changed", orgId } satisfies VaultChangedEvent,
  });

/**
 * The team changed (an agent made, renamed, given a look, archived, back or deleted): the apps read their lists again.
 * Nothing else goes out: what each person may see of it stays behind the agents' own endpoints.
 */
export const publishAgentsChanged = (pubsub: PubSub | undefined, orgId: string) =>
  publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "agents.changed" } });

/**
 * A channel was made, renamed, archived, back or deleted, or its members changed. On the org's topic, unlike
 * `channel.member_*`: a channel made a moment ago has nobody subscribed to it yet. Same contract as the agents': no ids.
 */
export const publishChannelsChanged = (pubsub: PubSub | undefined, orgId: string) =>
  publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "channels.changed" } });

/**
 * A list any member may have open changed: the Drive's files (saved, changed, moved, deleted, restored), the calendar,
 * the routines, or agents' memories learned in the background. Same contract as the agents': no ids, each app reads
 * again what its person may see.
 */
export const publishListChanged = (
  pubsub: PubSub | undefined,
  orgId: string,
  list: "artifacts" | "calendar" | "routines" | "memory",
) => publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: `${list}.changed` } });

/** An event for one person (forwarded to every connection they have open in that organization). */
export type UserEvent = { type: string; [key: string]: unknown };

export async function publishUserEvent(pubsub: PubSub | undefined, orgId: string, userId: string, event: UserEvent) {
  if (!pubsub) return;
  try {
    await pubsub.publish(userTopic(orgId, userId), event);
  } catch {}
}
