import {
  isScreenTool,
  type LiveWork,
  type Run,
  type RunStep,
  type ScreenKind,
  useCatalog,
  useRun,
} from "@agenteschat/client";
import type { Activity, ActivityKind } from "@agenteschat/client/lib/activity";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  appKey,
  callLogo,
  formatDuration,
  formatLineTime,
  oneCall,
  quietLine,
  quietWork,
  savedOneLine,
  showsActivity,
  type ToolItem,
  type ToolLine,
  toolApps,
  toolCalls,
  toolItemsLive,
  toolItemsSaved,
  toolLineHint,
  toolNow,
  toolPhrase,
  toolWhy,
  workApps,
  workFromSteps,
  workMeta,
  workSteps,
} from "@agenteschat/client/lib/work";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  type AgentColor,
  Icon,
  type IconName,
  PixelSpinner,
  ToolBlock,
  type ToolBlockItem,
  type ToolBlockLine,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CodePanel, formatBytes, OutputView, type SteerNote, SteerWell } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";

/** Our own tools by what they do: their icon in the block (a connector's call shows its logo). */
const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  readingDrive: "drive",
  writingDrive: "drive",
  exportingFile: "drive",
  importingFile: "drive",
  uploadingArtifact: "drive",
  fetchingFile: "file",
  creatingIssue: "issues",
  updatingIssue: "issues",
  readingIssues: "issues",
  startingTask: "issues",
  listingTasks: "issues",
  checkingTask: "issues",
  cancelingTask: "issues",
  searchingMemory: "bulb",
  updatingMemory: "bulb",
  gettingContext: "bulb",
  checkingCalendar: "calendar",
  schedulingEvent: "calendar",
  schedulingReminder: "bell",
  cancelingReminder: "bell",
  listingReminders: "bell",
  followingUp: "clock",
  cancelingFollowUp: "clock",
  creatingRoutine: "routines",
  updatingRoutine: "routines",
  listingRoutines: "routines",
  writingWiki: "book",
  readingWiki: "book",
  linkingWiki: "book",
  askingQuestion: "question",
  reacting: "smile",
  sendingGif: "sticker",
  sendingSticker: "sticker",
  openingSkill: "layers",
  consultingSkill: "layers",
  runningSkillScript: "code",
  runningSkillScriptAny: "code",
  runningCode: "code",
  browsing: "globe",
  pcFiles: "file",
  checkingComputer: "computer",
  checkingUsage: "chart",
  findingAgent: "search",
  proposingMission: "flag",
  messagingMission: "flag",
  updatingPlan: "flag",
  reportingProgress: "flag",
  askingDecision: "flag",
  requestingReview: "flag",
  requestingApproval: "approve",
  creatingChannel: "channel",
  offeringConnectAi: "plug",
  offeringConnectApp: "plug",
  offeringInvites: "personAdd",
  findingTools: "search",
  runningCommand: "code",
  runningCommandAny: "code",
  usingScreen: "computer",
  testingOnPhone: "phone",
  waitingForDevice: "waiting",
  cloningRepo: "repo",
  openingPullRequest: "pullRequest",
  handingOff: "routines",
  recordingFindings: "flag",
  deliveringMission: "flag",
  requestingAccess: "key",
  requestingSecret: "lock",
  queryingDatabase: "database",
};

/**
 * A call's logo: its service's mark as the connectors screens draw it (`callLogo`), or the icon of one of our tools.
 * The task manager draws what a task uses now with the same logos.
 */
export function useCallLogo() {
  const catalog = useCatalog();
  return (a: Activity) => {
    const logo = callLogo(a, catalog.data?.connectors ?? []);
    if (logo.kind === "service") return <ConnectorIcon def={logo.def} label={logo.label} image={logo.image} />;
    return (
      <span className="tool-logo" aria-hidden="true">
        <Icon name={logo.kind === "mail" ? "mail" : (KIND_ICON[a.kind] ?? "plug")} size={14} />
      </span>
    );
  };
}

