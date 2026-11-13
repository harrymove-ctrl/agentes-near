import type { Agent } from "@agenteschat/client";
import {
  useAgentBrain,
  useAiStatus,
  useAuthConfig,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useInvitations,
  useInviteMany,
  useMembers,
  useMessages,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { emailName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  beatRow,
  type FirstRunFacts,
  type FirstRunStep,
  firstRunAiLabel,
  firstRunAppList,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunFact,
  firstRunRow,
  firstRunRowState,
  firstRunSayKey,
  firstRunSteps,
} from "@agenteschat/client/lib/setup-checklist";
import {
  aboutYouContext,
  answerAfter,
  LIFE_AREAS,
  type LifeArea,
  lifeAreaTemplate,
  readAboutYou,
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { Button, Field, Icon, type IconName, Input, Locked } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SetupAsks, SetupCardView, StepDialog, useDoneSay } from "@/components/AgentSetup";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { useFirstRunPowers } from "@/components/Standing";
import { TeamTemplatesDialog } from "@/components/TeamPlan";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useDirectory } from "@/hooks/useDirectory";

/*
 * The right hand's first run (ADR 0155 §6, ADR 0162): one checklist card inside its greeting, drawn by the app and
 * never stored, for the workspace's owners, with what the onboarding didn't do: an AI, apps, people. A personal
 * workspace (ADR 0159) has four in its words: what the person wants help with (areas of life), their agents, an AI,
 * their apps. Each row opens in place, none needing a model, and reads done from the data; only "Not now" is kept.
 * While the workspace waits for its first plan, the plan leads as a row of its own whose button is the way to it (the
 * hold's, `from: "hold"`), the AI row says it comes next, and the rest wait for the plan (ADR 0162).
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  plan: "power",
  about: "person",
  team: "agent",
  ai: "bolt",
  apps: "plug",
  people: "personAdd",
};

/** The rows this person sees on the right hand's card (none: the card isn't theirs). */
export function useFirstRunSteps(agent: Agent | undefined): FirstRunStep[] {
  const powers = useFirstRunPowers();
  return agent ? firstRunSteps(agent, powers) : [];
}

/** Where the card stands for this person: `open` while a row is left, `complete`, or `none` (not theirs). */
export function useFirstRun(agent: Agent | undefined) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const steps = useFirstRunSteps(agent);
  const status = useAiStatus(org.id);
  const members = useMembers(org.id);
  const detail = useSettings(org.id);
  const invitations = useInvitations(org.id, steps.includes("people"));
  const connections = useConnections(org.id, steps.includes("apps"));
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const held = usePlanHold() !== null;
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const waiting = invitations.data ?? [];
  const facts: FirstRunFacts = {
    context: Boolean(detail.data?.context?.trim()),
    team: team.length > 0,
    ai: !held && (aiState === "ready" || aiState === "waiting"),
    apps: live.length > 0,
    people: (members.data?.length ?? 1) > 1 || waiting.length > 0,
  };
  const done = agent?.setup && steps.length > 0 ? firstRunDone(agent.setup, facts) : new Set<FirstRunStep>();
  const ready =
    status.isSuccess &&
    members.isSuccess &&
    (!steps.includes("about") || detail.isSuccess) &&
    (!steps.includes("apps") || connections.isSuccess) &&
    (!steps.includes("people") || !invitations.isPending);
  const left = steps.filter((s) => !done.has(s));
  return {
    steps,
    done,
    facts,
    ready,
    held,
    team,
    connections: live,
    members: members.data?.length ?? 1,
    context: detail.data?.context ?? "",
    invited: waiting.map((i) => emailName(i.email)),
    state: steps.length === 0 ? ("none" as const) : left.length > 0 ? ("open" as const) : ("complete" as const),
  };
}

/**
 * The card, under the right hand's greeting. `channelId`: its DM, where what the person already typed to it fills in a
 * personal workspace's row 1.
 */
