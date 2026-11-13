import type { Agent, AgentSetupStep } from "@agenteschat/client";
import { useAgentAccess, useAgentDetail, useAiStatus, useMe } from "@agenteschat/client";
import { levelOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { audienceOf } from "@agenteschat/client/lib/audience";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  askedLine,
  nextStep,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
  suggestedLevels,
} from "@agenteschat/client/lib/setup-checklist";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Button, Card, Icon, type IconName, MEDIA_ROW, MediaRow, Text, useReducedMotion } from "@/ui";
import { openConnectAi } from "../../ai/NoAiCard";
import { usePlanHold } from "../../ai/parts";
import { requestComposerText } from "../../chat/composer-request";
import { useOpenDm } from "../../new/useOpenDm";
import { resourceName, useConnectedById, usePersonalView } from "../../settings/hooks";
import { AgentFace } from "../../shared/Face";
import { useColors, useDirectory, useMeId } from "../../shared/hooks";
import { successHaptic, tapHaptic } from "../../shared/parts";
import { openSetupStep } from "./SetupStepScreen";
import { setupStepsInSight } from "./steps";
import { useAgentChannels } from "./useAgentChannels";

/*
 * A new agent's setup checklist on the phone (ADR 0155 §2), as on the web: the top of its DM, drawn by the app and
 * never stored, in its voice. Five steps (think, apps, channels, who talks to it, how it works); each button opens a
 * screen of its own with the suggestion marked (managing is a pushed screen), think opens Connect AI. Only who may set
 * the agent up sees it: who manages agents all the steps, its owner the ones they may change. Its screen shows the
 * same card while something is left. Alone in a personal workspace (ADR 0159), "who talks to it" isn't asked while it
 * holds its default (`setupStepsInSight`), and the rows read the workspace's own words.
 */

const STEP_ICON: Record<AgentSetupStep, IconName> = {
  ai: "brain",
  apps: "bolt",
  where: "hash",
  who: "members",
  how: "doc",
};

/** The agents whose first card already arrived in their conversation while the app runs (its stagger plays once). */
const ARRIVED = new Set<string>();

/** The steps this person sees for this agent (none: the checklist isn't theirs, or the agent has none). */
export function useSetupSteps(agent: Agent | undefined): AgentSetupStep[] {
  const { org } = useOrg();
  const meId = useMeId();
  const { solo } = usePersonalView();
  return agent && meId
    ? setupStepsInSight(setupSteps(agent, { meId, admin: can(org, "manage_agents") }), audienceOf(agent), solo)
    : [];
}

/**
 * What its checklist reads for this person (ADR 0155 §2), as on the web: their steps, the ones done (confirmed, or
 * done as its data says), and whether everything it reads has loaded.
 */
function useSetupProgress(agent: Agent) {
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const admin = can(org, "manage_agents");
  const steps = useSetupSteps(agent);
  const status = useAiStatus(orgId);
  const access = useAgentAccess(orgId, agent.id, admin && steps.includes("apps"));
  const detail = useAgentDetail(orgId, agent.id);
  const visible = useAgentChannels();
  const connectors = access.data ? resourcesOf(access.data).filter((r) => r.kind === "connector") : [];
  const granted = connectors.filter((r) => levelOf(r) !== "none");
  const visibleIds = new Set(visible.list.map((ch) => ch.id));
  const inChannels = (detail.data?.channels ?? []).filter((ch) => visibleIds.has(ch.id));
  const aiState = aiStateOf(status.data, agent.id);
  // On a billing hold nothing thinks, a saved key included: the AI row says where the plan is, in words.
  const held = usePlanHold(orgId, org) !== null;
  // "Agora não" to apps on the right hand's card is for the team: its agents don't ask again (as on the web).
  const appsLater = dir.agents.find(isRightHand)?.setup?.done.includes("apps") ?? false;
  const done = agent.setup
    ? setupDone(agent.setup, {
        ai: !held && (aiState === "ready" || aiState === "waiting"),
        apps: granted.length > 0 || appsLater,
        where: inChannels.length > 0,
      })
    : new Set<AgentSetupStep>();
  const doneHere = steps.filter((s) => done.has(s));
  return {
    steps,
    done,
    doneHere,
    all: doneHere.length === steps.length,
    // Everything it reads has loaded: a step that turns done after this was done now (its line and a haptic).
    ready: status.isSuccess && detail.isSuccess && visible.ready && (!steps.includes("apps") || !access.isPending),
    held,
    connectors,
    granted,
    inChannels,
    visible,
  };
}