/** A line of the block from the shared model: its phrase, time, open view (code, output, what it got and gave). */
function blockLine(t: TFunction, locale: string, l: ToolLine, logo: ReactNode, personal = false) {
  const lines = l.code ? l.code.source.split("\n").length : 0;
  const output = l.output ?? [];
  const label =
    l.code && l.state === "done"
      ? t("code.ranSummary", {
          count: lines,
          language: l.code.language,
          size: formatBytes(
            locale,
            output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0),
          ),
        })
      : toolPhrase(t, l);
  const why = toolWhy(t, l, personal);
  // What the tool answered, its own words when it failed: only in the open view, never under the line.
  const answered = l.result ?? why ?? l.why;
  const detail = l.code ? (
    <CodePanel code={l.code} output={output} live={l.state === "run"} />
  ) : output.length > 0 ? (
    <OutputView output={output} live={l.state === "run"} />
  ) : l.input || answered ? (
    <div className="ac-tools__io">
      {l.input && (
        <>
          <b>{t("chat.work.gave")}</b>
          <span>{l.input}</span>
        </>
      )}
      {answered && (
        <>
          <b>{l.state === "fail" ? t("chat.work.error") : t("chat.work.answered")}</b>
          <span>{answered}</span>
        </>
      )}
    </div>
  ) : undefined;
  const line: ToolBlockLine = {
    key: l.key,
    state: l.state,
    logo,
    label,
    hint: toolLineHint(t, l),
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    count: l.count > 1 ? t("chat.work.times", { count: l.count }) : undefined,
    why: l.state === "fail" ? why : null,
    detail,
    defaultOpen: l.state === "run" && Boolean(l.code),
  };
  return line;
}

function useBlockItems(items: ToolItem[]): ToolBlockItem[] {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  const personal = isPersonal(useOrg().org);
  return items.flatMap((item): ToolBlockItem[] =>
    item.kind === "call"
      ? [{ kind: "line", line: blockLine(t, i18n.language, item.line, logo(item.line), personal) }]
      : item.kind === "say"
        ? [{ kind: "note", key: item.key, node: item.text }]
        : [],
  );
}

/**
 * The tools of a reply while it works (and kept after, `done`): one line saying what it does now, the apps'
 * logos and the steps, opening into every call; a single call is that call's own line. What it said between calls
 * is inside; the messages it read stay outside, under the block, so "Leu seu recado" is always in sight.
 */
