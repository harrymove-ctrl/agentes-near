import type { Agent, AgentBrainInput } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useApi,
  useCredentials,
  useModels,
  usePlatformKey,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
  useUpdateAgent,
  useWorkspaceUsesApi,
} from "@agenteschat/client";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { handleAfterRename } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { accountPlan, planReplies } from "@agenteschat/client/lib/plans";
import { AUTO, modelChoices } from "@agenteschat/client/lib/providers";
import { mineStatus } from "@agenteschat/client/lib/right-hand";
import {
  AffixInput,
  BrainLogo,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  GroupHeading,
  Icon,
  Input,
  OptionList,
  type OptionListItem,
  ProviderLogo,
  Switch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LookRows, ModelSelect, modelOptions } from "@/components/AgentFields";
import { RightHandApprovalsCard } from "@/components/ApprovalCover";
import { PlanHold, usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { TeamWeekSchedule } from "@/components/TeamWeekCard";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { fullLook, lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * The right hand's page (ADR 0137): its settings in two groups. "Só para você": the AI the viewer's own conversation
 * thinks with, when its weekly card comes, and what it creates and adjusts for them without asking. "Para todo o
 * workspace", only for who manages agents: its name and look, the AI of people with no plan of their own, and who may
 * use it. Its instructions are the product's.
 */
export function RightHandSettingsSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <div className="ac-groups">
      <section className="rh-group" aria-labelledby="rh-group-mine">
        <GroupHeading id="rh-group-mine" title={t("rightHand.settings.groupMine")} />
        <Card>
          <div className="settings-rows">
            <RightHandMineRow agent={agent} />
            <TeamWeekPref name={agent.name} />
          </div>
        </Card>
        <RightHandApprovalsCard />
      </section>
      {can(org, "manage_agents") && (
        <section className="rh-group" aria-labelledby="rh-group-workspace">
          <GroupHeading
            id="rh-group-workspace"
            title={t("rightHand.settings.groupWorkspace")}
            note={`· ${t("rightHand.settings.groupAdmins")}`}
          />
          <RightHandForm agent={agent} />
        </section>
      )}
    </div>
  );
}

/** A plan's maker, its account's name ("Plano Claude") and whose it is, to anyone but its owner: a row's value line. */
function PlanLine({ kind, label, owner }: { kind: PlanKind; label?: string; owner?: string }) {
  const { t } = useTranslation();
  return (
    <span className="rh-value ac-iconline">
      <BrainLogo kind={kind} size="xs" />
      <span>
        <b>{t("rightHand.settings.planName", { name: label ?? t(`aiAccounts.connect.${kind}`) })}</b>
        {owner && ` · ${t("rightHand.settings.planOwner", { owner })}`}
      </span>
    </span>
  );
}

type PlanKind = "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
const planKind = (kind: string | undefined): PlanKind | null => (kind && kind !== "model" ? (kind as PlanKind) : null);

/**
 * "Sua IA" (ADR 0137 §11): one line that opens, with what answers the viewer in their own DM with the right hand under
 * its name (the maker's mark, its name, what it is to them: Claude · seu plano), or that nothing does yet. Its dialog
 * holds the choice: their own plan (connecting one, or another) or the workspace's AI. Everyone has this line, in the
 * DM's side panel and on the right hand's page.
 */