export function FirstRunCard({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const connect = useConnectAi();
  const invite = useInviteDialog();
  const actions = useChannelActions();
  const catalog = useCatalog();
  const confirm = useConfirmSetup(org.id, agent.id);
  const run = useFirstRun(agent);
  const messages = useMessages(org.id, channelId, run.steps.includes("about")).data;
  const thinks = useAgentThinks(agent);
  // Through the API, the workspace's key it runs on names its maker, as the side panel does (Automático names none).
  const keyMaker = useAgentBrain(org.id, agent.id).data?.workspaceAi?.key?.provider;
  const billingUrl = useAuthConfig().data?.billingUrl;
  const navigate = useNavigate();
  const [open, setOpen] = useState<"about" | "apps" | null>(null);
  const [templates, setTemplates] = useState<{ initial?: string } | null>(null);
  const burstRef = useRef<HTMLCanvasElement>(null);
  const { steps, done, held, team, facts } = run;
  const doneHere = steps.filter((s) => done.has(s));
  const personal = isPersonal(org);
  // "Agora não" moves the row on and says nothing: only something done gets its line and its burst. An invitation is
  // only sent: its line says so, with no burst, which waits for someone joining.
  const said = useDoneSay(
    run.ready,
    firstRunBeats(doneHere, { members: run.members, invited: run.invited.length }),
    steps.length,
    agent.appearance?.color,
    burstRef,
    (beat) =>
      beat === "invited"
        ? t("agentSetup.firstRun.say.invited")
        : firstRunFact(facts, beat)
          ? t(firstRunSayKey(beat, personal), agentGrammar(agent.name))
          : "",
    (beat) => beat !== "invited",
  );
  if (run.state === "none") return null;

  const defs = catalog.data?.connectors ?? [];
  const appNames = run.connections.flatMap((c) => {
    const def = defs.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held });
  const next = steps.find((s) => stateOf(s) === "open");
  const skip = (step: "apps" | "people") => confirm.mutate(step);
  const act: Record<FirstRunStep, () => void> = {
    // Its button leaves for the billing service (`actionNode` below), never this.
    plan: () => undefined,
    about: () => setOpen("about"),
    team: () =>
      done.has("team") ? void navigate({ to: "/org/$orgId/team", params: { orgId: org.id } }) : setTemplates({}),
    // For the whole team: no one agent named, so the dialog offers them all.
    ai: () => connect?.open({ agentIds: [agent.id, ...team.map((a) => a.id)] }),
    apps: () => setOpen("apps"),
    people: () => invite?.open(),
  };
  const label = thinks ? firstRunAiLabel(thinks, keyMaker ?? thinks.mark) : null;
  const rows = steps.map((s) => {
    const state = stateOf(s);
    // People, open: an address to send at once in the row, the dialog behind "Mais opções".
    const inline = s === "people" && state === "open" && invite !== null && can(org, "invite_people");
    const words = firstRunRow(
      t,
      s,
      state,
      {
        org: org.name,
        agents: team.length,
        label,
        apps: appNames.length ? joinNames(appNames, t) : null,
        members: run.members,
        invited: run.invited.length ? joinNames(run.invited, t) : null,
        personal,
      },
      // Nothing about the plan is stored: it is never skipped, it leaves when the hold lifts.
      s !== "plan" && (agent.setup?.done.includes(s) ?? false),
    );
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      title: words.title,
      desc: words.desc,
      dim: state === "afterPlan",
      saying: said && beatRow(said.step) === s ? said.text : null,
      ...(words.action && !inline && s !== "plan" && (s !== "ai" || connect) && (s !== "people" || invite)
        ? { action: { label: words.action, primary: s === next, onClick: act[s] } }
        : {}),
      // The plan's row: the hold's own way to the billing service (no billing service, no button).
      ...(s === "plan" && state === "open" && words.action && billingUrl
        ? {
            actionNode: (
              <BillingLinkButton orgId={org.id} from="hold" size="sm" variant="primary">
                {words.action}
              </BillingLinkButton>
            ),
          }
        : {}),
      ...(words.skip && (s === "apps" || s === "people") && !inline
        ? { skip: { label: words.skip, busy: confirm.isPending, onClick: () => skip(s) } }
        : {}),
      ...(inline
        ? {
            form: (
              <InviteLine
                onMore={() => invite?.open()}
                skip={words.skip ? { label: words.skip, busy: confirm.isPending, onClick: () => skip("people") } : null}
              />
            ),
          }
        : {}),
    };
  });

  // A personal workspace's row 1 saved: straight into the agents, once, with the template that fits the areas picked.
  const aboutSaved = (initial: string | null) => {
    setOpen(null);
    if (!done.has("team") && steps.includes("team")) setTemplates(initial ? { initial } : {});
  };

  // What to ask it. The team's first task is offered once, by the team card ("Primeira tarefa"), never here too.
  const asks = firstRunAsks(done, held, team.length > 0)
    ? (["fit", "who"] as const).map((k) => ({
        label: t(modeKey(org, `agentSetup.firstRun.asks.${k}`)),
        onClick: () => actions?.resend(t(modeKey(org, `agentSetup.firstRun.asks.${k}`))),
      }))
    : [];

  return (
    <SetupCardView
      title={
        run.state === "complete"
          ? t("agentSetup.firstRun.complete")
          : t(modeKey(org, "agentSetup.firstRun.title"), { org: org.name })
      }
      done={doneHere.length}
      total={steps.length}
      place="dm"
      burstRef={burstRef}
      rows={rows}
      foot={asks.length > 0 && <SetupAsks lead={t("agentSetup.firstRun.asks.lead")} asks={asks} />}
    >
      {open === "about" && (
        <AboutYouDialog
          context={run.context}
          typed={answerAfter(messages, null)}
          onClose={() => setOpen(null)}
          onSaved={aboutSaved}
        />
      )}
      {open === "apps" && <AppsDialog team={team} onClose={() => setOpen(null)} />}
      <TeamTemplatesDialog open={templates !== null} initial={templates?.initial} onClose={() => setTemplates(null)} />
    </SetupCardView>
  );
}