/**
 * The top of a new agent's DM: its greeting and the checklist, as its first message. The greeting asks for help only
 * when something is left as the conversation first shows its checklist loaded; done meanwhile, the ask stays as asked.
 */
export function AgentSetupIntro({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const progress = useSetupProgress(agent);
  const [asks, setAsks] = useState<boolean | null>(null);
  if (asks === null && progress.ready) setAsks(!progress.all);
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const person = firstName(me.data?.user.name ?? "");
  // A ready-made role's name, else the role it was given (a template's "Atendimento"); only an agent with neither
  // says back what it was asked (as on the web).
  const own = agent.role.trim();
  const asked = role || own ? null : askedLine(agent.instructions);
  const roleName = role
    ? roleWord(t(`newAgent.roles.${role}.name`), i18n.language)
    : own
      ? roleWord(own, i18n.language)
      : null;
  const greeting = roleName
    ? t("agentSetup.greetingRole", { ...g, person, role: roleName })
    : t("agentSetup.greeting", { ...g, person });
  return (
    <View style={styles.intro}>
      <View style={styles.head}>
        <AgentFace agentId={agent.id} size={36} />
        <Text variant="body" style={styles.bold}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="body" tone="ink2">
          {[greeting, asked ? t("agentSetup.asked", { what: asked }) : null, asks ? t("agentSetup.lead") : null]
            .filter(Boolean)
            .join(" ")}
        </Text>
        <AgentSetupCard agent={agent} place="dm" channelId={channelId} />
      </View>
    </View>
  );
}

/** "Atendimento" → "atendimento" in a sentence; an acronym ("QA") stays as it is. */
const roleWord = (name: string, locale: string) =>
  name.length <= 3 && name === name.toUpperCase() ? name : name.toLocaleLowerCase(locale);

/**
 * The checklist card. `dm`: under the agent's greeting, in its voice ("To get started"), its first tasks filling the
 * composer of `channelId`; `profile`: on its screen ("For Leo to get started"), gone once everything is done, its
 * first tasks opening its DM with the text written.
 */
export function AgentSetupCard({
  agent,
  place,
  channelId,
}: {
  agent: Agent;
  place: "dm" | "profile";
  channelId?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const openDm = useOpenDm();
  const { steps, done, doneHere, all, ready, held, connectors, granted, inChannels, visible } = useSetupProgress(agent);
  const items = useConnectedById();
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const next = nextStep(steps, done);
  const said = useDoneSay(ready, doneHere, (step) => t(`agentSetup.say.${step}`, agentGrammar(agent.name)));

  // In the new agent's conversation its first card's steps arrive one after another, once per agent while the app
  // runs: a first-time moment, never replayed when the conversation's list recycles the row or it opens again.
  const [arrives] = useState(() => place === "dm" && !ARRIVED.has(agent.id));
  useEffect(() => {
    if (arrives) ARRIVED.add(agent.id);
  }, [arrives, agent.id]);
  if (steps.length === 0 || (place === "profile" && all)) return null;

  const names = (list: typeof connectors) =>
    joinNames(
      list.map((r) => resourceName(t, r, items)),
      t,
    );
  const suggested = suggestedLevels(role);
  const suggestedApps = connectors.filter((r) => r.connector && suggested[r.connector]);
  const placeable = visible.list.filter((ch) => addsAgentsTo(ch, meId, org));
  const firstChannel = placeable.find((ch) => suggestedChannels(role, placeable).includes(ch.id));
  const audience = audienceOf(agent);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const ownerIsMe = Boolean(meId && agent.ownerUserId === meId);
  const rowOf = (step: AgentSetupStep) =>
    setupRow(t, step, done.has(step), {
      org: org?.name ?? "",
      role,
      granted: granted.length ? names(granted) : null,
      suggested: suggestedApps.length ? names(suggestedApps) : null,
      channels: inChannels.length
        ? joinNames(
            inChannels.map((ch) => `#${ch.name}`),
            t,
          )
        : null,
      firstChannel: firstChannel ? `#${firstChannel.name}` : null,
      audience: audience.mode,
      otherOwner: !ownerIsMe && owner ? firstName(owner.name) : null,
      onPlan: Boolean(agent.brain && agent.brain.kind !== "model"),
      personal: isPersonal(org),
    });

  const act = (step: AgentSetupStep) => {
    tapHaptic();
    if (step === "ai") openConnectAi({ agentId: agent.id });
    else openSetupStep(agent.id, step);
  };

  // Its role's first tasks (a blank agent's own two); a key a language lacks is left out.
  const anyKey = t as unknown as (key: string) => string;
  const tasks = setupTaskKeys(role)
    .filter((key) => i18n.exists(key))
    .map((key) => anyKey(key));
  const ask = (text: string) => {
    tapHaptic();
    if (place === "dm" && channelId) requestComposerText(channelId, text);
    else void openDm({ agentId: agent.id }, { compose: true, text });
  };

  const title =
    place === "dm" ? (all ? t("agentSetup.ready", g) : t("agentSetup.title")) : t("agentSetup.titleProfile", g);
  return (
    <SetupCardView
      title={title}
      arrives={arrives}
      done={doneHere.length}
      total={steps.length}
      rows={steps.map((s) => {
        const row = rowOf(s);
        if (s === "ai" && held && !done.has(s)) {
          return {
            key: s,
            icon: STEP_ICON[s],
            done: false,
            dim: true,
            title: planHoldPhoneLine(t, can(org, "manage_billing")),
          };
        }
        return {
          key: s,
          icon: STEP_ICON[s],
          done: done.has(s),
          title: row.title,
          desc: row.desc,
          saying: said?.step === s ? said.text : null,
          action: { label: row.action, primary: s === next, onPress: () => act(s) },
        };
      })}
      foot={
        done.has("ai") && tasks.length > 0 ? (
          <SetupAsks
            lead={all ? t("agentSetup.tasksAllDone") : t("agentSetup.tasksLead")}
            asks={tasks.map((task) => ({ label: task, onPress: () => ask(task) }))}
          />
        ) : null
      }
    />
  );
}

/** One row of a checklist card, as drawn: its button (a text button once done), "Agora não", or words alone. */
export interface SetupCardRow {
  key: string;
  icon: IconName;
  done: boolean;
  title: string;
  desc?: string | undefined;
  saying?: string | null;
  action?: { label: string; primary?: boolean; onPress: () => void };
  skip?: { label: string; onPress: () => void; busy?: boolean };
  /** It waits for something else (the plan): quieter, with no button. */
  dim?: boolean;
}

/**
 * A checklist card's drawing on the phone, a new agent's (ADR 0155 §2) and the right hand's first run (§6): the head
 * and its count, the segmented bar, the rows, a foot of asks.
 */
export function SetupCardView({
  title,
  done,
  total,
  rows,
  foot,
  arrives = false,
}: {
  title: string;
  done: number;
  total: number;
  rows: SetupCardRow[];
  foot?: ReactNode;
  /** Its rows fade in one after another (the card itself stays put): a new agent's first card, once. */
  arrives?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // Opacity only, 50 ms apart, 220 ms each with a strong ease-out: the whole card is in by about 400 ms, every
  // button pressable from the first frame. Reduced motion: no stagger at all.
  const enter = (i: number) =>
    arrives && !reduced
      ? FadeIn.duration(220)
          .delay(Math.min(i, 5) * 50)
          .easing(Easing.bezier(0.23, 1, 0.32, 1))
      : undefined;
  return (
    <Card style={styles.card}>
      <View style={styles.inner} accessibilityLabel={title}>
        <View style={styles.cardHead}>
          <Text variant="subhead" style={[styles.bold, styles.fill]} accessibilityRole="header">
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {t("agentSetup.count", { done, total })}
          </Text>
        </View>
        <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {rows.map((r, i) => (
            <View key={r.key} style={[styles.seg, { backgroundColor: i < done ? c.ink : c.line2 }]} />
          ))}
        </View>
        <View accessibilityLiveRegion="polite">
          {rows.map((r, i) => (
            // A MediaRow: the step's icon (a check once done) in the face's place, its name on that line, what it says
            // and its buttons under them at the card's width, as on the web.
            <Animated.View
              key={r.key}
              entering={enter(i)}
              style={[styles.row, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <MediaRow
                size="row"
                name={r.title}
                quiet={r.done ? "ink2" : r.dim ? "muted" : undefined}
                face={
                  r.done ? (
                    <View style={[styles.check, { backgroundColor: c.ink }]}>
                      <Icon name="check" size={12} color={c.bg} />
                    </View>
                  ) : (
                    <View style={styles.lead}>
                      <Icon name={r.icon} size={18} color={r.dim ? c.faint : c.ink2} />
                    </View>
                  )
                }
              >
                {r.saying ? (
                  <Text variant="caption" tone="ok">
                    {r.saying}
                  </Text>
                ) : !r.done && r.desc ? (
                  <Text variant="caption" tone="muted">
                    {r.desc}
                  </Text>
                ) : null}
                {(!r.done && r.skip) || r.action ? (
                  <View style={styles.acts}>
                    {!r.done && r.skip ? (
                      <Button
                        variant="text"
                        size="sm"
                        label={r.skip.label}
                        disabled={r.skip.busy}
                        onPress={r.skip.onPress}
                      />
                    ) : null}
                    {r.action ? (
                      r.done ? (
                        <Button variant="text" size="sm" label={r.action.label} onPress={r.action.onPress} />
                      ) : (
                        <Button
                          variant={r.action.primary ? "primary" : "secondary"}
                          size="sm"
                          label={r.action.label}
                          disabled={r.skip?.busy}
                          onPress={r.action.onPress}
                        />
                      )
                    ) : null}
                  </View>
                ) : null}
              </MediaRow>
            </Animated.View>
          ))}
        </View>
        {foot}
      </View>
    </Card>
  );
}

/** The card's foot: a lead, then asks to press. */
export function SetupAsks({ lead, asks }: { lead: string; asks: { label: string; onPress: () => void }[] }) {
  const c = useColors();
  return (
    <View style={[styles.foot, { borderTopColor: c.line }]}>
      <Text variant="small" style={styles.bold}>
        {lead}
      </Text>
      {asks.map((a) => (
        <Pressable
          key={a.label}
          onPress={a.onPress}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          style={({ pressed }) => [styles.task, { borderColor: c.line2 }, pressed && { backgroundColor: c.sunken }]}
        >
          <Icon name="chat" size={16} color={c.ink2} />
          <Text variant="small" style={styles.fill}>
            {a.label}
          </Text>
          <Icon name="right" size={16} color={c.faint} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * A step done while the card is in view (after everything it reads has loaded): its line for a moment and a haptic.
 */
export function useDoneSay<S extends string>(ready: boolean, doneNow: readonly S[], sayOf: (step: S) => string) {
  const [said, setSaid] = useState<{ step: S; text: string } | null>(null);
  const seen = useRef<Set<S> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useRef(sayOf);
  say.current = sayOf;
  const doneKey = doneNow.join();
  useEffect(() => {
    if (!ready) return;
    const now = new Set(doneKey ? (doneKey.split(",") as S[]) : []);
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const fresh = [...now].find((s) => !before.has(s));
    const text = fresh ? say.current(fresh) : "";
    if (!fresh || !text) return;
    successHaptic();
    setSaid({ step: fresh, text });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), 2600);
  }, [ready, doneKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return said;
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { gap: 10 },
  bold: { fontWeight: "600" },
  fill: { flex: 1, minWidth: 0 },
  card: { marginTop: 2 },
  inner: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  meter: { flexDirection: "row", gap: 4, marginTop: 10, marginBottom: 4 },
  seg: { flex: 1, height: 4, borderRadius: 2 },
  row: { paddingVertical: 12 },
  lead: { flex: 1, alignItems: "center", justifyContent: "center" },
  check: {
    width: MEDIA_ROW.row.face,
    height: MEDIA_ROW.row.face,
    borderRadius: MEDIA_ROW.row.face / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, paddingBottom: 8, gap: 8 },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
