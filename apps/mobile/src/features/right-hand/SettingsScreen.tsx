import {
  type Agent,
  type AgentBrainInput,
  keys,
  useAgentBrain,
  useApi,
  useModelLabel,
  usePlatformKey,
  useRoles,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
  useUpdateAgent,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { agentsReach, audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { accountPlan, planReplies } from "@agenteschat/client/lib/plans";
import { AUTO } from "@agenteschat/client/lib/providers";
import { mineStatus, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { dayText, hourText, teamWeekOn } from "@agenteschat/client/lib/team-week";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PressScale,
  ProviderLogo,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { PlanHoldNote, usePlanHold } from "../ai/parts";
import { useFailed } from "../routines/hooks";
import { usePersonalView } from "../settings/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { type Directory, useColors, useDirectory, useMeId } from "../shared/hooks";
import { type PickLeading, pickOne } from "../shared/PickerSheet";
import { RightHandApprovalsGroup } from "./Approvals";

/** Opens Configurações › the right hand (ADR 0137). */
export const openRightHandSettings = () => router.push("/settings/right-hand" as never);

/**
 * The right hand's settings (ADR 0137), as on the web, in two groups. "Só para você": the AI the person's own
 * conversation thinks with, when its weekly card comes, and what it creates and adjusts for them without asking. "Para
 * todo o workspace", only for who manages agents: its name and look, the AI of people with no plan of their own and
 * the switch that lends it, its monthly budget where something bills per use, and who may use it; one line says it
 * can't be archived or deleted, and its audit log is a tap away. Its instructions are the product's.
 */
export function RightHandSettingsScreen() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const agent = rightHandOf(useDirectory().agents);
  if (!agent)
    return (
      <SettingsPage title={t("settings.section.right_hand")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  return (
    <SettingsPage title={agent.name} subtitle={t("rightHand.label")}>
      <GroupTitle>{t("rightHand.settings.groupMine")}</GroupTitle>
      <GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>
      <RightHandMine agent={agent} />
      <TeamWeekRows name={agent.name} />
      <RightHandApprovalsGroup />
      {can(org, "manage_agents") ? (
        <>
          <GroupTitle note={t("rightHand.settings.groupAdmins")}>{t("rightHand.settings.groupWorkspace")}</GroupTitle>
          <Form agent={agent} />
        </>
      ) : null}
    </SettingsPage>
  );
}

/** A group of the screen by its name, over its lists' own headers; `note`: quiet words after it (who sees it). */
function GroupTitle({ children, note }: { children: string; note?: string }) {
  return (
    <Text variant="title" accessibilityRole="header" style={styles.groupTitle}>
      {children}
      {note ? (
        <Text variant="subhead" tone="muted">
          {` · ${note}`}
        </Text>
      ) : null}
    </Text>
  );
}

/** The choices of "Sua IA": the person's own plan, connecting another one, the workspace's AI. */
const MINE = "mine";
const OTHER = "other";
const WORKSPACE = "workspace";

/**
 * "Sua IA" (ADR 0137 §11) as one row that opens, as on the web (`mineStatus`): the logo of what answers the person in
 * their own DM with the right hand, its name and what it is to them (Claude, chave do workspace). Its sheet holds the
 * choice, the one in use checked: their own plan (connecting one, or another) or the workspace's AI. When nothing
 * answers them the row is the call to connect a plan. Why it is theirs alone is the row's ⓘ. Everyone has it, on the
 * right hand's profile.
 */
export function RightHandMine({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const dir = useDirectory();
  const meId = useMeId();
  const view = useAgentBrain(orgId, agent.id).data;
  const platform = usePlatformKey(orgId).data === true;
  const status = mineStatus(view, meId ?? "", platform, agent.brain?.maker);
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0] ?? "";
  const back = () =>
    void api.agents
      .setBrain(orgId, agent.id, { scope: "mine", brain: "model" })
      .then(() => {
        void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, agent.id) });
        void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
      })
      .catch(failed);
  if (!status) return null;
  const connect = () => openConnectAi({ agentId: agent.id });
  const hint = {
    name: t("common.about", { label: t("rightHand.settings.mine") }),
    text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),
  };
  if (status.kind === "nobody")
    return (
      <GroupedList>
        <GroupedRow
          icon="bolt"
          label={t("rightHand.settings.connectMine")}
          sub={t("rightHand.settings.mineNobody")}
          hint={hint}
          chevron
          onPress={connect}
        />
      </GroupedList>
    );
  const own = status.kind === "own";
  const logo =
    status.kind === "key" ? (
      status.provider ? (
        <ProviderLogo id={status.provider} size="sm" />
      ) : null
    ) : (
      <ProviderLogo id={status.brain} size="sm" />
    );
  const label =
    status.kind === "own"
      ? (status.label ?? t(`aiAccounts.connect.${status.brain}`))
      : status.kind === "key"
        ? (status.label ?? t("rightHand.settings.mineKeyName"))
        : t(`aiAccounts.connect.${status.brain}`);
  const sub =
    status.kind === "own"
      ? status.ownerId
        ? t("rightHand.settings.mineOf", { owner: first(status.ownerId) })
        : t("rightHand.settings.mineYours")
      : t(status.kind === "key" ? "rightHand.settings.mineKey" : "rightHand.settings.minePlan");
  const leading: PickLeading = logo ? { kind: "node", node: logo } : { kind: "icon", name: "key" };
  const choose = async () => {
    const picked = await pickOne({
      title: t("rightHand.settings.mine"),
      value: own ? MINE : WORKSPACE,
      options: own
        ? [
            { key: MINE, label, sub, leading },
            { key: OTHER, label: t("agentPage.work.brain.connectPlan"), leading: { kind: "icon", name: "plus" } },
            { key: WORKSPACE, label: t("rightHand.settings.useWorkspace"), leading: { kind: "icon", name: "members" } },
          ]
        : [
            { key: MINE, label: t("rightHand.settings.useMine"), leading: { kind: "icon", name: "bolt" } },
            { key: WORKSPACE, label: t("rightHand.settings.useWorkspace"), sub: `${label} · ${sub}`, leading },
          ],
    });
    if (picked === OTHER || (picked === MINE && !own)) connect();
    else if (picked === WORKSPACE && own) back();
  };
  return (
    <GroupedList>
      <GroupedRow
        {...(logo ? { leading: logo } : { icon: "key" as const })}
        label={label}
        sub={sub}
        hint={hint}
        chevron
        onPress={() => void choose()}
      />
    </GroupedList>
  );
}

