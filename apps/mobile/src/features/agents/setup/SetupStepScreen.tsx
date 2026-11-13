import type { Agent, AgentAudience, AudienceMode, SetupStep } from "@agenteschat/client";
import {
  keys,
  useAgentAccess,
  useAgentBrain,
  useAgentDetail,
  useApi,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useModelLabel,
  useRoles,
  useSettings,
  useUpdateAgent,
  useUpdateSettings,
  useWidenAudience,
} from "@agenteschat/client";
import {
  type AccessResource,
  asksAt,
  type Level,
  type LevelState,
  levelOf,
  nextLevel,
  resourcesOf,
} from "@agenteschat/client/lib/access-levels";
import { channelsAfter, sameAudience } from "@agenteschat/client/lib/agent-edit";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { firstName } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { planOf } from "@agenteschat/client/lib/plans";
import { AUTO } from "@agenteschat/client/lib/providers";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  firstRunAppList,
  setupRole,
  suggestedChannels,
  suggestedLevels,
} from "@agenteschat/client/lib/setup-checklist";
import {
  aboutYouContext,
  LIFE_AREAS,
  type LifeArea,
  lifeAreaTemplate,
  readAboutYou,
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, fieldText, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentAi } from "../../ai/AgentAiScreen";
import { PlanReplies } from "../../ai/parts";
import { useWidenAsk } from "../../chat/ReachLines";
import { ConnectorIcon } from "../../connectors/ConnectorIcon";
import { openTemplatesAfterAbout } from "../../right-hand/FirstRun";
import { useFailed } from "../../routines/hooks";
import { resourceName, useConnectedById, useSetLevels } from "../../settings/hooks";
import { SettingsPage } from "../../settings/parts";
import { useColors, useDirectory, useMeId } from "../../shared/hooks";
import { goBack, PushedHeader, successHaptic, tapHaptic } from "../../shared/parts";
import { TextArea } from "../../shared/TextArea";
import { useAgentChannels } from "./useAgentChannels";

/*
 * The screens behind the setup checklist's buttons (ADR 0155 §2), the web's small dialogs on the phone: one step each,
 * the agent's role's suggestion marked, nothing saved until the word on the right of the bar. Each saves through the
 * same APIs as the agent's other screens, then confirms its step, and goes back to where the checklist was. A personal
 * workspace (ADR 0159) reads them in its own words, row 1 about the person (areas of life) instead of a business.
 */

const STEPS: readonly SetupStep[] = ["apps", "where", "who", "how", "about"];

/** Opens one step's screen (`ai` is Connect AI, not a screen of this); `text` fills row 1's sentence. */
export const openSetupStep = (agentId: string, step: SetupStep, text?: string | null) =>
  router.push({
    pathname: "/agent-step/[id]",
    params: { id: agentId, step, ...(text ? { text: text.slice(0, 500) } : {}) },
  });

export function SetupStepScreen({
  agentId,
  step,
  text,
}: {
  agentId: string;
  step: string | undefined;
  text?: string | undefined;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  const known = STEPS.find((s) => s === step);
  const firstRun = isRightHand(agent);
  // The right hand's first run has its own screens for apps, and in a personal workspace (ADR 0159) for what the person
  // wants help with (ADR 0155 §6); a new agent's checklist, the other four.
  const firstRunScreen = known === "apps" || (known === "about" && isPersonal(org));
  if (!agent?.setup || !known || (firstRun ? !firstRunScreen : known === "about")) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("agentSetup.title")} solid={false} />
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </View>
    );
  }
  switch (known) {
    case "about":
      return <AboutYouStep typed={text ?? null} />;
    case "apps":
      return firstRun ? <FirstRunAppsStep /> : <AppsStep agent={agent} />;
    case "where":
      return <WhereStep agent={agent} />;
    case "who":
      return <WhoStep agent={agent} />;
    default:
      return <HowStep agent={agent} />;
  }
}

/**
 * A personal workspace's row 1 (ADR 0159), as the web's dialog: "What do you want help with?", the areas of life to
 * pick, several at once, and one optional sentence about the person; saved as the workspace's context
 * (`aboutYouContext`), which every agent reads, and read back into the same answers when opened again (`readAboutYou`:
 * what was saved, else what was typed or tapped on the card). "Something else" asks for the sentence. Saved, it goes
 * back and the card opens the agents' templates with the first area's picked.
 */