export function RightHandMineRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const view = useAgentBrain(org.id, agent.id).data;
  const platform = usePlatformKey(org.id).data === true;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = mineStatus(view, me.user.id, platform, agent.brain?.maker);
  if (!status) return null;
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0] ?? "";
  const back = () => {
    setBusy(true);
    void api.agents
      .setBrain(org.id, agent.id, { scope: "mine", brain: "model" })
      .then(() =>
        Promise.all([
          qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) }),
          qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) }),
        ]),
      )
      .then(() => setOpen(false))
      .catch((e) => toast.show(errorText(t, e), "error"))
      .finally(() => setBusy(false));
  };
  // Connecting is a dialog of its own: this one closes for it.
  const connectMine = connect
    ? () => {
        setOpen(false);
        connect.open({ agentId: agent.id });
      }
    : null;
  let face: ReactNode = null;
  let name: string;
  let what: string | null = null;
  if (status.kind === "own") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="xs" />;
    name = status.label ?? (kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.mine"));
    what = status.ownerId
      ? t("rightHand.settings.mineOf", { owner: first(status.ownerId) })
      : t("rightHand.settings.mineYours");
  } else if (status.kind === "key") {
    face = status.provider ? <ProviderLogo id={status.provider} size="xs" /> : <Icon name="key" size={14} />;
    name = status.label ?? t("rightHand.settings.mineKeyName");
    what = t("rightHand.settings.mineKey");
  } else if (status.kind === "plan") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="xs" />;
    name = kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.mineKeyName");
    what = t("rightHand.settings.minePlan");
  } else {
    name = t("rightHand.settings.mineNobody");
  }
  const own = status.kind === "own";
  const value = (
    <span className={face ? "rh-value ac-iconline" : "rh-value"}>
      {face}
      <span>
        <b>{name}</b>
        {what && ` · ${what}`}
      </span>
    </span>
  );
  const options: OptionListItem<"mine" | "other" | "workspace">[] = [];
  if (own) options.push({ value: "mine", title: name, description: what });
  // On a billing hold nothing connects before the plan, whose one way in is the hold's banner (ADR 0162).
  if (connectMine && !held)
    options.push(
      own
        ? { value: "other", title: t("agentPage.work.brain.connectPlan") }
        : {
            value: "mine",
            title: t(status.kind === "nobody" ? "rightHand.settings.connectMine" : "rightHand.settings.useMine"),
          },
    );
  if (status.kind !== "nobody")
    options.push({
      value: "workspace",
      title: t("rightHand.settings.useWorkspace"),
      description: own ? undefined : `${name} · ${what}`,
    });
  return (
    <>
      <PrefRow
        id="rh-mine"
        icon="person"
        label={t("rightHand.settings.mine")}
        status={value}
        onOpen={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("rightHand.settings.mine")}
        description={t("rightHand.settings.mineHelp", agentGrammar(agent.name))}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          {options.length > 0 ? (
            <OptionList
              aria-label={t("rightHand.settings.mine")}
              value={own ? "mine" : "workspace"}
              disabled={busy}
              onValueChange={(next) => {
                if (next === "workspace") {
                  if (own) back();
                } else if (next === "other" || !own) connectMine?.();
              }}
              options={options}
            />
          ) : (
            <p className="muted">{t(held ? "agentSetup.firstRun.afterPlan" : "rightHand.settings.mineNobody")}</p>
          )}
        </DialogBody>
      </Dialog>
    </>
  );
}

/** "Sua IA"'s explanation, the ⓘ of the section the status stands in. */
export function useRightHandMineHint(agent: Agent) {
  const { t } = useTranslation();
  return {
    name: t("common.about", { label: t("rightHand.settings.mine") }),
    text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),
  };
}

