import {
  type AgentGroup,
  useAgentGroups,
  useAiStatus,
  useApprovals,
  useDms,
  useFormerAgents,
  useUnarchiveAgent,
  useWorkingRuns,
} from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isOutOfOffice } from "@agenteschat/client/lib/presence";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useIsFocused } from "expo-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { Gaze } from "@/agent/AgentAvatar";
import { STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  type HeaderAction,
  LargeTitleScreen,
  LIST_PREVIEW,
  ListRow,
  PixelOrbit,
  SectionHeader,
  SwipeRow,
  Text,
  useReducedMotion,
  useToast,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { usePlanHold } from "../ai/parts";
import { CollapsibleSection, useCollapsedSections } from "../chats/HomeSection";
import { usePins } from "../chats/pins";
import { mayCreate } from "../new/logic";
import { useMachineOutages } from "../outages/queries";
import { chooseAction } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { successHaptic, Tile } from "../shared/parts";
import { useWaitingApprovals, useWorkingNow } from "../shared/queries";
import { SheetHostProvider } from "../shared/SheetHost";
import { useTabHeader } from "../shared/tabHeader";
import { usePresenceOf } from "../status/hooks";
import { useTasksToday } from "../task-manager/hooks";
import { useSectorMenu } from "../team/SectorScreen";
import { TeamEntry } from "../team/TeamEntry";
import { ARRIVAL_LOOK_MS, clearArrived, useArrived } from "./arrival";
import { openAgentDelete } from "./DeleteAgentScreen";
import { agoOf, freeSections, plainRole, type TeamLine, teamLines } from "./logic";
import { agoShort, workTitle } from "./work";

/** Rows whose agent moves (a long team stays light). */
const LIVE_ROWS = 8;
/** While Agentes is on screen, how often it asks whether the task manager is there (the manager itself: seconds). */
const TASKS_POLL_MS = 15_000;
/** A row's state line changes in place (a run starts, a request lands): it crosses over, never pops. */
const STATE_IN = FadeIn.duration(160);
/** Back from a routine: the body comes back into its sky's frame. */
const FACE_IN = FadeIn.duration(280).easing(Easing.bezier(0.23, 1, 0.32, 1));

/**
 * Agentes: the team in Conversas' rows, who needs you first. The task manager (ADR 0128) is a fixed row under the
 * title, saying how many work and how many wait; then three sections with names that never change: "Esperando você"
 * (the exact request and since when), "Trabalhando" (what each one is on, with the pixel orbit) and "Equipe" (its role
 * in plain words), split by the workspace's departments when it has some. Each row says its state as text in the
 * state's color (amber only for what waits on you; no badges, no dots), one fact per line, and the face is the state
 * too: running at work, asleep without an AI or while its computer is away. Tapping an agent opens its profile; the
 * bar's "+" creates one; an archived agent restores with a swipe.
 */
export function AgentsScreen() {
  return (
    <SheetHostProvider>
      <Agents />
    </SheetHostProvider>
  );
}

function Agents() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const header = useTabHeader();
  const orgId = useOrgId();
  const org = useOrg().org;
  const runs = useWorkingRuns(orgId);
  const dms = useDms(orgId);
  const approvals = useApprovals(orgId);
  const work = useWorkingNow();
  const asking = useWaitingApprovals();
  const outages = useMachineOutages();
  const groups = useAgentGroups(orgId);
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  const agents = dir.agents.filter((a) => listsAgent(org, a));
  const { waiting, working, free } = teamLines(agents, work, dms.data ?? [], asking, offline);
  const busy = waiting.length + working.length;
  // A routine's run works in the background, in no conversation (never "Trabalhando"): the agent is out on it.
  const onRoutine = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of runs.data ?? []) {
      if (!r.background) continue;
      const at = r.startedAt ?? r.createdAt;
      const before = out.get(r.agentId);
      if (!before || at < before) out.set(r.agentId, at);
    }
    return out;
  }, [runs.data]);
  // Rows in the order they show, so the others know which way to look at a newcomer.
  const pins = usePins();
  const order = useMemo(
    () => [
      ...waiting.map((l) => l.agent.id),
      ...working.map((l) => l.agent.id),
      ...freeSections(free, groups.data ?? [], pins.pins.agents).flatMap((s) => s.lines.map((l) => l.agent.id)),
    ],
    [waiting, working, free, groups.data, pins.pins.agents],
  );
  const greeting = useGreeting(order);
  const gazeOf = (id: string): Gaze | undefined => {
    if (!greeting || id === greeting) return undefined;
    return order.indexOf(id) < order.indexOf(greeting) ? "down" : "up";
  };
  const pull = usePullRefresh(() =>
    Promise.allSettled([runs.refetch(), dms.refetch(), approvals.refetch(), outages.refetch(), groups.refetch()]),
  );
  const total = agents.length;
  // Archived agents have no profile: admins bring them back, or delete them for good (ADR 0082), from here.
  const admin = can(org, "manage_agents");
  const archived = (useFormerAgents(orgId).data ?? []).filter((a) => admin && !a.deleted);
  const restore = useUnarchiveAgent(orgId);
  const toast = useToast();
  const c = useColors();
  const restoreOne = (a: (typeof archived)[number]) =>
    restore.mutate(a.id, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("team.restored", agentGrammar(a.name)), icon: "check" });
      },
      onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
    });
  const archivedActions = (a: (typeof archived)[number]) =>
    chooseAction(
      a.name,
      [
        { label: t("team.restore"), onPress: () => restoreOne(a) },
        { label: t("agentPage.delete.button"), destructive: true, onPress: () => openAgentDelete(a.id) },
      ],
      t("common.cancel"),
    );
  // A server without the task manager shows no way into it.
  const tasks = useTasksToday({ pollMs: TASKS_POLL_MS });
  const showsManager = total > 0 && !(tasks.isError && !tasks.data);
  // The bar's "+" does what the empty page's button does: a new agent, never the generic New.
  const creates = mayCreate(org, "agent");
  const actions: HeaderAction[] = creates
    ? [{ icon: "plus", sf: "plus", label: t("mobile.agents.create"), onPress: () => router.push("/new-agent") }]
    : header.actions;
  return (
    <LargeTitleScreen
      title={t("mobile.agents.title")}
      left={header.left}
      actions={actions}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {dir.loading ? null : dir.agents.length === 0 ? (
        <FirstUse
          place="agents"
          acts={mayCreate(org, "agent")}
          label={t("mobile.homeNow.first.create")}
          onPress={() => router.push("/new-agent")}
        />
      ) : total === 0 ? (
        <FirstUse place="agentsForYou" acts={false} />
      ) : null}
      {showsManager ? (
        <ManagerRow working={working.length} waiting={waiting.length} onPress={() => router.push("/task-manager")} />
      ) : null}
      {/* Equipe's org chart and channels (ADR 0148). A personal workspace (ADR 0159) keeps it as the last row of You ›
          Work: one person's agents rarely need an org chart in sight. */}
      {total > 0 && !isPersonal(org) ? <TeamEntry /> : null}
      <LayoutAnimationConfig skipEntering>
        {waiting.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.intentAgents.waitingSection")} count={waiting.length} />
            {waiting.map((l, i) => (
              <AgentRow
                key={l.agent.id}
                line={l}
                divider={i > 0}
                live={i < LIVE_ROWS}
                gaze={gazeOf(l.agent.id)}
                routine={onRoutine.get(l.agent.id)}
              />
            ))}
          </>
        ) : null}
        {working.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.agents.workingSection")} count={working.length} />
            {working.map((l, i) => (
              <AgentRow
                key={l.agent.id}
                line={l}
                divider={i > 0}
                live={waiting.length + i < LIVE_ROWS}
                gaze={gazeOf(l.agent.id)}
                routine={onRoutine.get(l.agent.id)}
              />
            ))}
          </>
        ) : null}
        {free.length > 0 && !groups.isPending ? (
          <FreeSections
            free={free}
            groups={groups.data ?? []}
            before={busy}
            greeting={greeting}
            gazeOf={gazeOf}
            onRoutine={onRoutine}
          />
        ) : null}
        {archived.length > 0 ? (
          <>
            <SectionHeader title={t("team.archived")} count={archived.length} />
            {archived.map((a, i) => (
              <SwipeRow
                key={a.id}
                left={{
                  label: t("team.restore"),
                  icon: "undo",
                  color: c.agent,
                  ink: c.onAgent,
                  onAction: () => restoreOne(a),
                }}
              >
                {/* The swipe's pane shows under the row, so the row is opaque. */}
                <View style={{ backgroundColor: c.bg }}>
                  <ListRow
                    onPress={() => archivedActions(a)}
                    accessibilityRole="button"
                    accessibilityLabel={[a.name, t("mobile.agents.state.archived")].join(", ")}
                    accessibilityActions={[{ name: "restore", label: t("team.restore") }]}
                    onAccessibilityAction={() => restoreOne(a)}
                    divider={i > 0}
                    leading={<AgentFace agentId={a.id} size={52} mode="rest" live={false} />}
                    title={a.name}
                    sub={
                      <Text variant="small" tone="faint" numberOfLines={1} style={LIST_PREVIEW}>
                        {t("mobile.agents.state.archived")}
                      </Text>
                    }
                  />
                </View>
              </SwipeRow>
            ))}
          </>
        ) : null}
      </LayoutAnimationConfig>
    </LargeTitleScreen>
  );
}