function AboutYouStep({ typed }: { typed: string | null }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const settings = useSettings(orgId);
  const save = useUpdateSettings(orgId);
  const failed = useFailed();
  // What it starts from, until the person changes the areas or the sentence.
  const start = readAboutYou(t, settings.data?.context || typed || "");
  const [areas, setAreas] = useState<ReadonlySet<LifeArea> | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const picked = areas ?? new Set(start.areas);
  const shown = line ?? start.line;
  const other = picked.has("other");
  const text = aboutYouContext(t, picked, shown);
  const toggle = (area: LifeArea) => {
    tapHaptic();
    setAreas((now) => {
      const next = new Set(now ?? start.areas);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  };
  return (
    <SettingsPage
      title={t("agentSetup.firstRun.about.titlePersonal")}
      locked={save.isPending}
      action={{
        label: t("common.save"),
        disabled: !text || save.isPending || !settings.isSuccess,
        onPress: () =>
          save.mutate(
            { context: text },
            {
              onSuccess: () => {
                successHaptic();
                goBack();
                openTemplatesAfterAbout(lifeAreaTemplate(picked) ?? undefined);
              },
              onError: failed,
            },
          ),
      }}
    >
      <GroupedFooter>{t("agentSetup.firstRun.about.descPersonal")}</GroupedFooter>
      <GroupedList>
        {LIFE_AREAS.map((area) => (
          <GroupedRow
            key={area}
            label={t(`teamPlan.lifeArea.${area}`)}
            checked={picked.has(area)}
            disabled={save.isPending}
            onPress={() => toggle(area)}
          />
        ))}
      </GroupedList>
      <GroupedHeader
        {...(other
          ? {}
          : {
              hint: {
                name: t("common.about", { label: t("agentSetup.firstRun.about.linePersonal") }),
                text: t("agentSetup.firstRun.about.optionalPersonal"),
              },
            })}
      >
        {t("agentSetup.firstRun.about.linePersonal")}
      </GroupedHeader>
      <TextArea
        value={shown}
        onChangeText={setLine}
        accessibilityLabel={t("agentSetup.firstRun.about.linePersonal")}
        minHeight={88}
        scrollEnabled={false}
        editable={!save.isPending}
      />
    </SettingsPage>
  );
}

/**
 * The first run's row 4, as the web's dialog: the apps the team just made would use, plug-and-play ones only, each
 * opening the same connect sheet as Apps (whose last step says which agents use it), and the whole list under them.
 */
function FirstRunAppsStep() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const connected = new Set((connections.data ?? []).filter((x) => !x.revokedAt).map((x) => x.connector));
  const list = firstRunAppList(
    catalog.data?.connectors ?? [],
    connected,
    dir.agents.filter((a) => !isRightHand(a)),
  );
  return (
    <SettingsPage title={t(modeKey(org, "agentSetup.firstRun.apps.title"))}>
      <GroupedFooter>{t(modeKey(org, "agentSetup.firstRun.apps.desc"))}</GroupedFooter>
      {catalog.isPending || connections.isPending ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {list.length > 0 ? (
        <GroupedList>
          {list.map(({ def, suggested }) => (
            <GroupedRow
              key={def.id}
              leading={<ConnectorIcon def={def} label={connectorName(t, def)} size={30} />}
              label={connectorName(t, def)}
              {...(suggested ? { sub: t("agentSetup.suggested") } : {})}
              value={t("agentSetup.firstRun.apps.connect")}
              chevron
              onPress={() => {
                tapHaptic();
                router.push({ pathname: "/connectors", params: { connect: def.id } });
              }}
            />
          ))}
        </GroupedList>
      ) : null}
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("agentSetup.firstRun.apps.all")}
          chevron
          onPress={() => router.push("/connectors")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/** Saves a step's choice, then confirms the step and goes back; a failure says why and keeps the screen. */
function useStepSave(agent: Agent, step: SetupStep) {
  const { orgId } = useOrg();
  const failed = useFailed();
  const confirm = useConfirmSetup(orgId, agent.id);
  const [busy, setBusy] = useState(false);
  const run = async (save: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      // `false`: the person said no to a question on the way (a wider audience); nothing is confirmed.
      if ((await save()) === false) return;
      await confirm.mutateAsync(step);
      successHaptic();
      goBack();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** "What Leo can use": the workspace's apps, its role's at their suggestion; a tap moves a level on. */
function AppsStep({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const access = useAgentAccess(orgId, agent.id);
  const items = useConnectedById();
  const setLevels = useSetLevels();
  const { busy, run } = useStepSave(agent, "apps");
  const [draft, setDraft] = useState<Record<string, LevelState>>({});
  const g = agentGrammar(agent.name);
  const suggested = suggestedLevels(setupRole(agent.setup));
  const suggestionOf = (r: AccessResource) => (r.connector ? suggested[r.connector] : undefined);
  const connectors = access.data ? resourcesOf(access.data).filter((r) => r.kind === "connector") : [];
  // The role's apps first, each at its suggestion while it has none yet; the rest as they are.
  const ordered = [...connectors.filter(suggestionOf), ...connectors.filter((r) => !suggestionOf(r))];
  const level = (r: AccessResource): LevelState => {
    const picked = draft[r.id];
    if (picked) return picked;
    const now = levelOf(r);
    const wish = suggestionOf(r);
    return now === "none" && wish && r.levels.includes(wish) ? wish : now;
  };
  const count = connectors.filter((r) => level(r) !== "none").length;
  const save = () =>
    run(async () => {
      const changes: Record<string, Level> = {};
      for (const r of connectors) {
        const l = level(r);
        if (l !== "custom" && l !== levelOf(r)) changes[r.id] = l;
      }
      if (Object.keys(changes).length > 0) await setLevels.mutateAsync({ agentId: agent.id, changes });
    });
  return (
    <SettingsPage
      title={t("agentSetup.apps.title", g)}
      action={{
        label: count ? t("agentSetup.apps.ok", { count }) : t("agentSetup.apps.okNone"),
        onPress: () => void save(),
        disabled: busy || !access.isSuccess,
      }}
    >
      <GroupedFooter>{t("agentSetup.apps.desc")}</GroupedFooter>
      {access.isPending ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {access.isSuccess && ordered.length === 0 ? (
        <GroupedFooter>{t(modeKey(org, "agentSetup.apps.empty"), { org: org?.name ?? "" })}</GroupedFooter>
      ) : null}
      {ordered.length > 0 ? (
        <GroupedList>
          {ordered.map((r) => {
            const name = resourceName(t, r, items);
            const item = r.connectionId ? items.get(r.connectionId) : undefined;
            const l = level(r);
            const asks = asksAt(r, l).length > 0;
            const sub = [suggestionOf(r) ? t("agentSetup.suggested") : null, asks ? t("access.asksLegend") : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <GroupedRow
                key={r.id}
                leading={<ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} size={30} />}
                label={name}
                {...(sub ? { sub } : {})}
                value={t(`access.level.${l}`)}
                disabled={busy}
                onPress={() => {
                  tapHaptic();
                  setDraft((d) => ({ ...d, [r.id]: nextLevel(r, l) }));
                }}
              />
            );
          })}
        </GroupedList>
      ) : null}
      {ordered.length > 0 ? <GroupedFooter>{t("mobile.settings.access.how")}</GroupedFooter> : null}
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("agentSetup.apps.connectOther")}
          chevron
          onPress={() => router.push("/connectors")}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/** "Where Leo works": the channels this person may put it in, its role's marked; its DM always counts. */
function WhereStep({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const meId = useMeId();
  const detail = useAgentDetail(orgId, agent.id);
  const visible = useAgentChannels();
  const { busy, run } = useStepSave(agent, "where");
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const g = agentGrammar(agent.name);
  const placeable = visible.list.filter((ch) => addsAgentsTo(ch, meId, org));
  const placeableIds = new Set(placeable.map((ch) => ch.id));
  const current = (detail.data?.channels ?? []).filter((ch) => placeableIds.has(ch.id)).map((ch) => ch.id);
  const suggested = new Set(suggestedChannels(setupRole(agent.setup), placeable));
  const picked = draft ?? new Set(current.length ? current : suggested);
  const toggle = (id: string) => {
    tapHaptic();
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraft(next);
  };
  const save = () =>
    run(async () => {
      const wanted = [...picked];
      if (wanted.length === current.length && wanted.every((id) => current.includes(id))) return;
      // The PUT replaces the list: start from what the server has now (its DMs, channels this person can't see).
      const now = await api.agents.channels(orgId, agent.id);
      await api.agents.setChannels(orgId, agent.id, channelsAfter(now, current, wanted));
      await qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, agent.id) });
    });
  const only = placeable.find((ch) => picked.has(ch.id));
  const ok =
    picked.size === 0
      ? t("agentSetup.where.okNone")
      : picked.size === 1 && only
        ? t("agentSetup.where.okOne", { channel: `#${only.name}` })
        : t("agentSetup.where.ok", { count: picked.size });
  const order = [...placeable.filter((ch) => suggested.has(ch.id)), ...placeable.filter((ch) => !suggested.has(ch.id))];
  const ready = detail.isSuccess && visible.ready;
  return (
    <SettingsPage
      title={t("agentSetup.where.title", g)}
      action={{ label: ok, onPress: () => void save(), disabled: busy || !ready }}
    >
      <GroupedFooter>{t("agentSetup.where.desc")}</GroupedFooter>
      {!ready ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {ready && order.length === 0 ? <GroupedFooter>{t("newAgent.noChannels")}</GroupedFooter> : null}
      {ready && order.length > 0 ? (
        <GroupedList>
          {order.map((ch) => {
            const sub = suggested.has(ch.id) ? t("agentSetup.suggested") : ch.topic;
            return (
              <GroupedRow
                key={ch.id}
                icon="hash"
                label={ch.name}
                {...(sub ? { sub } : {})}
                checked={picked.has(ch.id)}
                disabled={busy}
                onPress={() => toggle(ch.id)}
              />
            );
          })}
        </GroupedList>
      ) : null}
    </SettingsPage>
  );
}

const MODES: AudienceMode[] = ["everyone", "people", "owner"];

/**
 * "Who talks to Leo": everyone, some people and roles, or only its owner; on a plan, whether it serves others. A
 * personal workspace (ADR 0159) says it in plain words and a family picks people: its roles come into sight only when
 * one is picked already or one exists besides the base and admin ones (`rolePicksInSight`). The choice is the same.
 */
function WhoStep({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const meId = useMeId();
  const dir = useDirectory();
  const roles = useRoles(orgId);
  const widen = useWidenAudience(orgId, agent.id);
  const ask = useWidenAsk(agent);
  const { busy, run } = useStepSave(agent, "who");
  const g = agentGrammar(agent.name);
  const planKind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const brain = useAgentBrain(orgId, agent.id, planKind !== null).data;
  const saved = audienceOf(agent);
  const [audience, setAudience] = useState<AgentAudience>(saved);
  const [share, setShare] = useState<boolean | null>(null);
  const owner = agent.ownerUserId;
  const ownerName = owner ? dir.memberById.get(owner)?.name : undefined;
  const ownerIsMe = Boolean(meId && owner === meId);
  const pickedPeople = new Set(audience.userIds);
  const pickedRoles = new Set(audience.roleIds ?? []);
  const rolesInSight = rolePicksInSight(org, roles.data?.roles ?? [], audience.roleIds ?? []);
  const roleList = rolesInSight ? sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))) : [];
  const people = [...dir.memberById.values()].filter((m) => m.userId !== owner);
  const modeLabel = (mode: AudienceMode) =>
    mode === "owner" ? t("audience.mode.owner") : t(modeKey(org, `audience.mode.${mode}`));
  const modeText = (mode: AudienceMode) =>
    mode === "owner"
      ? ownerName
        ? t("audience.modeText.owner", { ...g, owner: ownerIsMe ? t("agentSetup.who.you") : ownerName })
        : t("audience.modeText.noOwner")
      : t(modeKey(org, `audience.modeText.${mode}`), g);
  const valid =
    audience.mode === "everyone" ||
    (audience.mode === "owner" ? Boolean(owner) : pickedPeople.size > 0 || pickedRoles.size > 0 || Boolean(owner));
  const shareOn = share ?? (brain ? !brain.onlyOwner : false);
  const planOwner = ownerName ? firstName(ownerName) : undefined;
  const always = ownerName
    ? t("audience.ownerAlways", { name: ownerIsMe ? t("agentSetup.who.youCap") : ownerName })
    : undefined;
  const flip = (kind: "userIds" | "roleIds", id: string) => {
    tapHaptic();
    setAudience((a) => {
      const list = a[kind] ?? [];
      return { ...a, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  };
  const save = () =>
    run(async () => {
      if (!sameAudience(audience, saved)) {
        // The one save that asks first when it takes mailboxes away or opens someone else's plan (`useWidenAsk`).
        const next = audiencePatch(audience);
        if (!(await widen.saveAsync(next, ask(next)))) return false;
      }
      if (planKind && brain && share !== null && share === brain.onlyOwner) {
        await api.agents.setBrain(orgId, agent.id, { onlyOwner: !share });
        await qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, agent.id) });
      }
    });
  return (
    <SettingsPage
      title={t("agentSetup.who.title", g)}
      action={{ label: t("common.save"), onPress: () => void save(), disabled: busy || !valid }}
    >
      <GroupedHeader>{t("audience.section")}</GroupedHeader>
      <GroupedList>
        {MODES.map((mode) => (
          <GroupedRow
            key={mode}
            label={modeLabel(mode)}
            sub={modeText(mode)}
            subLines={2}
            checked={audience.mode === mode}
            disabled={busy}
            onPress={() => {
              tapHaptic();
              setAudience((a) => ({ ...a, mode }));
            }}
          />
        ))}
      </GroupedList>
      {valid ? null : (
        <GroupedFooter>
          {audience.mode === "owner" ? t("audience.modeText.noOwner") : t("audience.pickSomeone")}
        </GroupedFooter>
      )}
      {audience.mode === "people" ? (
        <>
          <GroupedHeader>{rolesInSight ? t("agentSetup.who.people") : t("audience.people")}</GroupedHeader>
          <GroupedList>
            {roleList.map((r) => (
              <GroupedRow
                key={r.id}
                icon="members"
                label={r.name}
                checked={pickedRoles.has(r.id)}
                disabled={busy}
                onPress={() => flip("roleIds", r.id)}
              />
            ))}
            {people.map((m) => (
              <GroupedRow
                key={m.userId}
                icon="person"
                label={m.name}
                checked={pickedPeople.has(m.userId)}
                disabled={busy}
                onPress={() => flip("userIds", m.userId)}
              />
            ))}
          </GroupedList>
          {always ? <GroupedFooter>{always}</GroupedFooter> : null}
        </>
      ) : null}
      {planKind && brain && audience.mode !== "owner" ? (
        <View style={styles.plan}>
          <PlanReplies
            agent={agent.name}
            {...(brain.canUsePlans || !planOwner ? {} : { owner: planOwner })}
            on={shareOn}
            onChange={setShare}
            disabled={!brain.canEdit || busy}
            brain={planKind}
            {...(planOf(agent.brain?.provider) ? { coding: planOf(agent.brain?.provider) } : {})}
          />
        </View>
      ) : null}
    </SettingsPage>
  );
}

/** "How Leo works": its instructions, its monthly limit when it pays per use, its model on its AI's screen. */
function HowStep({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const update = useUpdateAgent(orgId, agent.id);
  const modelLabel = useModelLabel();
  const { busy, run } = useStepSave(agent, "how");
  const g = agentGrammar(agent.name);
  const onApi = !agent.brain || agent.brain.kind === "model";
  // Money is for who sees it (admins): the agent's own limit, else the workspace's.
  const seesBudget = onApi && agent.monthlyBudgetUsd !== undefined && can(org, "manage_agents");
  const [instructions, setInstructions] = useState(agent.instructions);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const typed = budget.trim().replace(",", ".");
  const amount = typed === "" ? null : Number(typed);
  const budgetOk = amount === null || (Number.isFinite(amount) && amount >= 0);
  const save = () =>
    run(async () => {
      const patch: Parameters<typeof update.mutateAsync>[0] = {};
      if (instructions !== agent.instructions) patch.instructions = instructions;
      if (seesBudget && amount !== (agent.monthlyBudgetUsd ?? null)) patch.monthlyBudgetUsd = amount;
      if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
    });
  return (
    <SettingsPage
      title={t("agentSetup.how.title", g)}
      action={{ label: t("common.save"), onPress: () => void save(), disabled: busy || !budgetOk }}
    >
      <GroupedHeader>{t("agentSetup.how.instructions")}</GroupedHeader>
      <TextArea
        value={instructions}
        onChangeText={setInstructions}
        placeholder={t("newAgent.instructionsPlaceholder")}
        accessibilityLabel={t("agentSetup.how.instructions")}
        minHeight={180}
        scrollEnabled={false}
        editable={!busy}
      />
      <GroupedFooter>{t(modeKey(org, "agentSetup.how.desc"))}</GroupedFooter>
      {seesBudget ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("agentSetup.how.budget") }),
              text: t("agentSetup.how.budgetHelp", g),
            }}
          >
            {t("agentSetup.how.budget")}
          </GroupedHeader>
          <View style={[styles.budget, { backgroundColor: c.raised }]}>
            <Text variant="body" tone="muted">
              US$
            </Text>
            <TextInput
              value={budget}
              onChangeText={setBudget}
              keyboardType="decimal-pad"
              editable={!busy}
              accessibilityLabel={t("agentSetup.how.budget")}
              style={[styles.amount, fieldText("body"), { color: c.ink }]}
            />
          </View>
          {budgetOk ? null : <GroupedFooter>{t("agent.budgetInvalid")}</GroupedFooter>}
        </>
      ) : null}
      {onApi ? (
        <>
          <GroupedHeader>{t("agentSetup.how.more")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="brain"
              label={t("agentSetup.how.model")}
              hint={{ name: t("common.about", { label: t("agentSetup.how.model") }), text: t("brain.auto.hint") }}
              value={agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
              chevron
              onPress={() => openAgentAi(agent.id)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { marginVertical: 16 },
  plan: { marginTop: 18 },
  budget: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  amount: { flex: 1, paddingVertical: 12 },
});