/**
 * The people row's own line: one address and Enviar invites at once with the invite dialog's defaults, the dialog
 * itself behind "Mais opções" (several people, roles, channels, a note), and "Agora não" beside it, under the field.
 */
function InviteLine({
  onMore,
  skip,
}: {
  onMore: () => void;
  skip: { label: string; busy: boolean; onClick: () => void } | null;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const send = useInviteMany(org.id);
  const [email, setEmail] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const address = email.trim();
  const submit = () =>
    send.mutate(
      { emails: [address] },
      {
        onSuccess: ([out]) => {
          if (out?.status === "invalid_email") return setRefused(t("members.batch.invalid_email", { email: address }));
          setRefused(null);
          setEmail("");
        },
        onError: (e) => setRefused(errorText(t, e)),
      },
    );
  return (
    <form
      className="setup-invite"
      onSubmit={(e) => {
        e.preventDefault();
        if (address && !send.isPending) submit();
      }}
    >
      <span className="setup-invite__line">
        <Input
          type="email"
          className="setup-invite__email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("agentSetup.firstRun.people.email")}
          aria-label={t("auth.email")}
          disabled={send.isPending}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!address} loading={send.isPending}>
          {t("agentSetup.firstRun.people.send")}
        </Button>
      </span>
      {refused && (
        <span className="setup-invite__error" role="alert">
          {refused}
        </span>
      )}
      <span className="setup-invite__more">
        <button type="button" className="ac-link" onClick={onMore}>
          {t("agentSetup.firstRun.people.more")}
        </button>
        {skip && (
          <button type="button" className="ac-link" disabled={skip.busy} onClick={skip.onClick}>
            {skip.label}
          </button>
        )}
      </span>
    </form>
  );
}