/**
 * The task manager's row, fixed under the title: its tile, its name and how the team stands now ("1 trabalhando ·
 * 1 espera você"), a chevron since it opens a screen. The row highlights as the system's lists do.
 */
function ManagerRow({ working, waiting, onPress }: { working: number; waiting: number; onPress: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const line =
    [
      working > 0 ? t("taskManager.working", { count: working }) : null,
      waiting > 0 ? t("taskManager.waiting", { count: waiting }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || t("mobile.agents.managerQuiet");
  return (
    <ListRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[t("taskManager.title"), line].join(", ")}
      leading={<Tile icon="list" size={52} />}
      title={t("taskManager.title")}
      sub={
        <Text variant="subhead" style={{ color: waiting > 0 ? c.amber : c.muted }} numberOfLines={1}>
          {line}
        </Text>
      }
      subLines={1}
      chevron
    />
  );
}

/**
 * The free agents: "Equipe" (the ones in no department, "Sem setor" once there are departments), then each
 * department, which collapses (remembered on this phone, for every workspace). Mounted once the groups are in, so
 * the team doesn't show whole and then split.
 */
function FreeSections({
  free,
  groups,
  before,
  greeting,
  gazeOf,
  onRoutine,
}: {
  free: TeamLine[];
  groups: AgentGroup[];
  before: number;
  greeting: string | null;
  gazeOf: (id: string) => Gaze | undefined;
  onRoutine: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  // A personal workspace's free agents are its person's, not a team (ADR 0159).
  const { org } = useOrg();
  const { collapsed, toggle } = useCollapsedSections<string>(STORED.agentGroupsCollapsed, null);
  const pins = usePins();
  const sectorMenu = useSectorMenu();
  const manages = can(org, "manage_agents");
  let shown = before;
  return (
    <>
      {freeSections(free, groups, pins.pins.agents).map(({ group, lines, pinnedCount }) => {
        const first = shown;
        shown += lines.length;
        const rows = lines.map((l, i) => (
          <AgentRow
            key={l.agent.id}
            line={l}
            divider={i > 0}
            // The newcomer and the ones looking at it move while it arrives, wherever they sit in the list.
            live={first + i < LIVE_ROWS || greeting !== null}
            pinned={i < pinnedCount}
            arriving={greeting === l.agent.id}
            gaze={gazeOf(l.agent.id)}
            routine={onRoutine.get(l.agent.id)}
          />
        ));
        return group ? (
          <CollapsibleSection
            key={group.id}
            title={group.name}
            count={lines.length}
            collapsed={collapsed.includes(group.id)}
            onToggle={() => toggle(group.id)}
            {...(manages
              ? { menu: { label: t("agentGroups.options", { name: group.name }), onPress: () => sectorMenu(group) } }
              : {})}
          >
            {rows}
          </CollapsibleSection>
        ) : (
          <Fragment key="free">
            <SectionHeader
              title={
                groups.length > 0 ? t("mobile.agents.noGroupSection") : t(modeKey(org, "mobile.agents.teamSection"))
              }
              count={lines.length}
            />
            {rows}
          </Fragment>
        );
      })}
    </>
  );
}

/** What a row's second line says, so a change of state crosses over in place (the key) while the row stays. */
type RowState = "asks" | "works" | "routine" | "away" | "noAi" | "out" | "free";

/**
 * One agent: its living body at 52 (running at work, asleep when it can't work), its name, the time at the right
 * (how long since it asked or started; when you last talked, free), then its state as text: what waits on you in
 * amber, what it is on with the orbit, its computer away or no AI in the quiet color, else its role in plain words.
 * Pinned ones come first, with no mark.
 */
function AgentRow({
  line: l,
  divider,
  live,
  pinned = false,
  arriving = false,
  gaze,
  routine,
}: {
  line: TeamLine;
  divider: boolean;
  live: boolean;
  /** On top of the free ones ("Fixar no topo"): said to screen readers; the order shows it. */
  pinned?: boolean;
  /** Just created on this phone: its row comes in once, the others looking at it. */
  arriving?: boolean;
  /** Where its face looks while a newcomer arrives (up or down at the newcomer's row). */
  gaze?: Gaze | undefined;
  /** Since when it is out on a routine (its background run), when it is. */
  routine?: string | undefined;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow();
  const reduced = useReducedMotion();
  const { agent: a, work: w, approval, computer } = l;
  const { orgId, org } = useOrg();
  const ai = useAiStatus(orgId);
  // On a billing hold an AI comes after the plan: no "Sem IA" on a team just made.
  const held = usePlanHold(orgId, org) !== null;
  const shown = usePresenceOf().agent(a.id);
  const onRoutineNow = !approval && !w && routine !== undefined;
  const noAi =
    !held && !approval && !w && !onRoutineNow && computer === undefined && aiStateOf(ai.data, a.id) === "no_ai";
  // Out of office (its plan or budget ran out, ADR 0084): the server's line says when it is back.
  const out =
    !approval && !w && !onRoutineNow && computer === undefined && !noAi && isOutOfOffice(shown?.status?.status);
  const busy = Boolean(approval || w);
  const state: RowState = approval
    ? "asks"
    : w
      ? "works"
      : onRoutineNow
        ? "routine"
        : computer !== undefined
          ? "away"
          : noAi
            ? "noAi"
            : out
              ? "out"
              : "free";
  // One meta per row: how long since it asked or started; a free agent's row needs none.
  const time = l.at && busy ? agoShort(t, agoOf(l.at, now)) : null;
  const entrance = useArrival(arriving, reduced);
  const role =
    plainRole(a.instructions) ??
    (a.role.trim() ||
      (l.preview || l.previewMedia ? previewBody(t, l.preview ?? "", l.previewMeta ?? null, l.previewMedia) : ""));
  const asks = approval
    ? l.waitingCount > 1
      ? t("mobile.intentAgents.waitingMore", { title: approval.title, count: l.waitingCount - 1 })
      : approval.title
    : "";
  const said =
    state === "asks"
      ? t("mobile.intentAgents.waitingLabel", { name: a.name })
      : state === "works"
        ? t("mobile.agents.workingLabel", { name: a.name })
        : state === "away"
          ? t("mobile.outage.rowWaitingLabel", { name: a.name, computer })
          : state === "routine"
            ? [a.name, t("mobile.agents.state.routineShort")].join(", ")
            : a.name;
  const sub = (
    <Animated.View key={state} entering={reduced ? undefined : STATE_IN} style={styles.state}>
      {state === "asks" ? (
        <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          <Text variant="small" style={[LIST_PREVIEW, styles.medium, { color: c.amber }]}>
            {t("mobile.agents.state.waitsYou")}
          </Text>
          {` · ${asks}`}
        </Text>
      ) : state === "works" && w ? (
        <>
          <PixelOrbit color={agentLook(a).color} size={16} />
          <Text variant="small" tone="ink2" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
            {shown?.line?.text ?? workTitle(t, w)}
          </Text>
        </>
      ) : state === "routine" && routine ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.agents.state.routine", { time: agoShort(t, agoOf(routine, now)) })}
        </Text>
      ) : state === "away" ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.outage.rowWaiting", { computer })}
        </Text>
      ) : state === "noAi" ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {t("mobile.agents.state.noAi")}
          {" · "}
          <Text variant="small" tone="ink2" style={[LIST_PREVIEW, styles.semibold]}>
            {t("mobile.agents.state.connect")}
          </Text>
        </Text>
      ) : state === "out" && shown?.line ? (
        <Text variant="small" tone="faint" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {shown.line.text}
        </Text>
      ) : role ? (
        <Text variant="small" tone="muted" numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
          {role}
        </Text>
      ) : null}
    </Animated.View>
  );
  return (
    // Only the newcomer's row carries a style; the rest stay plain views.
    <Animated.View style={arriving ? entrance : undefined}>
      <ListRow
        onPress={() => router.push(`/agent/${a.id}`)}
        accessibilityRole="button"
        accessibilityLabel={[
          said,
          pinned ? t("sidebarPins.pinned") : null,
          a.role.trim() || null,
          time,
          state === "away" ? null : role,
        ]
          .filter(Boolean)
          .join(", ")}
        divider={divider}
        leading={
          state === "routine" ? (
            // Out on its routine: the frame keeps its sky and waits for it.
            <AgentFace agentId={a.id} size={52} live={false} bodyless />
          ) : (
            <Animated.View key="here" entering={reduced ? undefined : FACE_IN}>
              <AgentFace
                agentId={a.id}
                size={52}
                mode={
                  state === "works" ? "run" : state === "away" || state === "noAi" || state === "out" ? "rest" : "idle"
                }
                live={live}
                gaze={gaze}
                {...(arriving ? { expression: "happy" as const } : {})}
              />
            </Animated.View>
          )
        }
        title={a.name}
        time={time}
        // An agent with no role and nothing on has no second line, never an empty one.
        sub={(state === "free" || (state === "out" && !shown?.line)) && !role ? null : sub}
      />
    </Animated.View>
  );
}

/**
 * The agent just created here, while Agentes is on screen: it is greeted once (its row comes in, the others look at it
 * for `ARRIVAL_LOOK_MS`), then the list is the list again. Null when there is no one to greet.
 */
function useGreeting(order: readonly string[]): string | null {
  const arrived = useArrived();
  const focused = useIsFocused();
  const [greeting, setGreeting] = useState<string | null>(null);
  const listed = arrived !== null && order.includes(arrived);
  useEffect(() => {
    if (!focused || !listed || !arrived) return;
    clearArrived(arrived);
    setGreeting(arrived);
  }, [focused, listed, arrived]);
  useEffect(() => {
    if (!greeting) return;
    const done = setTimeout(() => setGreeting(null), ARRIVAL_LOOK_MS);
    return () => clearTimeout(done);
  }, [greeting]);
  return greeting;
}

/**
 * A newcomer's row coming in: from a little below and a touch small, on a spring with a small bounce (a rare moment,
 * the one place this list is allowed one). Reduced motion: it only fades in. Every other row: no style at all.
 */
function useArrival(arriving: boolean, reduced: boolean) {
  const shown = useSharedValue(1);
  useEffect(() => {
    if (!arriving) return;
    shown.set(0);
    shown.set(
      reduced ? withTiming(1, { duration: 200 }) : withDelay(120, withSpring(1, { duration: 520, dampingRatio: 0.72 })),
    );
  }, [arriving, reduced, shown]);
  return useAnimatedStyle(() => {
    const v = shown.get();
    return reduced
      ? { opacity: v }
      : {
          opacity: Math.min(1, v * 1.6),
          transform: [{ translateY: (1 - v) * 16 }, { scale: 0.96 + 0.04 * v }],
        };
  });
}

const styles = StyleSheet.create({
  // The orbit sits on the line's left, 8 before the words, as the state's mark.
  state: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  medium: { fontWeight: weights.medium },
  semibold: { fontWeight: weights.semibold },
  shrink: { flexShrink: 1 },
});