/** The API key among the plans in the choice of the workspace's AI. */
const KEY = "key";

/**
 * The AI of people with no plan of their own (ADR 0137 §11), as on the web: one row with what it is now (a plan and
 * whose account, or the API key) that opens the choice of the key or a plan the person may set (their own, everyone's
 * with `use_others_plans`). On the key, its model is the row under it. On a plan, the switch that lends it, as for any
 * agent on its owner's plan: the plan's owner chooses, an admin may override, the plan's owner hears it by email.
 */
function WorkspaceAi({ agent, dir }: { agent: Agent; dir: Directory }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org) !== null;
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const meId = useMeId();
  const modelLabel = useModelLabel();
  const view = useAgentBrain(orgId, agent.id, true, false, "workspace").data;
  const kind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const key = view?.workspaceAi?.key;
  const { solo } = usePersonalView();
  const [busy, setBusy] = useState(false);
  const set = (input: AgentBrainInput) => {
    setBusy(true);
    void api.agents
      .setBrain(orgId, agent.id, { scope: "workspace", ...input })
      .then(() =>
        Promise.all(
          [keys.agentBrain(orgId, agent.id), keys.agents(orgId), keys.aiStatus(orgId)].map((queryKey) =>
            qc.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch(failed)
      .finally(() => setBusy(false));
  };
  const theirs = (id: string | null | undefined) =>
    id && id !== meId ? dir.memberById.get(id)?.name.split(" ")[0] : undefined;
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  // A plan in use that is no longer active stays listed, so the choice never opens with nothing checked.
  const listed = signIn && !plans.some((p) => p.id === signIn.id) ? [signIn, ...plans] : plans;
  const choose = async () => {
    const picked = await pickOne({
      title: t("rightHand.settings.workspace"),
      value: kind ? (view?.account ?? null) : KEY,
      options: [
        {
          key: KEY,
          label: t("rightHand.settings.mineKeyName"),
          sub: key?.label,
          leading: key
            ? { kind: "node", node: <ProviderLogo id={key.provider} size="sm" /> }
            : { kind: "icon", name: "key" },
        },
        ...listed.map((a) => {
          const owner = theirs(a.ownerId);
          return {
            key: a.id,
            label: t("rightHand.settings.planName", { name: a.label }),
            sub: owner ? t("rightHand.settings.planOwner", { owner }) : undefined,
            leading: { kind: "node" as const, node: <ProviderLogo id={a.kind} size="sm" /> },
          };
        }),
      ],
    });
    if (picked === null) return;
    if (picked === KEY) {
      if (kind) set({ brain: "model" });
      return;
    }
    const plan = listed.find((p) => p.id === picked);
    if (plan && plan.id !== view?.account) set({ brain: plan.kind, account: plan.id });
  };
  const owner = theirs(signIn?.ownerId);
  const on = view ? !view.onlyOwner : false;
  const g = agentGrammar(agent.name);
  const terms = kind
    ? planReplies(t, { on: false, agent: null, brain: kind, plan: signIn?.plan, coding: accountPlan(signIn) })
    : null;
  return (
    <>
      <GroupedList>
        <GroupedRow
          {...(kind
            ? { leading: <ProviderLogo id={kind} size="sm" /> }
            : key
              ? { leading: <ProviderLogo id={key.provider} size="sm" /> }
              : { icon: "key" as const })}
          label={
            kind
              ? t("rightHand.settings.planName", { name: signIn?.label ?? t(`aiAccounts.connect.${kind}`) })
              : t("rightHand.settings.mineKeyName")
          }
          labelLines={2}
          {...(kind
            ? owner
              ? { sub: t("rightHand.settings.planOwner", { owner }) }
              : {}
            : key
              ? { sub: key.label }
              : {})}
          // On a billing hold nothing changes before the plan (ADR 0162).
          chevron={!hold}
          disabled={busy || hold}
          onPress={() => void choose()}
        />
        {kind ? null : (
          <GroupedRow
            icon="brain"
            label={agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
            chevron
            onPress={() => openAgentAi(agent.id)}
          />
        )}
      </GroupedList>
      {hold ? (
        <PlanHoldNote org={org} />
      ) : plans.length === 0 ? (
        <GroupedFooter>{t("rightHand.settings.noPlans", g)}</GroupedFooter>
      ) : null}
      {kind && view && !solo ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="members"
              label={t("rightHand.settings.lend")}
              labelLines={2}
              // The plan's own terms on lending it, as an agent's plan says them everywhere.
              {...(terms ? { hint: { name: terms.about, text: terms.text } } : {})}
              toggle={on}
              disabled={!view.canEdit || busy}
              onPress={() => set({ onlyOwner: on })}
            />
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

function Form({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const usesApi = useWorkspaceUsesApi(orgId);
  const { solo } = usePersonalView();
  const dir = useDirectory();
  const planKind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const roles = useRoles(orgId).data?.roles ?? [];
  const update = useUpdateAgent(orgId, agent.id);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const g = agentGrammar(agent.name);
  const audience = audienceOf(agent);
  const picked = audience.mode === "people" ? audience.roleIds : [];
  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch, { onError: failed });
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      toast({ title: t("agent.budgetInvalid"), icon: "x" });
      return;
    }
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  // The people picked on the web stay; nobody and no role left picked: everyone again.
  const toggleRole = (id: string) => {
    const roleIds = picked.includes(id) ? picked.filter((r) => r !== id) : [...picked, id];
    const people = roleIds.length > 0 || audience.userIds.length > 0;
    save({
      audience: audiencePatch(people ? { ...audience, mode: "people", roleIds } : { ...audience, mode: "everyone" }),
    });
  };
  const everyone = audience.mode === "everyone";
  // Whether the narrowed audience holds for other agents too, as the web says under it.
  const reach = agentsReach(audience, false, agent.ownerUserId);
  return (
    <>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("rightHand.settings.name") }),
          text: t("rightHand.settings.nameHelp", { ...g, label: t("rightHand.label") }),
        }}
      >
        {t("rightHand.settings.name")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<AgentFace agentId={agent.id} size={36} live={false} />}
          label={agent.name}
          sub={`@${agent.handle}`}
          chevron
          onPress={() => openAgentEdit(agent.id)}
        />
      </GroupedList>

      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("rightHand.settings.workspace") }),
          text: t(planKind ? "rightHand.settings.planHelp" : "rightHand.settings.workspaceHelp", g),
        }}
      >
        {t("rightHand.settings.workspace")}
      </GroupedHeader>
      <WorkspaceAi agent={agent} dir={dir} />

      {usesApi ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("rightHand.settings.budget") }),
              text: t("rightHand.settings.budgetHelp", g),
            }}
          >
            {t("rightHand.settings.budget")}
          </GroupedHeader>
          <GroupedList>
            <View style={styles.budget}>
              <Text variant="body" tone="muted">
                US$
              </Text>
              <TextInput
                value={budget}
                onChangeText={setBudget}
                onEndEditing={saveBudget}
                keyboardType="decimal-pad"
                placeholder={t("rightHand.value.budgetDefault")}
                placeholderTextColor={c.faint}
                accessibilityLabel={t("rightHand.settings.budget")}
                style={[styles.amount, fieldText("body"), { color: c.ink }]}
              />
              <Text variant="body" tone="muted">
                {t("rightHand.settings.perMonth")}
              </Text>
            </View>
          </GroupedList>
        </>
      ) : null}

      {solo ? null : (
        <>
          <GroupedHeader>{t("rightHand.settings.audience")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="members"
              label={t("audience.mode.everyone")}
              checked={everyone}
              onPress={() => !everyone && save({ audience: audiencePatch({ ...audience, mode: "everyone" }) })}
            />
            {roles.map((r) => (
              <GroupedRow key={r.id} label={r.name} checked={picked.includes(r.id)} onPress={() => toggleRole(r.id)} />
            ))}
          </GroupedList>
          <GroupedFooter>
            {t("common.joinSentences", { a: t("rightHand.settings.audienceHelp", g), b: t("audience.rolesHint") })}
            {reach ? ` ${t(`audience.agents.${reach}`, g)}` : ""}
          </GroupedFooter>
        </>
      )}

      <Gap />
      <GroupedList>
        <GroupedRow
          icon="list"
          label={t("rightHand.settings.audit", g)}
          chevron
          onPress={() => router.push({ pathname: "/settings/audit", params: { agent: agent.id } } as never)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.lock", g)}</GroupedFooter>
    </>
  );
}

