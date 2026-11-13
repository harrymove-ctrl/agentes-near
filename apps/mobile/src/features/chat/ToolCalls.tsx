import { isScreenTool, type ScreenKind, useCatalog, useRun, useTaskSteps } from "@agenteschat/client";
import type { Activity, ActivityKind } from "@agenteschat/client/lib/activity";
import { formatBytes } from "@agenteschat/client/lib/files";
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
  type ToolState,
  toolApps,
  toolCalls,
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
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { stopBreath } from "@/agent/orbit";
import { useOrg } from "@/providers/org";
import {
  CHROME_MAX_SCALE,
  Icon,
  type IconName,
  PixelDone,
  PixelFail,
  PixelOrbit,
  PixelStopped,
  Text,
  useReducedMotion,
} from "@/ui";
import { ConnectorIcon, IconTile } from "../connectors/ConnectorIcon";
import { useColors, useOrgId } from "../shared/hooks";
import { MONO, tapHaptic } from "../shared/parts";
import { CodeCard } from "./CodeCard";
import { MessageText } from "./MessageText";
import { outputTail } from "./turn";

/**
 * The tools of one reply, as on the web (`ToolCalls.tsx`, the UI kit's `ToolBlock`): one
 * flat card that stays one line while the agent works (the apps' logos, what it does now, the pixel mark)
 * and opens on a tap into every call, each opening again into what it ran or was given and answered. What
 * the agent said between calls sits inside, muted; the messages it read stay outside, under the block, so
 * "Leu seu recado" is always in sight. The words come from the shared model (`@agenteschat/client/lib/work`).
 */

/** Our own tools by what they do: their icon on the tile (a connector's call shows its mark). */
const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  readingDrive: "drive",
  writingDrive: "drive",
  exportingFile: "drive",
  importingFile: "drive",
  uploadingArtifact: "drive",
  fetchingFile: "file",
  pcFiles: "file",
  creatingIssue: "issue",
  updatingIssue: "issue",
  readingIssues: "issue",
  startingTask: "issue",
  listingTasks: "issue",
  checkingTask: "issue",
  cancelingTask: "issue",
  searchingMemory: "brain",
  updatingMemory: "brain",
  gettingContext: "brain",
  checkingCalendar: "clock",
  schedulingEvent: "clock",
  schedulingReminder: "bell",
  cancelingReminder: "bell",
  listingReminders: "bell",
  followingUp: "clock",
  cancelingFollowUp: "clock",
  creatingRoutine: "clock",
  updatingRoutine: "clock",
  listingRoutines: "clock",
  writingWiki: "doc",
  readingWiki: "doc",
  linkingWiki: "doc",
  askingQuestion: "help",
  reacting: "smile",
  sendingGif: "image",
  sendingSticker: "smile",
  openingSkill: "sparkle",
  consultingSkill: "sparkle",
  runningSkillScript: "code",
  runningSkillScriptAny: "code",
  runningCode: "code",
  browsing: "globe",
  checkingComputer: "laptop",
  checkingUsage: "chart",
  findingAgent: "agent",
  proposingMission: "flag",
  messagingMission: "flag",
  updatingPlan: "flag",
  reportingProgress: "flag",
  askingDecision: "flag",
  requestingReview: "flag",
  requestingApproval: "shield",
  creatingChannel: "hash",
  askingAgent: "agent",
  tellingAgent: "agent",
  findingTools: "search",
  runningCommand: "code",
  runningCommandAny: "code",
  usingScreen: "laptop",
  waitingForDevice: "wait",
  cloningRepo: "code",
  openingPullRequest: "code",
  handingOff: "clock",
  recordingFindings: "flag",
  deliveringMission: "flag",
  requestingAccess: "shield",
  requestingSecret: "lock",
  queryingDatabase: "server",
};

/** How many logos the closed line stacks (a phone has no room for more). */
const LOGOS_MAX = 4;

/**
 * A call's logo: its service's mark as the connectors screens draw it (`callLogo`), or the icon of one of our tools.
 * The task manager draws what a task uses now with it too (ADR 0128).
 */