function RightHandForm({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const usesApi = useWorkspaceUsesApi(org.id);
  const { solo } = usePersonalView();
  const [name, setName] = useState(agent.name);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const [looking, setLooking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [look, setLook] = useState(() => fullLook(lookOf(agent)));
  const g = agentGrammar(agent.name);
  const label = t("rightHand.label");
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const hold = usePlanHold();
  // The workspace's AI (ADR 0137 §11): what every DM thinks with while its person has no plan of their own.
  const kind = planKind(agent.brain?.kind);
  const view = useAgentBrain(org.id, agent.id, true, false, "workspace").data;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const key = view?.workspaceAi?.key;
  const ownerId = signIn?.ownerId;
  const firstOf = (id: string | null | undefined) => (id ? dir.memberById.get(id)?.name.split(" ")[0] : undefined);
  const save = (patch: Parameters<typeof update.mutate>[0], onSuccess?: () => void) =>
    update.mutate(patch, { onSuccess, onError: (e) => toast.show(errorText(t, e), "error") });
  const setWorkspace = (input: AgentBrainInput) => {
    setBusy(true);
    void api.agents
      .setBrain(org.id, agent.id, { scope: "workspace", ...input })
      .then(() =>
        Promise.all(
          [keys.agentBrain(org.id, agent.id), keys.agents(org.id), keys.aiStatus(org.id)].map((queryKey) =>
            qc.invalidateQueries({ queryKey }),
          ),
        ),
      )
      .catch((e) => toast.show(errorText(t, e), "error"))
      .finally(() => setBusy(false));
  };
  const rename = () => {
    const next = name.trim();
    if (!next || next === agent.name) return setName(agent.name);
    save({ name: next, handle: handleAfterRename(agent, next) });
  };
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      return toast.show(t("agent.budgetInvalid"), "error");
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  const list = modelOptions(
    t,
    i18n.language,
    modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
  );
  // Plans it may think with for everyone: the admin's own, and everyone's with `use_others_plans`.
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  const opened = view ? !view.onlyOwner : false;
  const theirs = (id: string | null | undefined) => (id && id !== me.user.id ? firstOf(id) : undefined);
  // The choice in the dialog: the API key (its model under it while chosen), then each plan. A plan in use that is no
  // longer active stays listed, so the choice never shows empty.
  const KEY = "key";
  const listed = signIn && !plans.some((p) => p.id === signIn.id) ? [signIn, ...plans] : plans;
  const choices: OptionListItem<string>[] = [
    {
      value: KEY,
      title: t("rightHand.settings.mineKeyName"),
      description: key?.label,
      leading: key ? (
        <ProviderLogo id={key.provider} size="sm" />
      ) : (
        <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
          <Icon name="key" />
        </span>
      ),
      children: (
        <ModelSelect
          aria-label={t("rightHand.settings.workspace")}
          value={agent.model}
          onChange={(model) => model !== agent.model && save({ model })}
          options={[
            { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
            ...(agent.model === AUTO || list.some((o) => o.value === agent.model)
              ? []
              : [{ value: agent.model, label: agent.model }]),
            ...list,
          ]}
        />
      ),
    },
    ...listed.map((a) => {
      const owner = theirs(a.ownerId);
      return {
        value: a.id,
        title: t("rightHand.settings.planName", { name: a.label }),
        description: owner ? t("rightHand.settings.planOwner", { owner }) : undefined,
        leading: <BrainLogo kind={a.kind} size="sm" />,
      };
    }),
  ];
  return (
    <>
      {hold && (
        <Card className="ai-panel">
          <PlanHold hold={hold} />
        </Card>
      )}
      <Card>
        <div className="settings-rows">
          <PrefRow
            id="rh-name"
            icon="agent"
            label={t("rightHand.settings.name")}
            hint={t("rightHand.settings.nameHelp", { ...g, label })}
            control={
              <span className="rh-set__name">
                <button
                  type="button"
                  className="rh-set__face-edit"
                  aria-label={t("rightHand.settings.lookEdit", g)}
                  title={t("rightHand.settings.lookEdit", g)}
                  onClick={() => setLooking(true)}
                >
                  <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
                </button>
                <Input
                  aria-label={t("rightHand.settings.name")}
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </span>
            }
          />
          <PrefRow
            id="rh-ai"
            icon="members"
            label={t("rightHand.settings.workspace")}
            status={
              kind ? (
                <PlanLine kind={kind} label={signIn?.label} owner={theirs(ownerId)} />
              ) : (
                <span className="rh-value ac-iconline">
                  {key ? <ProviderLogo id={key.provider} size="xs" /> : <Icon name="key" size={14} />}
                  <b>{key?.label ?? t("rightHand.settings.mineKeyName")}</b>
                </span>
              )
            }
            onOpen={() => setChoosing(true)}
          />
          {kind && view && !solo && (
            // As for any agent on its owner's plan (ADR 0059 §5): the plan's owner chooses, an admin may override, and
            // the plan's owner hears it by email. For the right hand it decides who without a plan of their own may
            // talk to it on this one.
            <PrefRow
              id="rh-shares"
              icon={opened ? "audienceEveryone" : "audienceOwner"}
              label={t("rightHand.settings.lend")}
              // The plan's own terms on lending it, as an agent's plan says them everywhere.
              hint={
                planReplies(t, { on: false, agent: null, brain: kind, plan: signIn?.plan, coding: accountPlan(signIn) })
                  .text
              }
              control={
                <Switch
                  aria-label={t("rightHand.settings.lend")}
                  checked={opened}
                  disabled={!view.canEdit || busy}
                  onCheckedChange={(on) => setWorkspace({ onlyOwner: !on })}
                />
              }
            />
          )}
          {usesApi && (
            <PrefRow
              id="rh-budget"
              icon="wallet"
              label={t("rightHand.settings.budget")}
              hint={t("rightHand.settings.budgetHelp", g)}
              control={
                <span className="rh-set__budget">
                  <AffixInput
                    aria-label={t("rightHand.settings.budget")}
                    prefix="US$"
                    inputMode="decimal"
                    value={budget}
                    placeholder={t("rightHand.value.budgetDefault")}
                    onChange={(e) => setBudget(e.target.value)}
                    onBlur={saveBudget}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
                  <span className="muted">{t("rightHand.settings.perMonth")}</span>
                </span>
              }
            />
          )}
        </div>
        <CardFooter icon="lock">
          {t("rightHand.settings.lock", g)}{" "}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            search={{ agent: agent.id }}
          >
            {t("rightHand.settings.audit", g)}
          </Link>
        </CardFooter>
      </Card>
      {!solo && (
        <Card aria-labelledby="rh-audience">
          <CardHeader
            id="rh-audience"
            icon="audiencePeople"
            title={t("rightHand.settings.audience")}
            subtitle={t("rightHand.settings.audienceHelp", g)}
          />
          <AudienceChoice
            value={audienceOf(agent)}
            onChange={(next) => save({ audience: audiencePatch(next) })}
            ownerUserId={agent.ownerUserId}
            agentName={agent.name}
            idPrefix="rh-audience"
          />
        </Card>
      )}
      <Dialog
        open={choosing}
        onOpenChange={setChoosing}
        title={t("rightHand.settings.workspace")}
        description={t(kind ? "rightHand.settings.planHelp" : "rightHand.settings.workspaceHelp", g)}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <OptionList
            aria-label={t("rightHand.settings.workspace")}
            value={kind ? (view?.account ?? "") : KEY}
            // On a billing hold nothing changes before the plan (ADR 0162).
            disabled={busy || !!hold}
            onValueChange={(next) => {
              if (next === KEY) return kind && setWorkspace({ brain: "model" });
              const plan = listed.find((p) => p.id === next);
              if (plan && plan.id !== view?.account) setWorkspace({ brain: plan.kind, account: plan.id });
            }}
            options={choices}
          />
          {plans.length === 0 && <p className="small muted">{t("rightHand.settings.noPlans", g)}</p>}
        </DialogBody>
      </Dialog>
      <Dialog
        open={looking}
        onOpenChange={setLooking}
        title={t("rightHand.settings.changeLook")}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <span className="rh-set__face">
            <AgentAvatar name={agent.name} appearance={look} size="lg" />
          </span>
          <LookRows look={look} onChange={setLook} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setLooking(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => save({ appearance: look }, () => setLooking(false))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * "Semana da equipe" (ADR 0137 §9): an admin's own day and hour of Lodi's weekly card, every day instead, or off.
 * Anyone else may get it every day ("Resumo do dia").
 */
function TeamWeekPref({ name }: { name: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "administrator");
  const prefs = useTeamWeekPrefs(org.id).data;
  const set = useSetTeamWeekPrefs(org.id);
  const toast = useToast();
  if (!prefs) return null;
  return (
    <PrefRow
      id="rh-team-week"
      icon="calendar"
      label={t(admin ? "teamWeek.settings.label" : "teamWeek.settings.dayLabel")}
      hint={t(admin ? "teamWeek.settings.help" : "teamWeek.settings.dayHelp", agentGrammar(name))}
      actions={
        <span className="rh-set__week">
          <TeamWeekSchedule
            prefs={prefs}
            admin={admin}
            locale={i18n.language}
            plated
            onChange={(patch) => set.mutate(patch, { onError: (e) => toast.show(errorText(t, e), "error") })}
          />
        </span>
      }
    />
  );
}