/**
 * "Semana da equipe" (ADR 0137 §9): an admin's own day and hour of Lodi's weekly card, every day instead, or off;
 * anyone else's "Resumo do dia", every day or not at all, as on the web.
 */
function TeamWeekRows({ name }: { name: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const failed = useFailed();
  const admin = can(org, "administrator");
  const prefs = useTeamWeekPrefs(orgId).data;
  const set = useSetTeamWeekPrefs(orgId);
  if (!prefs) return null;
  const save = (patch: Parameters<typeof set.mutate>[0]) => set.mutate(patch, { onError: failed });
  const locale = i18n.language;
  const on = teamWeekOn(prefs, admin);
  const label = t(admin ? "teamWeek.settings.label" : "teamWeek.settings.dayLabel");
  return (
    <>
      <GroupedHeader>{label}</GroupedHeader>
      {/* The day and the hour are rows of the switch's group, as any settings group. */}
      <GroupedList>
        <GroupedRow
          icon="clock"
          label={label}
          hint={{
            name: t("common.about", { label }),
            text: t(admin ? "teamWeek.settings.help" : "teamWeek.settings.dayHelp", agentGrammar(name)),
          }}
          toggle={on}
          onPress={() => save(admin ? { off: !prefs.off } : on ? { daily: false } : { daily: true, off: false })}
        />
        {on && admin ? (
          <Pills
            label={t("teamWeek.schedule.day")}
            value={prefs.daily ? EVERY_DAY : prefs.day}
            options={[
              ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: dayText(locale, d) })),
              { value: EVERY_DAY, label: t("teamWeek.schedule.daily") },
            ]}
            onPick={(day) => save(day === EVERY_DAY ? { daily: true } : { daily: false, day })}
          />
        ) : null}
        {!on ? null : (
          <Pills
            label={t("teamWeek.schedule.hour")}
            value={prefs.hour}
            options={Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourText(locale, h) }))}
            onPick={(hour) => save({ hour })}
          />
        )}
      </GroupedList>
    </>
  );
}

