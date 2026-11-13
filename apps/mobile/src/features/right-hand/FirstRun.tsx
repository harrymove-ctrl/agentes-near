import type { Agent } from "@agenteschat/client";
import {
  useAgentBrain,
  useAiStatus,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useInvitations,
  useMembers,
  useMessages,
  useModelLabel,
  useModels,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { emailName, firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { aiStateOf, planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { apiProviderOf, isAuto } from "@agenteschat/client/lib/providers";
import type { FirstRunState } from "@agenteschat/client/lib/right-hand";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  beatRow,
  type FirstRunFacts,
  type FirstRunStep,
  firstRunAiLabel,
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
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, type IconName } from "@/ui";
import { router } from "@/ui/navigation";
import { SetupAsks, SetupCardView, useDoneSay } from "../agents/setup/SetupCard";
import { openSetupStep } from "../agents/setup/SetupStepScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";
import { successHaptic, tapHaptic } from "../shared/parts";
import { ChoiceChip, TeamTemplatesSheet, useSendAnswer } from "./TeamCard";

/*
 * The right hand's first run on the phone (ADR 0155 §6, ADR 0162), as on the web: one checklist card inside its
 * greeting for the workspace's owners, with what the onboarding didn't do (an AI, apps, people), each row Connect AI,
 * a pushed screen or the invite screen. A personal workspace (ADR 0159), which the onboarding opens at once, has four
 * in its words: what the person wants help with (areas of life, answered in place or on a pushed screen), their agents
 * (a sheet of templates), an AI, their apps. On a billing hold the rest wait for the plan: a workspace waiting for its
 * first plan leads with a plan row (ADR 0162, amended 2026-11-10) that says where the plan is chosen, in words only
 * and with no button (App Store 3.1.1); on any other hold the AI row says it.
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  plan: "play",
  about: "person",
  team: "agent",
  ai: "brain",
  apps: "bolt",
  people: "person",
};

/** A personal workspace's row 1 saved with a template that fits: the card opens it once it is back in view. */
let templatesAfterAbout: ((template: string | undefined) => void) | null = null;
export const openTemplatesAfterAbout = (template: string | undefined) => templatesAfterAbout?.(template);

/**
 * Where the card stands for this person, and what its rows read (Conversas reads it too, with no conversation).
 * `channelId`: the right hand's DM, where what the person typed fills in a personal workspace's row 1.
 */
export function useFirstRun(agent: Agent | undefined, channelId: string | null = null) {
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const may = stepPermissions(org, meId, dir.agents);
  const hold = usePlanHold(orgId, org);
  const held = hold !== null;
  const steps = !agent
    ? []
    : firstRunSteps(agent, {
        owner: org?.role === "owner",
        configure: can(org, "configure"),
        createAgents: may.createAgents,
        connectAi: may.connectAi,
        pay: may.pay,
        connectors: can(org, "manage_connectors"),
        invite: may.invite,
        personal: isPersonal(org),
        waitsForPlan: hold === "payment",
      });
  const status = useAiStatus(orgId);
  const members = useMembers(orgId);
  const settings = useSettings(orgId);
  const messages = useMessages(orgId, channelId ?? "", channelId !== null && steps.includes("about")).data;
  const invitations = useInvitations(orgId, steps.includes("people"));
  const connections = useConnections(orgId, steps.includes("apps"));
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const waiting = invitations.data ?? [];
  const facts: FirstRunFacts = {
    context: Boolean(settings.data?.context?.trim()),
    team: team.length > 0,
    ai: !held && (aiState === "ready" || aiState === "waiting"),
    apps: live.length > 0,
    people: (members.data?.length ?? 1) > 1 || waiting.length > 0,
  };
  const done = agent?.setup && steps.length > 0 ? firstRunDone(agent.setup, facts) : new Set<FirstRunStep>();
  const left = steps.filter((s) => !done.has(s));
  const state: FirstRunState = steps.length === 0 ? "none" : left.length > 0 ? "open" : "complete";
  return {
    steps,
    done,
    facts,
    held,
    team,
    state,
    ready: status.isSuccess && members.isSuccess && (!steps.includes("about") || settings.isSuccess),
    members: members.data?.length ?? 1,
    invited: waiting.map((i) => emailName(i.email)),
    connections: live,
    typed: answerAfter(messages, null),
  };
}

export function FirstRunCard({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const send = useSendAnswer(channelId);
  const confirm = useConfirmSetup(orgId, agent.id);
  const run = useFirstRun(agent, channelId);
  const catalog = useCatalog();
  const dir = useDirectory();
  const modelLabel = useModelLabel();
  const models = useModels();
  // Through the API, the workspace's key it runs on names its maker, as on the web (Automático names none).
  const keyMaker = useAgentBrain(orgId, agent.id).data?.workspaceAi?.key?.provider;
  const [templates, setTemplates] = useState<{ initial?: string } | null>(null);
  const { steps, done, held, team, facts } = run;
  // Once, while a personal workspace's row of agents is still open for this person.
  const teamOpen = useRef(false);
  teamOpen.current = steps.includes("team") && !done.has("team");
  useEffect(() => {
    templatesAfterAbout = (initial) => {
      if (teamOpen.current) setTemplates(initial ? { initial } : {});
    };
    return () => {
      templatesAfterAbout = null;
    };
  }, []);
  const doneHere = steps.filter((s) => done.has(s));
  const personal = isPersonal(org);
  // "Agora não" moves the row on and says nothing: only something done gets its line. An invitation is only sent: its
  // line says so, and someone joining gets the welcome.
  const said = useDoneSay(
    run.ready,
    firstRunBeats(doneHere, { members: run.members, invited: run.invited.length }),
    (beat) =>
      beat === "invited"
        ? t("agentSetup.firstRun.say.invited")
        : firstRunFact(facts, beat)
          ? t(firstRunSayKey(beat, personal), agentGrammar(agent.name))
          : "",
  );
  if (run.state === "none") return null;

  // The apps it reads, by name, as on the web ("Leio GitHub e Linear").
  const names = run.connections.flatMap((c) => {
    const def = catalog.data?.connectors.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const appNames = names.length ? joinNames(names, t) : null;
  // The AI it thinks with, as the web names it: an API key's maker ("Claude"), a plan's line.
  const ownerName = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  const thinks = brainLine(
    t,
    agent.brain,
    isAuto(agent.model) ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model),
    { owner: ownerName ? firstName(ownerName) : undefined, agents: dir.agents },
  );
  const label = firstRunAiLabel(thinks, keyMaker ?? apiProviderOf(agent.model, models.data?.models ?? []));
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held });
  const next = steps.find((s) => stateOf(s) === "open");
  const act: Record<FirstRunStep, () => void> = {
    // No way to pay from the phone (App Store 3.1.1): the plan row has no button.
    plan: () => undefined,
    about: () => openSetupStep(agent.id, "about", run.typed),
    team: () => (done.has("team") ? router.push("/team") : setTemplates({})),
    // For the whole team, as the web's row: with agents besides it, every agent of the person's is chosen.
    ai: () => openConnectAi(team.length > 0 ? {} : { agentId: agent.id }),
    apps: () => openSetupStep(agent.id, "apps"),
    people: () => router.push("/invite-people"),
  };
  const mayPay = can(org, "manage_billing");
  const rows = steps.map((s) => {
    const state = stateOf(s);
    const words = firstRunRow(
      t,
      s,
      state,
      {
        org: org?.name ?? "",
        agents: team.length,
        label,
        apps: appNames,
        members: run.members,
        invited: run.invited.length ? joinNames(run.invited, t) : null,
        personal,
      },
      s !== "plan" && (agent.setup?.done.includes(s) ?? false),
    );
    // The plan row says where the plan is chosen, in words only, and has no button (App Store 3.1.1). Without one (a
    // hold that isn't a first plan's), the AI row says it, as before.
    const holdLine = s === "ai" && state === "afterPlan" && !steps.includes("plan");
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      title: holdLine ? planHoldPhoneLine(t, mayPay) : words.title,
      desc: holdLine
        ? undefined
        : s === "plan"
          ? t("common.joinSentences", {
              a: words.desc ?? "",
              b: t(mayPay ? "connectAi.billingWeb" : "standing.billing.askAdmin"),
            })
          : words.desc,
      dim: state === "afterPlan",
      saying: said && beatRow(said.step) === s ? said.text : null,
      // A personal workspace's first question is answered by the chips under it (`AboutYouAnswers`), not a button.
      ...(words.action && s !== "plan" && !(s === "about" && next === "about")
        ? {
            action: {
              label: words.action,
              primary: s === next,
              onPress: () => {
                tapHaptic();
                act[s]();
              },
            },
          }
        : {}),
      ...(words.skip && (s === "apps" || s === "people")
        ? { skip: { label: words.skip, busy: confirm.isPending, onPress: () => confirm.mutate(s) } }
        : {}),
    };
  });

  // What to ask it. The team's first task is offered once, by the team card ("Primeira tarefa"), never here too.
  const asks = firstRunAsks(done, held, team.length > 0)
    ? (["fit", "who"] as const).map((k) => ({
        label: t(modeKey(org, `agentSetup.firstRun.asks.${k}`)),
        onPress: () => send(t(modeKey(org, `agentSetup.firstRun.asks.${k}`))),
      }))
    : [];

  // One question at a time, as in a conversation: the next open step with its button, and a step just done while it
  // says so; the count says how far the rest is ("1 de 3"). Complete, the card keeps every row as the record.
  const focus = next ?? rows.find((r) => !r.done && !r.dim)?.key;
  const shown = run.state === "complete" ? rows : rows.filter((r) => r.key === focus || r.saying);

  return (
    <>
      <SetupCardView
        title={
          run.state === "complete"
            ? t("agentSetup.firstRun.complete")
            : t(modeKey(org, "agentSetup.firstRun.title"), { org: org?.name ?? "" })
        }
        done={doneHere.length}
        total={steps.length}
        rows={shown.length > 0 ? shown : rows}
        foot={
          next === "about" && run.state !== "complete" ? (
            <AboutYouAnswers
              // The areas already tapped go along, so the screen opens with them picked.
              onOther={(areas) => (areas ? openSetupStep(agent.id, "about", areas) : act.about())}
              onSaved={(template) => {
                if (teamOpen.current) setTemplates(template ? { initial: template } : {});
              }}
            />
          ) : asks.length > 0 ? (
            <SetupAsks lead={t("agentSetup.firstRun.asks.lead")} asks={asks} />
          ) : null
        }
      />
      <TeamTemplatesSheet
        open={templates !== null}
        initial={templates?.initial}
        onClose={() => setTemplates(null)}
        onNone={() => setTemplates(null)}
      />
    </>
  );
}

/**
 * A personal workspace's first question (ADR 0159), answered in place: the areas of life as answers to tap, several at
 * once, as the right hand's other questions; Save keeps them as the workspace's context in one sentence
 * (`aboutYouContext`, the same save as the step's own screen) and the agents' templates open with the first area's
 * picked. "Something else" opens the screen to write a sentence about the person, with the areas tapped so far
 * (`onOther`: them as that sentence would start, empty for none).
 */
function AboutYouAnswers({
  onOther,
  onSaved,
}: {
  onOther: (areas: string) => void;
  onSaved: (template: string | null) => void;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const save = useUpdateSettings(orgId);
  const failed = useFailed();
  const [picked, setPicked] = useState<ReadonlySet<LifeArea>>(() => new Set());
  const toggle = (area: LifeArea) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });
  const keep = () => {
    if (save.isPending || picked.size === 0) return;
    save.mutate(
      { context: aboutYouContext(t, picked, "") },
      {
        onSuccess: () => {
          successHaptic();
          onSaved(lifeAreaTemplate(picked));
        },
        onError: failed,
      },
    );
  };
  return (
    <View style={styles.areas}>
      <View style={styles.chips}>
        {LIFE_AREAS.map((area) => (
          <ChoiceChip
            key={area}
            label={t(`teamPlan.lifeArea.${area}`)}
            on={picked.has(area)}
            disabled={save.isPending}
            onPress={() => (area === "other" ? onOther(aboutYouContext(t, picked, "")) : toggle(area))}
          />
        ))}
      </View>
      {picked.size > 0 ? (
        <View style={styles.keep}>
          <Button variant="primary" size="sm" label={t("common.save")} loading={save.isPending} onPress={keep} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The areas as the right hand's answers to tap: chips that wrap, 8 apart, Save under them at their start.
  areas: { gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  keep: { flexDirection: "row" },
});