export function useCallLogo() {
  const catalog = useCatalog();
  return (a: Activity, size = 20): ReactNode => {
    const logo = callLogo(a, catalog.data?.connectors ?? []);
    if (logo.kind === "service")
      return <ConnectorIcon def={logo.def} label={logo.label} image={logo.image} size={size} />;
    return <IconTile name={logo.kind === "mail" ? "mail" : (KIND_ICON[a.kind] ?? "server")} size={size} />;
  };
}

// ── The block ────────────────────────────────────────────────────────────────

export interface BlockLine {
  key: string;
  state: ToolState;
  logo: ReactNode;
  /** "Consultando o GitHub…", "Consultou o GitHub", "Rodou 12 linhas de python · saída 1 kB". */
  label: string;
  /** The tool's own name or the built-in's label: read aloud, not drawn (no room on a phone). */
  hint: string | null;
  /** "1,2 s". */
  time?: string;
  /** "×5": several calls of the same kind in a row. */
  count?: string;
  /** Why it failed, under the line. */
  why?: string | null;
  /** Its open view; without it the line doesn't open. */
  detail?: ReactNode;
  /** Opens by itself (a call running code shows it as it runs). */
  defaultOpen?: boolean;
}

export type BlockItem = { kind: "line"; line: BlockLine } | { kind: "note"; key: string; node: ReactNode };

interface BlockHead {
  /** What it does now ("Consultando o banco…"), or "Usou 5 ferramentas" once done. */
  text: string;
  /** Changes when what it does changes: the words come up again. */
  textKey?: string;
  /** The mark after the words: the orbit while it works; none once done. */
  state?: ToolState;
  /** "4 passos" while it works: read aloud only (the phone's line has no room for it). */
  count?: string;
  /** "6 s" once done. */
  time?: string;
}

const POP = ZoomIn.springify().damping(11).stiffness(320).mass(0.6);

/**
 * A block someone was just led to ("Ver" on an answer's line) wears the plate this long, the web's message focus
 * (`ac-msg--focus`): held, then fading. With reduced motion it stays the whole time and goes at once.
 */
const FLASH_MS = 2400;
const FLASH_HOLD_MS = 960;