/** The day pills' "every day" ("Resumo do dia"). */
const EVERY_DAY = -1;

/** A choice of a few short values as pills that wrap (the days, the hours), the picked one filled. */
function Pills({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onPick: (value: number) => void;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.pills}>
      <Text variant="footnote" tone="muted" style={styles.pillsLabel}>
        {label}
      </Text>
      <View style={styles.pillRow}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <PressScale
              key={o.value}
              to={0.95}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => !on && onPick(o.value)}
              style={[styles.pill, { backgroundColor: on ? c.ink : c.sunken }]}
              contentStyle={styles.pillIn}
            >
              <Text variant="footnote" style={{ color: on ? c.bg : c.ink }}>
                {o.label}
              </Text>
            </PressScale>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Over a list's own header: the lists' 16 sides, a section's room above.
  groupTitle: { paddingTop: 24, paddingHorizontal: 16 },
  // Inside a group: its rows' 14 sides.
  pills: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  pillsLabel: { fontWeight: "600" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: { minHeight: 32, borderRadius: 10, borderBottomLeftRadius: 3 },
  // The whole pill presses: its padding is the press area's.
  pillIn: { paddingHorizontal: 12, justifyContent: "center" },
  // One row of a group, as GroupedRow's.
  budget: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: GROUPED_ROW.padX,
    minHeight: GROUPED_ROW.minHeight,
  },
  amount: { flex: 1, paddingVertical: GROUPED_ROW.tallPadY },
});