export function LiveTools({
  work,
  agentName,
  color,
  steerNote,
  done,
  stopped,
}: {
  work: LiveWork[];
  agentName: string;
  color?: AgentColor;
  steerNote?: (messageId: string) => SteerNote | undefined;
  /** The reply is done: "Usou 4 ferramentas". */
  done?: boolean;
  /** Stopped by someone: the call running then shows as stopped. */
  stopped?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const items = toolItemsLive(work, stopped || done);
  const blockItems = useBlockItems(items);
  const logo = useCallLogo();
  const calls = toolCalls(items);
  const steers = items.flatMap((i) => (i.kind === "steer" ? [i] : []));
  // Done, its tools are the summary the person chose not to see (`showActivity`): what it read stays.
  if (done && !showsActivity(org))
    return steers.map((s) => <SteerWell key={s.key} now={s.now} note={steerNote?.(s.messageId)} />);
  // A lone quick read that only fed the answer: no card, as if it called nothing (once done, what it said on the way
  // is in its reply).
  const quiet = quietWork(items);
  const now = quiet ? null : toolNow(items);
  const said = quiet && done ? [] : items.flatMap((i) => (i.kind === "say" ? [i] : []));
  if (!now) {
    // Nothing called yet: what it said and read, as lines.
    return said.length + steers.length > 0 ? (
      <div className="live-work-notes">
        {items.map((i) =>
          i.kind === "say" && said.length > 0 ? (
            <p key={i.key} className="live-work__say">
              {i.text}
            </p>
          ) : i.kind === "steer" ? (
            <SteerWell key={i.key} now={i.now} note={steerNote?.(i.messageId)} />
          ) : null,
        )}
      </div>
    ) : null;
  }
  const one = oneCall(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head = done
    ? {
        text: t("chat.work.used", { count: calls }),
        time: total > 0 ? formatDuration(t, total) : undefined,
      }
    : {
        text: blockLine(t, i18n.language, now, null).label,
        textKey: `${now.key}-${now.state}`,
        state: now.state,
        count: t("chat.work.steps", { count: calls }),
      };
  return (
    <>
      <ToolBlock
        logos={toolApps(items).map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
        head={head}
        // Its own line is closed until clicked, as the block it stands for (code that runs shows when opened).
        items={
          one
            ? blockItems.map((i) => (i.kind === "line" ? { ...i, line: { ...i.line, defaultOpen: false } } : i))
            : blockItems
        }
        color={color}
        label={t("chat.work.block", agentGrammar(agentName))}
        one={one}
      />
      {steers.map((s) => (
        <SteerWell key={s.key} now={s.now} note={steerNote?.(s.messageId)} />
      ))}
    </>
  );
}

/**
 * A task's steps in the task manager's panel (ADR 0128): the same block and lines as a reply's, open, from the task's
 * own steps (`useTaskSteps`). While it works, its last call still waiting for a result is the one running.
 */
export function TaskStepsBlock({
  steps,
  run,
  working,
  agentName,
  color,
}: {
  steps: RunStep[];
  run: Pick<Run, "createdAt" | "finishedAt">;
  working: boolean;
  agentName: string;
  color?: AgentColor;
}) {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  const saved = toolItemsSaved(workFromSteps(steps, run));
  const last = saved.findLastIndex((i) => i.kind === "call");
  const items: ToolItem[] = saved.map((item, i) =>
    working && i === last && item.kind === "call" && item.line.state === "stop"
      ? { ...item, line: { ...item.line, state: "run" as const } }
      : item,
  );
  const blockItems = useBlockItems(items);
  const calls = toolCalls(items);
  if (calls === 0) return null;
  const now = toolNow(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head =
    working && now
      ? {
          text: blockLine(t, i18n.language, now, null).label,
          textKey: `${now.key}-${now.state}`,
          state: now.state,
          count: t("chat.work.steps", { count: calls }),
        }
      : { text: t("chat.work.used", { count: calls }), time: total > 0 ? formatDuration(t, total) : undefined };
  return (
    <ToolBlock
      defaultOpen
      logos={toolApps(items).map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
      head={head}
      items={blockItems}
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
    />
  );
}

/**
 * The tools of a saved reply: closed, "Usou 4 ferramentas · 12 s" with the apps' logos from `meta.work`; its
 * steps load from `GET …/runs/{id}` only when opened (one request per opened message). A single call is its own
 * line from `meta.work` ("Criou uma rotina"), opening on what it was given and answered.
 */
export function SavedTools({
  runId,
  meta,
  agentName,
  color,
  skipScreens = [],
}: {
  runId: string;
  meta: Record<string, unknown> | undefined;
  agentName: string;
  color?: AgentColor;
  /** Screens whose calls have their own card on the message (`BrowserTrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(org.id, open ? runId : null);
  const logo = useCallLogo();
  const compact = workMeta(meta);
  const onCard = (name: unknown) => skipScreens.some((screen) => isScreenTool(String(name ?? ""), screen));
  const work = run.data
    ? workFromSteps(
        run.data.steps.filter((s) => !(s.kind === "tool_call" && onCard(s.data.name))),
        run.data.run,
      )
    : null;
  const items = work ? toolItemsSaved(work) : [];
  const blockItems = useBlockItems(items);
  // Nothing more to show than the message does: no tools (lookups and reactions aren't counted), or only the ones
  // its own cards show (where it browsed).
  // No `meta.work` (a reply saved before it): a block that loads the run's steps when opened, gone if it called none.
  const shown = compact ? workSteps(compact, onCard) : null;
  if (shown === 0 || !showsActivity(org)) return null;
  const calls = work ? toolCalls(items) : (shown ?? 0);
  const lone = savedOneLine(meta, onCard);
  // Its one call (beside the screens' on their cards) only fed the answer (`quietLine`): the reply says it. Time
  // unknown (saved before the server wrote it): kept, it may have failed.
  if (lone && lone.ms !== null && quietLine(lone)) return null;
  if (lone && (!work || oneCall(items) || !items.some((i) => i.kind === "call"))) {
    const line = blockLine(t, i18n.language, lone, logo(lone), isPersonal(org));
    const wait = run.isError ? (
      t("chat.work.failed")
    ) : !work ? (
      <PixelSpinner size={14} color={color} label={t("common.loading")} />
    ) : undefined;
    return (
      <ToolBlock
        one
        logos={[]}
        head={{ text: line.label }}
        items={work && oneCall(items) ? blockItems : [{ kind: "line", line: { ...line, detail: wait } }]}
        color={color}
        label={t("chat.work.block", agentGrammar(agentName))}
        // Its steps stay once loaded: closing the line doesn't change what it says.
        onToggle={(o) => o && setOpen(true)}
      />
    );
  }
  // Never a block that opens on nothing.
  if (work && calls === 0) return null;
  const durationMs = work?.durationMs ?? compact?.durationMs ?? null;
  const apps = work ? toolApps(items) : workApps((compact?.calls ?? []).filter((c) => !onCard(c.name)));
  const status: ToolBlockItem[] = run.isError
    ? [{ kind: "note", key: "error", node: t("chat.work.failed") }]
    : !work
      ? [
          {
            kind: "note",
            key: "loading",
            node: <PixelSpinner size={14} color={color} label={t("common.loading")} />,
          },
        ]
      : [];
  return (
    <ToolBlock
      logos={apps.map((a) => <span key={appKey(a)}>{logo(a)}</span>)}
      head={{
        text: calls > 0 ? t("chat.work.used", { count: calls }) : t("chat.work.block", agentGrammar(agentName)),
        time: durationMs !== null ? formatDuration(t, durationMs) : undefined,
      }}
      items={[...status, ...blockItems]}
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
      onToggle={setOpen}
    />
  );
}