/**
 * A personal workspace's row 1 (ADR 0159): the areas of life the person wants help with, several at once, and one
 * optional sentence about them; saved as the workspace's context (`aboutYouContext`), which every agent reads, and
 * read back into the same answers when opened again. "Something else" asks for the sentence. What the person already
 * typed to the right hand comes filled in. Saved, the template that fits the areas picked.
 */
function AboutYouDialog({
  context,
  typed,
  onClose,
  onSaved,
}: {
  context: string;
  typed: string | null;
  onClose: () => void;
  onSaved: (template: string | null) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useUpdateSettings(org.id);
  const [start] = useState(() => readAboutYou(t, context || typed || ""));
  const [areas, setAreas] = useState<ReadonlySet<LifeArea>>(() => new Set(start.areas));
  const [line, setLine] = useState(start.line);
  const other = areas.has("other");
  const text = aboutYouContext(t, areas, line);
  const toggle = (a: LifeArea) =>
    setAreas((now) => {
      const next = new Set(now);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  return (
    <StepDialog
      title={t("agentSetup.firstRun.about.titlePersonal")}
      description={t("agentSetup.firstRun.about.descPersonal")}
      ok={t("common.save")}
      okDisabled={!text}
      busy={save.isPending}
      onClose={onClose}
      onOk={() => save.mutate({ context: text }, { onSuccess: () => onSaved(lifeAreaTemplate(areas)) })}
      note={save.isError ? <span className="setup-dlg__error">{errorText(t, save.error)}</span> : undefined}
    >
      <Locked when={save.isPending}>
        <div className="tp-chips__row">
          {LIFE_AREAS.map((a) => (
            <button key={a} type="button" className="tp-chip" aria-pressed={areas.has(a)} onClick={() => toggle(a)}>
              {areas.has(a) && <Icon name="check" size={14} />}
              <span>{t(`teamPlan.lifeArea.${a}`)}</span>
            </button>
          ))}
        </div>
        <Field
          label={t("agentSetup.firstRun.about.linePersonal")}
          hint={{
            name: t("common.about", { label: t("agentSetup.firstRun.about.linePersonal") }),
            text: other ? undefined : t("agentSetup.firstRun.about.optionalPersonal"),
          }}
        >
          <Input value={line} onChange={(e) => setLine(e.target.value)} maxLength={500} required={other} />
        </Field>
      </Locked>
    </StepDialog>
  );
}

/**
 * The apps row: the apps the team just made would use (its roles' suggestions), plug-and-play ones only, each with Conectar
 * (the same connect dialog as Settings, whose last step says which agents use it: all of them, by default).
 */
function AppsDialog({ team, onClose }: { team: Agent[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const connected = new Set((connections.data ?? []).filter((c) => !c.revokedAt).map((c) => c.connector));
  const list = firstRunAppList(catalog.data?.connectors ?? [], connected, team);
  return (
    <>
      <StepDialog
        title={t(modeKey(org, "agentSetup.firstRun.apps.title"))}
        description={t(modeKey(org, "agentSetup.firstRun.apps.desc"))}
        ok={t("common.close")}
        cancel={false}
        busy={false}
        onOk={onClose}
        onClose={onClose}
        note={
          <button
            type="button"
            className="ac-link"
            onClick={() =>
              void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "connectors" } })
            }
          >
            {t("agentSetup.firstRun.apps.all")}
          </button>
        }
      >
        <ul className="setup-apps">
          {list.map(({ def, suggested }) => (
            <li key={def.id} className="setup-apps__row">
              <ConnectorIcon def={def} label={connectorName(t, def)} />
              <b>{connectorName(t, def)}</b>
              {suggested && <small>{t("agentSetup.suggested")}</small>}
              <Button size="sm" onClick={() => setFlow({ step: 0, def })}>
                {t("agentSetup.firstRun.apps.connect")}
              </Button>
            </li>
          ))}
        </ul>
      </StepDialog>
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
    </>
  );
}