/** Whether the plate shows: for `ms` once drawn with `at` (when someone was led here), again when `at` changes. */
function useFlash(at: number | null, ms: number) {
  const [on, setOn] = useState(at !== null);
  useEffect(() => {
    setOn(at !== null);
    if (at === null) return;
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [at, ms]);
  return on;
}

/**
 * The card: a hairline and the app's cut corner (bottom left small), one line that opens on a tap. `live`:
 * new logos pop in and the line's words come up when they change; a saved block draws still. A single call (`one`)
 * is its own line, with nothing to open around it: what was said goes in that line's open view.
 */
export function ToolBlock({
  logos,
  head,
  items,
  color,
  label,
  live = false,
  defaultOpen = false,
  flash = null,
  onToggle,
  one = false,
}: {
  logos: { key: string; node: ReactNode }[];
  head: BlockHead;
  items: BlockItem[];
  color: AgentColorName;
  /** The block's name for screen readers ("O que a Ana fez"). */
  label: string;
  live?: boolean;
  /** Starts open (questions to other agents still out). */
  defaultOpen?: boolean;
  /** When someone was led here ("Ver" on an answer's line): the card wears a plate a moment, as the web does. */
  flash?: number | null;
  /** Opened (load the saved steps) or closed; with `one`, its line. */
  onToggle?: (open: boolean) => void;
  /** The work is one call: its line in place of the head ("Criou uma rotina", not "Usou 1 ferramenta"). */
  one?: boolean;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  const flashing = useFlash(flash, reduced ? FLASH_MS : FLASH_HOLD_MS);
  const moving = live && !reduced;
  const only = one ? items.find((i) => i.kind === "line") : undefined;
  const plate = flashing ? (
    // Under the card's words (drawn first), never over them.
    <Animated.View
      pointerEvents="none"
      exiting={reduced ? undefined : FadeOut.duration(FLASH_MS - FLASH_HOLD_MS)}
      style={[StyleSheet.absoluteFill, { backgroundColor: c.plate }]}
    />
  ) : null;
  if (only?.kind === "line") {
    const notes = items.flatMap((i) => (i.kind === "note" ? [i] : []));
    const detail =
      notes.length > 0 ? (
        <>
          {notes.map((n) => (
            <View key={n.key}>{n.node}</View>
          ))}
          {only.line.detail}
        </>
      ) : (
        only.line.detail
      );
    return (
      <View style={[styles.block, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        {plate}
        <View style={styles.one}>
          <Line line={{ ...only.line, detail }} color={color} onToggle={onToggle} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.block, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      {plate}
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen(!open);
          onToggle?.(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[label, head.text, head.count, head.time].filter(Boolean).join(", ")}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.plateSoft }]}
      >
        {logos.length > 0 ? (
          <View style={styles.logos}>
            {logos.slice(0, LOGOS_MAX).map((l, i) => (
              <Animated.View
                key={l.key}
                entering={moving ? POP : undefined}
                style={[styles.stacked, i > 0 && styles.overlap, { borderColor: c.raised }]}
              >
                {l.node}
              </Animated.View>
            ))}
          </View>
        ) : null}
        {/* The new words come up inside the line, never over the divider under it. */}
        <View style={[styles.grow, styles.clip]}>
          <Animated.View key={head.textKey ?? head.text} entering={moving ? FadeInDown.duration(350) : undefined}>
            <Breathing on={head.state === "run"}>
              <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.medium}>
                {head.text}
              </Text>
            </Breathing>
          </Animated.View>
        </View>
        {head.time ? (
          <Text variant="caption" tone="faint" style={styles.num} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {head.time}
          </Text>
        ) : null}
        {head.state ? <Mark state={head.state} color={color} /> : null}
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.faint} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View
          entering={reduced ? undefined : FadeIn.duration(200)}
          style={[styles.lines, { borderTopColor: c.line }]}
        >
          {items.map((item) =>
            item.kind === "note" ? (
              <View key={item.key} style={styles.note}>
                {item.node}
              </View>
            ) : (
              <Line key={item.line.key} line={item.line} color={color} />
            ),
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * One call: logo, phrase, time, mark; a tap opens what it ran or was given and answered. The phrase wraps, whole:
 * the logo, the time and the mark stay level with its first line.
 */
function Line({
  line,
  color,
  onToggle,
}: {
  line: BlockLine;
  color: AgentColorName;
  onToggle?: (open: boolean) => void;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(line.defaultOpen === true);
  // Open while it runs (its code), it folds when the call ends; a tap opens it again.
  const running = useRef(line.state === "run");
  useEffect(() => {
    if (running.current && line.state !== "run") setOpen(false);
    running.current = line.state === "run";
  }, [line.state]);
  const opens = Boolean(line.detail);
  const said = [line.label, line.hint, line.count, line.time].filter(Boolean).join(", ");
  const row = (
    <>
      <View style={styles.logo}>{line.logo}</View>
      <View style={styles.grow}>
        <Breathing on={line.state === "run"}>
          <Text variant="footnote" tone="ink2" style={[styles.medium, styles.firstLine]}>
            {line.label}
          </Text>
        </Breathing>
      </View>
      {line.count ? (
        <Text
          variant="caption"
          tone="faint"
          style={[styles.num, styles.level]}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
        >
          {line.count}
        </Text>
      ) : null}
      {line.time ? (
        <Text
          variant="caption"
          tone="faint"
          style={[styles.num, styles.level]}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
        >
          {line.time}
        </Text>
      ) : null}
      <View style={styles.level}>
        <Mark state={line.state} color={color} />
      </View>
    </>
  );
  return (
    // A failed call says so by its mark and its reason, on the block's own surface (no tinted plate).
    <View style={styles.line}>
      {opens ? (
        <Pressable
          onPress={() => {
            tapHaptic();
            setOpen(!open);
            onToggle?.(!open);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={said}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.plateSoft }]}
        >
          {row}
        </Pressable>
      ) : (
        <View style={styles.row} accessible accessibilityLabel={said}>
          {row}
        </View>
      )}
      {line.why ? (
        <Text variant="caption" tone="danger" style={styles.why}>
          {line.why}
        </Text>
      ) : null}
      {open && opens ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(160)} style={styles.detail}>
          {line.detail}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The pixel marks: the orbit while it works, one green pixel when done, an exclamation if it failed. */
function Mark({ state, color }: { state: ToolState; color: AgentColorName }) {
  return (
    <View style={styles.mark}>
      {state === "run" ? (
        <PixelOrbit color={color} size={14} />
      ) : state === "done" ? (
        <PixelDone size={14} />
      ) : state === "fail" ? (
        <PixelFail size={14} />
      ) : (
        <PixelStopped size={12} />
      )}
    </View>
  );
}

/**
 * The words of the call running now breathe (1 → 0.6 → 1 every 1.6 s, the stop square's rhythm): the web
 * shimmers them, which a phone's text can't do without masking. Still with Reduce Motion.
 */
function Breathing({ on, children }: { on: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const t = useFrameTime(on && !reduced, 0);
  return <View style={on ? { opacity: stopBreath(t * 1000, reduced) } : undefined}>{children}</View>;
}

/** Monospace text on a sunken plate: what it printed, or what it was given and answered. */
function Plate({ rows }: { rows: { label?: string; text: string; danger?: boolean }[] }) {
  const c = useColors();
  return (
    <View style={[styles.plate, { backgroundColor: c.sunken, borderColor: c.line }]}>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the plate's rows, in order
        <View key={i} style={styles.plateRow}>
          {r.label ? (
            <Text variant="caption" tone="faint">
              {r.label}
            </Text>
          ) : null}
          <Text selectable style={[styles.mono, { color: r.danger ? c.danger : c.muted }]}>
            {r.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

const bytesOf = (output: readonly { text: string }[]) =>
  output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0);

/** A line's open view: the code it ran (and what it printed), else what it was given and answered. */
function lineDetail(t: TFunction, l: ToolLine): ReactNode | undefined {
  const output = l.output ?? [];
  const printed = output.length > 0 ? outputTail(output) : "";
  if (l.code)
    return (
      <>
        <CodeCard lang={l.code.language} text={l.code.source} />
        {printed ? <Plate rows={[{ text: printed, danger: l.state === "fail" }]} /> : null}
      </>
    );
  if (printed) return <Plate rows={[{ text: printed, danger: l.state === "fail" }]} />;
  // What the tool answered, its own words when it failed: only in the open view, never under the line.
  const answer = l.result ?? toolWhy(t, l) ?? l.why;
  if (!l.input && !answer) return undefined;
  return (
    <Plate
      rows={[
        ...(l.input ? [{ label: t("chat.work.gave"), text: l.input }] : []),
        ...(answer
          ? [
              {
                label: l.state === "fail" ? t("chat.work.error") : t("chat.work.answered"),
                text: answer,
                danger: l.state === "fail",
              },
            ]
          : []),
      ]}
    />
  );
}

/** A code call's phrase once done ("Rodou 12 linhas de python · saída 1 kB"), else the shared phrase. */
function lineLabel(t: TFunction, locale: string, l: ToolLine) {
  if (!l.code || l.state !== "done") return toolPhrase(t, l);
  return t("code.ranSummary", {
    count: l.code.source.split("\n").length,
    language: l.code.language,
    size: formatBytes(locale, bytesOf(l.output ?? [])),
  });
}

/** A line of the block from the shared model. */
function blockLine(t: TFunction, locale: string, l: ToolLine, logo: ReactNode): BlockLine {
  return {
    key: l.key,
    state: l.state,
    logo,
    label: lineLabel(t, locale, l),
    hint: toolLineHint(t, l),
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    count: l.count > 1 ? t("chat.work.times", { count: l.count }) : undefined,
    why: l.state === "fail" ? toolWhy(t, l) : null,
    detail: lineDetail(t, l),
    defaultOpen: l.state === "run" && Boolean(l.code),
  };
}

function useBlockItems(items: ToolItem[]): BlockItem[] {
  const { t, i18n } = useTranslation();
  const logo = useCallLogo();
  return items.flatMap((item): BlockItem[] =>
    item.kind === "call"
      ? [{ kind: "line", line: blockLine(t, i18n.language, item.line, logo(item.line)) }]
      : item.kind === "say"
        ? [
            {
              kind: "note",
              key: item.key,
              node: (
                <Text variant="footnote" tone="muted">
                  {item.text}
                </Text>
              ),
            },
          ]
        : [],
  );
}

// ── A reply's tools, live and kept ───────────────────────────────────────────

/**
 * The tools of an agent's turn while it works (and kept by its saved reply a moment after, `done`): the
 * block saying what it does now, opening into every call; the messages it read under it. Before its first
 * call, what it said and read are plain lines (as on the web's `LiveTools`).
 */
export function TurnTools({
  items,
  agentName,
  color,
  quoteOf,
  done = false,
  settled = false,
}: {
  items: ToolItem[];
  agentName: string;
  color: AgentColorName;
  /** A message's text (the "Leu seu recado" wells quote it). */
  quoteOf: (messageId: string) => string | undefined;
  /** The reply is done: "Usou 4 ferramentas · 6 s". */
  done?: boolean;
  /** Drawn by the saved reply (nothing comes in any more). */
  settled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const blockItems = useBlockItems(items);
  const logo = useCallLogo();
  // A lone quick read that only fed the answer: no card, as if it called nothing. Done, its tools are the summary
  // the person chose not to see (`showActivity`) unless they turned it on.
  const now = quietWork(items) || (done && !showsActivity(org)) ? null : toolNow(items);
  if (!now) {
    // Done without a call: its words are the reply now; only the messages it read stay.
    const shown = done ? items.filter((i) => i.kind === "steer") : items;
    if (shown.length === 0) return null;
    return (
      <View style={styles.loose}>
        {shown.map((i) =>
          i.kind === "say" ? (
            <View key={i.key} style={styles.say}>
              <MessageText body={i.text} selectable={false} />
            </View>
          ) : i.kind === "steer" ? (
            <ReadWell key={i.key} now={i.now} quote={quoteOf(i.messageId) ?? ""} settled={settled} />
          ) : null,
        )}
      </View>
    );
  }
  const calls = toolCalls(items);
  const one = oneCall(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head: BlockHead = done
    ? { text: t("chat.work.used", { count: calls }), time: total > 0 ? formatDuration(t, total) : undefined }
    : {
        text: lineLabel(t, i18n.language, now),
        textKey: `${now.key}-${now.state}`,
        state: now.state,
        count: t("chat.work.steps", { count: calls }),
      };
  return (
    <>
      <ToolBlock
        logos={toolApps(items).map((a) => ({ key: appKey(a), node: logo(a, 18) }))}
        head={head}
        // Its own line is closed until tapped, as the block it stands for (code that runs shows when opened).
        items={
          one
            ? blockItems.map((i) => (i.kind === "line" ? { ...i, line: { ...i.line, defaultOpen: false } } : i))
            : blockItems
        }
        color={color}
        label={t("chat.work.block", agentGrammar(agentName))}
        live={!done && !settled}
        one={one}
      />
      {items.map((i) =>
        i.kind === "steer" ? (
          <ReadWell key={i.key} now={i.now} quote={quoteOf(i.messageId) ?? ""} settled={settled} />
        ) : null,
      )}
    </>
  );
}

/**
 * The tools of a saved reply: closed, "Usou 4 ferramentas · 12 s" with the apps' logos from `meta.work`; its
 * steps load from `GET …/runs/{id}` only when opened (one request per opened message). Nothing when the
 * server says it used no tools. A single call is its own line from `meta.work` ("Criou uma rotina"), opening on what
 * it was given and answered.
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
  color: AgentColorName;
  /** Screens whose calls have their own card on the message (`TrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(orgId, open ? runId : null);
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
  const shown = compact ? workSteps(compact, onCard) : 0;
  if (!compact || shown === 0 || !showsActivity(org)) return null;
  const calls = work ? toolCalls(items) : shown;
  const lone = savedOneLine(meta, onCard);
  // Its one call (beside the screens' on their cards) only fed the answer (`quietLine`): the reply says it. Time
  // unknown (saved before the server wrote it): kept, it may have failed.
  if (lone && lone.ms !== null && quietLine(lone)) return null;
  const durationMs = work?.durationMs ?? compact.durationMs;
  const apps = work ? toolApps(items) : workApps(compact.calls.filter((c) => !onCard(c.name)));
  const note = (key: string, node: ReactNode): BlockItem => ({ kind: "note", key, node });
  // The steps loading, or not come: said in the block, or in a lone call's open line.
  const pending = run.isError ? (
    <Text variant="footnote" tone="muted">
      {t("chat.work.failed")}
    </Text>
  ) : !work ? (
    <View style={styles.loading}>
      <PixelOrbit color={color} size={14} />
      <Text variant="footnote" tone="faint">
        {t("mobile.common.loading")}
      </Text>
    </View>
  ) : null;
  if (lone && (!work || oneCall(items) || !items.some((i) => i.kind === "call"))) {
    const line = blockLine(t, i18n.language, lone, logo(lone));
    return (
      <ToolBlock
        one
        logos={[]}
        head={{ text: line.label }}
        items={
          work && oneCall(items) ? blockItems : [{ kind: "line", line: { ...line, detail: pending ?? undefined } }]
        }
        color={color}
        label={t("chat.work.block", agentGrammar(agentName))}
        // Its steps stay once loaded: closing the line doesn't change what it says.
        onToggle={(o) => o && setOpen(true)}
      />
    );
  }
  // Never a block that opens on nothing.
  if (work && calls === 0) return null;
  const status: BlockItem[] = pending ? [note(run.isError ? "error" : "loading", pending)] : [];
  return (
    <ToolBlock
      logos={apps.map((a) => ({ key: appKey(a), node: logo(a, 18) }))}
      head={{
        text: t("chat.work.used", { count: calls }),
        time: durationMs !== null ? formatDuration(t, durationMs) : undefined,
      }}
      items={[...status, ...blockItems]}
      color={color}
      label={t("chat.work.block", agentGrammar(agentName))}
      onToggle={setOpen}
    />
  );
}

/**
 * A task's steps on its own screen (ADR 0128): every call of the run so far, open, each opening again on what it ran
 * or was given and answered. `calls` is how many calls the task made: when it grows, the steps load again. While it
 * works (`live`) its last call still waiting on an answer is the one running.
 */
export function RunSteps({
  runId,
  color,
  calls,
  live,
}: {
  runId: string;
  color: AgentColorName;
  calls: number;
  live: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  // The task manager's own read (ADR 0128): whoever sees the task sees its steps, without usage access.
  const run = useTaskSteps(orgId, runId);
  const { refetch } = run;
  const seen = useRef(calls);
  useEffect(() => {
    if (seen.current === calls) return;
    seen.current = calls;
    void refetch();
  }, [calls, refetch]);
  const work = run.data ? workFromSteps(run.data.steps, run.data.run) : null;
  const saved = work ? toolItemsSaved(work) : [];
  const lastCall = saved.findLastIndex((i) => i.kind === "call");
  const items: ToolItem[] = saved.map((item, i) =>
    live && i === lastCall && item.kind === "call" && item.line.state === "stop"
      ? { ...item, line: { ...item.line, state: "run" as const } }
      : item,
  );
  const blockItems = useBlockItems(items);
  if (!work)
    return run.isError ? (
      <Text variant="footnote" tone="muted">
        {t("chat.work.failed")}
      </Text>
    ) : (
      <View style={styles.loading}>
        <PixelOrbit color={color} size={14} />
        <Text variant="footnote" tone="faint">
          {t("mobile.common.loading")}
        </Text>
      </View>
    );
  if (blockItems.length === 0)
    return (
      <Text variant="footnote" tone="faint">
        {t("taskManager.panel.noSteps")}
      </Text>
    );
  return (
    <View style={[styles.block, styles.steps, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      {blockItems.map((item) =>
        item.kind === "note" ? (
          <View key={item.key} style={styles.note}>
            {item.node}
          </View>
        ) : (
          <Line key={item.line.key} line={item.line} color={color} />
        ),
      )}
    </View>
  );
}

/**
 * A message it read while working, under its tools: "Leu seu recado · …", or "Parou para ler seu recado ·
 * …" when it was asked to stop and read (until then the message itself says "lê na próxima pausa").
 */
function ReadWell({ now, quote, settled }: { now: boolean; quote: string; settled: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced || settled ? undefined : FadeIn.duration(260)}
      style={[styles.well, { backgroundColor: c.sunken }]}
    >
      <Icon name={now ? "bolt" : "eye"} size={15} color={c.muted} />
      <Text variant="small" tone="ink2" style={styles.wellTitle} numberOfLines={1}>
        {t(now ? "mobile.chat.steer.wellNow" : "mobile.chat.steer.well")}
      </Text>
      {quote ? (
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
          {quote}
        </Text>
      ) : null}
    </Animated.View>
  );
}

/** A call's row: its side padding, the logo's column (and its first line's height) and the gap to the phrase. */
const ROW_PAD = 8;
const LOGO = 20;
const ROW_GAP = 10;
/** Where a call's phrase starts in the block: why it failed and what it said between calls line up there. */
const PHRASE_AT = ROW_PAD + LOGO + ROW_GAP;

const styles = StyleSheet.create({
  // Flat: a hairline and the cut corner (the app's "tato com canto"), no shadow.
  block: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
  },
  // The block opens from here, 44 tall (a finger's target); its logos and words in the rows' columns (the lines'
  // 4 of padding and a row's own 8).
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    minHeight: 44,
    paddingLeft: 4 + ROW_PAD,
    paddingRight: 10,
  },
  logos: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  stacked: { borderRadius: 7, borderWidth: 1.5 },
  overlap: { marginLeft: -8 },
  grow: { flex: 1, minWidth: 0 },
  clip: { overflow: "hidden" },
  shrink: { flexShrink: 1 },
  medium: { fontWeight: "500" },
  num: { fontVariant: ["tabular-nums"] },
  mark: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  flip: { transform: [{ rotate: "180deg" }] },
  lines: { borderTopWidth: StyleSheet.hairlineWidth, padding: 4 },
  // A task's steps (`RunSteps`): the block's open lines, without its head.
  steps: { padding: 4 },
  line: { borderRadius: 10 },
  // Its 20px first line in the middle of 40: the logo's height; the phrase's 18px line, the time's 16px and the
  // mark's 16px are brought down onto it (`firstLine`, `level`).
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: ROW_GAP,
    minHeight: 40,
    paddingHorizontal: ROW_PAD,
    paddingVertical: 10,
    borderRadius: 10,
  },
  firstLine: { marginTop: (LOGO - 18) / 2 },
  level: { marginTop: (LOGO - 16) / 2 },
  one: { padding: 2 },
  logo: { width: LOGO, alignItems: "center" },
  why: { marginTop: -4, paddingLeft: PHRASE_AT, paddingRight: 8, paddingBottom: 8 },
  detail: { marginHorizontal: 8, marginBottom: 8, gap: 8 },
  plate: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  plateRow: { gap: 2 },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 18 },
  // What it said between calls: under the phrases, muted.
  note: { marginTop: 2, marginBottom: 4, marginLeft: PHRASE_AT, marginRight: 8 },
  loading: { flexDirection: "row", alignItems: "center", gap: 8 },
  loose: { gap: 2 },
  say: { marginVertical: 2 },
  // "Leu seu recado": a sunken well with the "tato com canto" corner.
  well: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginVertical: 6,
    paddingVertical: 6,
    paddingLeft: 8,
    paddingRight: 10,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  wellTitle: { fontWeight: "600", flexShrink: 0 },
});
